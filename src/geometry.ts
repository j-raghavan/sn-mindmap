/**
 * Local geometry type definitions — minimal mirror of
 * sn-shapes/src/shapes.ts (Point, PenStyle, GeometryFlags, Geometry
 * union). Maintained locally because sn-shapes is not a published
 * package; Phase 2 (§F-IN-* emit work) will decide whether to keep
 * this mirror, vendor the full shapes.ts, or introduce a package.
 *
 * The shape of these types must stay compatible with sn-plugin-lib's
 * PluginCommAPI.insertGeometry signature and with the sn-shapes
 * helpers that requirements §F-IN-2 instructs us to reuse
 * (roundedRectPoints etc.).
 */

export type Point = {x: number; y: number};

export type PenStyle = {
  penColor: number;
  penType: number;
  penWidth: number;
};

export type GeometryFlags = {
  /**
   * When true, sn-plugin-lib's insertGeometry auto-lassos the
   * inserted shape. For multi-geometry blocks (the sn-mindmap insert
   * path, §F-IN-3) EVERY emitted geometry sets this to false and the
   * plugin calls PluginCommAPI.lassoElements(unionRect) explicitly.
   */
  showLassoAfterInsert?: boolean;
};

export type PolygonGeometry = PenStyle &
  GeometryFlags & {
    type: 'GEO_polygon';
    points: Point[];
  };

export type CircleGeometry = PenStyle &
  GeometryFlags & {
    type: 'GEO_circle';
    ellipseCenterPoint: Point;
    ellipseMajorAxisRadius: number;
    ellipseMinorAxisRadius: number;
    ellipseAngle: number;
  };

export type EllipseGeometry = PenStyle &
  GeometryFlags & {
    type: 'GEO_ellipse';
    ellipseCenterPoint: Point;
    ellipseMajorAxisRadius: number;
    ellipseMinorAxisRadius: number;
    ellipseAngle: number;
  };

export type LineGeometry = PenStyle &
  GeometryFlags & {
    type: 'straightLine';
    points: Point[];
  };

export type Geometry =
  | PolygonGeometry
  | CircleGeometry
  | EllipseGeometry
  | LineGeometry;

/**
 * Axis-aligned bounding rectangle. Used for marker placement
 * (§6.1), per-node bbox in the marker payload (§6.3), lasso
 * union-rect (§F-IN-3), and label-to-node association on edit
 * (§F-ED-5 / §8.1).
 */
export type Rect = {
  x: number;
  y: number;
  w: number;
  h: number;
};

/**
 * Default pen style for sn-mindmap emissions. Per the conventions
 * inherited from sn-shapes (§11): black, pen width 400, standard
 * pen type. Overridden per-emission for the root Oval darker border
 * (pen width ≥ 500, §F-AC-2) and the marker cells (0x9D, pen width
 * 100, §6.4).
 */
export const PEN_DEFAULTS: PenStyle = {
  penColor: 0x00,
  penType: 0,
  penWidth: 400,
};
