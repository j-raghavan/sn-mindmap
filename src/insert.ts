/**
 * High-level insert flow (§5.3, §F-IN-1..F-IN-5).
 *
 *   1. resolvePageContext() — getCurrentFilePath → getCurrentPageNum →
 *      PluginFileAPI.getPageSize. Required for the batched
 *      replaceElements write; falling back to default dimensions when
 *      the chain fails rejects the insert with a clear error (the
 *      batched path can't operate without a concrete notePath/page).
 *   2. Auto-expand every subtree so no node is hidden at emit time.
 *   3. radialLayout() in mindmap-local coords, root at origin.
 *   4. Fit-to-page scale if wider than the page (§F-LY-6), then
 *      translate so the unionBbox sits centered on the page.
 *   5. emitGeometries() → outlines (pre-order) + connectors clipped
 *      to each node's bbox. No marker, no preserved label strokes —
 *      re-edit is out of scope for v0.1.
 *   6. For each emitted geometry: PluginCommAPI.createElement(TYPE_GEO)
 *      to mint a native-backed Element, populate pageNum / layerNum /
 *      thickness / geometry. Then ONE PluginFileAPI.replaceElements
 *      call with [existing..., newElements]. Confirmed on device to
 *      cost one host-side fsync (vs. one per insertGeometry), which
 *      is what makes the insert finish in ~1 s instead of ~80 s.
 *   7. setLassoBoxState(2) → reloadFile() (mirrors shape-snap's
 *      executeFastPath tail). This clears any residual lasso state
 *      and refreshes the view so the user's pen immediately returns
 *      to handwriting mode — the user can write labels on the
 *      inserted rectangles right away without tapping out of a lasso
 *      selection first.
 *   8. PluginManager.closePluginView() to dismiss.
 *
 * Error handling: replaceElements is all-or-nothing on the host, so
 * there is never a partial-insert state to clean up. On failure the
 * page is untouched; we throw and let the UI surface the banner.
 */
import {
  Element,
  PluginCommAPI,
  PluginFileAPI,
  PluginManager,
} from 'sn-plugin-lib';

import type {Geometry, Rect} from './geometry';
import type {LayoutResult} from './layout/radial';
import {radialLayout} from './layout/radial';
import {cloneTree, type NodeId, type Tree} from './model/tree';
import {emitGeometries} from './rendering/emitGeometries';
import type {ApiRes} from './pluginApi';

/**
 * Debug instrumentation. Every log line is prefixed with [INSERT] so
 * `grep '\[INSERT\]' logcat.txt` surfaces the full pipeline trace and
 * makes the boundaries between JS work and native bridge awaits
 * unambiguous when diagnosing hangs or silent failures. Keep this
 * free-function style (not a class) so tree-shaking is irrelevant —
 * console.log is always a no-op in release if the host disables it.
 */
const TAG = '[INSERT]';
function log(step: string, detail?: unknown): void {
  if (detail === undefined) {
    console.log(`${TAG} ${step}`);
  } else {
    let serialized: string;
    try {
      serialized = JSON.stringify(detail);
    } catch {
      serialized = String(detail);
    }
    console.log(`${TAG} ${step} :: ${serialized}`);
  }
}

/**
 * Nomad portrait defaults, mirrored from sn-shapes/src/ShapePalette.tsx.
 * Exported so the insert button and tests share the same constant.
 */
export const DEFAULT_PAGE_WIDTH = 1404;
export const DEFAULT_PAGE_HEIGHT = 1872;

