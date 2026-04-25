/**
 * Node outline geometry builders per §F-IN-2 step 1.
 *
 * Three shape kinds, selected by ShapeKind (the per-node stored byte
 * from §6.3):
 *
 *   OVAL              — stadium (elongated rounded rectangle with
 *                       fully-rounded short ends), darker border per
 *                       §F-AC-2 (default ROOT_PEN_WIDTH = 500).
 *   RECTANGLE         — 4 sharp corners, standard border
 *                       (STANDARD_PEN_WIDTH = 400).
 *   ROUNDED_RECTANGLE — small corner radius (SIBLING_CORNER_RADIUS
 *                       = 15), standard border.
 *
 * All three are emitted as GEO_polygon with closed point lists. The
 * spec's alternative GEO_ellipse path for OVAL (when proportions
 * match) is deferred to the §10 tuning pass — the stadium polygon is
 * visually identical for the default 220×96 node bbox and keeps the
 * point-count deterministic, which matters for the marker bbox
 * encoding (§6.3).
 *
 * The pure point-building helpers (rectanglePoints,
 * roundedRectPoints) are exported so the Phase 1 authoring canvas
 * can reuse the same math when rendering outlines via React Native
 * SVG — that keeps the "one shape, one source of truth" DRY
 * guarantee across the two consumers (canvas, insert emitter).
 */
import {
  PEN_DEFAULTS,
  type Geometry,
  type Point,
  type PolygonGeometry,
  type Rect,
} from '../geometry';
import {ShapeKind} from '../model/tree';
import {
  PARALLELOGRAM_SKEW_PX,
  ROOT_PEN_WIDTH,
  SIBLING_CORNER_RADIUS,
} from '../layout/constants';

export type NodeFrameOptions = {
  /**
   * Border weight. Defaults to PEN_DEFAULTS.penWidth for RECTANGLE
   * and ROUNDED_RECTANGLE. The OVAL uses ROOT_PEN_WIDTH (≥ 500)
   * per §F-AC-2 when omitted.
   */
  penWidth?: number;
};

/**
 * Point density along each rounded corner's arc. Eight mirrors the
 * sn-shapes roundedRectPoints default so the two plugins produce
 * visually identical outlines when viewed side-by-side on the same
 * device.
 */
const SEGMENTS_PER_CORNER = 8;

/**
 * Build the outline geometry for a node at the given bbox with the
 * given shape kind. Output is ready to pass to
 * PluginCommAPI.insertGeometry with `showLassoAfterInsert: false`
 * (§F-IN-3) — the caller batches and then lassos the union-rect.
 */
export function nodeFrame(
  bbox: Rect,
  shape: ShapeKind,
  opts: NodeFrameOptions = {},
): Geometry {
  switch (shape) {
    case ShapeKind.OVAL:
      return polygon(
        ovalPoints(bbox),
        opts.penWidth ?? ROOT_PEN_WIDTH,
      );
    case ShapeKind.RECTANGLE:
      return polygon(
        rectanglePoints(bbox),
        opts.penWidth ?? PEN_DEFAULTS.penWidth,
      );
    case ShapeKind.ROUNDED_RECTANGLE:
      return polygon(
        roundedRectPoints(bbox, SIBLING_CORNER_RADIUS),
        opts.penWidth ?? PEN_DEFAULTS.penWidth,
      );
    case ShapeKind.PARALLELOGRAM:
      return polygon(
        parallelogramPoints(bbox, PARALLELOGRAM_SKEW_PX),
        opts.penWidth ?? PEN_DEFAULTS.penWidth,
      );
    default:
      // Exhaustiveness guard: if ShapeKind grows a new value and a
      // new case isn't added here, TypeScript will flag this branch.
      // The runtime throw stays as a defense-in-depth check for JS
      // callers that could sneak past the type system.
      throw new Error(`nodeFrame: unknown shape kind ${shape as number}`);
  }
}

/**
 * Four corner points of an axis-aligned rectangle, ordered
 * clockwise from top-left. Open list — the caller (polygon()
 * below) closes the polygon by appending the first point.
 */
