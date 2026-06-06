/**
 * High-level "tree + layout -> Geometry[]" emitter per §F-IN-2 (+ the
 * DAG cross-edge overlay, §F-DAG-4).
 *
 * Emit order matters: strokes paint in emit order on Supernote, so
 * later strokes land on TOP of earlier ones. Outlines are emitted LAST
 * so they mask every connector / cross-edge endpoint at each node.
 *
 * Emit sequence:
 *   1. tree connectors — straightLine parent-border -> child-border,
 *      black, pen width follows the CHILD's node border (§F-IN-2 step 2).
 *   2. cross-edges (DAG overlay) — one gray clipped straightLine per
 *      Tree.crossEdge from-border -> to-border plus a ">" arrowhead at
 *      the `to` node (directed). Distinct pen (CROSS_EDGE_PEN) so it
 *      reads as "extra links" (§F-DAG-4). Emitted AFTER connectors and
 *      BEFORE outlines.
 *   3. node outlines — one GEO_polygon per node (pre-order); shape kind
 *      drives the frame (OVAL/ROUNDED_RECTANGLE/RECTANGLE/PARALLELOGRAM
 *      by depth). Paint last to cover their own connector endpoints.
 *
 * The marker + preserved-label-strokes passes were removed with the
 * edit/decode pipeline (v0.1 is insert-only).
 *
 * Every emitted geometry sets showLassoAfterInsert: false (§F-IN-3).
 * unionRect is returned so the caller does not have to re-walk the
 * geometry list; it already covers cross-edges + arrowheads because
 * unionRectOfGeometries walks every straightLine's points (§F-DAG-4-FR6).
 *
 * Collapse handling: §F-IN-2 explicitly auto-expands every subtree
 * before emit. We iterate the tree via `flattenForEmit`, which
 * visits every node regardless of the `collapsed` flag on any
 * ancestor. The caller does NOT need to un-collapse the tree prior
 * to calling us; the layout is already pre-computed against every
 * node anyway (see `radialLayout`'s collapse-agnostic contract).
 */
import {
  CROSS_EDGE_PEN,
  PEN_DEFAULTS,
  type Geometry,
  type LineGeometry,
  type Point,
  type Rect,
} from '../geometry';
import {flattenForEmit, type NodeId, type Tree} from '../model/tree';
import type {LayoutResult} from '../layout/radial';
import {
  ARROWHEAD_HALF_ANGLE,
  ARROWHEAD_LEN,
  STANDARD_PEN_WIDTH,
} from '../layout/constants';
import {nodeFrame} from './nodeFrame';

export type EmitInput = {
  tree: Tree;
  layout: LayoutResult;
};

export type EmitOutput = {
  geometries: Geometry[];
  /** Convenience union-rect for the post-insert lassoElements call. */
  unionRect: Rect;
};

/**
 * Assemble the full emit list for a mindmap per §F-IN-2. Outputs node
 * outlines first (in pre-order) then connector straightLines. The
 * marker + preserved-label-strokes passes were removed along with the
 * edit/decode pipeline (v0.1 is insert-only).
 */
