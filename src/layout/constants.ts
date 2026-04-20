/**
 * Radial-layout constants per §F-LY-5.
 *
 * These values are STARTING POINTS, not frozen. §F-LY-5 calls for
 * empirical tuning against both Nomad (1404×1872) and Manta
 * (1920×TBD per §10). §10 also tracks Manta pixel-height
 * verification — values that assume a 2560 height must not be frozen
 * until that is confirmed.
 *
 * Note: a few constants that used to live here were consolidated
 * elsewhere during the Phase 5 cleanup because they duplicated the
 * source-of-truth definition in their primary module:
 *   - MARKER_PEN_WIDTH      → src/marker/encode.ts (§6.4 codec owner)
 *   - PAGE_MARGIN           → INSERT_MARGIN_PX in src/insert.ts
 *                             (fit-to-page scaler owner, §F-LY-6)
 *   - NODE_INTERNAL_PADDING → decoder uses bbox-contains, not padded
 *                             offsets; unused by the emit path
 *   - RECENTER_ANIMATION_MS → the §F-AC-6 animation budget lives in
 *                             MindmapCanvas's withLayoutTiming helper
 *                             (not a shared constant)
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
