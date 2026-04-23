/**
 * High-level insert flow (§5.3, §F-IN-1..F-IN-5; §F-ED-7 on re-insert).
 *
 * First-insert sequence:
 *   1. resolvePageContext() — the three-step fall-through from
 *      sn-shapes/src/ShapePalette.tsx via PluginCommAPI
 *      getCurrentFilePath -> getCurrentPageNum -> PluginFileAPI
 *      getPageSize. Also captures notePath + page for the batched
 *      insertElements fast path (§F-IN-3). Defaults kick in if any
 *      step fails (§F-IN-1).
 *   2. Auto-expand every subtree in the tree so no node is hidden
 *      at emit time (§F-IN-2 / §8.6).
 *   3. Run radial layout (./layout/radial.ts).
 *   4. Fit-to-page scale if wider than the page (§F-LY-6). Applies
 *      to node positions and outline dimensions; preserved label
 *      strokes on re-insert are TRANSLATED, not scaled, so they pass
 *      through the scale step untouched.
 *   5. Emit geometries via ./rendering/emitGeometries.ts — outlines,
 *      connectors, marker, and on re-insert preserved label strokes.
 *      Every emission sets showLassoAfterInsert: false (§F-IN-3).
 *   6. Insert every geometry as a single batched
 *      PluginFileAPI.insertElements call (§F-IN-3). Each emitted
 *      Geometry is wrapped as an Element of TYPE_GEO (700). The
 *      batched path is massively faster than sequential
 *      insertGeometry calls — the marker alone emits ~2500 per-bit
 *      straight-lines and a per-geometry loop stalls the plugin for
 *      tens of seconds on device (the user sees this as "Insert
 *      hangs after the mindmap appears"). If the note context is
 *      unavailable (resolvePageContext fell through to defaults) we
 *      fall back to sequential PluginCommAPI.insertGeometry so the
 *      code still works in environments where the file bridge hasn't
 *      been wired up.
 *   7. Call PluginCommAPI.lassoElements(unionRect) explicitly to
 *      auto-select the whole block (§F-IN-3 / §11).
 *   8. PluginManager.closePluginView() to dismiss (§F-IN-4).
 *
 * Re-insert (Save) sequence — triggered by an optional `preEdit`
 * context on InsertInput (§F-ED-7):
 *   0. After resolving page size, call
 *      PluginCommAPI.deleteLassoElements() to remove the previously-
 *      inserted mindmap from the page. EditMindmap enters through the
 *      lasso-toolbar "Edit Mindmap" entry, so the firmware's lasso is
 *      already wrapped around the old block — a single
 *      deleteLassoElements clears the whole thing (outlines,
 *      connectors, marker bits, and preserved label strokes).
 *   2a. After step 4's fit-to-page, compute per-node MOVE DELTA:
 *           delta = postEditPageBbox.topLeft - preEditPageBbox.topLeft
 *       for every node present in BOTH the pre-edit and post-edit
 *       layouts. Strokes for nodes that exist only pre-edit (deleted
 *       subtree) are dropped; nodes that exist only post-edit (new
 *       Add Child / Add Sibling) have no strokes to translate.
 *   2b. translateStrokes(bucket, delta) for each surviving bucket.
 *       Rigid translation only — no scale, rotate, or resample
 *       (§F-LY-6, §8.1). This preserves every stroke's original pen
 *       style and point list, modulo the coordinate shift.
 *   5. Hand the translated bucket to emitGeometries as the existing
 *      preservedStrokesByNode param. The remaining insert / lasso /
 *      close steps run unchanged.
 *
 * Error handling (§F-IN-5): on any failure after one or more
 * geometries have been inserted, best-effort cleanup by lassoing the
 * partial union rect and calling deleteLassoElements before
 * re-raising to the UI. Cleanup failures are swallowed — the original
 * error is what the user needs to act on, and manual cleanup is
 * acceptable for v0.1.
 *
 * Save-specific failure modes:
 *   - deleteLassoElements (step 0) failure aborts the whole save
 *     before any new geometry lands on the page, so no cleanup is
 *     needed and the user's old mindmap stays intact.
 *   - Any failure during the post-delete insert loop leaves the page
 *     in a mixed state: the old mindmap has been removed, and the
 *     partial new emit is cleaned up by the standard §F-IN-5 path.
 *     v0.1 accepts that the user may see an empty page and need to
 *     undo; we do not attempt to restore the original strokes.
 */
