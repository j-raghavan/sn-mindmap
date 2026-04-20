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
 * inherited from sn-shapes (§11): black, Fineliner pen type, pen
 * width 400. Overridden per-emission for the root Oval darker border
 * (pen width ≥ 500, §F-AC-2) and the marker cells (0x9D, pen width
 * 100, §6.4).
 *
 * `penType: 10` is **required** — the firmware rejects insertGeometry
 * calls with an "invalid pen type" error for any value outside its
 * allow-list {1=Pressure, 10=Fineliner, 11=Marker, 14=Calligraphy}
 * (PEN_TYPE_PRESETS in sn-shapes/src/ShapeOptionsPanel.tsx:141-145).
 * Earlier drafts of this file used `penType: 0`, which passes our
 * jest suite (we don't validate the allow-list in unit tests) but
 * fails on Nomad/Manta as soon as the first outline reaches
 * PluginCommAPI. sn-shapes anchors this same default in
 * PEN_DEFAULTS at sn-shapes/src/shapes.ts:82-90.
 */
export const PEN_DEFAULTS: PenStyle = {
  penColor: 0x00,
  penType: 10,
  penWidth: 400,
};
