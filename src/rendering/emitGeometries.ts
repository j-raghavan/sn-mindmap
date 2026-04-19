/**
 * High-level "tree + layout (+ preserved strokes) -> Geometry[]"
 * emitter per §F-IN-2.
 *
 * Output order matters for visual consistency and for the marker
 * decoder's stroke scan: per §6.5 step 1, the decoder considers
 * straightLine geometries with length ≤ 4 px and pen color 0x9D as
 * marker candidates. Emitting marker LAST means the marker block
 * sits on top of node outlines and connectors in stroke order, and
 * label strokes (only present on re-insert from edit) come after
 * the marker so the user's most recent writing is on top.
 *
 * Emit sequence (§F-IN-2):
 *   1. node outlines  — one per node, shape kind drives the frame
 *      (OVAL with ROOT_PEN_WIDTH for the root, RECTANGLE for
 *      Add-Child nodes, ROUNDED_RECTANGLE for Add-Sibling nodes)
 *   2. connectors      — straightLine parent-center -> child-center,
 *      pen width follows the CHILD's node border (§F-IN-2 step 2)
 *   3. marker          — fixed-position binary grid in the top-left
 *      of the union-bbox (§6)
 *   4. preserved label strokes (only on re-insert from edit) — each
 *      node's strokes translated by that node's move delta
 *      (§F-ED-7)
 *
 * Every emitted geometry sets showLassoAfterInsert: false (§F-IN-3).
 * The caller (insert.ts) issues the explicit
 * PluginCommAPI.lassoElements(unionRect) AFTER the final insert.
 */
import type {Geometry} from '../geometry';
import type {Tree} from '../model/tree';
import type {LayoutResult} from '../layout/radial';
import type {StrokeBucket} from '../model/strokes';

export type EmitInput = {
  tree: Tree;
  layout: LayoutResult;
  /**
   * Only present on re-insert from edit (§F-ED-7). Undefined on
   * first-insert (§F-IN-2 step 3 — the plugin does not own labels
   * during initial authoring).
   */
  preservedStrokesByNode?: StrokeBucket;
};

export type EmitOutput = {
  geometries: Geometry[];
  /** Convenience union-rect for the post-insert lassoElements call. */
  unionRect: import('../geometry').Rect;
};

/**
 * TODO(Phase 2, §F-IN-2): implement.
 *   - node outline geometries via ./nodeFrame.ts
 *   - connector geometries via ../geometry's LineGeometry
 *   - marker geometries via ../marker/encode.ts
 *   - preserved-stroke re-emission with translation per §F-ED-7
 *   - return unionRect = bbox of every emitted geometry
 */
export function emitGeometries(_input: EmitInput): EmitOutput {
  throw new Error('TODO(Phase 2, §F-IN-2): emitGeometries not implemented');
}
