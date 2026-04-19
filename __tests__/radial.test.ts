/**
 * Placeholder tests for src/layout/radial.ts.
 *
 * Phase 1 (§9) replaces these with real coverage:
 *   - root at origin (§F-LY-1)
 *   - first-level even distribution on circle radius R1 (§F-LY-2)
 *   - deeper levels' angular slices proportional to leaf count (§F-LY-3)
 *   - determinism: same Tree -> same positions byte-for-byte
 *     (the marker bbox bytes depend on this)
 *
 * For now we only validate that the module imports cleanly and that
 * the layout constants are present with the values §F-LY-5 and §11
 * specify.
 */
import {radialLayout} from '../src/layout/radial';
import {
  R1,
  LEVEL_RADIUS_INCREMENT,
  NODE_WIDTH,
  NODE_HEIGHT,
  NODE_INTERNAL_PADDING,
  ROOT_PEN_WIDTH,
  STANDARD_PEN_WIDTH,
  MARKER_PEN_WIDTH,
  PAGE_MARGIN,
} from '../src/layout/constants';

describe('radial layout (scaffold)', () => {
  it('exposes radialLayout', () => {
    expect(typeof radialLayout).toBe('function');
  });

  it('layout constants match §F-LY-5 / §11 starting values', () => {
    expect(R1).toBeGreaterThan(0);
    expect(LEVEL_RADIUS_INCREMENT).toBeGreaterThan(0);
    expect(NODE_WIDTH).toBeGreaterThan(0);
    expect(NODE_HEIGHT).toBeGreaterThan(0);
    // §8.1 internal padding: 12 px so handwriting stays inside the
    // outline naturally.
    expect(NODE_INTERNAL_PADDING).toBe(12);
    // §F-AC-2 root oval pen width ≥ 500.
    expect(ROOT_PEN_WIDTH).toBeGreaterThanOrEqual(500);
    // §11 standard outline weight.
    expect(STANDARD_PEN_WIDTH).toBe(400);
    // §6.4 marker pen width = firmware MIN_PEN_WIDTH = 100.
    expect(MARKER_PEN_WIDTH).toBe(100);
    // §F-LY-6 default insert margin.
    expect(PAGE_MARGIN).toBe(80);
  });
});