import {PluginCommAPI, PluginFileAPI, PluginManager} from 'sn-plugin-lib';

import type {Geometry, Rect} from './geometry';
import type {LayoutResult} from './layout/radial';
import {radialLayout} from './layout/radial';
import {translateStrokes, type StrokeBucket} from './model/strokes';
import {cloneTree, type NodeId, type Tree} from './model/tree';
import {emitGeometries, unionRectOfGeometries} from './rendering/emitGeometries';
import type {ApiRes} from './pluginApi';

/**
 * Nomad portrait defaults, mirrored from sn-shapes/src/ShapePalette.tsx.
 * Exported so the insert button and tests share the same constant.
 */
export const DEFAULT_PAGE_WIDTH = 1404;
export const DEFAULT_PAGE_HEIGHT = 1872;

/**
 * Margin on each side of the page preserved by the fit-to-page
 * scaler (§F-LY-6). 80 px matches the requirements' default and
 * leaves visible room for handwritten labels that extend slightly
 * past a node's outline.
 */
export const INSERT_MARGIN_PX = 80;

/**
 * Firmware Element-type code for a Geometry record
 * (Element.TYPE_GEO == 700; see sn-plugin-lib's Element.d.ts). We
 * re-declare it locally rather than importing the runtime Element
 * class so unit tests can exercise the batched path without pulling
 * the whole ElementDataAccessor/native-cache machinery into jsdom.
 */
export const ELEMENT_TYPE_GEO = 700;

/**
 * Pre-edit context needed to translate preserved label strokes from
 * the pre-edit layout into the post-edit layout's coordinates on
 * Save. Supplied by EditMindmap on the §F-ED-7 round-trip — the
 * plugin holds neither the pre-edit layout nor the strokes outside
 * edit mode, so everything insertMindmap needs to reconstruct the
 * move delta lives in this bundle.
 *
 * - `preEditPageBboxes`: where each node WAS in page coords (decoder
 *   nodeBboxesById shifted by markerOriginPage), keyed by the
 *   decoder's post-decode NodeId.
 * - `strokesByNodePage`: associateStrokes output in PAGE coords —
 *   each stroke lives at its original pen-captured page coordinate.
 *   Not pre-translated by the caller; insertMindmap applies the
 *   delta internally so the cross-coord-system knowledge stays in
 *   one place (§F-ED-7).
 */
export type PreEditContext = {
  preEditPageBboxes: Map<NodeId, Rect>;
  strokesByNodePage: StrokeBucket;
};

export type InsertInput = {
  tree: Tree;
  /**
   * Only supplied on re-insert from edit mode (§F-ED-7). Present →
   * insertMindmap:
   *   1. Calls PluginCommAPI.deleteLassoElements() right after
   *      page-size resolution to clear the pre-edit mindmap from
   *      the page (the lasso is already wrapped around it, courtesy
   *      of the "Edit Mindmap" entry point).
   *   2. Computes a per-node move delta
   *        postEditPageBbox.topLeft − preEditPageBbox.topLeft
   *      for every node in both the pre-edit and post-edit layouts.
   *   3. Translates each node's stroke bucket by its delta (rigid —
   *      no scaling, §F-LY-6).
   *   4. Drops strokes for nodes that no longer exist in the
   *      post-edit tree (the user deleted a subtree). Strokes for
   *      newly-added nodes never existed pre-edit, so there's
   *      nothing to translate for them either.
   *   5. Hands the translated bucket to emitGeometries via the same
   *      preservedStrokesByNode path the first-insert flow has
   *      always supported (the first-insert flow just always passes
   *      `undefined`).
   *
   * Undefined → first-insert. The plugin never owns labels at
   * initial authoring (§F-IN-2 step 3).
   */
  preEdit?: PreEditContext;
};

/**
 * Run the full insert flow. Resolves when the plugin view has been
 * dismissed by closePluginView(). Rejects on any unrecoverable
 * error, after best-effort cleanup (§F-IN-5).
 */
