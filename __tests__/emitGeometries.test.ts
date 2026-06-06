/**
 * Tests for src/rendering/emitGeometries.ts.
 *
 * The marker + preserved-label-stroke passes were removed when the
 * edit/decode pipeline was dropped, so this suite covers only what
 * the emit does today:
 *
 *   - Emit order: outlines (pre-order) → connectors.
 *   - Every emitted geometry sets showLassoAfterInsert: false
 *     (§F-IN-3).
 *   - Per-shape outline selection follows the node's stored shape
 *     kind (§6.3 → §F-IN-2 step 1): OVAL/RECTANGLE/ROUNDED_RECTANGLE
 *     map to the three nodeFrame shapes with the right pen widths.
 *   - Connector properties: straightLine, pen-color/pen-type from
 *     PEN_DEFAULTS, pen width = STANDARD_PEN_WIDTH (§F-IN-2 step 2),
 *     exactly 2 points, endpoints land on the parent's and child's
 *     bbox borders (clipping, §F-IN-2 step 2 "stopping at outlines").
 *   - Fully-expanded auto-expansion: a collapsed subtree still emits
 *     every descendant (§8.6).
 *   - unionRect bounds every emitted point; unionRectOfGeometries
 *     handles all geometry variants including circles/ellipses.
 *   - Connector clipping edge cases (overlapping rects, coincident
 *     centres).
 */
import {
  emitGeometries,
  unionRectOfGeometries,
} from '../src/rendering/emitGeometries';
import {
  addChild,
  addCrossEdge,
  addSibling,
  createTree,
  setCollapsed,
  ShapeKind,
  type Tree,
  type NodeId,
} from '../src/model/tree';
import {radialLayout, type LayoutResult} from '../src/layout/radial';
import {
  ARROWHEAD_HALF_ANGLE,
  ARROWHEAD_LEN,
  ROOT_PEN_WIDTH,
  STANDARD_PEN_WIDTH,
} from '../src/layout/constants';
import {
  CROSS_EDGE_PEN,
  PEN_DEFAULTS,
  type CircleGeometry,
  type EllipseGeometry,
  type Geometry,
  type LineGeometry,
  type PolygonGeometry,
  type Rect,
} from '../src/geometry';

const EPS = 1e-6;

function isPolygon(g: Geometry): g is PolygonGeometry {
  return g.type === 'GEO_polygon';
}

function isLine(g: Geometry): g is LineGeometry {
  return g.type === 'straightLine';
}

function rectContains(rect: Rect, x: number, y: number, eps = EPS): boolean {
  return (
    x >= rect.x - eps &&
    x <= rect.x + rect.w + eps &&
    y >= rect.y - eps &&
    y <= rect.y + rect.h + eps
  );
}

function isOnRectBorder(
  rect: Rect,
  x: number,
  y: number,
  eps = 1e-4,
): boolean {
  if (!rectContains(rect, x, y, eps)) {
    return false;
  }
  const dLeft = Math.abs(x - rect.x);
  const dRight = Math.abs(x - (rect.x + rect.w));
  const dTop = Math.abs(y - rect.y);
  const dBottom = Math.abs(y - (rect.y + rect.h));
  return dLeft <= eps || dRight <= eps || dTop <= eps || dBottom <= eps;
}

function threeNodeTree(): {
  tree: Tree;
  rootId: NodeId;
  childId: NodeId;
  siblingId: NodeId;
} {
  const tree = createTree();
  const rootId = tree.rootId;
  const childId = addChild(tree, rootId);
  const siblingId = addSibling(tree, childId);
  return {tree, rootId, childId, siblingId};
}

describe('emitGeometries — module surface', () => {
  it('is a function', () => {
    expect(typeof emitGeometries).toBe('function');
  });
});