export function rectanglePoints(bbox: Rect): Point[] {
  const {x, y, w, h} = bbox;
  return [
    {x, y},
    {x: x + w, y},
    {x: x + w, y: y + h},
    {x, y: y + h},
  ];
}

/**
 * Vertices of a rounded rectangle, sampled along each corner arc.
 * Edges between corners are implicit straight segments when the
 * resulting polygon is rendered. `cornerRadius` is clamped to the
 * rectangle's half-dimensions so the output is well-defined even
 * when the caller requests an aggressive radius (used for OVAL).
 *
 * Mirrors the sn-shapes helper of the same name so both plugins
 * produce visually identical outlines.
 */
export function roundedRectPoints(bbox: Rect, cornerRadius: number): Point[] {
  const {center, halfW, halfH} = halfDims(bbox);
  const r = Math.min(Math.max(cornerRadius, 0), halfW, halfH);

  const corners = [
    {cx: center.x + halfW - r, cy: center.y - halfH + r, from: -Math.PI / 2, to: 0},
    {cx: center.x + halfW - r, cy: center.y + halfH - r, from: 0, to: Math.PI / 2},
    {cx: center.x - halfW + r, cy: center.y + halfH - r, from: Math.PI / 2, to: Math.PI},
    {cx: center.x - halfW + r, cy: center.y - halfH + r, from: Math.PI, to: (3 * Math.PI) / 2},
  ];

  const points: Point[] = [];
  for (const {cx, cy, from, to} of corners) {
    for (let i = 0; i <= SEGMENTS_PER_CORNER; i += 1) {
      const angle = from + ((to - from) * i) / SEGMENTS_PER_CORNER;
      points.push({
        x: cx + r * Math.cos(angle),
        y: cy + r * Math.sin(angle),
      });
    }
  }
  return points;
}

/**
 * Vertices of a "stadium" — an elongated rounded rectangle whose
 * short edges fully round into semicircles, per §F-AC-2. Computed
 * by sharing roundedRectPoints with a cornerRadius equal to half
 * the rectangle's shorter dimension.
 */
function ovalPoints(bbox: Rect): Point[] {
  const {halfW, halfH} = halfDims(bbox);
  return roundedRectPoints(bbox, Math.min(halfW, halfH));
}

/**
 * Vertices of a parallelogram inscribed in `bbox`, slanted right by
 * `skew` pixels. Top edge shifts right by `skew`; bottom edge shifts
 * left by the same amount. The four-point list is open — `polygon()`
 * closes it by appending the first point.
 *
 *   ┌──────────┐         skew →
 *   │          │      ╱──────────╱
 *   │   bbox   │     ╱          ╱
 *   │          │    ╱          ╱
 *   └──────────┘   ╱──────────╱
 *
 * `skew` is clamped to `bbox.w / 2` so the shape never collapses to
 * a line for narrow rectangles. Output points walk clockwise from
 * the top-left vertex of the slanted shape.
 */
export function parallelogramPoints(bbox: Rect, skew: number): Point[] {
  const {x, y, w, h} = bbox;
  const s = Math.max(0, Math.min(skew, w / 2));
  return [
    {x: x + s, y},
    {x: x + w, y},
    {x: x + w - s, y: y + h},
    {x, y: y + h},
  ];
}

/**
 * bbox → {center, halfW, halfH} in one place. Used by every shape
 * helper so the "Rect uses (x, y, w, h) top-left-anchored" detail
 * only has to be unpacked once.
 */
function halfDims(bbox: Rect): {center: Point; halfW: number; halfH: number} {
  const halfW = bbox.w / 2;
  const halfH = bbox.h / 2;
  return {
    center: {x: bbox.x + halfW, y: bbox.y + halfH},
    halfW,
    halfH,
  };
}

/**
 * Wrap an open point list into a closed PolygonGeometry, applying
 * the plugin's standard pen style (black, standard type) with the
 * given border width. `showLassoAfterInsert: false` is implicit via
 * the default — the caller sets the explicit lasso at the union
 * rect per §F-IN-3.
 */
function polygon(points: Point[], penWidth: number): PolygonGeometry {
  return {
    ...PEN_DEFAULTS,
    penWidth,
    type: 'GEO_polygon',
    points: [...points, points[0]],
  };
}
