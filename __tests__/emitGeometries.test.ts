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
  addSibling,
  createTree,
  setCollapsed,
  ShapeKind,
  type Tree,
  type NodeId,
} from '../src/model/tree';
import {radialLayout, type LayoutResult} from '../src/layout/radial';
import {ROOT_PEN_WIDTH, STANDARD_PEN_WIDTH} from '../src/layout/constants';
import {
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

    // Root node is OVAL with ROOT_PEN_WIDTH.
    expect(tree.nodesById.get(rootId)?.shape).toBe(ShapeKind.OVAL);
    expect(rootPoly.penWidth).toBe(ROOT_PEN_WIDTH);

    // Child is RECTANGLE with STANDARD_PEN_WIDTH.
    expect(tree.nodesById.get(childId)?.shape).toBe(ShapeKind.RECTANGLE);
    expect(childPoly.penWidth).toBe(STANDARD_PEN_WIDTH);

    // Sibling is ROUNDED_RECTANGLE with STANDARD_PEN_WIDTH.
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

  it('order: connectors follow all outlines, never interleaved', () => {
    const {tree} = threeNodeTree();
    const layout = radialLayout(tree);
    const {geometries} = emitGeometries({tree, layout});
    // After the last polygon, everything is a connector.
    let sawLine = false;
    for (const g of geometries) {
      if (isLine(g)) {
        sawLine = true;
      } else if (isPolygon(g)) {
        // A polygon appearing after a line would be an interleave
        // violation.
        expect(sawLine).toBe(false);
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
});