export function emitGeometries(input: EmitInput): EmitOutput {
  const {tree, layout} = input;
  const geometries: Geometry[] = [];

  // Pre-order walk of the FULLY EXPANDED tree (§F-IN-2). We do NOT
  // filter by `node.collapsed` — §8.6 commits to "every node is
  // emitted at insert, collapse is authoring-only convenience".
  const nodes = flattenForEmit(tree);

  // -----------------------------------------------------------------
  // 1. Connectors (emitted FIRST so node outlines paint over them).
  // -----------------------------------------------------------------
  // Strokes paint in emit order on Supernote — later strokes land on
  // top of earlier ones. We want the user to see clean node outlines
  // with no connector line bleeding through them, so connectors emit
  // first and are then visually masked by the node outline at each
  // endpoint. The clipping logic still trims connector endpoints to
  // each node's AABB, but for non-rectangular nodes (the root oval)
  // the AABB is larger than the visible shape — paint order is what
  // produces a clean visual on the curved edge.
  //
  // Endpoints are clipped to each node's bounding box. If the two
  // rects overlap (shouldn't happen with sane layouts but guarded for
  // fuzz-testing) we fall back to center-to-center to avoid NaN.
  for (const node of nodes) {
    if (node.parentId === null) {
      continue;
    }
    const parentCenter = centerOrThrow(layout, node.parentId);
    const childCenter = centerOrThrow(layout, node.id);
    const parentBbox = bboxOrThrow(layout, node.parentId);
    const childBbox = bboxOrThrow(layout, node.id);

    const [start, end] = clipSegmentBetweenRects(
      parentCenter,
      childCenter,
      parentBbox,
      childBbox,
    );

    const line: LineGeometry = {
      ...PEN_DEFAULTS,
      penWidth: STANDARD_PEN_WIDTH,
      type: 'straightLine',
      points: [start, end],
      showLassoAfterInsert: false,
    };
    geometries.push(line);
  }

  // -----------------------------------------------------------------
  // 2. Cross-edges (DAG overlay) — emitted AFTER tree connectors and
  //    BEFORE node outlines, so outlines still mask every endpoint.
  //    Directed: a gray clipped line + a ">" arrowhead at the `to`
  //    node. Reuses clipSegmentBetweenRects verbatim — identical
  //    endpoint geometry to tree connectors (§F-DAG-4-FR1/FR2/FR4).
  // -----------------------------------------------------------------
  for (const edge of tree.crossEdges) {
    const fromCenter = centerOrThrow(layout, edge.from);
    const toCenter = centerOrThrow(layout, edge.to);
    const fromBbox = bboxOrThrow(layout, edge.from);
    const toBbox = bboxOrThrow(layout, edge.to);

    const [start, end] = clipSegmentBetweenRects(
      fromCenter,
      toCenter,
      fromBbox,
      toBbox,
    );

    geometries.push({
      ...CROSS_EDGE_PEN,
      type: 'straightLine',
      points: [start, end],
      showLassoAfterInsert: false,
    });
    for (const barb of arrowheadGeometries(start, end)) {
      geometries.push(barb);
    }
  }

  // -----------------------------------------------------------------
  // 3. Node outlines (pre-order, paint LAST so they cover their
  //    own connector and cross-edge endpoints).
  // -----------------------------------------------------------------
  for (const node of nodes) {
    const bbox = bboxOrThrow(layout, node.id);
    geometries.push(withNoAutoLasso(nodeFrame(bbox, node.shape)));
  }

  return {
    geometries,
    unionRect: unionRectOfGeometries(geometries),
  };
}

/**
 * Shallow-clone a geometry and force `showLassoAfterInsert: false`
 * (§F-IN-3). The original geometry may have an explicit `true` (e.g.
 * a user-drawn stroke replayed verbatim from an earlier Edit), which
 * would break the multi-geometry lasso batch on re-insert; this
 * override is the one-liner fix.
 */
function withNoAutoLasso<G extends Geometry>(g: G): G {
  return {...g, showLassoAfterInsert: false};
}

function centerOrThrow(layout: LayoutResult, id: NodeId): Point {
  const p = layout.centers.get(id);
  if (!p) {
    throw new Error(`emitGeometries: missing layout center for node ${id}`);
  }
  return p;
}

function bboxOrThrow(layout: LayoutResult, id: NodeId): Rect {
  const r = layout.bboxes.get(id);
  if (!r) {
    throw new Error(`emitGeometries: missing layout bbox for node ${id}`);
  }
  return r;
}

/**
 * Two short straightLine barbs forming a ">" at `end`, pointing back
 * along the edge from `end` toward `start` (the directionality
 * affordance for a DAG cross-edge, §F-DAG-4-FR4). Each barb is the
 * REVERSED unit edge vector rotated by ±ARROWHEAD_HALF_ANGLE and scaled
 * by ARROWHEAD_LEN. A degenerate zero-length edge (start ≈ end) yields
 * no barbs — guards against NaN from a 0/0 unit vector. Pure helper,
 * fully unit-testable.
 */
function arrowheadGeometries(start: Point, end: Point): LineGeometry[] {
  const dx = end.x - start.x;
  const dy = end.y - start.y;
  const len = Math.hypot(dx, dy);
  if (len === 0) {
    return []; // degenerate — no direction to point
  }
  const ux = dx / len;
  const uy = dy / len;
  // Each barb: rotate the reversed unit vector (-ux, -uy) by ±half-angle
  // and lay a short segment from the head back along it.
  const barb = (sign: number): LineGeometry => {
    const a = sign * ARROWHEAD_HALF_ANGLE;
    const cos = Math.cos(a);
    const sin = Math.sin(a);
    const rx = -ux * cos - -uy * sin;
    const ry = -ux * sin + -uy * cos;
    return {
      ...CROSS_EDGE_PEN,
      type: 'straightLine',
      points: [
        {x: end.x, y: end.y},
        {x: end.x + rx * ARROWHEAD_LEN, y: end.y + ry * ARROWHEAD_LEN},
      ],
      showLassoAfterInsert: false,
    };
  };
  return [barb(1), barb(-1)];
}

/**
 * Clip a parent-center → child-center segment to the portion that
 * lies OUTSIDE both rectangles — i.e. return the endpoints where the
 * line exits the parent rect and enters the child rect. If the two
 * rectangles overlap along the line (e.g. from pathological layouts
 * or unit-test fuzzing), falls back to the unmodified center pair so
 * downstream geometry consumers never see NaN.
 *
 * Uses the axis-aligned slab method. Both rectangles share the same
 * parametric line P + t * (C - P), t ∈ [0, 1]; we locate the parent's
 * tExit and the child's tEnter. If either slab returns no
 * intersection (shouldn't happen when centers are inside their own
 * rects, but we guard it), fall back to centers.
 */
