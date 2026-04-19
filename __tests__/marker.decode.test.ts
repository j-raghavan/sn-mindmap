/**
 * Placeholder tests for src/marker/decode.ts.
 *
 * Phase 3 (§9) replaces these with the real round-trip and
 * rejection-path coverage — in particular:
 *   - encode(tree) -> decode(geometries) -> equivalent tree
 *   - §6.5 step 6 CRC scope is 2 + 10N bytes (NOT 9N — see the
 *     v0.8.1 bug fix)
 *   - §F-ED-4 failure modes: no_candidates, rs_failed, crc_failed,
 *     bad_version, bad_record
 *
 * For now we only validate that the module exports decodeMarker and
 * decodeMarkerBytes with the expected signature, and that the
 * DecodeResult sum type includes the §F-ED-4 reason codes.
 */
import {decodeMarker, decodeMarkerBytes} from '../src/marker/decode';
import type {DecodeResult} from '../src/marker/decode';

describe('marker decode (scaffold)', () => {
  it('exposes decodeMarker and decodeMarkerBytes', () => {
    expect(typeof decodeMarker).toBe('function');
    expect(typeof decodeMarkerBytes).toBe('function');
  });

  it('DecodeResult type accepts every §F-ED-4 reason code', () => {
    // Compile-time check dressed up as a runtime one. If any of
    // these reason strings is dropped from the decode.ts union,
    // this test will fail to typecheck.
    const reasons: DecodeResult[] = [
      {
        ok: false,
        reason: 'no_candidates',
        message: 'No marker candidate strokes in selection',
      },
      {ok: false, reason: 'rs_failed', message: 'RS decode failed'},
      {ok: false, reason: 'crc_failed', message: 'CRC mismatch'},
      {ok: false, reason: 'bad_version', message: 'Unknown marker version'},
      {ok: false, reason: 'bad_record', message: 'Invalid node record'},
    ];
    expect(reasons).toHaveLength(5);
  });
});
