/**
 * Tests for src/rendering/emitGeometries.ts — Phase 2 (§F-IN-2) plus
 * Phase 3.4 marker wire-up.
 *
 * Coverage:
 *   - Emit order: outlines → connectors → marker → preserved label
 *     strokes (§F-IN-2, §6.4).
 *   - Every emitted geometry sets showLassoAfterInsert: false (§F-IN-3).
 *   - Per-shape outline selection follows the node's stored shape kind
 *     (§6.3 → §F-IN-2 step 1): OVAL/RECTANGLE/ROUNDED_RECTANGLE map
 *     to the three nodeFrame shapes with the right pen widths.
 *   - Connector properties: straightLine, pen-color/pen-type from
 *     PEN_DEFAULTS, pen width = STANDARD_PEN_WIDTH (§F-IN-2 step 2),
 *     exactly 2 points, endpoints land on the parent's and child's
 *     bbox borders (clipping, §F-IN-2 step 2 "stopping at outlines").
 *   - Marker geometries: §6.4 pen style, grid alignment from
 *     layout.unionBbox.topleft, positioned AFTER connectors and
 *     BEFORE preserved strokes (§F-IN-2 step 3/4).
 *   - Fully-expanded auto-expansion: a collapsed subtree still emits
 *     every descendant (§8.6, §F-IN-2 auto-expansion).
 *   - Preserved-stroke pass-through: bucket contents emitted after
 *     outlines+connectors+marker, NodeId-ascending order,
 *     showLassoAfterInsert overridden even when input stroke carried
 *     true.
 *   - unionRect bounds every emitted point (including marker strokes).
 *   - MarkerCapacityError surfaces through emitGeometries when the
 *     tree exceeds MARKER_PUBLISHED_NODE_CAP (§F-PE-4).
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
import {
  ROOT_PEN_WIDTH,
  STANDARD_PEN_WIDTH,
} from '../src/layout/constants';
import {
  PEN_DEFAULTS,
  type CircleGeometry,
  type EllipseGeometry,
  type Geometry,
  type LineGeometry,
  type PolygonGeometry,
  type Rect,
} from '../src/geometry';
import {
  MARKER_BIT_STROKE_LEN,
  MARKER_CELL_PX,
  MARKER_GRID,
  MARKER_PEN_COLOR,
  MARKER_PEN_TYPE,
  MARKER_PEN_WIDTH,
  MARKER_PUBLISHED_NODE_CAP,
  MarkerCapacityError,
} from '../src/marker/encode';

const EPS = 1e-6;

function isPolygon(g: Geometry): g is PolygonGeometry {
  return g.type === 'GEO_polygon';
}

function isLine(g: Geometry): g is LineGeometry {
  return g.type === 'straightLine';
}

/**
 * Marker strokes are tagged by pen color 0x9D (§6.4) — this is the
 * same discriminator the decoder uses to pick them out of a mixed
 * Geometry[] at decode time.
 */
function isMarkerStroke(g: Geometry): boolean {
  return g.type === 'straightLine' && g.penColor === MARKER_PEN_COLOR;
}

/** Non-marker geometries — the outlines, connectors, and preserved
 * strokes. Convenient for tests that care about the "primary" emit
 * mix and want to assert counts without the marker bits polluting
 * them.
 */