describe('emitGeometries — single-node tree (root only)', () => {
  it('emits exactly one polygon (the root Oval) and zero connectors', () => {
    const tree = createTree();
    const layout = radialLayout(tree);
    const {geometries} = emitGeometries({tree, layout});
    expect(geometries).toHaveLength(1);
    const only = geometries[0];
    expect(isPolygon(only)).toBe(true);
    expect(only.penWidth).toBe(ROOT_PEN_WIDTH);
    expect(only.showLassoAfterInsert).toBe(false);
  });

  it('unionRect covers the root bbox', () => {
    const tree = createTree();
    const layout = radialLayout(tree);
    const {geometries, unionRect} = emitGeometries({tree, layout});
    const rootBbox = layout.bboxes.get(tree.rootId)!;
    // Sampled polygon points live along the oval outline — the
    // unionRect of those points should match rootBbox within a pixel
    // (the oval polygon is sampled on a circular arc, so the extremes
    // sit within ε of the bbox edges).
    expect(unionRect.x).toBeCloseTo(rootBbox.x, 0);
    expect(unionRect.y).toBeCloseTo(rootBbox.y, 0);
    expect(unionRect.x + unionRect.w).toBeCloseTo(
      rootBbox.x + rootBbox.w,
      0,
    );
    expect(unionRect.y + unionRect.h).toBeCloseTo(
      rootBbox.y + rootBbox.h,
      0,
    );
    expect(geometries.length).toBe(1);
  });
});

describe('emitGeometries — shape-kind dispatch (§F-IN-2 step 1)', () => {
  it('one polygon per node, with shape-appropriate pen widths', () => {
    const {tree, rootId, childId, siblingId} = threeNodeTree();
    const layout = radialLayout(tree);
    const {geometries} = emitGeometries({tree, layout});

    // pre-order: root, child, sibling → 3 polygons + 2 connectors.
    const polygons = geometries.filter(isPolygon);
    expect(polygons).toHaveLength(3);

    const rootPoly = polygons[0];
    const childPoly = polygons[1];
    const siblingPoly = polygons[2];

    // Root (depth 0) is OVAL with ROOT_PEN_WIDTH.
    expect(tree.nodesById.get(rootId)?.shape).toBe(ShapeKind.OVAL);
    expect(rootPoly.penWidth).toBe(ROOT_PEN_WIDTH);

    // Direct children of the root sit at depth 1, which the v1.0
    // shape-by-depth table maps to ROUNDED_RECTANGLE — same shape
    // for both the child and the sibling, both at STANDARD_PEN_WIDTH.
    expect(tree.nodesById.get(childId)?.shape).toBe(
      ShapeKind.ROUNDED_RECTANGLE,
    );
    expect(childPoly.penWidth).toBe(STANDARD_PEN_WIDTH);

    expect(tree.nodesById.get(siblingId)?.shape).toBe(
      ShapeKind.ROUNDED_RECTANGLE,
    );
    expect(siblingPoly.penWidth).toBe(STANDARD_PEN_WIDTH);
  });
});

describe('emitGeometries — connectors (§F-IN-2 step 2)', () => {
  it('straightLine with standard pen width and default color/type', () => {
    const {tree} = threeNodeTree();
    const layout = radialLayout(tree);
    const {geometries} = emitGeometries({tree, layout});
    const lines = geometries.filter(isLine);
    expect(lines.length).toBeGreaterThan(0);
    for (const line of lines) {
      expect(line.type).toBe('straightLine');
      expect(line.penColor).toBe(PEN_DEFAULTS.penColor);
      expect(line.penType).toBe(PEN_DEFAULTS.penType);
      expect(line.penWidth).toBe(STANDARD_PEN_WIDTH);
      expect(line.showLassoAfterInsert).toBe(false);
      expect(line.points).toHaveLength(2);
    }
  });

  it('endpoints land on the parent and child bbox borders (clip)', () => {
    const {tree, rootId, childId} = threeNodeTree();
    const layout = radialLayout(tree);
    const {geometries} = emitGeometries({tree, layout});

    const parentBbox = layout.bboxes.get(rootId)!;
    const childBbox = layout.bboxes.get(childId)!;

    // The first connector is parent→child by emit order (pre-order
    // visit). Its endpoints should lie on both bboxes' borders.
    const firstLine = geometries.filter(isLine)[0];
    const [start, end] = firstLine.points;
    // Start should sit on parent rect's border; end on child's.
    expect(
      isOnRectBorder(parentBbox, start.x, start.y) ||
        isOnRectBorder(childBbox, start.x, start.y),
    ).toBe(true);
    expect(
      isOnRectBorder(parentBbox, end.x, end.y) ||
        isOnRectBorder(childBbox, end.x, end.y),
    ).toBe(true);
  });

  it('order: every connector is emitted before any node outline', () => {
    // Strokes paint in emit order on Supernote, so connectors emit
    // FIRST — node outlines come after and visually mask the
    // connector endpoints, keeping the rendered shape edges clean
    // even where the connector AABB-clip leaves a few pixels inside
    // a non-rectangular outline (e.g. the root oval).
    const {tree} = threeNodeTree();
    const layout = radialLayout(tree);
    const {geometries} = emitGeometries({tree, layout});
    let sawPolygon = false;
    for (const g of geometries) {
      if (isPolygon(g)) {
        sawPolygon = true;
      } else if (isLine(g)) {
        // A line appearing after a polygon would be an interleave
        // violation — connectors must all be emitted before the
        // first outline so the outlines paint on top.
        expect(sawPolygon).toBe(false);
      }
    }
  });
});

