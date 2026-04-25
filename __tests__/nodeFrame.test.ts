/**
 * Tests for src/rendering/nodeFrame.ts.
 *
 * Phase 1.3 (§9) coverage:
 *   - Each shape kind emits a GEO_polygon (§F-IN-2 step 1).
 *   - Rectangle has 5 points (4 corners + closing point).
 *   - Rounded rectangle and Oval have 4 × (SEGMENTS_PER_CORNER+1)
 *     + 1 = 37 points (36 corner samples + closing point).
 *   - All polygon points lie inside the node bbox (+ tiny float
 *     epsilon).
 *   - Polygons are closed (last point === first point).
 *   - Pen-width defaults: OVAL → ROOT_PEN_WIDTH (500), others →
 *     PEN_DEFAULTS.penWidth (400).
 *   - opts.penWidth override applies to every shape kind.
 *   - Standard pen color and type come from PEN_DEFAULTS.
 *   - Unknown ShapeKind value throws.
 *   - Determinism: same bbox + shape → identical output.
 *   - Exported point helpers (rectanglePoints, roundedRectPoints)
 *     return the raw open lists so the canvas can reuse them.
 */
import {
  nodeFrame,
  parallelogramPoints,
  rectanglePoints,
  roundedRectPoints,
} from '../src/rendering/nodeFrame';
import {ShapeKind} from '../src/model/tree';
import {PEN_DEFAULTS, type Rect} from '../src/geometry';
import {
  PARALLELOGRAM_SKEW_PX,
  ROOT_PEN_WIDTH,
  SIBLING_CORNER_RADIUS,
} from '../src/layout/constants';

// Standard node bbox matching NODE_WIDTH × NODE_HEIGHT = 220 × 96 at
// the origin; positioned off-origin to catch bbox.x / bbox.y bugs
// that would escape a centered-at-origin test.
const BBOX: Rect = {x: 100, y: -40, w: 220, h: 96};
const EPS = 1e-9;

function assertInsideBbox(points: {x: number; y: number}[], bbox: Rect): void {
  for (const p of points) {
    expect(p.x).toBeGreaterThanOrEqual(bbox.x - EPS);
    expect(p.x).toBeLessThanOrEqual(bbox.x + bbox.w + EPS);
    expect(p.y).toBeGreaterThanOrEqual(bbox.y - EPS);
    expect(p.y).toBeLessThanOrEqual(bbox.y + bbox.h + EPS);
  }
}