/**
 * Margin on each side of the page preserved by the fit-to-page
 * scaler (§F-LY-6). 200 px (≈ 14% of a 1404 px Nomad portrait page)
 * leaves comfortable breathing room around the mindmap so the user
 * can:
 *   - pen-lasso the whole map (the lasso start point has to be
 *     OUTSIDE every glyph, so the outermost nodes need to sit a
 *     full pen-tip-width clear of the page edge);
 *   - hand-write labels that overshoot a node's outline without
 *     bumping into a page boundary;
 *   - eyeball the map vs. the page chrome (toolbar, page number)
 *     without parts of the layout disappearing under those bands.
 *
 * v1.0 used 80 px and a real on-device run produced a near-edge
 * placement that the user couldn't lasso cleanly. 200 px is the
 * smallest value that visibly fixes that on a 4-parent / 1-grandchild
 * tree (the empirical worst case so far) without making small trees
 * look cramped to the centre of an empty page.
 */
export const INSERT_MARGIN_PX = 200;

export type InsertInput = {
  tree: Tree;
};

/**
 * Run the full insert flow. Resolves when the plugin view has been
 * dismissed by closePluginView(). Rejects on any unrecoverable error.
 */
export async function insertMindmap(input: InsertInput): Promise<void> {
  log('enter', {
    nodeCount: input.tree.nodesById.size,
    rootId: input.tree.rootId,
  });

  log('resolvePageContext:before');
  const pageCtx = await resolvePageContext();
  log('resolvePageContext:after', pageCtx);
  const {width: pageWidth, height: pageHeight} = pageCtx;

  // §F-IN-2 step 0 — auto-expand every subtree so the layout + emit
  // passes see the fully expanded tree. We clone so the caller's
  // reference is untouched (collapse is an authoring-time UI state
  // and the user expects to return to the canvas with their collapse
  // choices intact if the insert fails).
  const expanded = autoExpand(input.tree);
  log('autoExpand:done', {nodeCount: expanded.nodesById.size});

  // §F-LY-1..F-LY-3 — radial layout in mindmap-local coords (root at
  // origin). The emit step needs bboxes for outlines and centers for
  // connector endpoints, and §F-IN-3 needs the union-rect for the
  // post-insert lasso.
  const baseLayout = radialLayout(expanded);
  log('radialLayout:done', {
    unionBbox: baseLayout.unionBbox,
    centers: baseLayout.centers.size,
    bboxes: baseLayout.bboxes.size,
  });

  // §F-LY-6 — scale uniformly to fit if the map is wider than the
  // page (minus INSERT_MARGIN_PX on each side). Scale is capped at 1
  // so small maps keep their designed proportions; page-centering is
  // still applied even at scale=1 so the mindmap lands at the page
  // center regardless of where the user's viewport happened to be.
  const scale = computeFitScale(
    baseLayout.unionBbox,
    pageWidth,
    pageHeight,
    INSERT_MARGIN_PX,
  );
  const pageLayout = transformLayout(
    baseLayout,
    scale,
    pageWidth,
    pageHeight,
  );
  log('transformLayout:done', {
    scale,
    unionBbox: pageLayout.unionBbox,
  });

  // §F-IN-2 — assemble the geometry list (outlines + connectors).
  const {geometries, unionRect} = emitGeometries({
    tree: expanded,
    layout: pageLayout,
  });
  log('emitGeometries:done', {
    total: geometries.length,
    byType: countByType(geometries),
    unionRect,
  });

  // §F-IN-3 — batched write. Build one native-backed Element per
  // emitted geometry (createElement returns an Element whose native
  // side carries the uuid / angles / contoursSrc accessors the host
  // validator expects; our old hand-built {type:700,…} object missed
  // that plumbing and got rejected with APIError 106), then call
  // replaceElements(notePath, page, [existing..., newElements]) ONCE.
  //
  // Performance: single replaceElements = one host-side fsync instead
  // of one per geometry, cutting insert wall-time from ~80 s (309
  // geometries × ~260 ms/fsync observed on the 08:45 probe run) to
  // ~1–2 s. replaceElements itself is the only disk-touching step;
  // every createElement is bridge-only.
  //
  // Atomicity: replaceElements is all-or-nothing on the host. If it
  // fails, the page is untouched, so there's nothing to clean up —
  // we just re-raise and let the UI layer surface the error banner.
  if (pageCtx.notePath === null || pageCtx.page === null) {
    throw new Error(
      'insertMindmap: resolvePageContext returned null notePath/page; ' +
        'replaceElements requires both',
    );
  }
  // Collect labeled nodes so their text lands inside their outline as
  // a TYPE_TEXT element. Unlabeled nodes contribute outline-only.
  const labeledNodes = collectLabeledNodes(expanded, pageLayout);
  log('collectLabeledNodes:done', {count: labeledNodes.length});

  try {
    log('buildElements:before', {
      geometries: geometries.length,
      labels: labeledNodes.length,
    });
    const newElements = await buildElementsForInsert(
      geometries,
      labeledNodes,
      pageCtx.page,
    );
    log('buildElements:done', {built: newElements.length});

    log('getElements:before');
    const getRes = (await PluginFileAPI.getElements(
      pageCtx.page,
      pageCtx.notePath,
    )) as ApiRes<unknown[]>;
    log('getElements:after', {
      success: getRes?.success,
      errorMessage: getRes?.error?.message,
      existingCount: Array.isArray(getRes?.result)
        ? (getRes?.result as unknown[]).length
        : null,
    });
    if (!getRes?.success || !Array.isArray(getRes.result)) {
      throw new Error(getRes?.error?.message ?? 'getElements failed');
    }
    const existing = getRes.result as unknown[];

    const combined = [...existing, ...newElements];
    log('replaceElements:before', {
      existingCount: existing.length,
      addedCount: newElements.length,
      totalCount: combined.length,
    });
    const replaceRes = (await PluginFileAPI.replaceElements(
      pageCtx.notePath,
      pageCtx.page,
      combined as object[],
    )) as ApiRes<boolean>;
    log('replaceElements:after', {
      success: replaceRes?.success,
      errorCode: (replaceRes?.error as {code?: number} | undefined)?.code,
      errorMessage: replaceRes?.error?.message,
    });
    if (!replaceRes?.success) {
      throw new Error(replaceRes?.error?.message ?? 'replaceElements failed');
    }

    // Force the host to repaint the page with the newly-inserted
    // geometries. reloadFile is non-fatal: its success is cosmetic
    // (the page would repaint on the next interaction anyway), so
    // we log and continue even on failure.
    //
    // NB: shape-snap calls setLassoBoxState(2) before reloadFile,
    // but it does so AFTER an explicit lassoElements (to clear the
    // selection that lasso produced). Our flow never lassos, so the
    // call returns APIError 904 "no lasso action has been performed"
    // — it's meaningless here. Skipped.
    log('reloadFile:before');
    const reloadRes = (await PluginCommAPI.reloadFile()) as ApiRes<boolean>;
    log('reloadFile:after', reloadRes);

    // Dismiss the plugin. NOT awaited — the host's response to
    // closePluginView can be slow on-device, and we don't want the
    // caller's `isInserting` UI state to stay pinned on "Inserting…"
    // while that round-trip settles. sn-shapes's ShapePalette uses
    // the same fire-and-forget pattern for this exact reason
    // (https://github.com/… — see ShapePalette.tsx). Failures are
    // visible via the :after line landing late or not at all.
    log('closePluginView:fire');
    PluginManager.closePluginView().then(
      () => log('closePluginView:after'),
      err =>
        log('closePluginView:threw', {
          message: err instanceof Error ? err.message : String(err),
        }),
    );
  } catch (err) {
    log('catch', {
      message: err instanceof Error ? err.message : String(err),
      stack: err instanceof Error ? err.stack : undefined,
    });
    // replaceElements is atomic, so there is never a partial insert
    // to clean up. The error re-raises unchanged.
    throw err;
  }
}

