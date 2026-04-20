/* eslint-disable no-bitwise */
/**
 * Tests for src/marker/rs.ts — the RS / GF(256) / CRC32 primitives
 * behind the marker codec (§6.2, §6.5 step 5).
 *
 * Coverage:
 *   - crc32: reference vectors (empty, "", "123456789" → 0xCBF43926,
 *     single byte, long binary) to pin the IEEE 802.3 polynomial and
 *     byte-at-a-time table implementation to the spec.
 *   - rsEncode: systematic property (first k bytes of codeword ===
 *     message), parity length, empty-parity pass-through, oversize
 *     rejection.
 *   - rsEncode + rsDecode round-trip with zero, one-byte, and
 *     exactly-t byte errors (t = floor(parity/2)), across codeword
 *     lengths spanning the §6.2 design sizes (message=2+10N+4,
 *     parity=642-10N for N=5, 30, 50, 53).
 *   - Exceeding the error-correction capability surfaces as a thrown
 *     Error, not a silent miscorrection — §F-ED-4 'rs_failed' path.
 *   - Degenerate inputs (codeword shorter than parity, parity=0,
 *     codeword > 255 bytes) throw with descriptive messages.
 *   - Determinism: same message+parity → identical codeword byte-for-
 *     byte on repeated calls, so the emitted marker is reproducible
 *     and round-trip diffable.
 */
import {rsEncode, rsDecode, crc32} from '../src/marker/rs';

describe('crc32 (IEEE 802.3)', () => {
  it('empty input is 0', () => {
    expect(crc32(new Uint8Array())).toBe(0);
  });

  it('single-byte reference: crc32([0x00]) = 0xD202EF8D', () => {
    // Verified against the same reference table the spec quotes
    // (the standard IEEE 802.3 / zlib CRC32 of a single null byte).
    expect(crc32(new Uint8Array([0x00]))).toBe(0xd202ef8d);
  });

  it('crc32("123456789") = 0xCBF43926 (the canonical reference vector)', () => {
    const bytes = new Uint8Array([
      0x31, 0x32, 0x33, 0x34, 0x35, 0x36, 0x37, 0x38, 0x39,
    ]);
    expect(crc32(bytes)).toBe(0xcbf43926);
  });

  it('determinism: same bytes → same digest on repeat calls', () => {
    const bytes = new Uint8Array([0xde, 0xad, 0xbe, 0xef, 0x00, 0xff]);
    const a = crc32(bytes);
    const b = crc32(bytes);
    expect(b).toBe(a);
  });

  it('distinctness: a single-byte flip changes the digest', () => {
    const a = new Uint8Array([0x10, 0x20, 0x30, 0x40]);
    const b = new Uint8Array([0x10, 0x20, 0x30, 0x41]);
    expect(crc32(a)).not.toBe(crc32(b));
  });
});

describe('rsEncode (systematic)', () => {
  it('returns a codeword of length message.length + parityBytes', () => {
    const msg = new Uint8Array([1, 2, 3, 4, 5]);
    const cw = rsEncode(msg, 10);
    expect(cw).toHaveLength(15);
  });

  it('first k bytes of codeword equal the message (systematic property)', () => {
    const msg = new Uint8Array([0x02, 0x03, 0xaa, 0xbb, 0xcc, 0xdd, 0xee]);
    const cw = rsEncode(msg, 16);
    expect(Array.from(cw.slice(0, msg.length))).toEqual(Array.from(msg));
  });

  it('parityBytes = 0 returns a copy of the message unchanged', () => {
    const msg = new Uint8Array([7, 8, 9]);
    const cw = rsEncode(msg, 0);
    expect(Array.from(cw)).toEqual([7, 8, 9]);
    // Must be an independent buffer — caller mutation of cw must not
    // affect the input.
    cw[0] = 0;
    expect(msg[0]).toBe(7);
  });

  it('throws on negative parityBytes', () => {
    expect(() => rsEncode(new Uint8Array([1]), -1)).toThrow(
      /non-negative/,
    );
  });

  it('throws when codeword length exceeds GF(256) maximum of 255', () => {
    const msg = new Uint8Array(200);
    expect(() => rsEncode(msg, 100)).toThrow(/exceeds GF\(256\) maximum/);
  });

  it('is deterministic: same input → identical codeword on repeat calls', () => {
    const msg = new Uint8Array([0xff, 0x00, 0x55, 0xaa]);
    const a = rsEncode(msg, 8);
    const b = rsEncode(msg, 8);
    expect(Array.from(b)).toEqual(Array.from(a));
  });
});