export async function insertMindmap(input: InsertInput): Promise<void> {
  const pageCtx = await resolvePageContext();
  const {width: pageWidth, height: pageHeight} = pageCtx;

  // §F-ED-7 step 0 — re-insert path only. Delete the pre-edit
  // mindmap from the page BEFORE we start emitting the new one. The
  // "Edit Mindmap" entry leaves the lasso wrapped around the old
  // block, so a single deleteLassoElements reclaims everything
  // (outlines, connectors, marker strokes, preserved label strokes).
  // Done before layout/emit so a failure here leaves the old mindmap
  // intact and we can throw cleanly — no partial state to clean up.
  if (input.preEdit !== undefined) {
    const delRes = (await PluginCommAPI.deleteLassoElements()) as ApiRes<boolean>;
    if (!delRes?.success) {
      throw new Error(
        delRes?.error?.message ?? 'deleteLassoElements failed',
      );
    }
  }

  // §F-IN-2 step 0 — auto-expand every subtree so the layout + emit
  // passes see the fully expanded tree. We clone so the caller's
  // reference is untouched (collapse is an authoring-time UI state
  // and the user expects to return to the canvas with their collapse
  // choices intact if the insert fails).
  const expanded = autoExpand(input.tree);

  // §F-LY-1..F-LY-3 — radial layout in mindmap-local coords (root at
  // origin). The emit step needs bboxes for outlines and centers for
  // connector endpoints, and §F-IN-3 needs the union-rect for the
  // post-insert lasso.
  const baseLayout = radialLayout(expanded);

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

  // §F-ED-7 — compute post-edit stroke bucket. For first-insert this
  // is undefined (the plugin doesn't own labels at authoring time).
  // For Save, we translate every pre-edit bucket by its node's move
  // delta; nodes deleted in this edit session drop out silently.
  const preservedStrokesByNode =
    input.preEdit === undefined
      ? undefined
      : translateStrokesForSave(input.preEdit, pageLayout.bboxes);

  // §F-IN-2 — assemble the geometry list (outlines, connectors,
  // marker, preserved strokes on re-insert).
  //
  // §F-PE-4: emitGeometries calls encodeMarker, which throws
  // MarkerCapacityError when the tree exceeds MARKER_PUBLISHED_NODE_CAP.
  // We let that error propagate verbatim — the UI layer (MindmapCanvas)
  // catches it and surfaces the capacity modal. Nothing is on the page
  // yet at this point, so there is no cleanup to do; the general
  // try/catch below only wraps the per-geometry insertion loop that
  // follows.
  const {geometries, unionRect} = emitGeometries({
    tree: expanded,
    layout: pageLayout,
    preservedStrokesByNode,
  });

  // §F-IN-3 — hand every emitted geometry to the firmware. Two
  // paths:
  //   - Fast path (preferred): when we successfully resolved the
  //     current note's path and page, wrap every Geometry as an
  //     Element of TYPE_GEO (700) and call PluginFileAPI.insertElements
  //     once. This is a SINGLE RPC to the native side regardless of
  //     how many geometries the emit produced. Essential for the
  //     marker payload, which alone is ~2500 per-bit straightLines —
  //     a sequential loop there stalls the plugin by tens of seconds
  //     on device (each insertGeometry over the JS-to-native bridge
  //     costs ~200–300 ms wall clock, per the 21:20 session in the
  //     Nomad logcat).
  //   - Fallback: if no note context is available (e.g. the
  //     three-step chain in resolvePageContext fell through to
  //     defaults, or a future unit test runs without mocking the
  //     file bridge), use the original per-geometry insertGeometry
  //     loop. It's slow but semantically equivalent, and keeps
  //     resolvePageContext's defaults path working.
  // On success, `insertedCount` is set to the full geometry count so
  // the cleanup path has the full list if lassoElements fails next.
  // The fast path either inserts everything atomically or nothing,
  // which matches the semantics insertElements provides on device.
  let insertedCount = 0;
  try {
    if (pageCtx.notePath !== null && pageCtx.page !== null) {
      const elements = geometries.map(wrapGeometryAsElement);
      const res = (await PluginFileAPI.insertElements(
        pageCtx.notePath,
        pageCtx.page,
        elements,
      )) as ApiRes<boolean>;
      if (!res?.success) {
        throw new Error(res?.error?.message ?? 'insertElements failed');
      }
      insertedCount = geometries.length;
    } else {
      for (const geometry of geometries) {
        const res = (await PluginCommAPI.insertGeometry(
          roundGeometryPoints(geometry),
        )) as ApiRes<boolean>;
        if (!res?.success) {
          throw new Error(res?.error?.message ?? 'insertGeometry failed');
        }
        insertedCount += 1;
      }
    }

    // §F-IN-3 — single explicit lasso call over the union rect of
    // every geometry we emitted. The firmware's per-geometry
    // auto-lasso doesn't stack across a batch, so this is what makes
    // the whole block show up as a single selection.
    const lassoRes = (await PluginCommAPI.lassoElements(
      toLassoBounds(unionRect),
    )) as ApiRes<boolean>;
    if (!lassoRes?.success) {
      throw new Error(lassoRes?.error?.message ?? 'lassoElements failed');
    }

    // §F-IN-4 — dismiss the plugin. Awaited so the promise chain
    // accurately represents "insert complete" to the caller, even
    // though sn-shapes's ShapePalette doesn't await the same call
    // (it fires and forgets inside a React event handler).
    await PluginManager.closePluginView();
  } catch (err) {
    // §F-IN-5 — best-effort cleanup. Only attempted when something
    // actually landed on the page; a failed resolvePageContext or a
    // zeroth-geometry failure leaves the page untouched and there's
    // nothing to clean up.
    if (insertedCount > 0) {
      await attemptCleanup(geometries.slice(0, insertedCount));
    }
    throw err;
  }
}

