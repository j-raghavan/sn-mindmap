/**
 * Shared geometry primitives used throughout the mindmap plugin.
 *
 * Coordinate conventions (§3 / §F-LY-*):
 *   - Layout operates in "mindmap-local" space (logical pixels, origin at
 *     root centre).  The insert pipeline translates to page pixel coords
 *     before calling SDK APIs.
 *   - All sizes are in the same unit as the layout constants in
 *     src/layout/constants.ts.
 */

/** 2-D point with floating-point coordinates. */
export interface Point {
  x: number;
  y: number;
}

/**
 * Axis-aligned bounding box.
 * Uses (x, y, w, h) rather than (left, top, right, bottom) so that
 * width/height arithmetic never accidentally reintroduces right/bottom
 * confusion when coordinates are negative (common in mindmap-local space
 * where the root sits at origin).
 */
export interface Rect {
  x: number; // left edge
  y: number; // top edge
  w: number; // width  (always ≥ 0)
  h: number; // height (always ≥ 0)
}

/**
 * Pen style fields shared by every Geometry variant.
 */
export interface PenStyle {
  penColor: number;
  penType: number;
  penWidth: number;
}

/**
 * Default pen style for node outlines and connectors.
 * Black fineliner, standard pen weight.
 *
 * NOTE: penType=10 (Fineliner) must be in the firmware allow-list
 * {1=Pressure, 10=Fineliner, 11=Marker, 14=Calligraphy}. Any other
 * value causes insertGeometry to fail with "invalid pen type" on-device.
 */
export const PEN_DEFAULTS: PenStyle & {showLassoAfterInsert: false} = {
  penColor: 0x00, // black
  penType: 10,     // Fineliner
  penWidth: 400,   // STANDARD_PEN_WIDTH
  showLassoAfterInsert: false,
};

/**
 * Pen style for DAG cross-edge connectors and their arrowheads
 * (F-DAG-4-FR3). Dark gray (0x9D — the value reserved for unobtrusive
 * strokes, §6.4) and a thinner weight than STANDARD_PEN_WIDTH so the
 * overlay reads as "extra links" distinct from the black tree
 * connectors. penType stays 10 (Fineliner) to satisfy the firmware
 * allow-list {1, 10, 11, 14}.
 */
export const CROSS_EDGE_PEN: PenStyle & {showLassoAfterInsert: false} = {
  penColor: 0x9d, // dark gray (unobtrusive)
  penType: 10,    // Fineliner
  penWidth: 200,  // thinner than STANDARD_PEN_WIDTH (400)
  showLassoAfterInsert: false,
};

/**
 * Straight two-point line geometry. Used for connectors and marker bit
 * strokes.
 */
export interface LineGeometry extends PenStyle {
  type: 'straightLine';
  points: Point[];
  showLassoAfterInsert?: boolean;
}

/**
 * Closed polygon geometry. Used for node outlines.
 */
export interface PolygonGeometry extends PenStyle {
  type: 'GEO_polygon';
  points: Point[];
  showLassoAfterInsert?: boolean;
}

/**
 * Circle geometry (equal-axis ellipse). Used for preserved label
 * strokes that the user drew as a circle.
 */
export interface CircleGeometry extends PenStyle {
  type: 'GEO_circle';
  ellipseCenterPoint: Point;
  ellipseMajorAxisRadius: number;
  ellipseMinorAxisRadius: number;
  ellipseAngle: number;
  showLassoAfterInsert?: boolean;
}

/**
 * Ellipse geometry. Used for preserved label strokes.
 */
export interface EllipseGeometry extends PenStyle {
  type: 'GEO_ellipse';
  ellipseCenterPoint: Point;
  ellipseMajorAxisRadius: number;
  ellipseMinorAxisRadius: number;
  ellipseAngle: number;
  showLassoAfterInsert?: boolean;
}

/**
 * Discriminated union of all geometry types emitted by the plugin.
 */
export type Geometry =
  | LineGeometry
  | PolygonGeometry
  | CircleGeometry
  | EllipseGeometry;
