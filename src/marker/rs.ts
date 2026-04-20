/* eslint-disable no-bitwise */
/**
 * Tiny Reed-Solomon implementation for the marker block (§7.4).
 *
 * Systematic RS over GF(256) with the standard QR primitive polynomial
 * x^8 + x^4 + x^3 + x^2 + 1 (0x11D). The RS codeword is
 * [message || parity] — at decode time the corrected codeword's first
 * `message.length` bytes are the recovered message (§6.5 step 5).
 *
 * Parity ratio is caller-controlled. Design rule (§6.2) is
 * parity bytes ≥ 20% of message bytes, with room to go higher
 * (25–30%) based on on-device calibration — §10 tracks this tuning.
 *
 * Decoder uses syndromes → Berlekamp-Massey (error locator) → Chien
 * search (roots) → Forney (error magnitudes). No external dependency.
 *
 * Array layout convention (public API):
 *   - message[]     high-degree-first: message[0] is the "oldest" byte
 *                   in the codeword, message[k-1] is adjacent to parity.
 *   - codeword[]    high-degree-first: codeword = [message || parity].
 *
 * Array layout convention (internal polynomial algorithms):
 *   - low-degree-first: poly[0] is the constant term, poly[deg] is the
 *     leading coefficient. This is the natural form for Berlekamp-Massey
 *     and for the error-locator / error-evaluator products.
 *
 * The two conventions are related by Array.reverse(); we cross the
 * boundary only inside rsEncode / rsDecode, so callers never see it.
 */

// -----------------------------------------------------------------
// GF(256) arithmetic
// -----------------------------------------------------------------

/**
 * GF(256) primitive polynomial. x^8 + x^4 + x^3 + x^2 + 1 encoded as
 * the 9-bit value 0x11D. This is the QR-code / AZTEC / DataMatrix /
 * BCH-255 standard; interoperability with any off-device debug tools
 * that assume "the usual" GF(256) is automatic.
 */
const GF_PRIM = 0x11d;

/**
 * Dual-width exponent table: GF_EXP[i] = α^i for i in 0..254, plus
 * the same values repeated at i in 255..509. Doubling the table lets
 * `gfMul` skip a modulo-255 on the log sum — the sum of two logs is
 * at most 508, which is still in bounds.
 */
const GF_EXP = new Uint8Array(512);
const GF_LOG = new Uint8Array(256); // GF_LOG[α^i] = i; GF_LOG[0] is undefined (unused).

(function initGF(): void {
  let x = 1;
  for (let i = 0; i < 255; i += 1) {
    GF_EXP[i] = x;
    GF_LOG[x] = i;
    x <<= 1;
    if (x & 0x100) {
      x ^= GF_PRIM;
    }
  }
  for (let i = 255; i < 512; i += 1) {
    GF_EXP[i] = GF_EXP[i - 255];
  }
})();

function gfMul(a: number, b: number): number {
  if (a === 0 || b === 0) {
    return 0;
  }
  return GF_EXP[GF_LOG[a] + GF_LOG[b]];
}

function gfDiv(a: number, b: number): number {
  if (b === 0) {
    throw new Error('GF(256) division by zero');
  }
  if (a === 0) {
    return 0;
  }
  return GF_EXP[(GF_LOG[a] + 255 - GF_LOG[b]) % 255];
}

// -----------------------------------------------------------------
// Polynomial arithmetic (low-degree-first)
// -----------------------------------------------------------------

function polyMul(p: Uint8Array, q: Uint8Array): Uint8Array {
  if (p.length === 0 || q.length === 0) {
    return new Uint8Array();
  }
  const r = new Uint8Array(p.length + q.length - 1);
  for (let i = 0; i < p.length; i += 1) {
    if (p[i] === 0) {
      continue;
    }
    for (let j = 0; j < q.length; j += 1) {
      r[i + j] ^= gfMul(p[i], q[j]);
    }
  }
  return r;
}