/**
 * Wrap a Geometry into the Element envelope that
 * PluginFileAPI.insertElements expects (type = TYPE_GEO / 700,
 * geometry = the original record). The firmware tolerates unknown
 * fields (`allowUnknown: true` in sn-plugin-lib's ElementSchema),
 * so we don't have to mint uuids or fill the stroke/contours
 * accessors here — the native side generates those when the element
 * lands.
 *
 * `showLassoAfterInsert` is carried through from the geometry
 * (emitGeometries sets it to false on every entry, §F-IN-3), so the
 * batched insert does not auto-lasso individual elements — the
 * plugin's single explicit lassoElements call is what selects the
 * whole block post-insert.
 *
 * The geometry's point coordinates are rounded to integers at this
 * boundary (see roundGeometryPoints) because the native firmware
 * surfaces a "Invalid API parameters. Cannot call the API. Please
 * check parameter validity!" toast and aborts insertPageTrails when
 * point coordinates arrive as floats. sn-plugin-lib's JS-side
 * GeometrySchema does NOT require integer x/y (PointSchema only
 * enforces `{x: number, y: number}` with no integer flag), so
 * fractional coords pass JS validation but are rejected host-side
 * in com.ratta.supernote.note. Radial layout (Math.cos/Math.sin)
 * and roundedRectPoints corner sampling both produce fractional
 * coords, so the rounding pass is required on every emission.
 */
function wrapGeometryAsElement(geometry: Geometry): {
  type: number;
  geometry: Geometry;
} {
  return {type: ELEMENT_TYPE_GEO, geometry: roundGeometryPoints(geometry)};
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
 * Resolve everything insertMindmap needs to know about the current
 * page: its dimensions (for fit-to-page scale), its file path and
 * page index (for the batched PluginFileAPI.insertElements call).
 *
 * Mirrors the three-step fall-through from sn-shapes verbatim for
 * the dimensions — any null-ish/failure result at any step, or a
 * thrown exception, returns the Nomad portrait defaults. When the
 * note context is unavailable (path / page / size unresolvable), we
 * still return dimensions-only with `notePath: null` and
 * `page: null` so the caller falls back to the slower per-geometry
 * insertGeometry loop (which only needs the firmware's implicit
 * "current page" context via PluginCommAPI, not an explicit path).
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
      const notePath = pathRes.result;
      const page = pageRes.result;
      const sizeRes = (await PluginFileAPI.getPageSize(
        notePath,
        page,
      )) as ApiRes<{width: number; height: number}>;
      if (sizeRes?.success && sizeRes.result) {
        return {
          width: sizeRes.result.width,
          height: sizeRes.result.height,
          notePath,
          page,
        };
      }
    }
  } catch {
    // Fall through to defaults.
  }
  return defaults;
}

