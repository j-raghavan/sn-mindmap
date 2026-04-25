/**
 * Layout and rendering constants for the mindmap plugin.
 *
 * All dimension values are in logical pixels (mindmap-local coordinate
 * space).  The insert pipeline scales to note-page pixel coords via the
 * page-size returned by PluginFileAPI.getPageSize (§F-IN-1).
 *
 * References:
 *   §F-AC-2  Root node is an Oval, pen weight ROOT_PEN_WIDTH.
 *   §F-AC-3  Child = Rectangle (STANDARD_PEN_WIDTH); sibling = Rounded-
 *            Rectangle (STANDARD_PEN_WIDTH, corner radius CORNER_RADIUS).
 *   §F-LY-2  First-level children sit at radius R1 from the root.
 *   §F-LY-3  Each deeper level adds LEVEL_RADIUS_INCREMENT to the radius.
 *   §F-LY-5  Node bounding boxes are NODE_WIDTH × NODE_HEIGHT.
 *   §11      STANDARD_PEN_WIDTH = 400 (matches sn-shapes convention).
 */

/** Radius (logical px) from root centre to first-level child centres. */
export const R1 = 200;

/**
 * Extra radius added per depth level beyond the first (§F-LY-3).
 * Depth-d node distance from origin = R1 + (d − 1) × LEVEL_RADIUS_INCREMENT.
 */
export const LEVEL_RADIUS_INCREMENT = 400;

/** Width of every node bounding box (logical px) (§F-LY-5). */
export const NODE_WIDTH = 220;

/** Height of every node bounding box (logical px) (§F-LY-5). */
export const NODE_HEIGHT = 96;

/**
 * Pen weight for the root Oval outline (§F-AC-2).
 * Must be ≥ 500 to match the firmware's "thick" style.
 */
export const ROOT_PEN_WIDTH = 500;

/**
 * Pen weight for child Rectangle and sibling Rounded-Rectangle outlines
 * (§F-AC-3, §11).  Exactly 400 — do not change without updating §11.
 */
export const STANDARD_PEN_WIDTH = 400;

/**
 * Corner radius (logical px) for Rounded-Rectangle nodes.
 */
export const CORNER_RADIUS = 15;

/**
 * Alias for CORNER_RADIUS — used by consumers that prefer the more
 * descriptive name (nodeFrame, roundedRectPoints).
 */
export const SIBLING_CORNER_RADIUS = CORNER_RADIUS;

/**
 * Horizontal skew (logical px) of parallelogram-shaped nodes
 * (depth ≥ 3 in the v1.0 shape-by-depth table). The top edge shifts
 * right by this amount, the bottom edge shifts left by the same
 * amount, so the bounding box stays unchanged. 20 px on a default
 * NODE_WIDTH = 220 produces a visible slant without crowding the
 * label inside.
 */
export const PARALLELOGRAM_SKEW_PX = 20;