describe('emitGeometries — §F-IN-3 lasso flag', () => {
  it('every emitted geometry sets showLassoAfterInsert: false', () => {
    const {tree} = threeNodeTree();
    const layout = radialLayout(tree);
    const {geometries} = emitGeometries({tree, layout});
    for (const g of geometries) {
      expect(g.showLassoAfterInsert).toBe(false);
    }
  });
});

describe('emitGeometries — §8.6 auto-expansion', () => {
  it('collapsed subtrees still emit every descendant', () => {
    const tree = createTree();
    const child = addChild(tree, tree.rootId);
    const grandchild = addChild(tree, child);
    setCollapsed(tree, child, true);
    // setCollapsed is a no-op if the node has no children; sanity:
    expect(tree.nodesById.get(child)?.collapsed).toBe(true);
    expect(tree.nodesById.get(grandchild)).toBeDefined();

    const layout = radialLayout(tree);
    const {geometries} = emitGeometries({tree, layout});
    // 3 outlines expected: root + child + grandchild.
    expect(geometries.filter(isPolygon)).toHaveLength(3);
  });
});

describe('emitGeometries — unionRect (§F-IN-3)', () => {
  it('bounds every emitted polygon vertex and connector endpoint', () => {
    const tree = createTree();
    for (let i = 0; i < 6; i += 1) {
      addChild(tree, tree.rootId);
    }
    const layout = radialLayout(tree);
    const {geometries, unionRect} = emitGeometries({tree, layout});
    for (const g of geometries) {
      if (isPolygon(g) || isLine(g)) {
        for (const p of g.points) {
          expect(rectContains(unionRect, p.x, p.y)).toBe(true);
        }
      }
    }
  });
});

describe('unionRectOfGeometries — standalone', () => {
  it('returns {0,0,0,0} for an empty geometry list', () => {
    expect(unionRectOfGeometries([])).toEqual({x: 0, y: 0, w: 0, h: 0});
  });

  it('computes correct bounds for a single GEO_circle', () => {
    const circle: CircleGeometry = {
      ...PEN_DEFAULTS,
      type: 'GEO_circle',
      ellipseCenterPoint: {x: 100, y: 200},
      ellipseMajorAxisRadius: 30,
      ellipseMinorAxisRadius: 30,
      ellipseAngle: 0,
      showLassoAfterInsert: false,
    };
    expect(unionRectOfGeometries([circle])).toEqual({
      x: 70,
      y: 170,
      w: 60,
      h: 60,
    });
  });

  it('computes correct bounds for a GEO_ellipse (uses major radius)', () => {
    const ellipse: EllipseGeometry = {
      ...PEN_DEFAULTS,
      type: 'GEO_ellipse',
      ellipseCenterPoint: {x: 100, y: 200},
      ellipseMajorAxisRadius: 50,
      ellipseMinorAxisRadius: 20,
      ellipseAngle: 0,
      showLassoAfterInsert: false,
    };
    // Conservative envelope uses the major radius on both axes.
    expect(unionRectOfGeometries([ellipse])).toEqual({
      x: 50,
      y: 150,
      w: 100,
      h: 100,
    });
  });

  it('throws on unknown geometry variant (exhaustiveness guard)', () => {
    expect(() =>
      unionRectOfGeometries([{type: 'unknown-variant'} as unknown as Geometry]),
    ).toThrow(/unknown geometry variant/);
  });

  it('returns {0,0,0,0} when every polygon has an empty point list', () => {
    // Degenerate input: geometries.length > 0 so we skip the early-out,
    // but no extend() call ever fires because each polygon's points[]
    // is empty. The post-loop `minX === Infinity` sentinel catches this.
    const emptyPoly: PolygonGeometry = {
      ...PEN_DEFAULTS,
      type: 'GEO_polygon',
      points: [],
      showLassoAfterInsert: false,
    };
    expect(unionRectOfGeometries([emptyPoly])).toEqual({x: 0, y: 0, w: 0, h: 0});
  });
});