/**
 * Breakdown of a Geometry[] by its `type` discriminator, used only by
 * the `[INSERT] emitGeometries:done` log line to summarise the emit
 * payload without dumping every point list. Kept next to insertMindmap
 * because it exists purely for diagnostic output — no business logic
 * consumes the shape.
 */
function countByType(geometries: Geometry[]): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const g of geometries) {
    counts[g.type] = (counts[g.type] ?? 0) + 1;
  }
  return counts;
}

/**
 * Specification for a per-node text label landing on the page as a
 * TYPE_TEXT element. `bbox` is the node's outline bbox in page
 * coordinates so the host's text-flow can fit `label` inside the
 * rectangle when it renders.
 */
type LabeledNodeSpec = {
  label: string;
  bbox: Rect;
};

/**
 * Walk every node in the (auto-expanded) tree and collect those that
 * carry a non-empty label. Each entry pairs the label string with its
 * post-fit-to-page bbox so the caller can build a TYPE_TEXT element
 * whose `textRect` matches the node's outline exactly. Unlabeled
 * nodes (label undefined or empty) are skipped silently — they emit
 * outline-only.
 */
function collectLabeledNodes(
  tree: Tree,
  layout: LayoutResult,
): LabeledNodeSpec[] {
  const out: LabeledNodeSpec[] = [];
  for (const node of tree.nodesById.values()) {
    const label = node.label?.trim();
    if (!label) {
      continue;
    }
    const bbox = layout.bboxes.get(node.id);
    if (!bbox) {
      continue;
    }
    out.push({label, bbox});
  }
  return out;
}

