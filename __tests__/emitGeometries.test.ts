/**
 * Tests for src/rendering/emitGeometries.ts — Phase 2 (§F-IN-2).
 *
 * Coverage:
 *   - Emit order: outlines → connectors → (marker spliced in Phase 3)
 *     → preserved label strokes (§F-IN-2).
 *   - Every emitted geometry sets showLassoAfterInsert: false (§F-IN-3).
 *   - Per-shape outline selection follows the node's stored shape kind
 *     (§6.3 → §F-IN-2 step 1): OVAL/RECTANGLE/ROUNDED_RECTANGLE map
 *     to the three nodeFrame shapes with the right pen widths.
 *   - Connector properties: straightLine, pen-color/pen-type from
 *     PEN_DEFAULTS, pen width = STANDARD_PEN_WIDTH (§F-IN-2 step 2),
 *     exactly 2 points, endpoints land on the parent's and child's
 *     bbox borders (clipping, §F-IN-2 step 2 "stopping at outlines").
 *   - Fully-expanded auto-expansion: a collapsed subtree still emits
 *     every descendant (§8.6, §F-IN-2 auto-expansion).
 *   - Preserved-stroke pass-through: bucket contents emitted after
 *     outlines+connectors, NodeId-ascending order, showLassoAfterInsert
 *     overridden even when the input stroke carried true.
 *   - unionRect bounds every emitted point.
 *   - Capacity-cap is Phase 3's concern; Phase 2 only has to handle
 *     small trees correctly, so no cap-tests here.
 */
import {emitGeometries} from '../src/rendering/emitGeometries';
import {
  addChild,
  addSibling,
  createTree,
  setCollapsed,
  ShapeKind,
  type Tree,
  type NodeId,
} from '../src/model/tree';
import {radialLayout} from '../src/layout/radial';
import {
  ROOT_PEN_WIDTH,
  STANDARD_PEN_WIDTH,
} from '../src/layout/constants';
import {
  PEN_DEFAULTS,
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

/**
 * "Point is on the rectangle's border": inside the rect (with eps)
 * AND within eps of at least one of the four edges. Used to check
 * that the connector clipping lands endpoints on the parent/child
 * outline (§F-IN-2 step 2).
 */
function isOnRectBorder(rect: Rect, x: number, y: number, eps = 1e-4): boolean {
  if (!rectContains(rect, x, y, eps)) {
    return false;
  }
  const dLeft = Math.abs(x - rect.x);
  const dRight = Math.abs(x - (rect.x + rect.w));
  const dTop = Math.abs(y - rect.y);
  const dBottom = Math.abs(y - (rect.y + rect.h));
  return (
    dLeft <= eps || dRight <= eps || dTop <= eps || dBottom <= eps
  );
}

// -------------------------------------------------------------------
// Helpers for building small trees in the spec-expected shapes.
// -------------------------------------------------------------------

function threeNodeTree(): {tree: Tree; rootId: NodeId; childId: NodeId; siblingId: NodeId} {
  const tree = createTree();
  const rootId = tree.rootId;
  const childId = addChild(tree, rootId); // RECTANGLE
  const siblingId = addSibling(tree, childId); // ROUNDED_RECTANGLE (child of root, after childId)
  return {tree, rootId, childId, siblingId};
}

// -------------------------------------------------------------------
// Tests
// -------------------------------------------------------------------

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
    const root = geometries[0];
    expect(isPolygon(root)).toBe(true);
    if (!isPolygon(root)) {
      return;
    }
    expect(root.penWidth).toBe(ROOT_PEN_WIDTH);
    expect(root.penColor).toBe(PEN_DEFAULTS.penColor);
    expect(root.penType).toBe(PEN_DEFAULTS.penType);
    expect(root.showLassoAfterInsert).toBe(false);
  });

  it('unionRect equals the root bbox', () => {
    const tree = createTree();
    const layout = radialLayout(tree);
    const {unionRect} = emitGeometries({tree, layout});
    const rootBbox = layout.bboxes.get(tree.rootId);
    if (!rootBbox) {
      throw new Error('root bbox missing — test setup bug');
    }
    expect(unionRect.x).toBeCloseTo(rootBbox.x, 6);
    expect(unionRect.y).toBeCloseTo(rootBbox.y, 6);
    expect(unionRect.w).toBeCloseTo(rootBbox.w, 6);
    expect(unionRect.h).toBeCloseTo(rootBbox.h, 6);
  });
});