describe('emitGeometries — layout consistency errors', () => {
  it('throws when layout is missing a node center', () => {
    const tree = createTree();
    addChild(tree, tree.rootId);
    const layout = radialLayout(tree);
    const broken: LayoutResult = {
      ...layout,
      centers: new Map(),
    };
    expect(() => emitGeometries({tree, layout: broken})).toThrow(
      /missing layout center/,
    );
  });

  it('throws when layout is missing a node bbox', () => {
    const tree = createTree();
    addChild(tree, tree.rootId);
    const layout = radialLayout(tree);
    const broken: LayoutResult = {
      ...layout,
      bboxes: new Map(),
    };
    expect(() => emitGeometries({tree, layout: broken})).toThrow(
      /missing layout bbox/,
    );
  });
});

describe('emitGeometries — connector clipping edge cases', () => {
  /**
   * Build a two-node tree (root + one child) and wrap a synthetic
   * LayoutResult around it so tests can drive clipSegmentBetweenRects
   * through every failure mode — parent-center outside parent rect,
   * axis-parallel lines that miss a slab, non-parallel lines that miss
   * a rect entirely, and overlapping rects. The real radialLayout
   * always places centers INSIDE their own bboxes, so these pathologies
   * are only reachable with a fabricated layout.
   */
  function oneChildLayout(
    rootCenter: {x: number; y: number},
    rootBbox: Rect,
    childCenter: {x: number; y: number},
    childBbox: Rect,
  ): {tree: Tree; layout: LayoutResult} {
    const tree = createTree();
    const childId = addChild(tree, tree.rootId);
    const layout: LayoutResult = {
      centers: new Map([
        [tree.rootId, rootCenter],
        [childId, childCenter],
      ]),
      bboxes: new Map([
        [tree.rootId, rootBbox],
        [childId, childBbox],
      ]),
      unionBbox: rootBbox,
    };
    return {tree, layout};
  }

  it('falls back to center pair when the line is axis-parallel and origin lies outside the parent bbox slab (slabIntersect null)', () => {
    // Vertical line (dx=0) from a parent centre whose x sits far to
    // the right of the parent bbox. slabIntersect's d=0 branch hits the
    // `p0 < lo || p0 > hi` early-null, driving clipSegmentBetweenRects
    // into the center-pair fallback.
    const {tree, layout} = oneChildLayout(
      {x: 1000, y: 0},
      {x: -50, y: -50, w: 100, h: 100},
      {x: 1000, y: 500},
      {x: 950, y: 450, w: 100, h: 100},
    );
    const {geometries} = emitGeometries({tree, layout});
    const lines = geometries.filter(isLine);
    expect(lines).toHaveLength(1);
    // Fallback: endpoints equal the (broken) centres verbatim.
    expect(lines[0].points[0]).toEqual({x: 1000, y: 0});
    expect(lines[0].points[1]).toEqual({x: 1000, y: 500});
  });

  it('falls back to center pair when the line misses the parent bbox (slab tEnter > tExit)', () => {
    // Non-axis-parallel line whose parametric entry/exit on the parent
    // bbox's two slabs don't overlap — slabIntersect returns null
    // mid-loop via the `tEnter > tExit` guard. Both dx and dy are
    // non-zero so the axis-parallel early return is bypassed.
    const {tree, layout} = oneChildLayout(
      {x: 100, y: 100},
      {x: 0, y: 0, w: 50, h: 50},
      {x: 300, y: 50},
      {x: 250, y: 25, w: 100, h: 50},
    );
    const {geometries} = emitGeometries({tree, layout});
    const lines = geometries.filter(isLine);
    expect(lines).toHaveLength(1);
    expect(lines[0].points[0]).toEqual({x: 100, y: 100});
    expect(lines[0].points[1]).toEqual({x: 300, y: 50});
  });

  it('falls back to center pair when parent and child share the same bbox', () => {
    // Two nodes at the same position: parent center is inside both
    // rects, so the clipping's "exit parent, enter child" ordering
    // degenerates. Should fall back to center-to-center without NaN.
    const tree = createTree();
    addChild(tree, tree.rootId);
    const baseLayout = radialLayout(tree);
    const rootId = tree.rootId;
    const childId = [...baseLayout.centers.keys()].find(id => id !== rootId)!;
    const rootBbox = baseLayout.bboxes.get(rootId)!;
    const rootCenter = baseLayout.centers.get(rootId)!;
    const overlap: LayoutResult = {
      centers: new Map([
        [rootId, rootCenter],
        [childId, rootCenter],
      ]),
      bboxes: new Map([
        [rootId, rootBbox],
        [childId, rootBbox],
      ]),
      unionBbox: rootBbox,
    };
    const {geometries} = emitGeometries({tree, layout: overlap});
    const lines = geometries.filter(isLine);
    expect(lines).toHaveLength(1);
    // Endpoints equal the shared centre — no NaN produced.
    for (const p of lines[0].points) {
      expect(Number.isFinite(p.x)).toBe(true);
      expect(Number.isFinite(p.y)).toBe(true);
    }
  });

  it('falls back to center pair when parent and child rects overlap on the connector line', () => {
    // Distinct centres but bboxes that intersect — the line from the
    // parent centre exits the parent rect AFTER it has already entered
    // the child rect, so tExitParent >= tEnterChild and the clipper
    // bails to the unclipped centre pair. Reproduces the geometry that
    // existed before R1 was widened past NODE_WIDTH; without this the
    // tExitParent >= tEnterChild branch is unreachable through the
    // real radialLayout (root↔child bboxes are now always disjoint).
    const {tree, layout} = oneChildLayout(
      {x: 0, y: 0},
      {x: -110, y: -48, w: 220, h: 96},
      {x: 200, y: 0},
      {x: 90, y: -48, w: 220, h: 96},
    );
    const {geometries} = emitGeometries({tree, layout});
    const lines = geometries.filter(isLine);
    expect(lines).toHaveLength(1);
    expect(lines[0].points[0]).toEqual({x: 0, y: 0});
    expect(lines[0].points[1]).toEqual({x: 200, y: 0});
  });
});

