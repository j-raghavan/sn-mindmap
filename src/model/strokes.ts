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
 * Algorithm (§F-ED-5 + §8.1):
 *   1. Compute the stroke's centroid (arithmetic mean of its point
 *      list for polylines, or `ellipseCenterPoint` for circle/ellipse
 *      variants).
 *   2. Find every node whose bbox contains that centroid.
 *      - 0 matches → out-of-map bucket (user's mark didn't land
 *        inside any node; §8.1 surfaces these in a pre-Save dialog).
 *      - 1 match  → straight assignment.
 *      - ≥ 2 matches → tie-break by point mass: count how many of
 *        the stroke's points lie inside each candidate bbox and
 *        pick the maximum. A point-mass tie falls to the earliest
 *        candidate in Map iteration order (insertion order),
 *        which is deterministic because `nodeBboxesById` is built
 *        by the decoder in BFS order.
 *
 * Each stroke is preserved verbatim — this function never touches
 * the stroke's points, pen color, or pen width. It only decides
 * which bucket the stroke lands in.
 *
 * Returns buckets in insertion order of the nodes they key on; a
 * node with zero assigned strokes never appears as a key in `byNode`
 * (matches emitGeometries' empty-bucket behavior). Strokes in each
 * bucket preserve their input-array order so the eventual re-emit
 * pass (§F-ED-7) is stable.
 */
export function associateStrokes(
  strokes: PreservedStroke[],
  nodeBboxesById: Map<NodeId, Rect>,
): StrokeAssociation {
  const byNode: StrokeBucket = new Map();
  const outOfMap: OutOfMapStrokes = [];

  for (const stroke of strokes) {
    const centroid = strokeCentroid(stroke);
    const candidates: NodeId[] = [];
    for (const [id, bbox] of nodeBboxesById) {
      if (pointInRect(centroid, bbox)) {
        candidates.push(id);
      }
    }

    if (candidates.length === 0) {
      outOfMap.push(stroke);
      continue;
    }

    let chosenId: NodeId;
    if (candidates.length === 1) {
      chosenId = candidates[0];
    } else {
      // Point-mass tie-break. Iterate in the order the candidates
      // appeared in the Map, and keep the first winner on mass ties —
      // stable, deterministic, and matches the §8.1 "earlier wins"
      // intuition when two node bboxes each contain exactly half of a
      // symmetric stroke.
      let bestId = candidates[0];
      const firstBbox = nodeBboxesById.get(bestId);
      let bestMass =
        firstBbox === undefined ? 0 : strokePointMassInRect(stroke, firstBbox);
      for (let i = 1; i < candidates.length; i += 1) {
        const id = candidates[i];
        const bbox = nodeBboxesById.get(id);
        if (bbox === undefined) {
          continue;
        }
        const mass = strokePointMassInRect(stroke, bbox);
        if (mass > bestMass) {
          bestMass = mass;
          bestId = id;
        }
      }
      chosenId = bestId;
    }

    let bucket = byNode.get(chosenId);
    if (!bucket) {
      bucket = [];
      byNode.set(chosenId, bucket);
    }
    bucket.push(stroke);
  }

  return {byNode, outOfMap};
}

/**
 * Rigid-translate every stroke in a bucket by (dx, dy). Called
 * once per node on Save (§F-ED-7) using the node's move delta
 * between pre-edit and post-edit layouts. No scaling, no rotation,
 * no resampling (§F-LY-6). Input strokes are never mutated — a
 * shallow clone with translated points/center is returned.
 */
export function translateStrokes(
  strokes: PreservedStroke[],
  delta: Point,
): PreservedStroke[] {
  const {x: dx, y: dy} = delta;
  return strokes.map(s => translateStroke(s, dx, dy));
}

// -------------------------------------------------------------------
// internal helpers
// -------------------------------------------------------------------

function pointInRect(p: Point, r: Rect): boolean {
  return p.x >= r.x && p.x <= r.x + r.w && p.y >= r.y && p.y <= r.y + r.h;
}

/**
 * Stroke centroid per §8.1. Polyline-style strokes use the
 * arithmetic mean of their points; ellipse/circle geometries use
 * their stored center directly (the only meaningful "centroid" for
 * a closed-curve shape). An empty-points polyline is degenerate
 * (shouldn't occur in firmware output) but returns (0, 0) so the
 * caller never sees NaN.
 */
function strokeCentroid(stroke: PreservedStroke): Point {
  switch (stroke.type) {
    case 'straightLine':
    case 'GEO_polygon': {
      const pts = stroke.points;
      if (pts.length === 0) {
        return {x: 0, y: 0};
      }
      let sumX = 0;
      let sumY = 0;
      for (const p of pts) {
        sumX += p.x;
        sumY += p.y;
      }
      return {x: sumX / pts.length, y: sumY / pts.length};
    }
    case 'GEO_circle':
    case 'GEO_ellipse':
      return stroke.ellipseCenterPoint;
    default: {
      const _exhaustive: never = stroke;
      throw new Error(
        `strokeCentroid: unknown geometry variant ${
          (_exhaustive as {type: string}).type
        }`,
      );
    }
  }
}

/**
 * "Point mass" for §8.1 tie-break: number of the stroke's points
 * that fall inside `r`. For ellipse/circle geometries we only have
 * a single representative point (the center), so the mass is 0 or 1
 * — a sensible degenerate when a closed-curve geometry happens to
 * appear as a preserved stroke.
 */
function strokePointMassInRect(stroke: PreservedStroke, r: Rect): number {
  switch (stroke.type) {
    case 'straightLine':
    case 'GEO_polygon': {
      let count = 0;
      for (const p of stroke.points) {
        if (pointInRect(p, r)) {
          count += 1;
        }
      }
      return count;
    }
    case 'GEO_circle':
    case 'GEO_ellipse':
      return pointInRect(stroke.ellipseCenterPoint, r) ? 1 : 0;
    default: {
      const _exhaustive: never = stroke;
      throw new Error(
        `strokePointMassInRect: unknown geometry variant ${
          (_exhaustive as {type: string}).type
        }`,
      );
    }
  }
}

/**
 * Translate a single geometry by (dx, dy). Pure — returns a new
 * object with shallow-copied shape plus translated coordinates;
 * never mutates the input. Exhaustiveness-guarded against future
 * Geometry variants.
 */
function translateStroke(
  s: PreservedStroke,
  dx: number,
  dy: number,
): PreservedStroke {
  switch (s.type) {
    case 'straightLine':
      return {
        ...s,
        points: s.points.map(p => ({x: p.x + dx, y: p.y + dy})),
      };
    case 'GEO_polygon':
      return {
        ...s,
        points: s.points.map(p => ({x: p.x + dx, y: p.y + dy})),
      };
    case 'GEO_circle':
      return {
        ...s,
        ellipseCenterPoint: {
          x: s.ellipseCenterPoint.x + dx,
          y: s.ellipseCenterPoint.y + dy,
        },
      };
    case 'GEO_ellipse':
      return {
        ...s,
        ellipseCenterPoint: {
          x: s.ellipseCenterPoint.x + dx,
          y: s.ellipseCenterPoint.y + dy,
        },
      };
    default: {
      const _exhaustive: never = s;
      throw new Error(
        `translateStroke: unknown geometry variant ${
          (_exhaustive as {type: string}).type
        }`,
      );
    }
  }
}