function nonMarker(geometries: Geometry[]): Geometry[] {
  return geometries.filter(g => !isMarkerStroke(g));
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
  it('emits exactly one polygon (the root Oval) and zero connectors (non-marker only)', () => {
    const tree = createTree();
    const layout = radialLayout(tree);
    const {geometries} = emitGeometries({tree, layout});

    const primary = nonMarker(geometries);
    expect(primary).toHaveLength(1);
    const root = primary[0];
    expect(isPolygon(root)).toBe(true);
    if (!isPolygon(root)) {
      return;
    }
    expect(root.penWidth).toBe(ROOT_PEN_WIDTH);
    expect(root.penColor).toBe(PEN_DEFAULTS.penColor);
    expect(root.penType).toBe(PEN_DEFAULTS.penType);
    expect(root.showLassoAfterInsert).toBe(false);
  });

  it('unionRect covers both the root bbox and the marker footprint', () => {
    const tree = createTree();
    const layout = radialLayout(tree);
    const {unionRect} = emitGeometries({tree, layout});
    const rootBbox = layout.bboxes.get(tree.rootId);
    if (!rootBbox) {
      throw new Error('root bbox missing — test setup bug');
    }
    // Marker origin is at unionBbox.topleft, so unionRect.topleft
    // matches the node unionBbox topleft exactly. Width/height can be
    // larger because the 288×288 marker footprint exceeds the single
    // root's 220×96.
    expect(unionRect.x).toBeCloseTo(layout.unionBbox.x, 6);
    expect(unionRect.y).toBeCloseTo(layout.unionBbox.y, 6);
    expect(unionRect.w).toBeGreaterThanOrEqual(rootBbox.w - 1e-6);
    expect(unionRect.h).toBeGreaterThanOrEqual(rootBbox.h - 1e-6);
  });
});