function clipSegmentBetweenRects(
  parentCenter: Point,
  childCenter: Point,
  parentRect: Rect,
  childRect: Rect,
): [Point, Point] {
  const dx = childCenter.x - parentCenter.x;
  const dy = childCenter.y - parentCenter.y;

  const pSlab = slabIntersect(parentCenter, dx, dy, parentRect);
  const cSlab = slabIntersect(parentCenter, dx, dy, childRect);

  if (!pSlab || !cSlab) {
    return [parentCenter, childCenter];
  }

  // Parent center is inside the parent rect → pSlab.tEnter ≤ 0 ≤
  // pSlab.tExit. We want the exit.
  // Child center is inside the child rect at t=1 → cSlab.tEnter ≤ 1
  // ≤ cSlab.tExit. We want the entry.
  const tExitParent = pSlab.tExit;
  const tEnterChild = cSlab.tEnter;

  if (!Number.isFinite(tExitParent) || !Number.isFinite(tEnterChild)) {
    return [parentCenter, childCenter];
  }

  // Degenerate: if the exit is past the entry (overlapping rects or
  // coincident centers), the "outside" portion of the segment has
  // zero or negative length. Fall back to center-to-center.
  if (tExitParent >= tEnterChild) {
    return [parentCenter, childCenter];
  }

  return [
    {x: parentCenter.x + tExitParent * dx, y: parentCenter.y + tExitParent * dy},
    {x: parentCenter.x + tEnterChild * dx, y: parentCenter.y + tEnterChild * dy},
  ];
}

/**
 * Parametric entry/exit of the line `origin + t * (dx, dy)` through
 * an axis-aligned rect. Returns null when the line misses the rect
 * entirely (tEnter > tExit after both slabs are applied). For a line
 * parallel to an axis whose origin lies outside the rect on that
 * axis, returns null; parallel lines inside the rect on that axis
 * are handled by simply skipping that axis's contribution to tEnter/
 * tExit.
 */
function slabIntersect(
  origin: Point,
  dx: number,
  dy: number,
  rect: Rect,
): {tEnter: number; tExit: number} | null {
  let tEnter = -Infinity;
  let tExit = Infinity;

  const axes: Array<[number, number, number, number]> = [
    [origin.x, dx, rect.x, rect.x + rect.w],
    [origin.y, dy, rect.y, rect.y + rect.h],
  ];

  for (const [p0, d, lo, hi] of axes) {
    if (d === 0) {
      // Line is parallel to this axis. If the origin is outside the
      // slab, there is no intersection anywhere on the line.
      if (p0 < lo || p0 > hi) {
        return null;
      }
      continue;
    }
    const t1 = (lo - p0) / d;
    const t2 = (hi - p0) / d;
    const tNear = t1 < t2 ? t1 : t2;
    const tFar = t1 < t2 ? t2 : t1;
    if (tNear > tEnter) {
      tEnter = tNear;
    }
    if (tFar < tExit) {
      tExit = tFar;
    }
    if (tEnter > tExit) {
      return null;
    }
  }

  return {tEnter, tExit};
}

/**
 * Axis-aligned bounding rectangle of every emitted geometry's
 * points (§F-IN-3 — unionRect for the post-insert lasso). Handles
 * every Geometry variant defined in ../geometry.
 *
 * GEO_circle / GEO_ellipse AABB is the rotation-ignoring
 * conservative envelope (max axis radius on each side). That is
 * tight enough for the lasso — the firmware's lasso is itself a
 * polygon approximation and an over-generous rect would lasso more
 * than intended only for the ellipse's own rotated corner strip,
 * which does not appear in Phase 2's emit mix (the stadium Oval is
 * emitted as a GEO_polygon, not a GEO_ellipse — see
 * nodeFrame's §10 tuning note).
 *
 * Exported so insert.ts's §F-IN-5 cleanup path can compute the union
 * rect of the PARTIAL insert subset (which emitGeometries itself
 * can't reveal after the fact — its returned unionRect is always the
 * full geometry list).
 */
export function unionRectOfGeometries(geometries: Geometry[]): Rect {
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
        // Exhaustiveness guard — if a new Geometry variant is
        // added and we forgot to teach the union about it, TypeScript
        // flags this branch. Runtime throw is defense-in-depth for
        // JS callers.
        const _exhaustive: never = g;
        throw new Error(
          `emitGeometries: unknown geometry variant ${(_exhaustive as {type: string}).type}`,
        );
      }
    }
  }

  if (minX === Infinity) {
    return {x: 0, y: 0, w: 0, h: 0};
  }
  return {x: minX, y: minY, w: maxX - minX, h: maxY - minY};
}