/**
 * Pixels of inner padding between a node's outline and its label
 * text rectangle. Keeps the rendered text from kissing the outline
 * edge, which looks tight on e-ink. 8 px on each side is comfortable
 * at the firmware's default text-flow margins.
 */
const TEXT_PADDING_PX = 8;

/**
 * Map a node's bbox height to a font size that looks centred and
 * legible inside the outline. Empirical values: NODE_HEIGHT=96 gives
 * a comfortable ~28 px font; ~bbox.h × 0.32 with a 20–48 clamp keeps
 * smaller fit-to-page-scaled nodes readable without blowing past the
 * outline at large scales.
 */
function fontSizeForBbox(bbox: Rect): number {
  const desired = Math.round(bbox.h * 0.32);
  return Math.max(20, Math.min(48, desired));
}

/**
 * Build one native-backed `Element` per emitted Geometry plus one
 * `Element.TYPE_TEXT` per labeled node, ready to hand to
 * `PluginFileAPI.replaceElements`.
 *
 * Geometry path (mirrors shape-snap):
 *   1. PluginCommAPI.createElement(Element.TYPE_GEO) — the native
 *      side mints a new Element with the `uuid`, `angles` /
 *      `contoursSrc` ElementDataAccessor instances, and the other
 *      internal plumbing the host's validator requires. Our earlier
 *      hand-built `{type:700, uuid, geometry}` objects missed this
 *      plumbing and were rejected with APIError 106.
 *   2. Populate `pageNum` / `layerNum` / `thickness` / `geometry` on
 *      the returned Element. Points are rounded to integers here
 *      (fractional coords are rejected host-side).
 *
 * Text path (one per labeled node):
 *   1. PluginCommAPI.createElement(Element.TYPE_TEXT) — same native
 *      uuid + plumbing.
 *   2. Populate `pageNum` / `layerNum` / `textBox` with the label
 *      text, the node's outline bbox shrunk by TEXT_PADDING_PX as
 *      `textRect`, fontSize derived from bbox height, and centre
 *      alignment.
 *
 * Throws on the first `createElement` failure.
 */
