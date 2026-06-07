/**
 * High-level insert flow (§5.3, §F-IN-1..F-IN-5; concept-map branch
 * §14.6 / §F-IN-DAG-1..2).
 *
 * Two public entry points share one mode-agnostic tail (finalizeInsert):
 *   - insertMindmap({tree})    — auto-expands the tree, radialLayout.
 *   - insertConceptMap({graph}) — NO auto-expand (a DAG has no collapse
 *                                 state, §F-IN-DAG-2), forceDirectedLayout.
 * Each builds a base (mode-local) layout, then hands finalizeInsert an
 * `emit` callback (emitGeometries vs emitConceptGeometries) and a
 * `collectLabels` callback so the shared tail never branches on mode.
 *
 * Per-entry steps:
 *   1. resolvePageContext() — getCurrentFilePath → getCurrentPageNum →
 *      PluginFileAPI.getPageSize. Required for the additive
 *      insertElements write; any failure in the chain returns null
 *      notePath/page, which finalizeInsert rejects with a clear error
 *      (the additive path can't operate without a concrete notePath/page).
 *   2. Build the base layout (radial for mindmap; force-directed for
 *      concept), in mode-local coords.
 *
 * Shared tail (finalizeInsert):
 *   3. Overlap-aware placement (§F-IN-3 / RA-2). Read existing content's
 *      extent (Element maxX/maxY, read-only) and choose a placement
 *      region: the empty band BELOW existing content, else to the RIGHT,
 *      else the whole page. This keeps the auto-lasso (step 7) from
 *      grabbing the user's existing ink.
 *   4. Fit-to-page scale (≤ 1) to the chosen region minus
 *      INSERT_MARGIN_PX, then translate so the map is centered WITHIN
 *      that region (§F-LY-6).
 *   5. emit (via the caller's callback) → connectors + node outlines.
 *      Mindmap: tree connectors (+ the gray DAG cross-edge overlay).
 *      Concept: one black connector per parent edge, no arrowheads
 *      (§F-LY-DAG-5). No marker / preserved strokes — insert-only.
 *   6. For each emitted geometry + each labeled node:
 *      PluginCommAPI.createElement(TYPE_GEO / TYPE_TEXT) to mint a
 *      native-backed Element, then ONE additive
 *      PluginFileAPI.insertElements call with just the new elements. The
 *      page's pre-existing elements are neither read nor sent — the
 *      insert ADDS the map and leaves existing content untouched
 *      (I-NDI-1/I-NDI-2). One host-side fsync (vs. one per geometry) is
 *      what makes the insert finish in ~1 s instead of ~80 s (I-NDI-3).
 *   7. reloadFile() THEN lassoElements(unionRect + LASSO_HALO_PX). Order
 *      matters: insertElements commits the elements but the rendered page
 *      doesn't include them until reloadFile re-reads it, so a lasso
 *      before reload matches nothing (and a reload after a lasso would
 *      clear the selection). The lasso PERSISTS (we do NOT
 *      setLassoBoxState(2)) so the freshly inserted map is grab-ready.
 *   8. PluginManager.closePluginView() (fire-and-forget) to dismiss.
 *
 * Error handling: the user's existing content is never at risk because
 * it is never read or sent — only the new map elements are passed to
 * insertElements. A partial NEW-element insert (some geometries applied,
 * then a mid-list failure) is theoretically possible and is a documented
 * follow-up (RA-3); it is NOT inherited atomicity. On failure we throw
 * and let the UI surface the banner.
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
import {forceDirectedLayout} from './layout/forceDirected';
import {cloneTree, type NodeId, type Tree} from './model/tree';
import type {Graph} from './model/graph';
import {
  emitConceptGeometries,
  emitGeometries,
} from './rendering/emitGeometries';
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

/**
 * Halo (px) added on every side of the union rect when auto-lassoing
 * the inserted block (§F-IN-3). A lasso rect that exactly hugs the
 * union bounds can miss strokes sitting on the boundary, so we expand
 * slightly to make sure every emitted geometry is captured. Mirrors the
 * 16 px halo an earlier on-device probe run used.
 */
