/**
 * High-level insert flow (§5.3, §F-IN-1..F-IN-5; §F-ED-7 on re-insert).
 *
 * First-insert sequence:
 *   1. resolvePageSize() — the three-step fall-through from
 *      sn-shapes/src/ShapePalette.tsx via PluginCommAPI
 *      getCurrentFilePath -> getCurrentPageNum -> PluginFileAPI
 *      getPageSize, with defaults if any step fails (§F-IN-1).
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
 *   6. Insert via PluginCommAPI.insertGeometry one-at-a-time. We do
 *      NOT batch via PluginFileAPI.insertElements yet — §F-IN-3
 *      flags it as a future path ("when stable"), and a partial
 *      sequential failure is easier to clean up (we know exactly how
 *      many geometries went in).
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
import {emitGeometries} from './rendering/emitGeometries';

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
 * Local narrow type for sn-plugin-lib responses. The SDK declares its
 * methods as returning the generic `Object` type, so TS doesn't know
 * about the `{success, result}` envelope the firmware actually
 * returns. Same shape as sn-shapes/src/ShapePalette.tsx.
 */
type ApiRes<T> =
  | {success: boolean; result?: T; error?: {message?: string}}
  | null
  | undefined;

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
  const {width: pageWidth, height: pageHeight} = await resolvePageSize();

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

  // §F-IN-3 — sequential insertGeometry with showLassoAfterInsert
  // forced to false on every geometry (done inside emitGeometries).
  // We track the count so cleanup on mid-insert failure only tries
  // to reclaim the geometries that actually made it onto the page.
  let insertedCount = 0;
  try {
    for (const geometry of geometries) {
      const res = (await PluginCommAPI.insertGeometry(
        geometry,
      )) as ApiRes<boolean>;
      if (!res?.success) {
        throw new Error(res?.error?.message ?? 'insertGeometry failed');
      }
      insertedCount += 1;
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
    // actually landed on the page; a failed resolvePageSize or a
    // zeroth-geometry failure leaves the page untouched and there's
    // nothing to clean up.
    if (insertedCount > 0) {
      await attemptCleanup(geometries.slice(0, insertedCount));
    }
    throw err;
  }
}

/**
 * Resolve the current note page's dimensions via the §F-IN-1
 * three-step fall-through. Mirrors sn-shapes/src/ShapePalette.tsx
 * verbatim: any null-ish/failure result at any step, or a thrown
 * exception at any step, returns the Nomad portrait defaults.
 */
async function resolvePageSize(): Promise<{width: number; height: number}> {
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
        return sizeRes.result;
      }
    }
  } catch {
    // Fall through to defaults.
  }
  return {width: DEFAULT_PAGE_WIDTH, height: DEFAULT_PAGE_HEIGHT};
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
 */
function toLassoBounds(rect: Rect): {
  left: number;
  top: number;
  right: number;
  bottom: number;
} {
  return {
    left: rect.x,
    top: rect.y,
    right: rect.x + rect.w,
    bottom: rect.y + rect.h,
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
  if (inserted.length === 0) {
    return;
  }
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

/**
 * Axis-aligned bounding rectangle of every geometry's points. Used
 * by the cleanup path for the partial insert subset, where we can't
 * reuse emitGeometries' unionRect (that one covers the full set). The
 * logic is a duplicate of the similarly-named helper inside
 * emitGeometries, kept local so the cleanup path doesn't reach into
 * another module's private helpers.
 */
function unionRectOfGeometries(geometries: Geometry[]): Rect {
  if (geometries.length === 0) {
    return {x: 0, y: 0, w: 0, h: 0};
  }
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;

  const extend = (x: number, y: number): void => {
    if (x < minX) {
      minX = x;
    }
    if (y < minY) {
      minY = y;
    }
    if (x > maxX) {
      maxX = x;
    }
    if (y > maxY) {
      maxY = y;
    }
  };

  for (const g of geometries) {
    switch (g.type) {
      case 'GEO_polygon':
      case 'straightLine': {
        for (const p of g.points) {
          extend(p.x, p.y);
        }
        break;
      }
      case 'GEO_circle':
      case 'GEO_ellipse': {
        const c = g.ellipseCenterPoint;
        const r = Math.max(
          g.ellipseMajorAxisRadius,
          g.ellipseMinorAxisRadius,
        );
        extend(c.x - r, c.y - r);
        extend(c.x + r, c.y + r);
        break;
      }
      default: {
        const _exhaustive: never = g;
        throw new Error(
          `insert.unionRectOfGeometries: unknown geometry variant ${
            (_exhaustive as {type: string}).type
          }`,
        );
      }
    }
  }

  if (minX === Infinity) {
    return {x: 0, y: 0, w: 0, h: 0};
  }
  return {x: minX, y: minY, w: maxX - minX, h: maxY - minY};
}