function polyAdd(p: Uint8Array, q: Uint8Array): Uint8Array {
  const r = new Uint8Array(Math.max(p.length, q.length));
  for (let i = 0; i < p.length; i += 1) {
    r[i] = p[i];
  }
  for (let i = 0; i < q.length; i += 1) {
    r[i] ^= q[i];
  }
  return r;
}

function polyScale(p: Uint8Array, x: number): Uint8Array {
  const r = new Uint8Array(p.length);
  for (let i = 0; i < p.length; i += 1) {
    r[i] = gfMul(p[i], x);
  }
  return r;
}

/**
 * Multiply a polynomial by x^m (low-degree-first: prepend m zeros).
 */
function polyShift(p: Uint8Array, m: number): Uint8Array {
  if (m === 0) {
    return p;
  }
  const r = new Uint8Array(p.length + m);
  for (let i = 0; i < p.length; i += 1) {
    r[i + m] = p[i];
  }
  return r;
}

/**
 * Horner evaluation, low-degree-first: p(x) = p[0] + x*(p[1] + x*(p[2] + …)).
 */
function polyEvalLDF(p: Uint8Array, x: number): number {
  let y = 0;
  for (let i = p.length - 1; i >= 0; i -= 1) {
    y = gfMul(y, x) ^ p[i];
  }
  return y;
}

// -----------------------------------------------------------------
// RS generator polynomial
// -----------------------------------------------------------------

/**
 * g(x) = Π_{i=0}^{nsym-1} (x - α^i).
 *
 * In GF(256) subtraction is XOR, so the monomial (x - α^i) is the
 * low-degree-first array [α^i, 1]. Returned poly is low-degree-first.
 */
function rsGenerator(nsym: number): Uint8Array {
  let g = new Uint8Array([1]);
  for (let i = 0; i < nsym; i += 1) {
    g = polyMul(g, new Uint8Array([GF_EXP[i], 1]));
  }
  return g;
}

// -----------------------------------------------------------------
// Public encoder
// -----------------------------------------------------------------

/**
 * Encode a message into a [message || parity] codeword of length
 * `message.length + parityBytes`. Systematic — the first
 * `message.length` bytes of the returned array equal `message`.
 *
 * Algorithm: long division of `message || zeros(parityBytes)` by the
 * generator polynomial, done in place on the high-degree-first buffer.
 * The remainder is the parity.
 */
export function rsEncode(
  message: Uint8Array,
  parityBytes: number,
): Uint8Array {
  if (parityBytes < 0) {
    throw new Error('rsEncode: parityBytes must be non-negative');
  }
  if (parityBytes === 0) {
    return new Uint8Array(message);
  }
  if (message.length + parityBytes > 255) {
    throw new Error(
      `rsEncode: codeword length ${
        message.length + parityBytes
      } exceeds GF(256) maximum 255`,
    );
  }

  const genLDF = rsGenerator(parityBytes);
  // Reverse generator to high-degree-first: genHDF[0] = 1 (leading).
  const genHDF = new Uint8Array(genLDF.length);
  for (let i = 0; i < genLDF.length; i += 1) {
    genHDF[i] = genLDF[genLDF.length - 1 - i];
  }

  const k = message.length;
  const n = k + parityBytes;
  // Scratch buffer: message then zeros, in high-degree-first order.
  const buf = new Uint8Array(n);
  buf.set(message, 0);

  // Long division: for each high-order position i, the leading
  // coefficient of the current remainder sits at buf[i]. We subtract
  // buf[i] * g(x) * x^{n-1-(n-k)-i} to zero it out. Since genHDF[0] = 1,
  // buf[i] gets canceled if we start j at 0; we instead start at 1 and
  // leave buf[i] as the quotient coefficient (which we discard).
  for (let i = 0; i < k; i += 1) {
    const coef = buf[i];
    if (coef === 0) {
      continue;
    }
    for (let j = 1; j < genHDF.length; j += 1) {
      buf[i + j] ^= gfMul(genHDF[j], coef);
    }
  }

  // Codeword = message || remainder. buf[0..k-1] holds quotient coefs
  // (garbage for our purposes) and buf[k..n-1] holds the remainder.
  const codeword = new Uint8Array(n);
  codeword.set(message, 0);
  for (let i = k; i < n; i += 1) {
    codeword[i] = buf[i];
  }
  return codeword;
}