export const LASSO_HALO_PX = 16;

/**
 * Gap (px) left between the user's existing content and the inserted
 * map when placing it in empty space (§F-IN-3 / RA-2). Big enough that
 * the map's auto-lasso rectangle clears the existing ink so a drag
 * doesn't grab it.
 */
export const CONTENT_GAP_PX = 80;

/**
 * Minimum usable size (px) an empty band must have (below or to the
 * right of existing content) for the map to be placed there instead of
 * page-centered. Below this, the map would be scaled too small to be
 * legible, so we fall back to centering on the whole page (accepting
 * possible overlap on a near-full page).
 */
export const MIN_PLACEMENT_BAND_PX = 600;

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

  // Shared placement + write tail. The mindmap path emits via
  // emitGeometries over the expanded tree and collects labels from it;
  // the rest (placement, fit-to-page, additive write, lasso, close) is
  // mode-agnostic (see finalizeInsert).
  await finalizeInsert({
    pageCtx,
    baseLayout,
    context: 'insertMindmap',
    emit: pageLayout => {
      const out = emitGeometries({tree: expanded, layout: pageLayout});
      log('emitGeometries:done', {
        total: out.geometries.length,
        byType: countByType(out.geometries),
        edgeCount: expanded.crossEdges.length,
        unionRect: out.unionRect,
      });
      return out;
    },
    collectLabels: pageLayout => collectLabeledNodes(expanded, pageLayout),
  });
}

export type InsertConceptInput = {
  graph: Graph;
};

/**
 * Run the full insert flow for a concept-map (DAG), §14.6. Sibling to
 * insertMindmap, sharing the mode-agnostic placement + write tail
 * (finalizeInsert). Two concept-specific differences (§F-IN-DAG-1/2):
 *   - layout via forceDirectedLayout instead of radialLayout, and
 *   - NO auto-expand pass (a Graph has no collapse state, §F-IN-DAG-2).
 * The geometry list comes from emitConceptGeometries (one connector per
 * parent edge); labels are collected by walking the graph's nodes.
 *
 * Resolves when the plugin view has been dismissed by closePluginView().
 * Rejects on any unrecoverable error.
 */
export async function insertConceptMap(
  input: InsertConceptInput,
): Promise<void> {
  log('enter', {
    nodeCount: input.graph.nodesById.size,
    rootId: input.graph.rootId,
  });

  log('resolvePageContext:before');
  const pageCtx = await resolvePageContext();
  log('resolvePageContext:after', pageCtx);

  // §F-IN-DAG-2 — NO auto-expand: the concept graph has no collapse
  // state. Force-directed layout in concept-map-local coords.
  const baseLayout = forceDirectedLayout(input.graph);
  log('forceDirectedLayout:done', {
    unionBbox: baseLayout.unionBbox,
    centers: baseLayout.centers.size,
    bboxes: baseLayout.bboxes.size,
  });

  await finalizeInsert({
    pageCtx,
    baseLayout,
    context: 'insertConceptMap',
    emit: pageLayout => {
      const out = emitConceptGeometries({graph: input.graph, layout: pageLayout});
      log('emitConceptGeometries:done', {
        total: out.geometries.length,
        byType: countByType(out.geometries),
        unionRect: out.unionRect,
      });
      return out;
    },
    collectLabels: pageLayout =>
      collectGraphLabeledNodes(input.graph, pageLayout),
  });
}

/**
 * The mode-agnostic insert tail shared by insertMindmap and
 * insertConceptMap (§F-IN-3 / RA-2). Given a resolved page context and a
 * base (mindmap- or concept-local) layout, it performs overlap-aware
 * placement, fit-to-page scaling, the emit (via the caller's `emit`
 * callback against the transformed layout), the single additive
 * insertElements write, reload, and the persistent auto-lasso, then
 * fire-and-forget closes the plugin view.
 *
 * `emit` and `collectLabels` are callbacks taking the FINAL page-space
 * layout so each mode supplies its own geometry + label collection
 * without duplicating the placement/write/lasso machinery. `context`
 * names the caller for the null page-context error message.
 */
