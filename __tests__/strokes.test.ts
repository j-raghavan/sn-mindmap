/**
 * Tests for src/model/strokes.ts (Phase 4.1 + 4.2).
 *
 * Coverage:
 *   - associateStrokes (§F-ED-5 / §8.1)
 *     - Obvious single-match case.
 *     - Zero-match → outOfMap bucket.
 *     - Multi-match resolved by point-mass.
 *     - Point-mass tie falls to earliest candidate (Map insertion order).
 *     - Supports all four Geometry variants (straightLine, GEO_polygon,
 *       GEO_circle, GEO_ellipse).
 *     - Ellipse / circle association uses `ellipseCenterPoint`.
 *     - Empty-points polyline → (0, 0) centroid (degenerate but safe).
 *     - Empty input list → empty association.
 *     - Buckets preserve input-array order; empty buckets never appear.
 *     - Input strokes, bboxes, and point arrays are not mutated.
 *     - Pen color / width / type preserved verbatim in the result.
 *   - translateStrokes (§F-ED-7)
 *     - Per-variant translation (all four Geometry types).
 *     - Zero delta is a no-op (values, not identity).
 *     - Negative delta works symmetrically.
 *     - Input strokes are not mutated (point arrays cloned).
 *     - Pen style (color / width / type) preserved verbatim.
 */
import {
  associateStrokes,
  translateStrokes,
  type PreservedStroke,
} from '../src/model/strokes';
import type {NodeId} from '../src/model/tree';
import type {PenStyle, Point, Rect} from '../src/geometry';

// ---------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------

const PEN: PenStyle = {penColor: 0x00, penType: 10, penWidth: 400};
const PEN_RED: PenStyle = {penColor: 0xff0000, penType: 11, penWidth: 300};

function line(points: Point[], pen: PenStyle = PEN): PreservedStroke {
  return {type: 'straightLine', points, ...pen};
}

function polyline(points: Point[], pen: PenStyle = PEN): PreservedStroke {
  return {type: 'GEO_polygon', points, ...pen};
}

function circle(center: Point, pen: PenStyle = PEN): PreservedStroke {
  return {
    type: 'GEO_circle',
    ellipseCenterPoint: center,
    ellipseMajorAxisRadius: 10,
    ellipseMinorAxisRadius: 10,
    ellipseAngle: 0,
    ...pen,
  };
}

function ellipse(center: Point, pen: PenStyle = PEN): PreservedStroke {
  return {
    type: 'GEO_ellipse',
    ellipseCenterPoint: center,
    ellipseMajorAxisRadius: 14,
    ellipseMinorAxisRadius: 8,
    ellipseAngle: 0,
    ...pen,
  };
}

function rect(x: number, y: number, w: number, h: number): Rect {
  return {x, y, w, h};
}

function id(n: number): NodeId {
  return n as NodeId;
}

// ---------------------------------------------------------------------
// associateStrokes
// ---------------------------------------------------------------------

