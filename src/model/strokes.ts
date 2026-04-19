/**
 * Per-node preserved label strokes.
 *
 * v0.10 dropped in-plugin handwriting capture entirely. The plugin
 * never captures stylus input. Label strokes therefore only exist
 * in sn-mindmap in one narrow window: after the user lassos a
 * previously-inserted mindmap and taps "Edit Mindmap". At that
 * moment PluginCommAPI.getLassoGeometries() returns every stroke
 * under the lasso; the decoder (§F-ED-5) associates each label
 * stroke to its node by bbox containment, storing them here for the
 * editor session.
 *
 * Each stroke is preserved verbatim — original pen color, original
 * pen width, original points. On Save (§F-ED-7) strokes are
 * translated as a rigid unit by the node's move delta and re-emitted
 * with their metadata intact. They are never scaled, rotated, or
 * resampled (§F-LY-6, §8.1).
 */
import type {Geometry, Point, Rect} from '../geometry';
import type {NodeId} from './tree';

// Re-export for callers that already import everything stroke-related
// from this module.
export type {NodeId};

/**
 * A single handwriting stroke read from the firmware. Shape mirrors
 * the `straightLine` / `GEO_polygon` (open polyline) Geometry types
 * in ../geometry, but preserved strokes keep their ORIGINAL geometry
 * type so we re-emit them on Save in the same form the firmware
 * wrote them. On first-insert the plugin never emits label strokes
 * (§F-IN-2 step 3).
 */
export type PreservedStroke = Geometry;

/**
 * Per-node bucket of preserved label strokes, keyed by NodeId. Built
 * by the decoder (§F-ED-5), read by the edit UI (§F-ED-6) and by
 * the re-emit path on Save (§F-ED-7).
 */
export type StrokeBucket = Map<NodeId, PreservedStroke[]>;

/**
 * Strokes whose centroid falls outside every node's bbox per the
 * disambiguation rule in §8.1. Surfaced in a pre-Save confirmation
 * dialog (§9 Phase 4) so the user can re-lasso if they meant these
 * as labels.
 */
export type OutOfMapStrokes = PreservedStroke[];

/**
 * Association result produced by §F-ED-5 decode.
 */
export type StrokeAssociation = {
  byNode: StrokeBucket;
  outOfMap: OutOfMapStrokes;
};

/**
 * Associate a set of candidate label strokes to nodes by centroid
 * containment, resolving ties by which node bbox contains more of
 * the stroke's point mass (§8.1). Strokes whose centroid falls
 * outside every node bbox are returned in `outOfMap`.
 *
 * TODO(Phase 4, §F-ED-5): implement.
 */
export function associateStrokes(
  _strokes: PreservedStroke[],
  _nodeBboxesById: Map<NodeId, Rect>,
): StrokeAssociation {
  throw new Error('TODO(Phase 4, §F-ED-5): associateStrokes not implemented');
}

/**
 * Rigid-translate every stroke in a bucket by (dx, dy). Called
 * once per node on Save (§F-ED-7) using the node's move delta
 * between pre-edit and post-edit layouts. No scaling, no rotation,
 * no resampling (§F-LY-6).
 *
 * TODO(Phase 4, §F-ED-7): implement.
 */
export function translateStrokes(
  _strokes: PreservedStroke[],
  _delta: Point,
): PreservedStroke[] {
  throw new Error('TODO(Phase 4, §F-ED-7): translateStrokes not implemented');
}
