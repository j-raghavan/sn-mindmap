/**
 * Radial-layout constants per §F-LY-5.
 *
 * These values are STARTING POINTS, not frozen. §F-LY-5 calls for
 * empirical tuning against both Nomad (1404×1872) and Manta
 * (1920×TBD per §10). §10 also tracks Manta pixel-height
 * verification — values that assume a 2560 height must not be frozen
 * until that is confirmed.
 */

/** First-level children orbit radius (distance from root to first ring). */
export const R1 = 340;

/**
 * Each deeper level grows by this much. Slices further out also get
 * wider angular arcs per §F-LY-3, so linear growth is usually enough
 * to keep crowding manageable.
 */
export const LEVEL_RADIUS_INCREMENT = 260;

/** Default node outline width (Oval / Rectangle / Rounded Rectangle). */
export const NODE_WIDTH = 220;

/** Default node outline height. */
export const NODE_HEIGHT = 96;

/**
 * Internal padding inside every node outline per §8.1 — the user
 * needs visible writing room well inside the outline bbox so
 * handwritten labels naturally stay contained, which is what the
 * decode-time centroid rule relies on.
 */
export const NODE_INTERNAL_PADDING = 12;

/**
 * Rounded-rectangle corner radius for Add-Sibling nodes (§F-AC-3).
 * The root's Oval uses a corner radius ≥ half the shorter side
 * (§F-AC-2) — computed from NODE_HEIGHT at emit time, not stored here
 * as a fixed value.
 */
export const SIBLING_CORNER_RADIUS = 15;

/**
 * Connector pen width follows the child node's border weight per
 * §F-IN-2 step 2. The two standard weights are:
 */
export const STANDARD_PEN_WIDTH = 400; // non-root node outlines + connectors
export const ROOT_PEN_WIDTH = 500; // root Oval darker border (§F-AC-2, min ≥ 500)
export const MARKER_PEN_WIDTH = 100; // marker cell strokes (§6.4, firmware min)

/** Default page margin when fit-scaling on insert (§F-LY-6). */
export const PAGE_MARGIN = 80;

/**
 * Animation budget on mutation (§F-AC-6). Canvas re-runs the radial
 * layout and animates the re-center within this budget; devices in
 * fast-refresh mode may skip the animation entirely.
 */
export const RECENTER_ANIMATION_MS = 250;