describe('associateStrokes', () => {
  it('returns empty buckets for empty input', () => {
    const bboxes = new Map<NodeId, Rect>([[id(1), rect(0, 0, 100, 100)]]);
    const res = associateStrokes([], bboxes);
    expect(res.byNode.size).toBe(0);
    expect(res.outOfMap).toEqual([]);
  });

  it('associates a polyline stroke to the node whose bbox contains its centroid', () => {
    const bboxes = new Map<NodeId, Rect>([
      [id(1), rect(0, 0, 100, 100)],
      [id(2), rect(200, 0, 100, 100)],
    ]);
    // Centroid at (50, 50) → inside node 1 only.
    const s = polyline([
      {x: 40, y: 40},
      {x: 60, y: 60},
    ]);
    const res = associateStrokes([s], bboxes);
    expect(res.byNode.get(id(1))).toEqual([s]);
    expect(res.byNode.has(id(2))).toBe(false);
    expect(res.outOfMap).toEqual([]);
  });

  it('sends strokes whose centroid lies outside every bbox to outOfMap', () => {
    const bboxes = new Map<NodeId, Rect>([
      [id(1), rect(0, 0, 100, 100)],
      [id(2), rect(200, 0, 100, 100)],
    ]);
    const s = polyline([
      {x: 500, y: 500},
      {x: 510, y: 520},
    ]);
    const res = associateStrokes([s], bboxes);
    expect(res.byNode.size).toBe(0);
    expect(res.outOfMap).toEqual([s]);
  });

  it('associates on straightLine variant', () => {
    const bboxes = new Map<NodeId, Rect>([[id(7), rect(0, 0, 100, 100)]]);
    const s = line([
      {x: 10, y: 10},
      {x: 90, y: 90},
    ]);
    const res = associateStrokes([s], bboxes);
    expect(res.byNode.get(id(7))).toEqual([s]);
  });

  it('associates GEO_circle by its ellipseCenterPoint', () => {
    const bboxes = new Map<NodeId, Rect>([
      [id(1), rect(0, 0, 100, 100)],
      [id(2), rect(200, 0, 100, 100)],
    ]);
    const s = circle({x: 250, y: 50});
    const res = associateStrokes([s], bboxes);
    expect(res.byNode.get(id(2))).toEqual([s]);
    expect(res.byNode.has(id(1))).toBe(false);
  });

  it('associates GEO_ellipse by its ellipseCenterPoint', () => {
    const bboxes = new Map<NodeId, Rect>([
      [id(1), rect(0, 0, 100, 100)],
      [id(2), rect(200, 0, 100, 100)],
    ]);
    const s = ellipse({x: 50, y: 50});
    const res = associateStrokes([s], bboxes);
    expect(res.byNode.get(id(1))).toEqual([s]);
  });

  it('sends an ellipse whose center lies outside every bbox to outOfMap', () => {
    const bboxes = new Map<NodeId, Rect>([[id(1), rect(0, 0, 100, 100)]]);
    const s = ellipse({x: -10, y: -10});
    const res = associateStrokes([s], bboxes);
    expect(res.outOfMap).toEqual([s]);
    expect(res.byNode.size).toBe(0);
  });

  it('picks the higher-mass candidate when bboxes overlap (§8.1 tie-break)', () => {
    // A is a small sliver around the centroid (so the centroid is in
    // both A and B), but most of the stroke's points lie inside B.
    // Expected winner: B (higher point mass).
    const bboxes = new Map<NodeId, Rect>([
      [id(1), rect(40, 40, 20, 20)], // A — sliver around centroid
      [id(2), rect(0, 0, 100, 100)], // B — whole field
    ]);
    const s = polyline([
      {x: 50, y: 50}, // in A and B
      {x: 10, y: 10}, // B only
      {x: 90, y: 10}, // B only
      {x: 10, y: 90}, // B only
      {x: 90, y: 90}, // B only
    ]);
    // centroid = ((50+10+90+10+90)/5, (50+10+10+90+90)/5) = (50, 50).
    // A contains only point #0 (mass=1). B contains all 5 (mass=5).
    // Expected: B wins.
    const res = associateStrokes([s], bboxes);
    expect(res.byNode.get(id(2))).toEqual([s]);
    expect(res.byNode.has(id(1))).toBe(false);
  });

  it('breaks a point-mass tie by Map insertion order (earliest candidate wins)', () => {
    // Both bboxes cover the full field and every point, so mass is
    // equal. Earliest inserted candidate (node 1) must win.
    const bboxes = new Map<NodeId, Rect>([
      [id(1), rect(0, 0, 100, 100)], // A — inserted first
      [id(2), rect(0, 0, 100, 100)], // B — same bbox, inserted second
    ]);
    const s = polyline([
      {x: 40, y: 40},
      {x: 50, y: 50},
      {x: 60, y: 60},
    ]);
    const res = associateStrokes([s], bboxes);
    expect(res.byNode.get(id(1))).toEqual([s]);
    expect(res.byNode.has(id(2))).toBe(false);
  });

  it('preserves input-array order within each bucket', () => {
    const bboxes = new Map<NodeId, Rect>([[id(1), rect(0, 0, 100, 100)]]);
    const a = polyline([{x: 10, y: 10}, {x: 20, y: 20}]);
    const b = polyline([{x: 30, y: 30}, {x: 40, y: 40}]);
    const c = polyline([{x: 50, y: 50}, {x: 60, y: 60}]);
    const res = associateStrokes([a, b, c], bboxes);
    expect(res.byNode.get(id(1))).toEqual([a, b, c]);
  });

  it('never creates empty buckets for nodes that receive no strokes', () => {
    const bboxes = new Map<NodeId, Rect>([
      [id(1), rect(0, 0, 100, 100)],
      [id(2), rect(200, 0, 100, 100)],
    ]);
    const s = polyline([{x: 10, y: 10}, {x: 20, y: 20}]);
    const res = associateStrokes([s], bboxes);
    expect(res.byNode.has(id(1))).toBe(true);
    expect(res.byNode.has(id(2))).toBe(false);
  });

  it('handles empty-points polyline without throwing (centroid falls to (0,0))', () => {
    const bboxes = new Map<NodeId, Rect>([
      [id(1), rect(-10, -10, 20, 20)], // contains (0,0)
    ]);
    const s = polyline([]);
    const res = associateStrokes([s], bboxes);
    expect(res.byNode.get(id(1))).toEqual([s]);
  });

  it('sends empty-points polyline to outOfMap when (0,0) is outside every bbox', () => {
    const bboxes = new Map<NodeId, Rect>([
      [id(1), rect(100, 100, 50, 50)], // far from origin
    ]);
    const s = polyline([]);
    const res = associateStrokes([s], bboxes);
    expect(res.outOfMap).toEqual([s]);
  });

  it('does not mutate input strokes, points, or bboxes', () => {
    const bboxes = new Map<NodeId, Rect>([
      [id(1), rect(0, 0, 100, 100)],
      [id(2), rect(200, 0, 100, 100)],
    ]);
    const bboxesBefore = JSON.stringify(Array.from(bboxes.entries()));
    const pts = [
      {x: 10, y: 10},
      {x: 20, y: 20},
    ];
    const ptsSnapshot = JSON.stringify(pts);
    const s = polyline(pts);
    const sSnapshot = JSON.stringify(s);
    associateStrokes([s], bboxes);
    expect(JSON.stringify(pts)).toBe(ptsSnapshot);
    expect(JSON.stringify(s)).toBe(sSnapshot);
    expect(JSON.stringify(Array.from(bboxes.entries()))).toBe(bboxesBefore);
  });

  it('preserves pen color / width / type verbatim', () => {
    const bboxes = new Map<NodeId, Rect>([[id(1), rect(0, 0, 100, 100)]]);
    const s = polyline(
      [{x: 50, y: 50}],
      {penColor: 0x123456, penType: 11, penWidth: 250},
    );
    const res = associateStrokes([s], bboxes);
    const bucket = res.byNode.get(id(1));
    expect(bucket).toBeDefined();
    const [got] = bucket!;
    expect(got).toBe(s);
    expect(got.penColor).toBe(0x123456);
    expect(got.penType).toBe(11);
    expect(got.penWidth).toBe(250);
  });

  it('routes strokes to distinct nodes correctly in a mixed batch', () => {
    const bboxes = new Map<NodeId, Rect>([
      [id(1), rect(0, 0, 100, 100)],
      [id(2), rect(200, 0, 100, 100)],
      [id(3), rect(0, 200, 100, 100)],
    ]);
    const a = polyline([{x: 50, y: 50}]); // → 1
    const b = circle({x: 250, y: 50}); // → 2
    const c = ellipse({x: 50, y: 250}); // → 3
    const d = line([{x: 10, y: 10}, {x: 20, y: 20}]); // → 1
    const e = polyline([{x: 999, y: 999}]); // → outOfMap
    const res = associateStrokes([a, b, c, d, e], bboxes);
    expect(res.byNode.get(id(1))).toEqual([a, d]);
    expect(res.byNode.get(id(2))).toEqual([b]);
    expect(res.byNode.get(id(3))).toEqual([c]);
    expect(res.outOfMap).toEqual([e]);
  });
});