// ---------------------------------------------------------------------------
// DAG cross-edge emit pass (Part B / F-DAG-4, F-DAG-5)
// ---------------------------------------------------------------------------

/** A tree-connector line is black (PEN_DEFAULTS.penColor === 0x00). */
function isTreeConnector(g: Geometry): g is LineGeometry {
  return isLine(g) && g.penColor === PEN_DEFAULTS.penColor;
}

/** A cross-edge line (or arrowhead barb) is dark gray (0x9d). */
function isCrossEdgeLine(g: Geometry): g is LineGeometry {
  return isLine(g) && g.penColor === CROSS_EDGE_PEN.penColor;
}

/**
 * Build root + two sibling children (B, D), wrap a real radialLayout
 * around it, and add a single B→D cross-edge. B and D are siblings of
 * the root so B→D is a genuine non-tree cross-edge with no cycle.
 */
function twoSiblingsWithCrossEdge(): {
  tree: Tree;
  layout: LayoutResult;
  b: NodeId;
  d: NodeId;
} {
  const tree = createTree();
  const b = addChild(tree, tree.rootId);
  const d = addChild(tree, tree.rootId);
  addCrossEdge(tree, b, d);
  const layout = radialLayout(tree);
  return {tree, layout, b, d};
}

describe('emitGeometries — cross-edge pass ordering (F-DAG-4-FR1/AC1)', () => {
  it('emits cross-edge lines AFTER every tree connector and BEFORE every node outline', () => {
    const {tree, layout} = twoSiblingsWithCrossEdge();
    const {geometries} = emitGeometries({tree, layout});

    // Index of the LAST black tree connector, the FIRST gray cross-edge
    // line, and the FIRST node outline polygon.
    const lastTreeConnector = geometries.reduce(
      (acc, g, i) => (isTreeConnector(g) ? i : acc),
      -1,
    );
    const firstCrossEdge = geometries.findIndex(isCrossEdgeLine);
    const firstPolygon = geometries.findIndex(isPolygon);

    expect(lastTreeConnector).toBeGreaterThanOrEqual(0);
    expect(firstCrossEdge).toBeGreaterThanOrEqual(0);
    expect(firstPolygon).toBeGreaterThanOrEqual(0);

    // Order: tree connectors → cross-edges (+arrowheads) → outlines.
    expect(lastTreeConnector).toBeLessThan(firstCrossEdge);
    expect(firstCrossEdge).toBeLessThan(firstPolygon);

    // And no gray line appears after the first outline (the whole
    // cross-edge group sits strictly before the outline group).
    const lastCrossEdge = geometries.reduce(
      (acc, g, i) => (isCrossEdgeLine(g) ? i : acc),
      -1,
    );
    expect(lastCrossEdge).toBeLessThan(firstPolygon);
  });
});