async function buildElementsForInsert(
  geometries: Geometry[],
  labeledNodes: LabeledNodeSpec[],
  page: number,
): Promise<unknown[]> {
  const out: unknown[] = [];
  for (let i = 0; i < geometries.length; i += 1) {
    const geom = geometries[i];
    const res = (await PluginCommAPI.createElement(
      Element.TYPE_GEO,
    )) as ApiRes<Record<string, unknown>>;
    if (!res?.success || !res.result) {
      throw new Error(
        `createElement(geo) failed at index ${i}: ${
          res?.error?.message ?? 'unknown error'
        }`,
      );
    }
    const element = res.result;
    const rounded = roundGeometryPoints(geom);
    element.pageNum = page;
    element.layerNum = 0;
    element.thickness = rounded.penWidth;
    element.geometry = rounded;
    out.push(element);
  }
  for (let i = 0; i < labeledNodes.length; i += 1) {
    const {label, bbox} = labeledNodes[i];
    const res = (await PluginCommAPI.createElement(
      Element.TYPE_TEXT,
    )) as ApiRes<Record<string, unknown>>;
    if (!res?.success || !res.result) {
      throw new Error(
        `createElement(text) failed at index ${i}: ${
          res?.error?.message ?? 'unknown error'
        }`,
      );
    }
    const element = res.result;
    element.pageNum = page;
    element.layerNum = 0;
    element.textBox = {
      textContentFull: label,
      textRect: {
        left: Math.round(bbox.x + TEXT_PADDING_PX),
        top: Math.round(bbox.y + TEXT_PADDING_PX),
        right: Math.round(bbox.x + bbox.w - TEXT_PADDING_PX),
        bottom: Math.round(bbox.y + bbox.h - TEXT_PADDING_PX),
      },
      fontSize: fontSizeForBbox(bbox),
      textAlign: 1, // centre — matches sn-plugin-lib TextBox.textAlign convention
      textBold: 0,
      textItalics: 0,
      textFrameWidthType: 0,
      textFrameStyle: 0,
      textEditable: 0,
    };
    out.push(element);
  }
  return out;
}

/**
 * Round every coordinate in a Geometry's point set (and, for
 * circle/ellipse, the ellipseCenterPoint) to the nearest integer.
 *
 * Used exclusively at the firmware boundary — the emit pipeline and
 * its tests stay in floating-point. This keeps emitGeometries pure
 * and leaves the tolerance-based geometry tests unaffected.
 *
 * Rounded fields:
 *   - polygon.points[*].x/y
 *   - straightLine.points[*].x/y
 *   - circle/ellipse.ellipseCenterPoint.x/y
 *
 * Ellipse radii and angle are left as-is for now: the logcat
 * evidence points at fractional polygon/line point coords as the
 * rejection trigger, and emitGeometries does not emit circles or
 * ellipses today. If the banner reappears after this fix, widening
 * the rounding to radii/angles is the next step.
 */
function roundGeometryPoints(geometry: Geometry): Geometry {
  switch (geometry.type) {
    case 'GEO_polygon':
    case 'straightLine':
      return {
        ...geometry,
        points: geometry.points.map(p => ({
          x: Math.round(p.x),
          y: Math.round(p.y),
        })),
      };
    case 'GEO_circle':
    case 'GEO_ellipse':
      return {
        ...geometry,
        ellipseCenterPoint: {
          x: Math.round(geometry.ellipseCenterPoint.x),
          y: Math.round(geometry.ellipseCenterPoint.y),
        },
      };
  }
}

/**
 * Resolve everything the insert pipeline needs from the host about
 * the current page: page dimensions (for fit-to-page scale), plus
 * notePath + page index used by the replaceElements probe (§F-IN-1).
 * Mirrors the three-step fall-through from sn-shapes:
 * PluginCommAPI.getCurrentFilePath -> getCurrentPageNum ->
 * PluginFileAPI.getPageSize. Any null-ish / failure result at any
 * step, or a thrown exception, returns the Nomad portrait defaults
 * (with notePath/page = null, which the probe treats as "don't
 * attempt"). The per-geometry insertGeometry loop doesn't consume
 * notePath or page — it relies on the firmware's implicit
 * "current page" context — so a null pair still lets the slow path
 * run to completion.
 */
type PageContext = {
  width: number;
  height: number;
  notePath: string | null;
  page: number | null;
};

