/**
 * High-level "tree + layout (+ preserved strokes) -> Geometry[]"
 * emitter per §F-IN-2.
 *
 * Output order matters for visual consistency and for the marker
 * decoder's stroke scan: per §6.5 step 1, the decoder considers
 * straightLine geometries with length ≤ 4 px and pen color 0x9D as
 * marker candidates. Emitting marker LAST among the plugin-owned
 * strokes means the marker block sits on top of node outlines and
 * connectors in stroke order, and label strokes (only present on
 * re-insert from edit) come after the marker so the user's most
 * recent writing is on top.
 *
 * Emit sequence (§F-IN-2):
 *   1. node outlines  — one per node, shape kind drives the frame
 *      (OVAL with ROOT_PEN_WIDTH for the root, RECTANGLE for
 *      Add-Child nodes, ROUNDED_RECTANGLE for Add-Sibling nodes)
 *   2. connectors      — straightLine parent-border -> child-border,
 *      pen width follows the CHILD's node border (§F-IN-2 step 2)
 *   3. marker          — fixed-position binary grid anchored at the
 *      top-left of the node union-bbox (§6.1). One straightLine per
 *      "1" bit in the 72×72 grid, pen color 0x9D, pen width 100.
 *      The per-node bboxes written into the marker bytes are stored
 *      mindmap-local (origin = marker top-left, per §6.3) — we
 *      translate them here so encodeMarker stays spec-aligned and
 *      oblivious to where the mindmap ended up on the page.
 *   4. preserved label strokes (only on re-insert from edit) — each
 *      node's strokes translated by that node's move delta by the
 *      caller (§F-ED-7) before being handed to this module; we just
 *      pass them through with showLassoAfterInsert overridden to
 *      false.
 *
 * Every emitted geometry sets showLassoAfterInsert: false (§F-IN-3).
 * The caller (insert.ts) issues the explicit
 * PluginCommAPI.lassoElements(unionRect) AFTER the final insert,
 * and unionRect is returned from this module so the caller does not
 * have to re-walk the geometry list.
 *
 * Collapse handling: §F-IN-2 explicitly auto-expands every subtree
 * before emit. We iterate the tree via `flattenForEmit`, which
 * visits every node regardless of the `collapsed` flag on any
 * ancestor. The caller does NOT need to un-collapse the tree prior
 * to calling us; the layout is already pre-computed against every
 * node anyway (see `radialLayout`'s collapse-agnostic contract).
 */
import {
  PEN_DEFAULTS,
  type Geometry,
  type LineGeometry,
  type Point,
  type Rect,
} from '../geometry';
import {encodeMarker} from '../marker/encode';
import {flattenForEmit, type NodeId, type Tree} from '../model/tree';
import type {LayoutResult} from '../layout/radial';
import type {StrokeBucket} from '../model/strokes';
import {STANDARD_PEN_WIDTH} from '../layout/constants';
import {nodeFrame} from './nodeFrame';

export type EmitInput = {
  tree: Tree;
  layout: LayoutResult;
  /**
   * Only present on re-insert from edit (§F-ED-7). Undefined on
   * first-insert (§F-IN-2 step 3 — the plugin does not own labels
   * during initial authoring).
   *
   * Strokes in this bucket MUST already be translated by the caller
   * to post-edit coordinates. emitGeometries is a pure pass-through
   * for stroke payloads; it never scales, rotates, or resamples.
   */
  preservedStrokesByNode?: StrokeBucket;
};

export type EmitOutput = {
  geometries: Geometry[];
  /** Convenience union-rect for the post-insert lassoElements call. */
  unionRect: Rect;
};

/**
 * Assemble the full emit list for a mindmap per §F-IN-2. See the
 * file-level comment for the ordering contract and the division of
 * labor between this module and the caller (insert.ts).
 */