describe('emitGeometries — cross-edge geometry + clip reuse (F-DAG-4-FR2/FR3)', () => {
  it('emits a gray clipped line from B border to D border with CROSS_EDGE_PEN', () => {
    const {tree, layout, b, d} = twoSiblingsWithCrossEdge();
    const {geometries} = emitGeometries({tree, layout});

    const bBbox = layout.bboxes.get(b)!;
    const dBbox = layout.bboxes.get(d)!;

    // The first gray line is the cross-edge connector (its arrowhead
    // barbs follow it). Distinguish the connector from the barbs: the
    // connector's endpoints land on the node borders; the barbs both
    // start at the connector's `end`.
    const grayLines = geometries.filter(isCrossEdgeLine);
    // 1 connector + 2 arrowhead barbs = 3 gray lines.
    expect(grayLines).toHaveLength(3);

    const connector = grayLines[0];
    // Pen: dark gray 0x9d, Fineliner 10, thinner 200, no auto-lasso.
    expect(connector.penColor).toBe(0x9d);
    expect(connector.penType).toBe(10);
    expect(connector.penWidth).toBe(200);
    expect(connector.showLassoAfterInsert).toBe(false);
    expect(connector.points).toHaveLength(2);

    // Endpoints clipped to the two node borders (same clip as tree
    // connectors — reused verbatim).
    const [start, end] = connector.points;
    expect(
      isOnRectBorder(bBbox, start.x, start.y) ||
        isOnRectBorder(dBbox, start.x, start.y),
    ).toBe(true);
    expect(
      isOnRectBorder(bBbox, end.x, end.y) ||
        isOnRectBorder(dBbox, end.x, end.y),
    ).toBe(true);
  });

  it('cross-edge lines are visually distinct from the black tree connectors', () => {
    const {tree, layout} = twoSiblingsWithCrossEdge();
    const {geometries} = emitGeometries({tree, layout});
    const tree0 = geometries.filter(isTreeConnector);
    const gray = geometries.filter(isCrossEdgeLine);
    // Root → B and Root → D = 2 black connectors; the cross-edge group
    // is gray. The two pens never share a color.
    expect(tree0.length).toBe(2);
    for (const t of tree0) {
      expect(t.penColor).toBe(0x00);
    }
    for (const g of gray) {
      expect(g.penColor).toBe(0x9d);
    }
  });
});

describe('emitGeometries — arrowhead geometry (F-DAG-4-FR4)', () => {
  it('emits two barbs at the `to` clipped point, each ARROWHEAD_LEN long, pointing back toward `start`', () => {
    const {tree, layout} = twoSiblingsWithCrossEdge();
    const {geometries} = emitGeometries({tree, layout});

    const grayLines = geometries.filter(isCrossEdgeLine);
    const connector = grayLines[0];
    const barbs = grayLines.slice(1); // the two arrowhead segments
    expect(barbs).toHaveLength(2);

    const [start, end] = connector.points;

    for (const barb of barbs) {
      // Each barb starts AT the connector's `to` endpoint (the head).
      expect(barb.points[0].x).toBeCloseTo(end.x, 6);
      expect(barb.points[0].y).toBeCloseTo(end.y, 6);
      // Each barb is ARROWHEAD_LEN long.
      const bx = barb.points[1].x - barb.points[0].x;
      const by = barb.points[1].y - barb.points[0].y;
      expect(Math.hypot(bx, by)).toBeCloseTo(ARROWHEAD_LEN, 4);
      // Barb pen matches the cross-edge pen.
      expect(barb.penColor).toBe(0x9d);
      expect(barb.penWidth).toBe(200);
    }

    // The two barbs are symmetric about the reversed edge direction:
    // the reversed unit vector bisects the angle between them, and the
    // half-angle from the bisector to each barb equals ARROWHEAD_HALF_ANGLE.
    const ex = end.x - start.x;
    const ey = end.y - start.y;
    const elen = Math.hypot(ex, ey);
    // Reversed unit edge vector (head → tail direction).
    const rux = -ex / elen;
    const ruy = -ey / elen;
    for (const barb of barbs) {
      const bx = (barb.points[1].x - barb.points[0].x) / ARROWHEAD_LEN;
      const by = (barb.points[1].y - barb.points[0].y) / ARROWHEAD_LEN;
      // Angle between the barb and the reversed edge vector.
      const dot = bx * rux + by * ruy;
      const angle = Math.acos(Math.max(-1, Math.min(1, dot)));
      expect(angle).toBeCloseTo(ARROWHEAD_HALF_ANGLE, 4);
      // Both barbs point back toward `start` (positive dot with the
      // reversed/head→tail direction) — i.e. they form a ">", not a "<".
      expect(dot).toBeGreaterThan(0);
    }
  });

  it('tree connectors carry NO arrowhead barbs', () => {
    // A plain tree (no cross-edges) must emit zero gray lines at all —
    // arrowheads are exclusive to cross-edges.
    const {tree} = threeNodeTree();
    const layout = radialLayout(tree);
    const {geometries} = emitGeometries({tree, layout});
    expect(geometries.filter(isCrossEdgeLine)).toHaveLength(0);
  });
});

