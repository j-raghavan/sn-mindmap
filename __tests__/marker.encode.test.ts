/**
 * Placeholder tests for src/marker/encode.ts.
 *
 * Phase 3 (§9) replaces these with property-style round-trip tests
 * (§13.5) up to N=50 for success and up to N=53 for rejection-path
 * coverage (§6.2 ceiling arithmetic).
 *
 * For now we only validate the wire constants — these are the
 * numbers the spec nails down in §6.1, §6.2, §6.3, §F-PE-3, and
 * §F-PE-4, and any drift from them is a decode-incompatible change.
 */
import {
  MARKER_GRID,
  MARKER_CELL_PX,
  MARKER_FOOTPRINT_PX,
  MARKER_CHANNEL_BYTES,
  MARKER_NODE_RECORD_BYTES,
  MARKER_FORMAT_VERSION,
  MARKER_PUBLISHED_NODE_CAP,
  MARKER_THEORETICAL_NODE_CAP,
  MarkerCapacityError,
} from '../src/marker/encode';

describe('marker encode wire constants (§6)', () => {
  it('grid is 72×72 at 4 px per cell (§6.1, §F-PE-3)', () => {
    expect(MARKER_GRID).toBe(72);
    expect(MARKER_CELL_PX).toBe(4);
    expect(MARKER_FOOTPRINT_PX).toBe(288);
  });

  it('raw channel is 648 bytes = 72*72/8 (§6.2)', () => {
    expect(MARKER_CHANNEL_BYTES).toBe(648);
    expect(MARKER_CHANNEL_BYTES).toBe((MARKER_GRID * MARKER_GRID) / 8);
  });

  it('node record is 10 bytes (§6.3)', () => {
    expect(MARKER_NODE_RECORD_BYTES).toBe(10);
  });

  it('format version byte is 0x02 (v2, §6.2)', () => {
    expect(MARKER_FORMAT_VERSION).toBe(0x02);
  });

  it('node cap: published 50, theoretical 53 (§6.2, §F-PE-4, §8.3)', () => {
    expect(MARKER_PUBLISHED_NODE_CAP).toBe(50);
    expect(MARKER_THEORETICAL_NODE_CAP).toBe(53);
  });

  it('MarkerCapacityError carries the offending node count', () => {
    const err = new MarkerCapacityError(51);
    expect(err).toBeInstanceOf(Error);
    expect(err).toBeInstanceOf(MarkerCapacityError);
    expect(err.name).toBe('MarkerCapacityError');
    expect(err.nodeCount).toBe(51);
    expect(err.message).toMatch(/51/);
    expect(err.message).toMatch(/50/);
  });
});