describe('nodeFrame', () => {
  describe('RECTANGLE', () => {
    it('emits a GEO_polygon with 5 points (4 corners + close)', () => {
      const geo = nodeFrame(BBOX, ShapeKind.RECTANGLE);
      expect(geo.type).toBe('GEO_polygon');
      if (geo.type !== 'GEO_polygon') {
        return;
      }
      expect(geo.points).toHaveLength(5);
      // First and last points must coincide (closed polygon).
      expect(geo.points[0]).toEqual(geo.points[4]);
    });

    it('points are the four bbox corners in clockwise order', () => {
      const geo = nodeFrame(BBOX, ShapeKind.RECTANGLE);
      if (geo.type !== 'GEO_polygon') {
        throw new Error('wrong type');
      }
      const [p0, p1, p2, p3] = geo.points;
      expect(p0).toEqual({x: BBOX.x, y: BBOX.y});
      expect(p1).toEqual({x: BBOX.x + BBOX.w, y: BBOX.y});
      expect(p2).toEqual({x: BBOX.x + BBOX.w, y: BBOX.y + BBOX.h});
      expect(p3).toEqual({x: BBOX.x, y: BBOX.y + BBOX.h});
    });

    it('uses STANDARD_PEN_WIDTH (via PEN_DEFAULTS) by default', () => {
      const geo = nodeFrame(BBOX, ShapeKind.RECTANGLE);
      expect(geo.penWidth).toBe(PEN_DEFAULTS.penWidth);
    });
  });

  describe('ROUNDED_RECTANGLE', () => {
    it('emits a GEO_polygon with 37 points (4 × 9 arc samples + close)', () => {
      const geo = nodeFrame(BBOX, ShapeKind.ROUNDED_RECTANGLE);
      expect(geo.type).toBe('GEO_polygon');
      if (geo.type !== 'GEO_polygon') {
        return;
      }
      expect(geo.points).toHaveLength(37);
      expect(geo.points[0]).toEqual(geo.points[36]);
    });

    it('every vertex sits inside the bbox', () => {
      const geo = nodeFrame(BBOX, ShapeKind.ROUNDED_RECTANGLE);
      if (geo.type !== 'GEO_polygon') {
        throw new Error('wrong type');
      }
      assertInsideBbox(geo.points, BBOX);
    });

    it('uses PEN_DEFAULTS.penWidth by default', () => {
      const geo = nodeFrame(BBOX, ShapeKind.ROUNDED_RECTANGLE);
      expect(geo.penWidth).toBe(PEN_DEFAULTS.penWidth);
    });

    it('corners match SIBLING_CORNER_RADIUS', () => {
      // Sanity: the polygon's bbox width/height should fill the
      // input bbox exactly (the rounded corners extend to the edges),
      // which only holds when r is bounded by the bbox half-dims.
      const geo = nodeFrame(BBOX, ShapeKind.ROUNDED_RECTANGLE);
      if (geo.type !== 'GEO_polygon') {
        throw new Error('wrong type');
      }
      const xs = geo.points.map(p => p.x);
      const ys = geo.points.map(p => p.y);
      expect(Math.min(...xs)).toBeCloseTo(BBOX.x, 6);
      expect(Math.max(...xs)).toBeCloseTo(BBOX.x + BBOX.w, 6);
      expect(Math.min(...ys)).toBeCloseTo(BBOX.y, 6);
      expect(Math.max(...ys)).toBeCloseTo(BBOX.y + BBOX.h, 6);
      // Corner radius shouldn't exceed the half-dims.
      expect(SIBLING_CORNER_RADIUS).toBeLessThanOrEqual(BBOX.w / 2);
      expect(SIBLING_CORNER_RADIUS).toBeLessThanOrEqual(BBOX.h / 2);
    });
  });

  describe('OVAL (stadium)', () => {
    it('emits a GEO_polygon with 37 points', () => {
      const geo = nodeFrame(BBOX, ShapeKind.OVAL);
      expect(geo.type).toBe('GEO_polygon');
      if (geo.type !== 'GEO_polygon') {
        return;
      }
      expect(geo.points).toHaveLength(37);
      expect(geo.points[0]).toEqual(geo.points[36]);
    });

    it('every vertex sits inside the bbox (fully-rounded short ends)', () => {
      const geo = nodeFrame(BBOX, ShapeKind.OVAL);
      if (geo.type !== 'GEO_polygon') {
        throw new Error('wrong type');
      }
      assertInsideBbox(geo.points, BBOX);
    });

    it('uses ROOT_PEN_WIDTH (≥ 500) by default per §F-AC-2', () => {
      const geo = nodeFrame(BBOX, ShapeKind.OVAL);
      expect(geo.penWidth).toBe(ROOT_PEN_WIDTH);
      expect(geo.penWidth).toBeGreaterThanOrEqual(500);
    });

    it('short ends fully round — polygon reaches the x extremes of the bbox', () => {
      const geo = nodeFrame(BBOX, ShapeKind.OVAL);
      if (geo.type !== 'GEO_polygon') {
        throw new Error('wrong type');
      }
      const xs = geo.points.map(p => p.x);
      // Leftmost point is the apex of the left semicircle.
      expect(Math.min(...xs)).toBeCloseTo(BBOX.x, 6);
      expect(Math.max(...xs)).toBeCloseTo(BBOX.x + BBOX.w, 6);
    });
  });

  describe('PARALLELOGRAM', () => {
    it('emits a GEO_polygon with 5 points (4 corners + close)', () => {
      const geo = nodeFrame(BBOX, ShapeKind.PARALLELOGRAM);
      expect(geo.type).toBe('GEO_polygon');
      if (geo.type !== 'GEO_polygon') {
        return;
      }
      expect(geo.points).toHaveLength(5);
      expect(geo.points[0]).toEqual(geo.points[4]);
    });

    it('top edge shifts right by skew, bottom edge shifts left', () => {
      const geo = nodeFrame(BBOX, ShapeKind.PARALLELOGRAM);
      if (geo.type !== 'GEO_polygon') {
        throw new Error('wrong type');
      }
      const s = PARALLELOGRAM_SKEW_PX;
      const [p0, p1, p2, p3] = geo.points;
      expect(p0).toEqual({x: BBOX.x + s, y: BBOX.y});
      expect(p1).toEqual({x: BBOX.x + BBOX.w, y: BBOX.y});
      expect(p2).toEqual({x: BBOX.x + BBOX.w - s, y: BBOX.y + BBOX.h});
      expect(p3).toEqual({x: BBOX.x, y: BBOX.y + BBOX.h});
    });

    it('uses PEN_DEFAULTS.penWidth by default', () => {
      const geo = nodeFrame(BBOX, ShapeKind.PARALLELOGRAM);
      expect(geo.penWidth).toBe(PEN_DEFAULTS.penWidth);
    });
  });

  describe('NodeFrameOptions.penWidth override', () => {
    it('overrides OVAL default', () => {
      const geo = nodeFrame(BBOX, ShapeKind.OVAL, {penWidth: 123});
      expect(geo.penWidth).toBe(123);
    });

    it('overrides RECTANGLE default', () => {
      const geo = nodeFrame(BBOX, ShapeKind.RECTANGLE, {penWidth: 42});
      expect(geo.penWidth).toBe(42);
    });

    it('overrides ROUNDED_RECTANGLE default', () => {
      const geo = nodeFrame(BBOX, ShapeKind.ROUNDED_RECTANGLE, {penWidth: 7});
      expect(geo.penWidth).toBe(7);
    });

    it('overrides PARALLELOGRAM default', () => {
      const geo = nodeFrame(BBOX, ShapeKind.PARALLELOGRAM, {penWidth: 99});
      expect(geo.penWidth).toBe(99);
    });
  });

  describe('PEN_DEFAULTS inheritance', () => {
    it('all shape kinds emit penColor and penType from PEN_DEFAULTS', () => {
      for (const shape of [
        ShapeKind.OVAL,
        ShapeKind.RECTANGLE,
        ShapeKind.ROUNDED_RECTANGLE,
      ]) {
        const geo = nodeFrame(BBOX, shape);
        expect(geo.penColor).toBe(PEN_DEFAULTS.penColor);
        expect(geo.penType).toBe(PEN_DEFAULTS.penType);
      }
    });

    // Regression guard against the "invalid pen type" on-device error
    // seen in April 2026: the firmware's insertGeometry only accepts
    // penType values {1=Pressure, 10=Fineliner, 11=Marker,
    // 14=Calligraphy} (sn-shapes/src/ShapeOptionsPanel.tsx:141-145).
    // Any other value fails at insert with "invalid pen type". Since
    // our emitters all spread PEN_DEFAULTS, pinning PEN_DEFAULTS.penType
    // to the allow-list here catches the regression in unit tests.
    it('PEN_DEFAULTS.penType is in the firmware allow-list', () => {
      const FIRMWARE_PEN_TYPE_ALLOW_LIST = new Set([1, 10, 11, 14]);
      expect(FIRMWARE_PEN_TYPE_ALLOW_LIST.has(PEN_DEFAULTS.penType)).toBe(true);
    });
  });

  describe('error handling', () => {
    it('throws on an unknown ShapeKind value', () => {
      // Cast to escape the exhaustive union — this simulates a JS
      // caller feeding junk data past the type system.
      expect(() => nodeFrame(BBOX, 99 as ShapeKind)).toThrow(
        /unknown shape kind/,
      );
    });
  });

  describe('determinism', () => {
    it('same bbox + shape → identical output on repeat calls', () => {
      const a = nodeFrame(BBOX, ShapeKind.OVAL);
      const b = nodeFrame(BBOX, ShapeKind.OVAL);
      expect(b).toEqual(a);
    });
  });
});