describe('emitGeometries — degenerate arrowhead (len === 0 branch)', () => {
  it('coincident node centers → cross-edge line emitted, ZERO barbs, no NaN', () => {
    // Fabricate a layout where B and D share the SAME center and bbox.
    // clipSegmentBetweenRects falls back to the (coincident) center
    // pair, so the cross-edge connector is a zero-length [p, p] segment.
    // arrowheadGeometries sees len === 0 and returns no barbs (its NaN
    // guard). This is the branch that holds emitGeometries.ts at 100%.
    const tree = createTree();
    const b = addChild(tree, tree.rootId);
    const d = addChild(tree, tree.rootId);
    addCrossEdge(tree, b, d);

    const sharedCenter = {x: 500, y: 500};
    const sharedBbox: Rect = {x: 450, y: 450, w: 100, h: 100};
    const rootBbox = radialLayout(tree).bboxes.get(tree.rootId)!;
    const rootCenter = radialLayout(tree).centers.get(tree.rootId)!;
    const layout: LayoutResult = {
      centers: new Map([
        [tree.rootId, rootCenter],
        [b, sharedCenter],
        [d, sharedCenter],
      ]),
      bboxes: new Map([
        [tree.rootId, rootBbox],
        [b, sharedBbox],
        [d, sharedBbox],
      ]),
      unionBbox: rootBbox,
    };

    const {geometries} = emitGeometries({tree, layout});
    const grayLines = geometries.filter(isCrossEdgeLine);
    // Exactly ONE gray line (the zero-length cross-edge connector) and
    // NO arrowhead barbs.
    expect(grayLines).toHaveLength(1);
    const connector = grayLines[0];
    expect(connector.points[0]).toEqual(connector.points[1]); // zero-length
    // No NaN anywhere in the emitted gray geometry.
    for (const p of connector.points) {
      expect(Number.isFinite(p.x)).toBe(true);
      expect(Number.isFinite(p.y)).toBe(true);
    }
  });
});

describe('emitGeometries — cross-edge clip fallback (F-DAG-4-AC2)', () => {
  it('overlapping node bboxes on the cross-edge line fall back to center-to-center (no NaN)', () => {
    // Distinct centers but overlapping bboxes along the line → the
    // clipper bails to the unclipped center pair, same fallback the
    // tree-connector overlap test exercises. Cross-edge must produce
    // finite points and an arrowhead (len > 0 since centers differ).
    const tree = createTree();
    const b = addChild(tree, tree.rootId);
    const d = addChild(tree, tree.rootId);
    addCrossEdge(tree, b, d);
    const rootBbox = radialLayout(tree).bboxes.get(tree.rootId)!;
    const rootCenter = radialLayout(tree).centers.get(tree.rootId)!;
    const layout: LayoutResult = {
      centers: new Map([
        [tree.rootId, rootCenter],
        [b, {x: 0, y: 0}],
        [d, {x: 200, y: 0}],
      ]),
      bboxes: new Map([
        [tree.rootId, rootBbox],
        [b, {x: -110, y: -48, w: 220, h: 96}],
        [d, {x: 90, y: -48, w: 220, h: 96}], // overlaps B along the line
      ]),
      unionBbox: rootBbox,
    };

    const {geometries} = emitGeometries({tree, layout});
    const grayLines = geometries.filter(isCrossEdgeLine);
    // Connector + 2 barbs (centers differ, so len > 0 → arrowhead).
    expect(grayLines).toHaveLength(3);
    const connector = grayLines[0];
    // Center-to-center fallback: endpoints are the raw centers.
    expect(connector.points[0]).toEqual({x: 0, y: 0});
    expect(connector.points[1]).toEqual({x: 200, y: 0});
    for (const g of grayLines) {
      for (const p of g.points) {
        expect(Number.isFinite(p.x)).toBe(true);
        expect(Number.isFinite(p.y)).toBe(true);
      }
    }
  });
});

