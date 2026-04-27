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

/** Width of every node bounding box (logical px) (§F-LY-5). */
export const NODE_WIDTH = 220;

/** Height of every node bounding box (logical px) (§F-LY-5). */
export const NODE_HEIGHT = 96;

/**
 * Visual gap (logical px) preserved between adjacent node outlines.
 * Drives the minimum radial spacing so two NODE_WIDTH × NODE_HEIGHT
 * bboxes never visibly fuse on e-ink, where a 1-pixel rendering jitter
 * across stacked borders reads as a single thicker line.
 */
const NODE_GAP = 24;

/**
 * Radius (logical px) from root centre to first-level child centres.
 *
 * Two axis-aligned bboxes centred at distance r in direction θ overlap
 * iff r·|cos θ| < NODE_WIDTH AND r·|sin θ| < NODE_HEIGHT. Adding a
 * NODE_GAP visual margin to each axis, the worst-case angle (where
 * both inequalities meet on the unit circle) gives
 *   r = √((NODE_WIDTH + NODE_GAP)² + (NODE_HEIGHT + NODE_GAP)²).
 * Picking R1 from that formula guarantees no first-level child can
 * overlap the root regardless of how many children fan around it —
 * the symptom reported on Reddit was a child placed at θ = 0° (single
 * child, or middle of a three-child full-ring layout) intersecting
 * the root oval because the prior hard-coded R1 = 200 was below
 * NODE_WIDTH (220).
 */
export const R1 = Math.hypot(NODE_WIDTH + NODE_GAP, NODE_HEIGHT + NODE_GAP);

/**
 * Extra radius added per depth level beyond the first (§F-LY-3).
 * Depth-d node distance from origin = R1 + (d − 1) × LEVEL_RADIUS_INCREMENT.
 *
 * A depth-(d+1) child placed straight outward from its depth-d parent
 * sits exactly LEVEL_RADIUS_INCREMENT away — the worst-case parent↔
 * child separation at every level beyond the first. By the same
 * diagonal argument used for R1 the increment must therefore clear
 * √((NODE_WIDTH + NODE_GAP)² + (NODE_HEIGHT + NODE_GAP)²) to keep two
 * NODE_WIDTH × NODE_HEIGHT bboxes disjoint at any orientation. We set
 * it equal to R1 so the rings step out at a consistent radial pace
 * and a future bump to NODE_WIDTH / NODE_HEIGHT propagates here
 * automatically — the previous hard-coded 400 was only accidentally
 * safe (400 > 272 with today's node size, but a 500-wide node would
 * have reintroduced parent↔child overlap at depth ≥ 2).
 */
export const LEVEL_RADIUS_INCREMENT = R1;

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
 * Skew angle (radians) used to slant parallelogram-shaped nodes
 * (depth ≥ 3 in the v1.0 shape-by-depth table). The on-canvas outline
 * uses a CSS `skewX(PARALLELOGRAM_SKEW_DEG)` transform; the emitted
 * polygon points use the matching horizontal pixel offset
 * NODE_HEIGHT × tan(angle), so the authoring view and the inserted
 * geometry stay in lockstep when NODE_HEIGHT changes.
 */
export const PARALLELOGRAM_SKEW_DEG = 12;

/**
 * Horizontal skew (logical px) of parallelogram-shaped nodes. The top
 * edge shifts right by this amount, the bottom edge shifts left by the
 * same amount, so the bounding box stays unchanged. Derived from the
 * skew angle so the slant tracks NODE_HEIGHT — pre-fix this was a hard-
 * coded 20 px tuned for NODE_HEIGHT = 96, and any change to NODE_HEIGHT
 * would have silently desynced the outline View's CSS skew (12°) from
 * the polygon points emitted on Insert.
 */
export const PARALLELOGRAM_SKEW_PX =
  NODE_HEIGHT * Math.tan((PARALLELOGRAM_SKEW_DEG * Math.PI) / 180);