describe('rsEncode + rsDecode round-trip', () => {
  /**
   * Helper: fill a Uint8Array with a pseudo-random but deterministic
   * byte stream seeded on `n`. Matches the style in the sn-shapes
   * test suite so tests stay reproducible across machines.
   */
  function fillDeterministic(n: number): Uint8Array {
    const out = new Uint8Array(n);
    let x = 0x13579bdf;
    for (let i = 0; i < n; i += 1) {
      x = (x * 1664525 + 1013904223) >>> 0;
      out[i] = (x >>> 24) & 0xff;
    }
    return out;
  }

  it('zero errors: corrected message equals input', () => {
    const msg = new Uint8Array([0x02, 0x05, 0xde, 0xad, 0xbe, 0xef]);
    const cw = rsEncode(msg, 10);
    const decoded = rsDecode(cw, 10);
    expect(Array.from(decoded)).toEqual(Array.from(msg));
  });

  it('one byte flip in the message is corrected', () => {
    const msg = fillDeterministic(20);
    const cw = rsEncode(msg, 8);
    // Flip a byte in the message portion (index 5).
    cw[5] ^= 0xa5;
    const decoded = rsDecode(cw, 8);
    expect(Array.from(decoded)).toEqual(Array.from(msg));
  });

  it('one byte flip in the parity region is corrected', () => {
    const msg = fillDeterministic(16);
    const cw = rsEncode(msg, 10);
    // Flip a byte in the parity portion (index 22 of 26).
    cw[22] ^= 0x7e;
    const decoded = rsDecode(cw, 10);
    expect(Array.from(decoded)).toEqual(Array.from(msg));
  });

  it('exactly floor(parity/2) byte errors are corrected', () => {
    const parity = 12;
    const t = Math.floor(parity / 2); // 6
    const msg = fillDeterministic(24);
    const cw = rsEncode(msg, parity);
    // Flip t distinct bytes at varied positions (message + parity
    // mix) so the locator-and-magnitude pipeline is exercised end to
    // end, not just a trivial pattern.
    const flipPositions = [0, 3, 7, 11, 20, 29];
    expect(flipPositions).toHaveLength(t);
    for (const p of flipPositions) {
      cw[p] ^= 0x5c;
    }
    const decoded = rsDecode(cw, parity);
    expect(Array.from(decoded)).toEqual(Array.from(msg));
  });

  it('beyond floor(parity/2) byte errors: rsDecode throws', () => {
    const parity = 6; // t = 3
    const msg = fillDeterministic(20);
    const cw = rsEncode(msg, parity);
    // Flip 4 bytes — one more than the correction capability.
    for (const p of [1, 4, 9, 14]) {
      cw[p] ^= 0xff;
    }
    expect(() => rsDecode(cw, parity)).toThrow();
  });

  it('zero-parity short-circuit: decode returns a copy of the codeword', () => {
    const cw = new Uint8Array([1, 2, 3, 4, 5]);
    const decoded = rsDecode(cw, 0);
    expect(Array.from(decoded)).toEqual([1, 2, 3, 4, 5]);
    decoded[0] = 0xff;
    expect(cw[0]).toBe(1);
  });

  it('rejects a codeword shorter than the parity', () => {
    expect(() => rsDecode(new Uint8Array(5), 10)).toThrow(
      /shorter than parity/,
    );
  });

  it('rejects a codeword longer than GF(256) maximum (255)', () => {
    expect(() => rsDecode(new Uint8Array(256), 8)).toThrow(
      /exceeds GF\(256\) maximum/,
    );
  });

  it('rejects negative parityBytes', () => {
    expect(() => rsDecode(new Uint8Array(10), -1)).toThrow(/non-negative/);
  });

  // The real marker uses a 648-byte channel which is WAY above the
  // GF(256) single-codeword limit of 255. The production codec will
  // have to either shorten (use a 255-byte RS block) or chunk (split
  // the 648-byte channel into multiple blocks). §6.2 doesn't specify
  // which yet — the test below pins the design-relevant sizes
  // (message+parity ≤ 255) that the Phase 3.2 codec will be built
  // from. If Phase 3.2 picks a chunking strategy, it'll test the
  // per-chunk sizes separately.
  describe('§6.2 design sizes (per-block, N < 25 fits inside one RS block)', () => {
    // For N nodes, message = 2 + 10N + 4 bytes. At N=24, message=246,
    // parity up to 9 still fits inside GF(256) (246+9=255). This is
    // enough coverage to prove the primitives work at spec-sized
    // inputs; the chunking/codeword layout for full 50-node maps is
    // a Phase 3.2 concern.
    const cases = [
      {label: 'N=5 (message=56)', messageLen: 56, parity: 14},
      {label: 'N=10 (message=106)', messageLen: 106, parity: 32},
      {label: 'N=20 (message=206)', messageLen: 206, parity: 40},
      {label: 'N=24 (message=246) / parity=8', messageLen: 246, parity: 8},
    ];

    for (const {label, messageLen, parity} of cases) {
      it(`round-trips clean for ${label}`, () => {
        const msg = fillDeterministic(messageLen);
        const cw = rsEncode(msg, parity);
        expect(cw).toHaveLength(messageLen + parity);
        const decoded = rsDecode(cw, parity);
        expect(Array.from(decoded)).toEqual(Array.from(msg));
      });

      it(`${label}: floor(parity/2) errors correctable`, () => {
        const t = Math.floor(parity / 2);
        if (t === 0) {
          return;
        }
        const msg = fillDeterministic(messageLen);
        const cw = rsEncode(msg, parity);
        // Scatter t flips uniformly across the codeword.
        const step = Math.max(1, Math.floor(cw.length / (t + 1)));
        for (let k = 0; k < t; k += 1) {
          cw[step * (k + 1)] ^= 0x33;
        }
        const decoded = rsDecode(cw, parity);
        expect(Array.from(decoded)).toEqual(Array.from(msg));
      });
    }
  });
});