describe('emitGeometries — unionRect includes cross-edges + arrowheads (F-DAG-4-FR6)', () => {
  it('a cross-edge grows the unionRect to cover its line and barb tips', () => {
    // Same two-sibling tree, emitted WITHOUT then WITH the cross-edge.
    // The cross-edge + arrowhead live between the two node bboxes (and
    // its barbs may poke slightly past), so the WITH-edge unionRect
    // must contain the WITHOUT-edge unionRect and cover every gray point.
    const treeNoEdge = createTree();
    addChild(treeNoEdge, treeNoEdge.rootId);
    addChild(treeNoEdge, treeNoEdge.rootId);
    const layoutNoEdge = radialLayout(treeNoEdge);
    const {unionRect: rectNoEdge} = emitGeometries({
      tree: treeNoEdge,
      layout: layoutNoEdge,
    });

    const {tree, layout} = twoSiblingsWithCrossEdge();
    const {geometries, unionRect: rectWithEdge} = emitGeometries({
      tree,
      layout,
    });

    // Every gray cross-edge / arrowhead point is inside the unionRect.
    for (const g of geometries.filter(isCrossEdgeLine)) {
      for (const p of g.points) {
        expect(rectContains(rectWithEdge, p.x, p.y)).toBe(true);
      }
    }
    // The with-edge rect contains the no-edge rect (cross-edge geometry
    // sits within the node span here, so the outlines still dominate —
    // assert containment, not strict growth).
    expect(rectWithEdge.x).toBeLessThanOrEqual(rectNoEdge.x + EPS);
    expect(rectWithEdge.y).toBeLessThanOrEqual(rectNoEdge.y + EPS);
    expect(rectWithEdge.x + rectWithEdge.w).toBeGreaterThanOrEqual(
      rectNoEdge.x + rectNoEdge.w - EPS,
    );
    expect(rectWithEdge.y + rectWithEdge.h).toBeGreaterThanOrEqual(
      rectNoEdge.y + rectNoEdge.h - EPS,
    );
  });
});

describe('emitGeometries — zero cross-edges baseline (regression)', () => {
  it('an empty crossEdges array emits exactly the pre-B2 geometry list', () => {
    // A tree with crossEdges: [] must emit connectors + outlines and
    // ZERO gray lines — identical to the pre-cross-edge behavior. This
    // protects every existing emit assertion.
    const {tree} = threeNodeTree();
    expect(tree.crossEdges).toEqual([]);
    const layout = radialLayout(tree);
    const {geometries} = emitGeometries({tree, layout});

    // 3 outlines + 2 black connectors, no gray lines.
    expect(geometries.filter(isPolygon)).toHaveLength(3);
    expect(geometries.filter(isTreeConnector)).toHaveLength(2);
    expect(geometries.filter(isCrossEdgeLine)).toHaveLength(0);
  });
});

describe('radialLayout — determinism with/without cross-edges (F-DAG-5-AC1, I-DAG-3)', () => {
  it('cross-edges do not perturb centers, bboxes, or unionBbox', () => {
    // Build two identical trees; populate crossEdges on one. radialLayout
    // walks childIds only, so its output must be byte-identical.
    const base = createTree();
    const a = addChild(base, base.rootId);
    const b = addChild(base, base.rootId);
    addChild(base, a);
    addSibling(base, b);

    const withEdges = createTree();
    const a2 = addChild(withEdges, withEdges.rootId);
    const b2 = addChild(withEdges, withEdges.rootId);
    addChild(withEdges, a2);
    addSibling(withEdges, b2);
    addCrossEdge(withEdges, a2, b2); // overlay — must NOT move anything

    const layoutBase = radialLayout(base);
    const layoutEdges = radialLayout(withEdges);

    // Same node-id sets, same centers/bboxes, same unionBbox.
    expect([...layoutEdges.centers.keys()].sort()).toEqual(
      [...layoutBase.centers.keys()].sort(),
    );
    for (const id of layoutBase.centers.keys()) {
      expect(layoutEdges.centers.get(id)).toEqual(layoutBase.centers.get(id));
      expect(layoutEdges.bboxes.get(id)).toEqual(layoutBase.bboxes.get(id));
    }
    expect(layoutEdges.unionBbox).toEqual(layoutBase.unionBbox);
  });
});