type FinalizeInsertInput = {
  pageCtx: PageContext;
  baseLayout: LayoutResult;
  context: string;
  emit: (pageLayout: LayoutResult) => {geometries: Geometry[]; unionRect: Rect};
  collectLabels: (pageLayout: LayoutResult) => LabeledNodeSpec[];
};

async function finalizeInsert({
  pageCtx,
  baseLayout,
  context,
  emit,
  collectLabels,
}: FinalizeInsertInput): Promise<void> {
  const {width: pageWidth, height: pageHeight} = pageCtx;

  // Overlap-aware placement (§F-IN-3 / RA-2). The firmware lasso is
  // rectangle-only — there is no "select these elements" API — so an
  // auto-lasso of a map placed ON TOP of existing ink would also grab
  // that ink, and dragging the map would drag the user's notes. To
  // avoid it we place the map in EMPTY space: read the existing
  // content's extent and drop the map into the band below — or, failing
  // that, to the right of — all existing content, falling back to the
  // whole page (centered) when the page is too full to fit a band.
  //
  // The extent MUST be in the same page-pixel space as the map we place
  // and the lasso rect we later send. getElements' maxX/maxY are in the
  // firmware's NATIVE stroke (EMR) space — ~6-11x the page (an on-device
  // trace read 21632x16224 against a 1920x2560 page) — so comparing them
  // to the pixel page made every band compute negative and the map
  // always landed centered ON TOP of the ink. Instead we let the
  // firmware do the EMR->pixel conversion for us: lasso the whole page,
  // read the selection's bounding rect (pixel space, the same Rect the
  // lasso hit-test uses), then drop the box. READ-ONLY for the user's
  // ink — selecting then deselecting never rewrites strokes, and the
  // insert itself stays additive (I-NDI-2 holds).
  const contentExtent = await resolveContentExtentPx(pageWidth, pageHeight);
  const region = choosePlacementRegion(pageWidth, pageHeight, contentExtent);
  log('choosePlacementRegion:done', {contentExtent, region});

  // §F-LY-6 — scale uniformly to fit the chosen region (minus
  // INSERT_MARGIN_PX on each side). Scale is capped at 1 so small maps
  // keep their designed proportions; centering within the region is
  // applied even at scale=1 so the map lands in the empty band.
  const scale = computeFitScale(
    baseLayout.unionBbox,
    region.w,
    region.h,
    INSERT_MARGIN_PX,
  );
  const pageLayout = transformLayout(baseLayout, scale, region);
  log('transformLayout:done', {
    scale,
    unionBbox: pageLayout.unionBbox,
  });

  // §F-IN-2 — assemble the geometry list (outlines + connectors). The
  // caller's emit closure logs its own per-mode summary.
  const {geometries, unionRect} = emit(pageLayout);

  // §F-IN-3 — additive write. Build one native-backed Element per
  // emitted geometry (createElement returns an Element whose native
  // side carries the uuid / angles / contoursSrc accessors the host
  // validator expects; our old hand-built {type:700,…} object missed
  // that plumbing and got rejected with APIError 106), then call
  // insertElements(notePath, page, newElements) ONCE.
  //
  // Performance: single insertElements = one host-side fsync instead
  // of one per geometry, cutting insert wall-time from ~80 s (309
  // geometries × ~260 ms/fsync observed on the 08:45 probe run) to
  // ~1–2 s (I-NDI-3). insertElements itself is the only disk-touching
  // step; every createElement is bridge-only. Dropping the prior
  // whole-page getElements read also removes a large bridge marshal on
  // pages that already hold many elements.
  //
  // Safety: insertElements is ADDITIVE — the page's existing elements
  // are never read or sent, so they cannot be corrupted (I-NDI-2). We
  // do NOT assume the new-element list is applied transactionally; a
  // partial NEW-element insert is a documented follow-up (RA-3), not
  // inherited atomicity. On failure we re-raise and let the UI layer
  // surface the error banner.
  if (pageCtx.notePath === null || pageCtx.page === null) {
    throw new Error(
      `${context}: resolvePageContext returned null notePath/page; ` +
        'insertElements requires both',
    );
  }
  // Collect labeled nodes so their text lands inside their outline as
  // a TYPE_TEXT element. Unlabeled nodes contribute outline-only.
  const labeledNodes = collectLabels(pageLayout);
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

    log('insertElements:before', {addedCount: newElements.length});
    const insertRes = (await PluginFileAPI.insertElements(
      pageCtx.notePath,
      pageCtx.page,
      newElements as object[],
    )) as ApiRes<boolean>;
    log('insertElements:after', {
      success: insertRes?.success,
      errorCode: (insertRes?.error as {code?: number} | undefined)?.code,
      errorMessage: insertRes?.error?.message,
    });
    if (!insertRes?.success) {
      throw new Error(insertRes?.error?.message ?? 'insertElements failed');
    }

    // Force the host to repaint the page with the newly-inserted
    // geometries. reloadFile is non-fatal: its success is cosmetic
    // (the page would repaint on the next interaction anyway), so
    // we log and continue even on failure.
    //
    // ORDER MATTERS: reloadFile MUST run BEFORE the auto-lasso below.
    // insertElements commits the elements to the file, but the host's
    // rendered/current page doesn't include them until reloadFile
    // re-reads it. An on-device trace showed lassoElements returning
    // {success:true, result:false} when called pre-reload (it matched
    // nothing — the elements weren't in the rendered page yet), and a
    // reload after a lasso would also clear the selection. So: reload
    // first, then lasso.
    log('reloadFile:before');
    const reloadRes = (await PluginCommAPI.reloadFile()) as ApiRes<boolean>;
    log('reloadFile:after', reloadRes);

    // Auto-lasso the freshly inserted block so the user can drag the
    // whole map into place right after insert (§F-IN-3). lassoElements
    // takes a {left,top,right,bottom} rect; unionRect is in page coords
    // ({x,y,w,h}). We expand by LASSO_HALO_PX on every side so elements
    // sitting exactly on the union-rect boundary are captured (a tight
    // rect can miss edge strokes), and round to integers at the firmware
    // boundary like the geometry points. We deliberately do NOT follow
    // shape-snap's setLassoBoxState(2) (which REMOVES the lasso box) —
    // we want the selection to PERSIST so the map is grab-ready.
    // Non-fatal: a lasso failure is cosmetic, so we log and continue
    // rather than abort an already-committed insert.
    const lassoRect = {
      left: Math.round(unionRect.x - LASSO_HALO_PX),
      top: Math.round(unionRect.y - LASSO_HALO_PX),
      right: Math.round(unionRect.x + unionRect.w + LASSO_HALO_PX),
      bottom: Math.round(unionRect.y + unionRect.h + LASSO_HALO_PX),
    };
    log('lassoElements:before', lassoRect);
    const lassoRes = (await PluginCommAPI.lassoElements(
      lassoRect,
    )) as ApiRes<boolean>;
    log('lassoElements:after', {
      success: lassoRes?.success,
      result: lassoRes?.result,
      errorCode: (lassoRes?.error as {code?: number} | undefined)?.code,
      errorMessage: lassoRes?.error?.message,
    });

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
    // Existing content is never sent, so it cannot be corrupted; a
    // partial NEW-element set is a documented follow-up (RA-3), not
    // silently inherited atomicity. The error re-raises unchanged.
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
 * Concept-map sibling of collectLabeledNodes: walk every ConceptNode and
 * collect those carrying a non-empty label, pairing each with its
 * post-fit-to-page bbox. Same label/bbox logic as the tree variant; a
 * parallel fn (rather than generalising collectLabeledNodes) keeps the
 * mindmap path's call site byte-identical (§14.6).
 */
function collectGraphLabeledNodes(
  graph: Graph,
  layout: LayoutResult,
): LabeledNodeSpec[] {
  const out: LabeledNodeSpec[] = [];
  for (const node of graph.nodesById.values()) {
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
 * Average glyph advance as a fraction of the font size, used to predict
 * a label's rendered width (label.length × fontSize × this). Deliberately
 * generous (the firmware's proportional font averages nearer ~0.5) so the
 * width-fit ERRS SMALL and the label never spills past the outline. RB:
 * tune on-device against the real font metrics.
 */
const CHAR_ADVANCE_RATIO = 0.6;

/** Hard ceiling so labels in big boxes don't render comically large. */
const MAX_FONT_PX = 48;

/**
 * Tiny safety floor — only guards against a degenerate ≤0 size for an
 * absurdly long label in a sub-pixel box. It is intentionally well BELOW
 * the old 20 px floor: that floor was the bug — when the map scaled down,
 * the height-derived size fell under 20, got clamped UP to 20, and the
 * now-too-big text was clipped by the firmware to the (also shrunk) box
 * ("Main idea" → "Mai"). Fit must win over a readability floor, because a
 * clipped label loses information while a small one does not.
 */
const MIN_FONT_PX = 6;

/**
 * Font size that fits the label INSIDE its box on BOTH axes. The firmware
 * CLIPS overflowing text (it neither wraps nor auto-shrinks), and node
 * boxes are a fixed NODE_WIDTH regardless of label length, so the size
 * must be the smaller of:
 *   - vertical fit: bbox.h × 0.32 (the historical look — governs short
 *     labels, so their size is unchanged from before), and
 *   - horizontal fit: the size at which `label.length` glyphs span the
 *     padded box width (governs long labels / downscaled boxes).
 * Capped at MAX_FONT_PX, floored only at the degenerate MIN_FONT_PX.
 *
 * Because the emit runs on the fit-to-page-SCALED bbox, this scales with
 * the map: short labels keep bbox.h × 0.32, and downscaling no longer
 * clips because there is no longer a 20 px floor to overshoot.
 */
function fontSizeForLabel(label: string, bbox: Rect): number {
  const availW = Math.max(1, bbox.w - 2 * TEXT_PADDING_PX);
  const byHeight = bbox.h * 0.32;
  const byWidth = availW / (Math.max(1, label.length) * CHAR_ADVANCE_RATIO);
  const fit = Math.min(byHeight, byWidth);
  // floor (not round): rounding UP could re-introduce a sub-pixel overflow,
  // and the whole point is that the label never exceeds the box.
  return Math.floor(Math.max(MIN_FONT_PX, Math.min(MAX_FONT_PX, fit)));
}

/**
 * Build one native-backed `Element` per emitted Geometry plus one
 * `Element.TYPE_TEXT` per labeled node, ready to hand to
 * `PluginFileAPI.insertElements`.
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
 *      `textRect`, fontSize fit to the label AND the box (so it can't
 *      overflow/clip), and centre alignment.
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
      fontSize: fontSizeForLabel(label, bbox),
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
 * notePath + page index used by the insertElements call (§F-IN-1).
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
 * Bottom-right extent (page-pixel space) of all existing content on the
 * page, or null when the page is empty / unreadable. Used by
 * choosePlacementRegion to drop the new map into empty space
 * (§F-IN-3 / RA-2).
 *
 * Why not getElements? Element `maxX`/`maxY` are in the firmware's NATIVE
 * stroke (EMR) coordinate space, which is ~6-11x the page (an on-device
 * trace read 21632x16224 against a 1920x2560 page). Placement, the map
 * geometry, and the auto-lasso rect all work in page-PIXEL space, so an
 * EMR extent made every empty-band calc go negative and the map always
 * landed centered on top of the ink.
 *
 * Instead we borrow the firmware's own EMR->pixel conversion: lasso the
 * whole page (left/top/right/bottom in pixel space, the exact space the
 * lasso hit-test consumes), then read the selection's bounding rect via
 * getLassoRect — that Rect comes back in pixel space — and immediately
 * drop the lasso box (setLassoBoxState(2) = "completely remove"; it
 * deselects only, never deletes strokes). The right/bottom of that rect
 * is the bottom-right extent of all ink, already in the space we place
 * into.
 *
 * Best-effort and READ-ONLY for the user's ink: an empty page (lasso
 * matches nothing), a missing/!success rect, or any thrown error returns
 * null and the caller centers on the whole page.
 */
async function resolveContentExtentPx(
  pageW: number,
  pageH: number,
): Promise<{maxX: number; maxY: number} | null> {
  let selected = false;
  try {
    const lassoRes = (await PluginCommAPI.lassoElements({
      left: 0,
      top: 0,
      right: Math.round(pageW),
      bottom: Math.round(pageH),
    })) as ApiRes<boolean>;
    // result === true means at least one element was selected; false (the
    // empty-page case, or a lasso no-op) means there is nothing to avoid
    // and nothing to clear.
    if (!lassoRes?.success || lassoRes.result !== true) {
      return null;
    }
    selected = true;
    const rectRes = (await PluginCommAPI.getLassoRect()) as ApiRes<{
      left?: number;
      top?: number;
      right?: number;
      bottom?: number;
    }>;
    const rect = rectRes?.result;
    if (
      !rectRes?.success ||
      !rect ||
      typeof rect.right !== 'number' ||
      typeof rect.bottom !== 'number' ||
      !Number.isFinite(rect.right) ||
      !Number.isFinite(rect.bottom)
    ) {
      return null;
    }
    log('resolveContentExtentPx:done', {rect});
    return {maxX: rect.right, maxY: rect.bottom};
  } catch {
    return null;
  } finally {
    // Clear the probe selection iff we actually made one, so the only
    // surviving selection at insert-end is the map's own auto-lasso.
    if (selected) {
      await clearLassoBox();
    }
  }
}

/**
 * Drop the lasso box so the whole-page content probe leaves no transient
 * selection behind. state 2 = "completely remove" the box (deselect) —
 * it never deletes strokes (that is deleteLassoElements). Best-effort:
 * a failure here is purely cosmetic, so swallow it.
 */
async function clearLassoBox(): Promise<void> {
  try {
    await PluginCommAPI.setLassoBoxState(2);
  } catch {
    // cosmetic — the plugin closing clears any lingering selection anyway
  }
}

/**
 * Pick the page sub-rectangle to place the map into (§F-IN-3 / RA-2).
 * Prefer the band BELOW all existing content; if that band is too short
 * (page mostly full vertically), prefer the band to the RIGHT; if
 * neither has MIN_PLACEMENT_BAND_PX of room, fall back to the whole page
 * (centered, accepting possible overlap). An empty page (`content` null)
 * always returns the whole page — identical to the prior center-on-page
 * behavior.
 */
function choosePlacementRegion(
  pageW: number,
  pageH: number,
  content: {maxX: number; maxY: number} | null,
): Rect {
  const fullPage: Rect = {x: 0, y: 0, w: pageW, h: pageH};
  if (content === null) {
    return fullPage;
  }
  const belowTop = content.maxY + CONTENT_GAP_PX;
  const belowH = pageH - belowTop;
  if (belowH >= MIN_PLACEMENT_BAND_PX) {
    return {x: 0, y: belowTop, w: pageW, h: belowH};
  }
  const rightLeft = content.maxX + CONTENT_GAP_PX;
  const rightW = pageW - rightLeft;
  if (rightW >= MIN_PLACEMENT_BAND_PX) {
    return {x: rightLeft, y: 0, w: rightW, h: pageH};
  }
  return fullPage;
}

/**
 * Uniform fit-to-page scale per §F-LY-6. Always ≤ 1: the requirement
 * scales DOWN only ("if the laid-out map is wider than the note
 * page"). Returns 1 when the map already fits — the region-centering
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
 * Scale the layout by `scale` around the origin, then translate so the
 * union bbox sits centered within `region` (a sub-rectangle of the page
 * chosen by choosePlacementRegion). Returns a fully-populated
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
  region: Rect,
): LayoutResult {
  const scaledU: Rect = {
    x: layout.unionBbox.x * scale,
    y: layout.unionBbox.y * scale,
    w: layout.unionBbox.w * scale,
    h: layout.unionBbox.h * scale,
  };
  const tx = region.x + region.w / 2 - (scaledU.x + scaledU.w / 2);
  const ty = region.y + region.h / 2 - (scaledU.y + scaledU.h / 2);

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