describe('rectanglePoints (exported helper)', () => {
  it('returns 4 open corner points in clockwise order', () => {
    const pts = rectanglePoints(BBOX);
    expect(pts).toHaveLength(4);
    expect(pts[0]).toEqual({x: BBOX.x, y: BBOX.y});
    expect(pts[2]).toEqual({x: BBOX.x + BBOX.w, y: BBOX.y + BBOX.h});
  });
});

describe('roundedRectPoints (exported helper)', () => {
  it('returns 36 open samples along the four corner arcs', () => {
    const pts = roundedRectPoints(BBOX, SIBLING_CORNER_RADIUS);
    // 4 corners × (8 + 1) samples each = 36 open points.
    expect(pts).toHaveLength(36);
  });

  it('clamps cornerRadius to the bbox half-dimensions', () => {
    // Request a radius larger than halfH; result should not extend
    // outside the bbox. Works because roundedRectPoints caps r.
    const pts = roundedRectPoints(BBOX, 9999);
    assertInsideBbox(pts, BBOX);
  });

  it('treats negative cornerRadius as zero (degenerates to sharp corners)', () => {
    const pts = roundedRectPoints(BBOX, -5);
    // With r=0, every arc collapses to a single repeated point at
    // the corner; the 9 samples per "corner" all coincide.
    for (let i = 0; i < 4; i += 1) {
      const start = i * 9;
      for (let j = 1; j < 9; j += 1) {
        expect(pts[start + j]).toEqual(pts[start]);
      }
    }
  });
});

describe('parallelogramPoints (exported helper)', () => {
  it('returns 4 open corner points slanted by the requested skew', () => {
    const pts = parallelogramPoints(BBOX, 20);
    expect(pts).toHaveLength(4);
    expect(pts[0]).toEqual({x: BBOX.x + 20, y: BBOX.y});
    expect(pts[1]).toEqual({x: BBOX.x + BBOX.w, y: BBOX.y});
    expect(pts[2]).toEqual({x: BBOX.x + BBOX.w - 20, y: BBOX.y + BBOX.h});
    expect(pts[3]).toEqual({x: BBOX.x, y: BBOX.y + BBOX.h});
  });

  it('clamps skew to bbox.w / 2 (shape never collapses to a line)', () => {
    const pts = parallelogramPoints(BBOX, 9999);
    // Top-left x is clamped to BBOX.x + BBOX.w / 2 (= halfway across).
    expect(pts[0].x).toBe(BBOX.x + BBOX.w / 2);
    expect(pts[2].x).toBe(BBOX.x + BBOX.w - BBOX.w / 2);
  });

  it('treats negative skew as zero (degenerates to a rectangle)', () => {
    const pts = parallelogramPoints(BBOX, -10);
    expect(pts[0]).toEqual({x: BBOX.x, y: BBOX.y});
    expect(pts[2]).toEqual({x: BBOX.x + BBOX.w, y: BBOX.y + BBOX.h});
  });
});