// -----------------------------------------------------------------
// Decoder internals
// -----------------------------------------------------------------

/**
 * Compute syndromes S_j = codeword(α^j) for j in 0..nsym-1.
 *
 * codeword is high-degree-first: codeword[0] is coefficient of x^{n-1},
 * codeword[n-1] is the constant term. Horner on that array order
 * evaluates to codeword(x) directly.
 */
function rsSyndromes(codeword: Uint8Array, nsym: number): Uint8Array {
  const synd = new Uint8Array(nsym);
  for (let j = 0; j < nsym; j += 1) {
    const x = GF_EXP[j];
    let s = 0;
    for (let i = 0; i < codeword.length; i += 1) {
      s = gfMul(s, x) ^ codeword[i];
    }
    synd[j] = s;
  }
  return synd;
}

/**
 * Berlekamp-Massey: given the syndrome sequence, return the minimal
 * error-locator polynomial Λ(x) such that Λ(α^{-i}) = 0 for every
 * error position i (index-from-the-end of the codeword).
 *
 * Λ is returned low-degree-first with Λ[0] = 1 by construction.
 * Degree of Λ = number of errors if syndromes are consistent; if the
 * true error count exceeds floor(nsym/2), the returned Λ may be
 * spurious and its roots won't validate — this is detected downstream
 * by a root-count mismatch and surfaced as "uncorrectable" (§F-ED-4
 * 'rs_failed').
 */
function rsBerlekampMassey(synd: Uint8Array): Uint8Array {
  let Lambda: Uint8Array = new Uint8Array([1]); // current error locator
  let B: Uint8Array = new Uint8Array([1]); // previous-iteration locator scaled for reuse
  let L = 0; // current degree of Lambda
  let m = 1; // shift distance for B
  let b = 1; // last nonzero discrepancy

  for (let n = 0; n < synd.length; n += 1) {
    // Discrepancy Δ = Σ_{i=0}^{L} Λ[i] * S[n - i].
    let delta = 0;
    for (let i = 0; i <= L && i < Lambda.length; i += 1) {
      if (n - i < 0) {
        continue;
      }
      delta ^= gfMul(Lambda[i], synd[n - i]);
    }

    if (delta === 0) {
      m += 1;
      continue;
    }

    // Λ_new = Λ + (Δ / b) * x^m * B.
    const factor = gfDiv(delta, b);
    const adj = polyScale(polyShift(B, m), factor);

    if (2 * L <= n) {
      const T = Lambda;
      Lambda = polyAdd(Lambda, adj);
      L = n + 1 - L;
      B = T;
      b = delta;
      m = 1;
    } else {
      Lambda = polyAdd(Lambda, adj);
      m += 1;
    }
  }

  return Lambda;
}

/**
 * Chien search: return the set of error positions (index-from-end of
 * the codeword) by finding every i in [0, n) such that Λ(α^{-i}) = 0.
 */
function rsFindErrorPositions(
  Lambda: Uint8Array,
  n: number,
): number[] {
  const positions: number[] = [];
  for (let i = 0; i < n; i += 1) {
    const xInv = GF_EXP[(255 - i) % 255]; // α^{-i}
    if (polyEvalLDF(Lambda, xInv) === 0) {
      positions.push(i);
    }
  }
  return positions;
}

/**
 * Formal derivative of Λ(x) in GF(256). In characteristic 2, d/dx(x^k)
 * is zero for even k and x^{k-1} for odd k — so we keep only the
 * odd-degree terms, shifted down by one.
 */