async function resolvePageContext(): Promise<PageContext> {
  const defaults: PageContext = {
    width: DEFAULT_PAGE_WIDTH,
    height: DEFAULT_PAGE_HEIGHT,
    notePath: null,
    page: null,
  };
  try {
    const pathRes = (await PluginCommAPI.getCurrentFilePath()) as ApiRes<string>;
    const pageRes = (await PluginCommAPI.getCurrentPageNum()) as ApiRes<number>;
    if (
      pathRes?.success &&
      pageRes?.success &&
      typeof pathRes.result === 'string' &&
      typeof pageRes.result === 'number'
    ) {
      const sizeRes = (await PluginFileAPI.getPageSize(
        pathRes.result,
        pageRes.result,
      )) as ApiRes<{width: number; height: number}>;
      if (sizeRes?.success && sizeRes.result) {
        return {
          width: sizeRes.result.width,
          height: sizeRes.result.height,
          notePath: pathRes.result,
          page: pageRes.result,
        };
      }
    }
  } catch {
    // Fall through to defaults.
  }
  return defaults;
}

/**
 * Clone the tree and clear the `collapsed` flag on every node. §8.6
 * commits to "collapse is authoring-only; auto-expand before emit",
 * and §F-IN-2 step 0 reads the emit pass against the fully-expanded
 * tree. We work on a clone so the caller's canvas state — including
 * the user's collapse choices — is untouched when the insert either
 * succeeds (we immediately close the plugin view) or fails (the user
 * returns to the canvas and expects their collapse state back).
 */
function autoExpand(tree: Tree): Tree {
  const next = cloneTree(tree);
  for (const node of next.nodesById.values()) {
    node.collapsed = false;
  }
  return next;
}

/**
 * Uniform fit-to-page scale per §F-LY-6. Always ≤ 1: the requirement
 * scales DOWN only ("if the laid-out map is wider than the note
 * page"). Returns 1 when the map already fits — the page-centering
 * translation still applies at scale=1 so the map lands centered.
 */
function computeFitScale(
  unionBbox: Rect,
  pageW: number,
  pageH: number,
  margin: number,
): number {
  const availW = Math.max(1, pageW - 2 * margin);
  const availH = Math.max(1, pageH - 2 * margin);
  const needW = Math.max(1, unionBbox.w);
  const needH = Math.max(1, unionBbox.h);
  return Math.min(1, availW / needW, availH / needH);
}

/**
 * Scale the layout by `scale` around the origin, then translate so
 * the union bbox sits centered on the page. Returns a fully-populated
 * LayoutResult that emitGeometries can consume without any further
 * coordinate math.
 *
 * Scaling applies to centers, bboxes (including w/h), and unionBbox,
 * per §F-LY-6 — which also notes that preserved label strokes pass
 * through unscaled. We don't handle strokes here; the caller is
 * expected to pre-translate them before handing them to insertMindmap.
 */
function transformLayout(
  layout: LayoutResult,
  scale: number,
  pageW: number,
  pageH: number,
): LayoutResult {
  const scaledU: Rect = {
    x: layout.unionBbox.x * scale,
    y: layout.unionBbox.y * scale,
    w: layout.unionBbox.w * scale,
    h: layout.unionBbox.h * scale,
  };
  const tx = pageW / 2 - (scaledU.x + scaledU.w / 2);
  const ty = pageH / 2 - (scaledU.y + scaledU.h / 2);

  const centers = new Map<NodeId, {x: number; y: number}>();
  for (const [id, c] of layout.centers) {
    centers.set(id, {x: c.x * scale + tx, y: c.y * scale + ty});
  }
  const bboxes = new Map<NodeId, Rect>();
  for (const [id, r] of layout.bboxes) {
    bboxes.set(id, {
      x: r.x * scale + tx,
      y: r.y * scale + ty,
      w: r.w * scale,
      h: r.h * scale,
    });
  }
  return {
    centers,
    bboxes,
    unionBbox: {
      x: scaledU.x + tx,
      y: scaledU.y + ty,
      w: scaledU.w,
      h: scaledU.h,
    },
  };
}