describe('emitGeometries — shape-kind dispatch (§F-IN-2 step 1)', () => {
  it('one polygon per node, with shape-appropriate pen widths', () => {
    const {tree, rootId, childId, siblingId} = threeNodeTree();
    const layout = radialLayout(tree);
    const {geometries} = emitGeometries({tree, layout});

    // 3 nodes -> 3 outlines (first) + 2 connectors (after).
    expect(geometries).toHaveLength(5);

    // First three are outlines, in pre-order: root, childId, siblingId.
    const outlines = geometries.slice(0, 3);
    for (const g of outlines) {
      expect(isPolygon(g)).toBe(true);
    }

    // Pre-order = root, then its children left-to-right in childIds.
    // createTree() root has [] then addChild puts childId at index 0,
    // then addSibling(childId) splices siblingId at index 1 in root's
    // childIds. So the pre-order is: root, childId, siblingId.
    const [rootOutline, childOutline, siblingOutline] =
      outlines as PolygonGeometry[];

    // Root: OVAL (37 points) + darker border.
    expect(rootOutline.penWidth).toBe(ROOT_PEN_WIDTH);
    expect(rootOutline.points).toHaveLength(37);

    // Child (addChild): RECTANGLE (5 points) + standard border.
    expect(childOutline.penWidth).toBe(PEN_DEFAULTS.penWidth);
    expect(childOutline.penWidth).toBe(STANDARD_PEN_WIDTH);
    expect(childOutline.points).toHaveLength(5);

    // Sibling (addSibling): ROUNDED_RECTANGLE (37 points) + standard
    // border.
    expect(siblingOutline.penWidth).toBe(PEN_DEFAULTS.penWidth);
    expect(siblingOutline.points).toHaveLength(37);

    // ShapeKind sanity via the tree itself.
    expect(tree.nodesById.get(rootId)?.shape).toBe(ShapeKind.OVAL);
    expect(tree.nodesById.get(childId)?.shape).toBe(ShapeKind.RECTANGLE);
    expect(tree.nodesById.get(siblingId)?.shape).toBe(
      ShapeKind.ROUNDED_RECTANGLE,
    );
  });
});