// ---------------------------------------------------------------------
// translateStrokes
// ---------------------------------------------------------------------

describe('translateStrokes', () => {
  it('returns an empty array for empty input', () => {
    expect(translateStrokes([], {x: 5, y: 7})).toEqual([]);
  });

  it('translates a straightLine stroke by (dx, dy)', () => {
    const s = line([
      {x: 10, y: 20},
      {x: 30, y: 40},
    ]);
    const [out] = translateStrokes([s], {x: 5, y: -3});
    expect(out.type).toBe('straightLine');
    if (out.type !== 'straightLine') {
      throw new Error('type narrowing');
    }
    expect(out.points).toEqual([
      {x: 15, y: 17},
      {x: 35, y: 37},
    ]);
  });

  it('translates a GEO_polygon stroke by (dx, dy)', () => {
    const s = polyline([
      {x: 0, y: 0},
      {x: 10, y: 10},
      {x: 20, y: 0},
    ]);
    const [out] = translateStrokes([s], {x: 100, y: 200});
    expect(out.type).toBe('GEO_polygon');
    if (out.type !== 'GEO_polygon') {
      throw new Error('type narrowing');
    }
    expect(out.points).toEqual([
      {x: 100, y: 200},
      {x: 110, y: 210},
      {x: 120, y: 200},
    ]);
  });

  it('translates a GEO_circle stroke via ellipseCenterPoint and preserves axes/angle', () => {
    const s = circle({x: 50, y: 50});
    const [out] = translateStrokes([s], {x: 10, y: 20});
    expect(out.type).toBe('GEO_circle');
    if (out.type !== 'GEO_circle') {
      throw new Error('type narrowing');
    }
    expect(out.ellipseCenterPoint).toEqual({x: 60, y: 70});
    expect(out.ellipseMajorAxisRadius).toBe(10);
    expect(out.ellipseMinorAxisRadius).toBe(10);
    expect(out.ellipseAngle).toBe(0);
  });

  it('translates a GEO_ellipse stroke via ellipseCenterPoint and preserves axes/angle', () => {
    const s = ellipse({x: 100, y: 100});
    const [out] = translateStrokes([s], {x: -30, y: -40});
    expect(out.type).toBe('GEO_ellipse');
    if (out.type !== 'GEO_ellipse') {
      throw new Error('type narrowing');
    }
    expect(out.ellipseCenterPoint).toEqual({x: 70, y: 60});
    expect(out.ellipseMajorAxisRadius).toBe(14);
    expect(out.ellipseMinorAxisRadius).toBe(8);
    expect(out.ellipseAngle).toBe(0);
  });

  it('is a value-level no-op when delta is (0, 0)', () => {
    const a = polyline([
      {x: 10, y: 20},
      {x: 30, y: 40},
    ]);
    const b = circle({x: 55, y: 66});
    const [outA, outB] = translateStrokes([a, b], {x: 0, y: 0});
    // translateStrokes always returns fresh objects, even at
    // zero-delta. Equal by value, not by reference.
    expect(outA).toEqual(a);
    expect(outB).toEqual(b);
    expect(outA).not.toBe(a);
    expect(outB).not.toBe(b);
  });

  it('handles negative delta symmetrically (round-trips to identity)', () => {
    const s = polyline([
      {x: 100, y: 200},
      {x: 150, y: 250},
    ]);
    const moved = translateStrokes([s], {x: 13, y: -7});
    const back = translateStrokes(moved, {x: -13, y: 7});
    expect(back[0]).toEqual(s);
  });

  it('does not mutate input strokes or their point arrays', () => {
    const pts = [
      {x: 10, y: 20},
      {x: 30, y: 40},
    ];
    const s = polyline(pts);
    const ptsSnapshot = JSON.stringify(pts);
    const sSnapshot = JSON.stringify(s);
    translateStrokes([s], {x: 5, y: 7});
    expect(JSON.stringify(pts)).toBe(ptsSnapshot);
    expect(JSON.stringify(s)).toBe(sSnapshot);
  });

  it('does not mutate input ellipseCenterPoint', () => {
    const center = {x: 100, y: 200};
    const s = circle(center);
    const centerSnapshot = JSON.stringify(center);
    const sSnapshot = JSON.stringify(s);
    const [out] = translateStrokes([s], {x: 10, y: 20});
    expect(JSON.stringify(center)).toBe(centerSnapshot);
    expect(JSON.stringify(s)).toBe(sSnapshot);
    if (out.type !== 'GEO_circle') {
      throw new Error('type narrowing');
    }
    // Translated point must be a distinct object, not the input center
    // with shared identity.
    expect(out.ellipseCenterPoint).not.toBe(center);
  });

  it('preserves pen style verbatim across all variants', () => {
    const strokes: PreservedStroke[] = [
      line([{x: 0, y: 0}, {x: 1, y: 1}], PEN_RED),
      polyline([{x: 0, y: 0}, {x: 2, y: 2}], PEN_RED),
      circle({x: 5, y: 5}, PEN_RED),
      ellipse({x: 9, y: 9}, PEN_RED),
    ];
    const out = translateStrokes(strokes, {x: 1, y: 1});
    for (const o of out) {
      expect(o.penColor).toBe(PEN_RED.penColor);
      expect(o.penType).toBe(PEN_RED.penType);
      expect(o.penWidth).toBe(PEN_RED.penWidth);
    }
  });

  it('preserves order across a mixed-variant batch', () => {
    const a = line([{x: 0, y: 0}, {x: 1, y: 1}]);
    const b = polyline([{x: 2, y: 2}, {x: 3, y: 3}]);
    const c = circle({x: 4, y: 4});
    const d = ellipse({x: 5, y: 5});
    const out = translateStrokes([a, b, c, d], {x: 10, y: 10});
    expect(out.map(s => s.type)).toEqual([
      'straightLine',
      'GEO_polygon',
      'GEO_circle',
      'GEO_ellipse',
    ]);
  });

  it('produces new point-array references (not shared with input)', () => {
    const s = polyline([{x: 10, y: 20}]);
    if (s.type !== 'GEO_polygon') {
      throw new Error('type narrowing');
    }
    const [out] = translateStrokes([s], {x: 1, y: 1});
    if (out.type !== 'GEO_polygon') {
      throw new Error('type narrowing');
    }
    // The translated points array must be a new array, not the same
    // reference. Otherwise mutating the original later would silently
    // change the previously-translated bucket.
    expect(out.points).not.toBe(s.points);
    expect(out.points[0]).not.toBe(s.points[0]);
  });
});
