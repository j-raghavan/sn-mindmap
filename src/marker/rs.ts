/**
 * Tiny Reed-Solomon implementation for the marker block (§7.4).
 *
 * Systematic RS over GF(256) with the standard QR polynomial
 * (0x11D). The RS codeword is [message || parity] — at decode
 * time the corrected codeword's first `message.length` bytes are
 * the recovered message (§6.5 step 5).
 *
 * Parity ratio is caller-controlled. Design rule (§6.2) is
 * parity bytes ≥ 20% of message bytes, with room to go higher
 * (25–30%) based on on-device calibration — §10 tracks this tuning.
 *
 * Decoder uses Berlekamp-Massey + Forney (§7.4 calls out ~150 LOC).
 * No external dependency — this file is the whole implementation.
 *
 * Phase 3 (§9) implements both encode and decode with property-style
 * fuzz tests (§13.5) up to N=50 for round-trip success and up to
 * N=53 for rejection-path coverage.
 */

/**
 * Encode a message into a [message || parity] codeword of length
 * `message.length + parityBytes`. Systematic — the first
 * `message.length` bytes of the returned array equal `message`.
 *
 * TODO(Phase 3, §7.4): implement.
 */
export function rsEncode(
  _message: Uint8Array,
  _parityBytes: number,
): Uint8Array {
  throw new Error('TODO(Phase 3, §7.4): rsEncode not implemented');
}

/**
 * Decode a codeword, correcting up to `floor(parityBytes / 2)`
 * errors. The returned array is the corrected message (length =
 * codeword.length - parityBytes).
 *
 * Throws if decoding fails (too many errors to correct). §F-ED-4's
 * "marker not found" / "marker corrupted" branch is triggered by
 * the caller catching this.
 *
 * TODO(Phase 3, §7.4): implement.
 */
export function rsDecode(
  _codeword: Uint8Array,
  _parityBytes: number,
): Uint8Array {
  throw new Error('TODO(Phase 3, §7.4): rsDecode not implemented');
}

/**
 * CRC32 over a byte range, IEEE 802.3 polynomial (§7.4).
 * Used as the inner integrity check inside the RS message (§6.5
 * step 6). 30-line in-house implementation per §7.4.
 *
 * TODO(Phase 3, §7.4): implement.
 */
export function crc32(_bytes: Uint8Array): number {
  throw new Error('TODO(Phase 3, §7.4): crc32 not implemented');
}