describe('emitGeometries — connectors (§F-IN-2 step 2)', () => {
  it('straightLine with standard pen width and default color/type', () => {
    const {tree} = threeNodeTree();
    const layout = radialLayout(tree);
    const {geometries} = emitGeometries({tree, layout});

    const connectors = geometries.slice(3);
    expect(connectors).toHaveLength(2);
    for (const g of connectors) {
      expect(isLine(g)).toBe(true);
      if (!isLine(g)) {
        return;
      }
      expect(g.penWidth).toBe(STANDARD_PEN_WIDTH);
      expect(g.penColor).toBe(PEN_DEFAULTS.penColor);
      expect(g.penType).toBe(PEN_DEFAULTS.penType);
      expect(g.points).toHaveLength(2);
      expect(g.showLassoAfterInsert).toBe(false);
    }
  });

  it('endpoints land on the parent and child bbox borders (clip)', () => {
    const {tree, rootId, childId} = threeNodeTree();
    const layout = radialLayout(tree);
    const {geometries} = emitGeometries({tree, layout});

    // Connector in pre-order: first non-root node is childId, so the
    // first connector is root -> childId.
    const [, , , firstConnector] = geometries;
    if (!isLine(firstConnector)) {
      throw new Error('expected a straightLine connector');
    }
    const [start, end] = firstConnector.points;

    const rootBbox = layout.bboxes.get(rootId);
    const childBbox = layout.bboxes.get(childId);
    if (!rootBbox || !childBbox) {
      throw new Error('bboxes missing — test setup bug');
    }

    // Start should touch the root bbox border; end should touch the
    // child bbox border. Neither endpoint should be the raw center.
    expect(isOnRectBorder(rootBbox, start.x, start.y)).toBe(true);
    expect(isOnRectBorder(childBbox, end.x, end.y)).toBe(true);

    // Defensive: endpoints should not be strictly inside EITHER rect
    // (they live on a border, not interior).
    expect(start).not.toEqual({x: rootBbox.x + rootBbox.w / 2, y: rootBbox.y + rootBbox.h / 2});
    expect(end).not.toEqual({x: childBbox.x + childBbox.w / 2, y: childBbox.y + childBbox.h / 2});
  });

  it('order: connectors follow all outlines, never interleaved', () => {
    // Build a four-node tree to make "never interleaved" testable.
    const tree = createTree();
    const a = addChild(tree, tree.rootId);
    addChild(tree, tree.rootId);
    addChild(tree, a);
    const layout = radialLayout(tree);
    const {geometries} = emitGeometries({tree, layout});

    const lastOutlineIdx = geometries.findIndex(isLine) - 1;
    const firstConnectorIdx = geometries.findIndex(isLine);
    expect(firstConnectorIdx).toBeGreaterThan(0);
    for (let i = 0; i <= lastOutlineIdx; i += 1) {
      expect(isPolygon(geometries[i])).toBe(true);
    }
    for (let i = firstConnectorIdx; i < geometries.length; i += 1) {
      expect(isLine(geometries[i])).toBe(true);
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
    // root -> A (collapsed) -> A1 -> A2 ; root -> B
    const tree = createTree();
    const a = addChild(tree, tree.rootId);
    addChild(tree, tree.rootId); // b
    const a1 = addChild(tree, a);
    addChild(tree, a1); // a2
    setCollapsed(tree, a, true);
    expect(tree.nodesById.get(a)?.collapsed).toBe(true);

    const layout = radialLayout(tree);
    const {geometries} = emitGeometries({tree, layout});

    // 5 nodes total → 5 outlines + 4 connectors = 9 geometries.
    expect(geometries).toHaveLength(9);
    const outlines = geometries.filter(isPolygon);
    const connectors = geometries.filter(isLine);
    expect(outlines).toHaveLength(5);
    expect(connectors).toHaveLength(4);
  });
});

describe('emitGeometries — unionRect (§F-IN-3)', () => {
  it('bounds every emitted polygon vertex and connector endpoint', () => {
    const {tree} = threeNodeTree();
    const layout = radialLayout(tree);
    const {geometries, unionRect} = emitGeometries({tree, layout});

    for (const g of geometries) {
      if (isPolygon(g) || isLine(g)) {
        for (const p of g.points) {
          expect(p.x).toBeGreaterThanOrEqual(unionRect.x - EPS);
          expect(p.x).toBeLessThanOrEqual(unionRect.x + unionRect.w + EPS);
          expect(p.y).toBeGreaterThanOrEqual(unionRect.y - EPS);
          expect(p.y).toBeLessThanOrEqual(unionRect.y + unionRect.h + EPS);
        }
      }
    }

    // Sanity: unionRect must match layout.unionBbox's extent for a
    // nodes-only tree (no preserved strokes). Connectors are strictly
    // inside node-to-node segments, so they never extend unionRect
    // beyond the node bboxes.
    const u = layout.unionBbox;
    expect(unionRect.x).toBeCloseTo(u.x, 6);
    expect(unionRect.y).toBeCloseTo(u.y, 6);
    expect(unionRect.w).toBeCloseTo(u.w, 6);
    expect(unionRect.h).toBeCloseTo(u.h, 6);
  });
});

describe('emitGeometries — preserved label strokes (§F-IN-2 step 4)', () => {
  it('emits buckets in ascending NodeId order, after outlines + connectors', () => {
    const {tree, childId, siblingId} = threeNodeTree();
    const layout = radialLayout(tree);

    const strokeForChild: LineGeometry = {
      ...PEN_DEFAULTS,
      type: 'straightLine',
      points: [
        {x: 0, y: 0},
        {x: 1, y: 1},
      ],
    };
    const strokeForSibling: LineGeometry = {
      ...PEN_DEFAULTS,
      type: 'straightLine',
      points: [
        {x: 2, y: 2},
        {x: 3, y: 3},
      ],
      // Input stroke with auto-lasso true — must be overridden to
      // false on emit.
      showLassoAfterInsert: true,
    };

    const preservedStrokesByNode = new Map<NodeId, Geometry[]>([
      // Insert in reverse NodeId order to prove the emitter sorts.
      [siblingId, [strokeForSibling]],
      [childId, [strokeForChild]],
    ]);

    const {geometries} = emitGeometries({
      tree,
      layout,
      preservedStrokesByNode,
    });

    // 3 outlines + 2 connectors + 2 preserved strokes = 7 geometries.
    expect(geometries).toHaveLength(7);

    // Last two geometries are the preserved strokes, in ascending
    // NodeId order: childId (lower) first, siblingId (higher) second.
    const lastTwo = geometries.slice(-2);
    for (const g of lastTwo) {
      expect(isLine(g)).toBe(true);
      expect(g.showLassoAfterInsert).toBe(false);
    }
    if (!isLine(lastTwo[0]) || !isLine(lastTwo[1])) {
      throw new Error('expected preserved strokes to be straightLine geometries');
    }
    // childId < siblingId so childId's stroke comes first.
    expect(childId).toBeLessThan(siblingId);
    expect(lastTwo[0].points).toEqual(strokeForChild.points);
    expect(lastTwo[1].points).toEqual(strokeForSibling.points);
  });

  it('skips empty buckets and empty maps cleanly', () => {
    const {tree, childId} = threeNodeTree();
    const layout = radialLayout(tree);

    // Empty bucket for a node, plus an absent node.
    const preservedStrokesByNode = new Map<NodeId, Geometry[]>([
      [childId, []],
    ]);

    const {geometries} = emitGeometries({
      tree,
      layout,
      preservedStrokesByNode,
    });

    // 3 outlines + 2 connectors + 0 strokes = 5 geometries.
    expect(geometries).toHaveLength(5);
  });

  it('omitting preservedStrokesByNode is supported (first-insert path)', () => {
    const {tree} = threeNodeTree();
    const layout = radialLayout(tree);
    const {geometries} = emitGeometries({tree, layout});
    expect(geometries).toHaveLength(5);
  });
});