/**
 * §F-ED-7 — per-node stroke translation for Save.
 *
 * Given the pre-edit page bboxes and stroke buckets carried over from
 * EditMindmap, plus the FRESH post-edit page bboxes computed by
 * transformLayout, produce a new bucket whose strokes live in
 * post-edit page coordinates.
 *
 * Algorithm:
 *   For every (nodeId, strokes) in preEdit.strokesByNodePage:
 *     - look up preEditBbox for that id → if missing, drop bucket.
 *       Missing pre-edit bbox is a decoder-vs-associator mismatch that
 *       shouldn't happen in practice but isn't worth crashing over.
 *     - look up postEditBbox for that id → if missing, drop bucket.
 *       This is the "user deleted this subtree during edit" case. The
 *       strokes simply go with the node (§F-ED-7 doesn't specify an
 *       orphan destination and there isn't a sensible one — the node
 *       is gone, so its labels go with it).
 *     - delta = postEditBbox.topLeft − preEditBbox.topLeft.
 *     - translateStrokes(strokes, delta) → post-edit page coords.
 *
 * Pure function — preEdit and the post-edit bbox map are untouched;
 * translateStrokes itself never mutates inputs. Stable iteration
 * order: the returned Map preserves insertion order from
 * preEdit.strokesByNodePage, which was built in the decoder's BFS
 * order (so tests and logs can rely on a deterministic layout).
 *
 * Newly-added nodes never appear as keys in preEdit.strokesByNodePage
 * because strokes came from the pre-edit lasso; they therefore end up
 * with no preserved strokes automatically, which is the right
 * behavior — the user hasn't written any labels for them yet.
 */
function translateStrokesForSave(
  preEdit: PreEditContext,
  postEditPageBboxes: Map<NodeId, Rect>,
): StrokeBucket {
  const out: StrokeBucket = new Map();
  for (const [id, strokes] of preEdit.strokesByNodePage) {
    const pre = preEdit.preEditPageBboxes.get(id);
    const post = postEditPageBboxes.get(id);
    if (!pre || !post) {
      // Either a decoder/associator mismatch (pre missing) or the
      // node was deleted in this edit session (post missing). Drop
      // the bucket silently — §F-ED-7 has no restoration path for
      // deleted subtrees' labels, and a hard error here would
      // block every Save whose user deleted anything.
      continue;
    }
    const delta = {x: post.x - pre.x, y: post.y - pre.y};
    out.set(id, translateStrokes(strokes, delta));
  }
  return out;
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

/**
 * Translate the plugin's Rect format (x/y/w/h) into the firmware's
 * lasso-bounds format (left/top/right/bottom). Exposed as a free
 * function so the cleanup path can reuse it without re-deriving the
 * conversion.
 *
 * The firmware's RectSchema (sn-plugin-lib VerifyUtils) requires all
 * four fields to be integers and rejects floats with APIError(107)
 * ("must be an integer"), which surfaces in the UI as "invalid
 * parameters sent to the API". Upstream geometry — radial layout
 * centers (Math.cos/Math.sin) and rounded-corner polygon vertices
 * (roundedRectPoints) — is inherently fractional, so we floor/ceil
 * here to produce the smallest integer rect that still encloses the
 * union. Widening by <1 unit has no user-visible effect because the
 * firmware canvas resolution is in the thousands per side.
 */
function toLassoBounds(rect: Rect): {
  left: number;
  top: number;
  right: number;
  bottom: number;
} {
  return {
    left: Math.floor(rect.x),
    top: Math.floor(rect.y),
    right: Math.ceil(rect.x + rect.w),
    bottom: Math.ceil(rect.y + rect.h),
  };
}

/**
 * §F-IN-5 — best-effort cleanup. Lasso the rectangle covering every
 * geometry that was successfully inserted, then call
 * deleteLassoElements. Failures at either step are swallowed: the
 * user will see the original insertGeometry error and can use the
 * firmware's undo action (the "undo" chevron in the standard note
 * toolbar) to back out anything this cleanup couldn't reclaim.
 */
async function attemptCleanup(inserted: Geometry[]): Promise<void> {
  const partial = unionRectOfGeometries(inserted);
  try {
    const lassoRes = (await PluginCommAPI.lassoElements(
      toLassoBounds(partial),
    )) as ApiRes<boolean>;
    if (lassoRes?.success) {
      await PluginCommAPI.deleteLassoElements();
    }
  } catch {
    // Swallow. Original error in the caller is what the user needs
    // to see; §F-IN-5 explicitly permits manual cleanup for v0.1.
  }
}