export function emitGeometries(input: EmitInput): EmitOutput {
  const {tree, layout, preservedStrokesByNode} = input;
  const geometries: Geometry[] = [];

  // Pre-order walk of the FULLY EXPANDED tree (§F-IN-2). We do NOT
  // filter by `node.collapsed` — §8.6 commits to "every node is
  // emitted at insert, collapse is authoring-only convenience".
  const nodes = flattenForEmit(tree);

  // -----------------------------------------------------------------
  // 1. Node outlines.
  // -----------------------------------------------------------------
  // Order is the pre-order visit order so tests and the marker-record
  // encoder (Phase 3) see outlines in the same order as the packed
  // node table. That symmetry simplifies debugging "this node's
  // outline is index N, its marker record is offset N×10" in logcat.
  for (const node of nodes) {
    const bbox = bboxOrThrow(layout, node.id);
    geometries.push(withNoAutoLasso(nodeFrame(bbox, node.shape)));
  }

  // -----------------------------------------------------------------
  // 2. Connectors.
  // -----------------------------------------------------------------
  // One straightLine per parent/child pair, in the same pre-order
  // visit so a given child's connector appears immediately after its
  // subtree's outlines in the full geometry list — convenient for
  // stroke-layer inspection. Connector endpoints are the intersection
  // of the center-to-center line with each rectangle's border, so the
  // line visibly starts at the parent's outline and ends at the
  // child's (§F-IN-2 step 2: "stopping at the parent's and child's
  // node outlines"). If the two rects overlap (shouldn't happen with
  // sane layouts but guarded for fuzz-testing), we fall back to
  // center-to-center to avoid NaN endpoints.
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

    // §F-IN-2 step 2: "Connector pen width follows the node border
    // weight of its child". The only OVAL in v0.1 is the root, which
    // has no parent and therefore never appears as a connector's
    // child — so STANDARD_PEN_WIDTH is correct for every connector.
    // Left as an explicit constant (rather than reading from the
    // child's outline geometry) so a future Oval-anywhere extension
    // requires touching this one line rather than post-processing
    // the connector list.
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
  // 3. Marker (§6).
  // -----------------------------------------------------------------
  // Marker origin = top-left of the node union-bbox (§6.1). The
  // spec permits a "small fixed offset" to guard against
  // marker-vs-node confusion; we don't apply one here because the
  // marker pen-color discriminator (0x9D) already keeps marker
  // candidates separate from the black-fineliner outlines, and a
  // zero offset makes lasso-bbox-topleft → marker-origin inference
  // exact when the user's lasso covers the whole block (decoder
  // still has a ±2-cell retry loop for on-device jitter).
  //
  // §6.3 stores per-node bboxes in mindmap-local coords (origin =
  // marker top-left). layout.bboxes is in page coords, so we
  // translate here; width/height pass through unchanged.
  const markerOrigin: Point = {x: layout.unionBbox.x, y: layout.unionBbox.y};
  const nodeBboxesRel = new Map<NodeId, Rect>();
  for (const [id, r] of layout.bboxes) {
    nodeBboxesRel.set(id, {
      x: r.x - markerOrigin.x,
      y: r.y - markerOrigin.y,
      w: r.w,
      h: r.h,
    });
  }
  const markerGeoms = encodeMarker({
    tree,
    nodeBboxesById: nodeBboxesRel,
    markerOrigin,
  });
  for (const g of markerGeoms) {
    geometries.push(g);
  }

  // -----------------------------------------------------------------
  // 4. Preserved label strokes.
  // -----------------------------------------------------------------
  // Ascending NodeId order (not pre-order) because:
  //   - The caller has already translated each bucket by its node's
  //     move delta; there's no spatial reason to prefer one order
  //     over the other.
  //   - NodeId order is a stable total ordering that survives tree
  //     restructuring during edit, which makes snapshot tests
  //     trivial to author in Phase 4.
  //   - Within a single node's bucket, we preserve the original
  //     stroke order — the firmware assigned them in time order when
  //     they were originally written.
  if (preservedStrokesByNode) {
    const nodeIds = [...preservedStrokesByNode.keys()].sort(
      (a, b) => a - b,
    );
    for (const nodeId of nodeIds) {
      const bucket = preservedStrokesByNode.get(nodeId);
      if (!bucket) {
        continue;
      }
      for (const stroke of bucket) {
        geometries.push(withNoAutoLasso(stroke));
      }
    }
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