function rsFormalDerivative(Lambda: Uint8Array): Uint8Array {
  if (Lambda.length <= 1) {
    return new Uint8Array();
  }
  const d = new Uint8Array(Lambda.length - 1);
  for (let i = 0; i < d.length; i += 1) {
    d[i] = (i + 1) & 1 ? Lambda[i + 1] : 0;
  }
  return d;
}

/**
 * Compute error magnitudes via Forney's algorithm.
 *
 * Ω(x) = [S(x) · Λ(x)] mod x^nsym, where S is the syndrome polynomial
 * (low-degree-first: S[j] = S_j). For each error position i (from the
 * end of the codeword), the magnitude is
 *
 *     m_i = X_i^{1-c} · Ω(α^{-i}) / Λ'(α^{-i})
 *
 * where X_i = α^i and `c` is the first consecutive root of the
 * generator. Our generator starts at α^0 (c=0), so the formula
 * simplifies to `m_i = X_i · Ω(α^{-i}) / Λ'(α^{-i})`. This is the
 * classic "off by one" trap in small RS implementations: c=1 makes
 * the X_i factor vanish, c=0 doesn't. With the factor omitted,
 * errors at position 0 (the constant term) decode correctly by luck
 * (X_0 = 1) while every other position silently miscorrects and
 * trips the post-correction syndrome guard downstream.
 *
 * Throws if any Λ'(α^{-i}) is zero — that indicates a malformed locator
 * or more errors than the parity can correct; callers in this module
 * convert that into an 'rs_failed' result.
 */
function rsForneyMagnitudes(
  synd: Uint8Array,
  Lambda: Uint8Array,
  errPositions: number[],
): Uint8Array {
  const Omega = polyMul(synd, Lambda);
  // Truncate to nsym coefficients (lowest-degree nsym).
  const OmegaT = new Uint8Array(synd.length);
  for (let i = 0; i < OmegaT.length && i < Omega.length; i += 1) {
    OmegaT[i] = Omega[i];
  }
  const Ld = rsFormalDerivative(Lambda);

  const mags = new Uint8Array(errPositions.length);
  for (let k = 0; k < errPositions.length; k += 1) {
    const i = errPositions[k];
    const xInv = GF_EXP[(255 - i) % 255];
    const num = polyEvalLDF(OmegaT, xInv);
    const den = polyEvalLDF(Ld, xInv);
    if (den === 0) {
      throw new Error('rsDecode: Forney denominator is zero (uncorrectable)');
    }
    // X_i = α^i, the c=0 correction factor.
    const Xi = GF_EXP[i % 255];
    mags[k] = gfMul(gfDiv(num, den), Xi);
  }
  return mags;
}

// -----------------------------------------------------------------
// Public decoder
// -----------------------------------------------------------------

/**
 * Decode a codeword, correcting up to `floor(parityBytes / 2)` errors.
 * Returned array is the corrected message (length = codeword.length -
 * parityBytes).
 *
 * Throws if decoding fails (too many errors to correct, or the
 * syndromes describe a non-codeword that the locator can't explain).
 * §F-ED-4's "marker corrupted" branch is triggered by the caller in
 * decode.ts catching this.
 */