describe('emitGeometries — shape-kind dispatch (§F-IN-2 step 1)', () => {
  it('one polygon per node, with shape-appropriate pen widths', () => {
    const {tree, rootId, childId, siblingId} = threeNodeTree();
    const layout = radialLayout(tree);
    const {geometries} = emitGeometries({tree, layout});

    // 3 nodes -> 3 outlines (first) + 2 connectors (after) + marker.
    const primary = nonMarker(geometries);
    expect(primary).toHaveLength(5);

    // First three are outlines, in pre-order: root, childId, siblingId.
    const outlines = primary.slice(0, 3);
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

    // Connectors are the black-fineliner straightLines; marker
    // strokes are straightLines too but with penColor 0x9D, so
    // filter them out first.
    const connectors = nonMarker(geometries).slice(3);
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
    // first connector is root -> childId. Filter out marker strokes
    // (same straightLine type but penColor 0x9D) first.
    const [, , , firstConnector] = nonMarker(geometries);
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

    const primary = nonMarker(geometries);
    const lastOutlineIdx = primary.findIndex(isLine) - 1;
    const firstConnectorIdx = primary.findIndex(isLine);
    expect(firstConnectorIdx).toBeGreaterThan(0);
    for (let i = 0; i <= lastOutlineIdx; i += 1) {
      expect(isPolygon(primary[i])).toBe(true);
    }
    for (let i = firstConnectorIdx; i < primary.length; i += 1) {
      expect(isLine(primary[i])).toBe(true);
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

    // 5 nodes total → 5 outlines + 4 connectors = 9 non-marker geometries.
    const primary = nonMarker(geometries);
    expect(primary).toHaveLength(9);
    const outlines = primary.filter(isPolygon);
    const connectors = primary.filter(isLine);
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

    // unionRect.topleft matches layout.unionBbox.topleft because
    // markerOrigin = unionBbox.topleft and all node bboxes are ≥ that
    // coordinate by definition. unionRect extent is the MAX of the
    // node unionBbox extent and the marker footprint — so we only
    // assert the outer bound here.
    const u = layout.unionBbox;
    expect(unionRect.x).toBeCloseTo(u.x, 6);
    expect(unionRect.y).toBeCloseTo(u.y, 6);
    expect(unionRect.w).toBeGreaterThanOrEqual(u.w - EPS);
    expect(unionRect.h).toBeGreaterThanOrEqual(u.h - EPS);
  });
});

describe('emitGeometries — preserved label strokes (§F-IN-2 step 4)', () => {
  it('emits buckets in ascending NodeId order, after outlines + connectors + marker', () => {
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

    // 3 outlines + 2 connectors + 2 preserved strokes = 7 non-marker
    // geometries, plus the marker's "1"-bit strokes (penColor 0x9D)
    // wedged between the connectors and the preserved strokes.
    const primary = nonMarker(geometries);
    expect(primary).toHaveLength(7);

    // Preserved strokes (default-pen black, NOT 0x9D) are the LAST
    // two elements of the full geometries list. No marker strokes or
    // other payload can follow them — preserved strokes must come
    // AFTER marker so the user's handwriting sits on top visually.
    const lastTwo = geometries.slice(-2);
    for (const g of lastTwo) {
      expect(isLine(g)).toBe(true);
      expect(isMarkerStroke(g)).toBe(false);
      expect(g.showLassoAfterInsert).toBe(false);
    }
    if (!isLine(lastTwo[0]) || !isLine(lastTwo[1])) {
      throw new Error('expected preserved strokes to be straightLine geometries');
    }
    // childId < siblingId so childId's stroke comes first.
    expect(childId).toBeLessThan(siblingId);
    expect(lastTwo[0].points).toEqual(strokeForChild.points);
    expect(lastTwo[1].points).toEqual(strokeForSibling.points);

    // Order check: every marker stroke sits before both preserved
    // strokes in the geometries array.
    const preservedIdxStart = geometries.length - 2;
    for (let i = 0; i < preservedIdxStart; i += 1) {
      if (isMarkerStroke(geometries[i])) {
        expect(i).toBeLessThan(preservedIdxStart);
      }
    }
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

    // 3 outlines + 2 connectors + 0 strokes = 5 non-marker geometries.
    const primary = nonMarker(geometries);
    expect(primary).toHaveLength(5);
  });

  it('omitting preservedStrokesByNode is supported (first-insert path)', () => {
    const {tree} = threeNodeTree();
    const layout = radialLayout(tree);
    const {geometries} = emitGeometries({tree, layout});
    const primary = nonMarker(geometries);
    expect(primary).toHaveLength(5);
  });
});

describe('emitGeometries — marker emission (§6 / Phase 3.4)', () => {
  it('emits at least one marker stroke for any non-empty tree', () => {
    const tree = createTree();
    const layout = radialLayout(tree);
    const {geometries} = emitGeometries({tree, layout});
    const markerStrokes = geometries.filter(isMarkerStroke);
    // Even a single-node tree has a 16-byte logical message + 510-byte
    // zero-padded block with RS parity; the bit population count is
    // always > 0 in practice.
    expect(markerStrokes.length).toBeGreaterThan(0);
  });

  it('marker strokes use §6.4 pen style (color 0x9D, type 10, width 100)', () => {
    const {tree} = threeNodeTree();
    const layout = radialLayout(tree);
    const {geometries} = emitGeometries({tree, layout});

    const markerStrokes = geometries.filter(isMarkerStroke);
    expect(markerStrokes.length).toBeGreaterThan(0);
    for (const g of markerStrokes) {
      if (!isLine(g)) {
        throw new Error('marker stroke should be straightLine');
      }
      expect(g.penColor).toBe(MARKER_PEN_COLOR);
      expect(g.penType).toBe(MARKER_PEN_TYPE);
      expect(g.penWidth).toBe(MARKER_PEN_WIDTH);
      expect(g.showLassoAfterInsert).toBe(false);
      expect(g.points).toHaveLength(2);
    }
  });

  it('marker strokes are horizontal 3-px segments on the 4-px grid', () => {
    const {tree} = threeNodeTree();
    const layout = radialLayout(tree);
    const {geometries} = emitGeometries({tree, layout});

    const markerStrokes = geometries.filter(isMarkerStroke);
    const originX = layout.unionBbox.x;
    const originY = layout.unionBbox.y;

    for (const g of markerStrokes) {
      if (!isLine(g)) {
        continue;
      }
      const [p0, p1] = g.points;
      expect(p1.y).toBeCloseTo(p0.y, 6); // horizontal
      expect(p1.x - p0.x).toBeCloseTo(MARKER_BIT_STROKE_LEN, 6);

      // Cell alignment: (x - origin.x) should be a multiple of
      // MARKER_CELL_PX; same for y. We don't care which cell, just
      // that it lands on the grid.
      const colReal = (p0.x - originX) / MARKER_CELL_PX;
      const rowReal = (p0.y - originY) / MARKER_CELL_PX;
      expect(colReal).toBeCloseTo(Math.round(colReal), 6);
      expect(rowReal).toBeCloseTo(Math.round(rowReal), 6);
      expect(Math.round(colReal)).toBeGreaterThanOrEqual(0);
      expect(Math.round(colReal)).toBeLessThan(MARKER_GRID);
      expect(Math.round(rowReal)).toBeGreaterThanOrEqual(0);
      expect(Math.round(rowReal)).toBeLessThan(MARKER_GRID);
    }
  });

  it('marker strokes sit between connectors and preserved strokes in emit order', () => {
    const {tree, childId} = threeNodeTree();
    const layout = radialLayout(tree);
    const preservedStrokesByNode = new Map<NodeId, Geometry[]>([
      [
        childId,
        [
          {
            ...PEN_DEFAULTS,
            type: 'straightLine',
            points: [
              {x: 0, y: 0},
              {x: 1, y: 1},
            ],
          } as LineGeometry,
        ],
      ],
    ]);
    const {geometries} = emitGeometries({
      tree,
      layout,
      preservedStrokesByNode,
    });

    // Find the marker block start/end and verify everything before it
    // is outlines/connectors (no marker pen color) and everything after
    // the last marker stroke is preserved-stroke (non-marker).
    const firstMarkerIdx = geometries.findIndex(isMarkerStroke);
    const lastMarkerIdx =
      geometries.length - 1 - [...geometries].reverse().findIndex(isMarkerStroke);
    expect(firstMarkerIdx).toBeGreaterThan(0);
    expect(lastMarkerIdx).toBeLessThan(geometries.length - 1);
    for (let i = 0; i < firstMarkerIdx; i += 1) {
      expect(isMarkerStroke(geometries[i])).toBe(false);
    }
    for (let i = lastMarkerIdx + 1; i < geometries.length; i += 1) {
      expect(isMarkerStroke(geometries[i])).toBe(false);
    }
  });

  it('translates page-coord bboxes to mindmap-local before marker encoding', () => {
    // Shift the whole map by a known offset using the layout, then
    // verify the marker stroke positions still land on the grid
    // anchored at the new unionBbox topleft (i.e. emitGeometries
    // picks up markerOrigin internally from layout.unionBbox).
    const tree = createTree();
    const base = radialLayout(tree);

    const shift = {x: 500, y: 700};
    const shifted = {
      centers: new Map(
        [...base.centers].map(([id, c]) => [
          id,
          {x: c.x + shift.x, y: c.y + shift.y},
        ]),
      ),
      bboxes: new Map(
        [...base.bboxes].map(([id, r]) => [
          id,
          {x: r.x + shift.x, y: r.y + shift.y, w: r.w, h: r.h},
        ]),
      ),
      unionBbox: {
        x: base.unionBbox.x + shift.x,
        y: base.unionBbox.y + shift.y,
        w: base.unionBbox.w,
        h: base.unionBbox.h,
      },
    };

    const {geometries} = emitGeometries({tree, layout: shifted});
    const markerStrokes = geometries.filter(isMarkerStroke);
    expect(markerStrokes.length).toBeGreaterThan(0);
    for (const g of markerStrokes) {
      if (!isLine(g)) {
        continue;
      }
      const [p0] = g.points;
      // Cells must index from the SHIFTED unionBbox topleft.
      const col = (p0.x - shifted.unionBbox.x) / MARKER_CELL_PX;
      const row = (p0.y - shifted.unionBbox.y) / MARKER_CELL_PX;
      expect(col).toBeCloseTo(Math.round(col), 6);
      expect(row).toBeCloseTo(Math.round(row), 6);
      expect(Math.round(col)).toBeGreaterThanOrEqual(0);
      expect(Math.round(row)).toBeGreaterThanOrEqual(0);
    }
  });

  it('throws MarkerCapacityError when the tree exceeds the published node cap (§F-PE-4)', () => {
    const tree = createTree();
    // Add children to push the node count past the cap. +1 to exceed.
    for (let i = 0; i < MARKER_PUBLISHED_NODE_CAP; i += 1) {
      addChild(tree, tree.rootId);
    }
    const layout = radialLayout(tree);

    let thrown: unknown;
    try {
      emitGeometries({tree, layout});
    } catch (err) {
      thrown = err;
    }
    expect(thrown).toBeInstanceOf(MarkerCapacityError);
    if (thrown instanceof MarkerCapacityError) {
      expect(thrown.nodeCount).toBe(MARKER_PUBLISHED_NODE_CAP + 1);
    }
  });
});

// ---------------------------------------------------------------------------
// unionRectOfGeometries — direct unit tests (covers circle/ellipse arms and
// empty-input sentinel that emitGeometries integration tests don't reach)
// ---------------------------------------------------------------------------

describe('unionRectOfGeometries — standalone (§F-IN-3)', () => {
  function makeCircle(cx: number, cy: number, r: number): CircleGeometry {
    return {
      type: 'GEO_circle',
      ellipseCenterPoint: {x: cx, y: cy},
      ellipseMajorAxisRadius: r,
      ellipseMinorAxisRadius: r,
      ellipseAngle: 0,
      ...PEN_DEFAULTS,
    };
  }

  function makeEllipse(
    cx: number,
    cy: number,
    major: number,
    minor: number,
  ): EllipseGeometry {
    return {
      type: 'GEO_ellipse',
      ellipseCenterPoint: {x: cx, y: cy},
      ellipseMajorAxisRadius: major,
      ellipseMinorAxisRadius: minor,
      ellipseAngle: 0,
      ...PEN_DEFAULTS,
    };
  }

  it('returns {0,0,0,0} for an empty geometry list', () => {
    const r = unionRectOfGeometries([]);
    expect(r).toEqual({x: 0, y: 0, w: 0, h: 0});
  });

  it('computes correct bounds for a single GEO_circle', () => {
    const r = unionRectOfGeometries([makeCircle(100, 200, 30)]);
    // Extends from center ± max(major, minor) = 30.
    expect(r).toEqual({x: 70, y: 170, w: 60, h: 60});
  });

  it('computes correct bounds for a GEO_ellipse (uses major radius on both axes)', () => {
    // major=50, minor=20 → bounding square is ±50 from center.
    const r = unionRectOfGeometries([makeEllipse(0, 0, 50, 20)]);
    expect(r).toEqual({x: -50, y: -50, w: 100, h: 100});
  });

  it('unions a circle and a polygon correctly', () => {
    const poly: PolygonGeometry = {
      type: 'GEO_polygon',
      points: [
        {x: 200, y: 200},
        {x: 300, y: 200},
        {x: 300, y: 300},
      ],
      ...PEN_DEFAULTS,
    };
    const circle = makeCircle(0, 0, 50);
    const r = unionRectOfGeometries([poly, circle]);
    // x: min(-50, 200)=-50 to max(50, 300)=300 → w=350
    // y: min(-50, 200)=-50 to max(50, 300)=300 → h=350
    expect(r).toEqual({x: -50, y: -50, w: 350, h: 350});
  });

  it('throws on unknown geometry variant (exhaustiveness guard)', () => {
    const bad = {type: 'UNKNOWN_GEOM'} as unknown as Geometry;
    expect(() => unionRectOfGeometries([bad])).toThrow(
      /unknown geometry variant UNKNOWN_GEOM/,
    );
  });
});

// ---------------------------------------------------------------------------
// emitGeometries — error paths for centerOrThrow / bboxOrThrow
// ---------------------------------------------------------------------------

describe('emitGeometries — layout consistency errors', () => {
  it('throws when layout is missing a node center', () => {
    const tree = createTree();
    const childId = addChild(tree, tree.rootId);
    const layout = radialLayout(tree);
    // Remove the child's center entry to trigger centerOrThrow.
    layout.centers.delete(childId);
    expect(() => emitGeometries({tree, layout})).toThrow(
      /missing layout center/,
    );
  });

  it('throws when layout is missing a node bbox', () => {
    const tree = createTree();
    const childId = addChild(tree, tree.rootId);
    const layout = radialLayout(tree);
    // Remove the child's bbox entry to trigger bboxOrThrow.
    layout.bboxes.delete(childId);
    expect(() => emitGeometries({tree, layout})).toThrow(
      /missing layout bbox/,
    );
  });
});

// ---------------------------------------------------------------------------
// emitGeometries — connector clipping edge-case paths
// (covers fallback branches in clipSegmentBetweenRects / slabIntersect that
// normal radial layouts never reach because their bboxes are always centred
// on their node centres)
// ---------------------------------------------------------------------------

describe('emitGeometries — connector clipping edge cases', () => {
  /**
   * Build a two-node tree (root + one child) with a hand-crafted
   * LayoutResult so we can place bboxes wherever we like.
   */
  function twoNodeLayout(
    rootCenter: {x: number; y: number},
    rootBbox: {x: number; y: number; w: number; h: number},
    childCenter: {x: number; y: number},
    childBbox: {x: number; y: number; w: number; h: number},
  ): {tree: ReturnType<typeof createTree>; layout: LayoutResult} {
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
      unionBbox: {x: -200, y: -200, w: 800, h: 400},
    };
    return {tree, layout};
  }

  it('falls back to center pair when parent center lies outside its own bbox (pSlab null)', () => {
    // Parent center at (0,0) but parent bbox placed far away.
    // slabIntersect for the y-axis will see p0=0 < lo=200 → return null.
    // Connector output falls back to [parentCenter, childCenter].
    const {tree, layout} = twoNodeLayout(
      {x: 0, y: 0},
      {x: -110, y: 200, w: 220, h: 96},   // parent bbox above the x-axis
      {x: 400, y: 0},
      {x: 290, y: -48, w: 220, h: 96},
    );
    const {geometries} = emitGeometries({tree, layout});
    // There should be exactly one connector (root → child). Verify it
    // falls back to the raw center pair — p0 = parentCenter = (0, 0).
    const connectors = geometries.filter(
      g => g.type === 'straightLine' && g.penColor !== MARKER_PEN_COLOR,
    );
    expect(connectors.length).toBe(1);
    if (connectors[0].type !== 'straightLine') throw new Error('type guard');
    expect(connectors[0].points[0]).toEqual({x: 0, y: 0});
    expect(connectors[0].points[1]).toEqual({x: 400, y: 0});
  });

  it('falls back to center pair when parent and child share the same center (dx=dy=0)', () => {
    // When the connector direction vector is zero, slabIntersect returns
    // {tEnter=-Inf, tExit=Inf} for any axis with d=0, so tExit is Infinity
    // and !Number.isFinite(tExit) fires the non-finite guard.
    const sharedCenter = {x: 100, y: 100};
    const {tree, layout} = twoNodeLayout(
      sharedCenter,
      {x: 0, y: 0, w: 220, h: 220},   // bbox contains the shared center
      sharedCenter,                     // same center as parent
      {x: 0, y: 0, w: 220, h: 220},
    );
    const {geometries} = emitGeometries({tree, layout});
    const connectors = geometries.filter(
      g => g.type === 'straightLine' && g.penColor !== MARKER_PEN_COLOR,
    );
    expect(connectors.length).toBe(1);
    if (connectors[0].type !== 'straightLine') throw new Error('type guard');
    // Fallback: both endpoints equal the shared center.
    expect(connectors[0].points[0]).toEqual(sharedCenter);
    expect(connectors[0].points[1]).toEqual(sharedCenter);
  });

  it('falls back when cSlab is null because the connector does not intersect the child bbox (tEnter > tExit)', () => {
    // Line from (0,0) toward (500,300) — direction (500,300).
    // Child bbox at x=[-10,10], y=[200,250]: x-slab t in [-0.02, 0.02]
    // but y-slab t in [0.67, 0.83]. Since max(-0.02,0.67) > min(0.02,0.83),
    // slabIntersect returns null (tEnter > tExit) for the child bbox.
    const {tree, layout} = twoNodeLayout(
      {x: 0, y: 0},
      {x: -110, y: -48, w: 220, h: 96},   // normal parent bbox (contains center)
      {x: 500, y: 300},
      {x: -10, y: 200, w: 20, h: 50},     // narrow bbox far off the connector line
    );
    const {geometries} = emitGeometries({tree, layout});
    const connectors = geometries.filter(
      g => g.type === 'straightLine' && g.penColor !== MARKER_PEN_COLOR,
    );
    expect(connectors.length).toBe(1);
    if (connectors[0].type !== 'straightLine') throw new Error('type guard');
    // Falls back to raw centers.
    expect(connectors[0].points[0]).toEqual({x: 0, y: 0});
    expect(connectors[0].points[1]).toEqual({x: 500, y: 300});
  });
});