export function rsDecode(
  codeword: Uint8Array,
  parityBytes: number,
): Uint8Array {
  if (parityBytes < 0) {
    throw new Error('rsDecode: parityBytes must be non-negative');
  }
  if (parityBytes === 0) {
    return new Uint8Array(codeword);
  }
  if (codeword.length > 255) {
    throw new Error(
      `rsDecode: codeword length ${codeword.length} exceeds GF(256) maximum 255`,
    );
  }
  if (codeword.length < parityBytes) {
    throw new Error('rsDecode: codeword shorter than parity');
  }

  // 1. Syndromes. Zero vector = already a valid codeword, no correction
  //    work needed.
  const synd = rsSyndromes(codeword, parityBytes);
  let anyNonzero = false;
  for (let i = 0; i < synd.length; i += 1) {
    if (synd[i] !== 0) {
      anyNonzero = true;
      break;
    }
  }
  const corrected = new Uint8Array(codeword);
  if (!anyNonzero) {
    return corrected.slice(0, codeword.length - parityBytes);
  }

  // 2. Error locator polynomial via Berlekamp-Massey.
  const Lambda = rsBerlekampMassey(synd);
  // True degree of Λ is its index-of-highest-nonzero coefficient in LDF.
  let locDegree = Lambda.length - 1;
  while (locDegree > 0 && Lambda[locDegree] === 0) {
    locDegree -= 1;
  }

  // Sanity: a zero locator means the syndromes don't describe a
  // valid error pattern (would-be Λ collapsed to 1). That's
  // uncorrectable.
  if (locDegree === 0) {
    throw new Error('rsDecode: degenerate locator (uncorrectable)');
  }

  // Classic limit: can't correct more errors than floor(parityBytes/2).
  if (locDegree > Math.floor(parityBytes / 2)) {
    throw new Error(
      `rsDecode: ${locDegree} errors exceeds correction capability ${Math.floor(
        parityBytes / 2,
      )}`,
    );
  }

  // 3. Chien search.
  const errPositions = rsFindErrorPositions(Lambda, codeword.length);
  // Root count must equal the locator degree — if it doesn't, the
  // syndromes are inconsistent with any correctable error pattern
  // (happens when true error count exceeds parity/2).
  if (errPositions.length !== locDegree) {
    throw new Error(
      `rsDecode: found ${errPositions.length} roots, expected ${locDegree} (uncorrectable)`,
    );
  }

  // 4. Forney magnitudes.
  const mags = rsForneyMagnitudes(synd, Lambda, errPositions);

  // 5. Apply corrections. Error position i (from end) maps to codeword
  // index (n - 1 - i) in high-degree-first form.
  for (let k = 0; k < errPositions.length; k += 1) {
    const i = errPositions[k];
    const idx = codeword.length - 1 - i;
    if (idx < 0 || idx >= corrected.length) {
      throw new Error('rsDecode: error position out of codeword bounds');
    }
    corrected[idx] ^= mags[k];
  }

  // 6. Re-verify syndromes against the corrected codeword. If the
  // corrected buffer is still not a valid codeword, the original was
  // too corrupt to fix; surface as uncorrectable.
  const post = rsSyndromes(corrected, parityBytes);
  for (let i = 0; i < post.length; i += 1) {
    if (post[i] !== 0) {
      throw new Error('rsDecode: post-correction syndromes nonzero (uncorrectable)');
    }
  }

  return corrected.slice(0, codeword.length - parityBytes);
}

// -----------------------------------------------------------------
// CRC32 (IEEE 802.3)
// -----------------------------------------------------------------

/**
 * Precomputed table for byte-at-a-time CRC32, LSB-first variant,
 * reversed polynomial 0xEDB88320. Initialized lazily because the
 * table fits in 1 KiB and callers of this module may never need it.
 */
let CRC32_TABLE: Uint32Array | null = null;

function ensureCrc32Table(): Uint32Array {
  if (CRC32_TABLE) {
    return CRC32_TABLE;
  }
  const t = new Uint32Array(256);
  for (let i = 0; i < 256; i += 1) {
    let c = i >>> 0;
    for (let j = 0; j < 8; j += 1) {
      c = c & 1 ? (0xedb88320 ^ (c >>> 1)) >>> 0 : c >>> 1;
    }
    t[i] = c >>> 0;
  }
  CRC32_TABLE = t;
  return t;
}

/**
 * CRC32 over a byte range, IEEE 802.3 polynomial (§7.4). Returned value
 * is an unsigned 32-bit integer. Reference vector: crc32("123456789") =
 * 0xCBF43926 (tested).
 */
export function crc32(bytes: Uint8Array): number {
  const t = ensureCrc32Table();
  let c = 0xffffffff;
  for (let i = 0; i < bytes.length; i += 1) {
    c = (t[(c ^ bytes[i]) & 0xff] ^ (c >>> 8)) >>> 0;
  }
  return (c ^ 0xffffffff) >>> 0;
}
