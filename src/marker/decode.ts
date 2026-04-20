/* eslint-disable no-bitwise */
/**
 * Marker decoder — Geometry[] (lassoed) -> Tree (§6.5).
 *
 * Decode pipeline (§6.5 step order — byte layout in §6.2 wins on
 * conflict):
 *   1. Collect marker-candidate strokes (straightLine, length ≤ 4 px,
 *      pen color 0x9D).
 *   2. Infer marker origin = top-left of lasso bbox (§6.5 step 2 +
 *      §8.5 caveat about partial lassos).
 *   3. Recover the bit matrix: project each candidate stroke onto
 *      the 72×72 grid.
 *   4. Pack 5184 bits into 648 bytes in row-major order.
 *   5. Reed-Solomon decode the 648-byte block; corrected message
 *      bytes are the buffer for the following steps.
 *   6. Verify CRC32 over bytes 0..2+10N-1 of the corrected message
 *      (note: 10N, NOT 9N — §6.3's record size).
 *   7. Deserialize node records into {parent, shapeKind, bbox}
 *      tuples; reconstruct the tree by walking parent indices from
 *      array-position node ids.
 *
 * Step 5 is the interleaved-chunk inverse of encode.ts: three
 * RS(216, 170) blocks tiled across the 648-byte channel. See the
 * MARKER_NUM_CHUNKS doc comment in encode.ts for why the spec's
 * single-codeword sketch isn't used as written.
 *
 * Failure modes (all surface as "marker not found" / "marker
 * corrupted" per §F-ED-4):
 *   - no candidate strokes           -> reason 'no_candidates'
 *   - any chunk's RS decode throws   -> reason 'rs_failed'
 *   - CRC mismatch                   -> reason 'crc_failed'
 *   - byte 0 != MARKER_FORMAT_VERSION-> reason 'bad_version'
 *   - parent out of range / N out of
 *     bounds / shape byte unknown    -> reason 'bad_record'
 */
import type {Geometry, LineGeometry, Point, Rect} from '../geometry';
import {
  ShapeKind,
  type MindmapNode,
  type NodeId,
  type Tree,
} from '../model/tree';
import {
  MARKER_CELL_PX,
  MARKER_CHANNEL_BYTES,
  MARKER_CHUNK_BYTES,
  MARKER_CHUNK_MESSAGE,
  MARKER_CHUNK_PARITY,
  MARKER_FORMAT_VERSION,
  MARKER_GRID,
  MARKER_LOGICAL_MESSAGE_BYTES,
  MARKER_NODE_RECORD_BYTES,
  MARKER_NUM_CHUNKS,
  MARKER_PEN_COLOR,
  MARKER_PUBLISHED_NODE_CAP,
  MARKER_ROOT_PARENT,
} from './encode';
import {crc32, rsDecode} from './rs';

export type DecodeOk = {
  ok: true;
  tree: Tree;
  /**
   * Per-node bbox in mindmap-local coords (origin = decoded marker
   * top-left). Caller re-projects to page coords using the marker's
   * lassoed position. Used by §F-ED-5 stroke association.
   */
  nodeBboxesById: Map<NodeId, Rect>;
  /** Decoded marker origin in page coords (§6.5 step 2). */
  markerOriginPage: Point;
};

export type DecodeErr = {
  ok: false;
  /** One of: 'no_candidates' | 'rs_failed' | 'crc_failed' | 'bad_version' | 'bad_record' */
  reason:
    | 'no_candidates'
    | 'rs_failed'
    | 'crc_failed'
    | 'bad_version'
    | 'bad_record';
  /** Human-friendly message suitable for surfacing in the §F-ED-4 banner. */
  message: string;
};

export type DecodeResult = DecodeOk | DecodeErr;

/**
 * Maximum per-axis origin-search radius (in cells). See the retry
 * loop in decodeMarker for why this exists. Two cells covers the
 * worst plausible case where the marker's first few columns/rows
 * happen to be all-zero bits, so the min-endpoint inference
 * undershoots by one or two cells.
 */
const ORIGIN_SEARCH_CELLS = 2;

/**
 * Marker candidate filter (§6.5 step 1). Strokes qualify if:
 *   - type === 'straightLine'
 *   - penColor === 0x9D (§6.4 marker pen channel)
 *   - two points, length ≤ MARKER_CELL_PX + 0.5 px tolerance
 * Everything else — node outlines (black fineliner), handwritten
 * labels (user's current pen), sketch strokes — is rejected.
 */
function filterMarkerCandidates(geometries: Geometry[]): LineGeometry[] {
  const out: LineGeometry[] = [];
  const maxLen = MARKER_CELL_PX + 0.5;
  for (const g of geometries) {
    if (g.type !== 'straightLine') {
      continue;
    }
    if (g.penColor !== MARKER_PEN_COLOR) {
      continue;
    }
    if (g.points.length !== 2) {
      continue;
    }
    const [p0, p1] = g.points;
    const dx = p1.x - p0.x;
    const dy = p1.y - p0.y;
    const len = Math.hypot(dx, dy);
    if (len > maxLen) {
      continue;
    }
    out.push(g);
  }
  return out;
}

/**
 * Project marker candidates onto the 72×72 grid using `origin` as the
 * marker's top-left anchor. Returns the 648-byte channel buffer, or
 * `null` if any candidate projects outside the grid (a signal that
 * the origin guess is wrong).
 */
function packCandidatesToBytes(
  candidates: LineGeometry[],
  origin: Point,
): Uint8Array | null {
  const bytes = new Uint8Array(MARKER_CHANNEL_BYTES);
  for (const c of candidates) {
    const [p0, p1] = c.points;
    const midX = (p0.x + p1.x) / 2;
    const midY = (p0.y + p1.y) / 2;
    // midX of a canonically-encoded cell at (col, row) is
    // origin.x + col*CELL + STROKE_LEN/2. For our 3-px horizontal
    // stroke that midpoint offset is 1.5 px, so col = round(
    // (midX - origin.x - 1.5) / CELL). Row has no offset because the
    // stroke is horizontal.
    const col = Math.round((midX - origin.x - 1.5) / MARKER_CELL_PX);
    const row = Math.round((midY - origin.y) / MARKER_CELL_PX);
    if (col < 0 || col >= MARKER_GRID || row < 0 || row >= MARKER_GRID) {
      return null;
    }
    const bitIndex = row * MARKER_GRID + col;
    const byteIdx = bitIndex >>> 3;
    const bitMask = 0x80 >>> (bitIndex & 7);
    bytes[byteIdx] |= bitMask;
  }
  return bytes;
}

/**
 * Full decode pipeline (§6.5). Filters candidate strokes, infers the
 * marker origin from their extents, projects them onto the bit
 * matrix, and delegates the byte-level work to decodeMarkerBytes.
 *
 * Origin inference: the top-left of the marker grid is at the
 * top-left of the earliest candidate stroke (min endpoint coords).
 * When the actual (col=0, *) or (*, row=0) cells are all-zero bits,
 * this undershoots by one or two cells — so the decoder retries
 * with negative offsets up to ORIGIN_SEARCH_CELLS. The RS failure
 * on a misaligned projection is very reliable (a one-cell shift
 * looks like >>23 byte errors per chunk), so the first origin that
 * decodes cleanly is the right one.
 *
 * §F-ED-4 failure surface: empty candidate set -> 'no_candidates';
 * every tried origin fails -> the last non-'no_candidates' reason
 * bubbles up (usually 'rs_failed' or 'crc_failed').
 */
export function decodeMarker(lassoedGeometries: Geometry[]): DecodeResult {
  const candidates = filterMarkerCandidates(lassoedGeometries);
  if (candidates.length === 0) {
    return {
      ok: false,
      reason: 'no_candidates',
      message:
        'decodeMarker: no marker candidate strokes in selection ' +
        '(need straightLine, penColor=0x9D, length ≤ 4 px)',
    };
  }

  // Min endpoint across all candidate strokes = provisional origin.
  let minX = Infinity;
  let minY = Infinity;
  for (const c of candidates) {
    for (const p of c.points) {
      if (p.x < minX) {
        minX = p.x;
      }
      if (p.y < minY) {
        minY = p.y;
      }
    }
  }

  // Retry loop over small origin shifts. (0, 0) is always tried
  // first — that's the successful path for a fully-lassoed mindmap
  // whose marker has a set bit in at least column 0 and row 0. The
  // non-zero offsets cover partial-lasso and sparse-first-row cases.
  let lastErr: DecodeResult = {
    ok: false,
    reason: 'rs_failed',
    message: 'decodeMarker: no origin candidate decoded cleanly',
  };
  for (let dy = 0; dy <= ORIGIN_SEARCH_CELLS; dy += 1) {
    for (let dx = 0; dx <= ORIGIN_SEARCH_CELLS; dx += 1) {
      const origin: Point = {
        x: minX - dx * MARKER_CELL_PX,
        y: minY - dy * MARKER_CELL_PX,
      };
      const bytes = packCandidatesToBytes(candidates, origin);
      if (!bytes) {
        continue;
      }
      const result = decodeMarkerBytes(bytes);
      if (result.ok) {
        return {
          ok: true,
          tree: result.tree,
          nodeBboxesById: result.nodeBboxesById,
          markerOriginPage: origin,
        };
      }
      // Remember the most recent failure; we don't report
      // no_candidates from here (we already passed that guard).
      if (result.reason !== 'no_candidates') {
        lastErr = result;
      }
    }
  }
  return lastErr;
}

/**
 * Decode just the binary buffer half of the pipeline (RS -> CRC ->
 * record parse). Exposed for the unit-test round-trip harness and
 * as the bottom half of decodeMarker once the bit-matrix recovery
 * (Phase 3.3) is wired in.
 *
 * Expects a MARKER_CHANNEL_BYTES (648) buffer. Shorter buffers,
 * longer buffers, and undefined slots all surface as rejections
 * with a descriptive reason code — never an uncaught throw. The
 * §F-ED-4 banner in the caller can just switch on the reason.
 *
 * markerOriginPage is returned as (0, 0) because this entry point
 * has no stroke positions to infer from — callers that need real
 * page coords must go through decodeMarker.
 */
export function decodeMarkerBytes(codeword: Uint8Array): DecodeResult {
  if (codeword.length !== MARKER_CHANNEL_BYTES) {
    return {
      ok: false,
      reason: 'rs_failed',
      message:
        `decodeMarkerBytes: expected ${MARKER_CHANNEL_BYTES}-byte codeword, ` +
        `got ${codeword.length}`,
    };
  }

  // 1. Per-chunk RS decode, write each 170-byte corrected message
  //    slice back into the logical message in interleave order.
  const logicalMsg = new Uint8Array(MARKER_LOGICAL_MESSAGE_BYTES);
  for (let k = 0; k < MARKER_NUM_CHUNKS; k += 1) {
    const chunkStart = k * MARKER_CHUNK_BYTES;
    const chunkCw = codeword.subarray(
      chunkStart,
      chunkStart + MARKER_CHUNK_BYTES,
    );
    let correctedMsg: Uint8Array;
    try {
      correctedMsg = rsDecode(chunkCw, MARKER_CHUNK_PARITY);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      return {
        ok: false,
        reason: 'rs_failed',
        message: `decodeMarkerBytes: RS decode failed on chunk ${k}: ${msg}`,
      };
    }
    // rsDecode returns the recovered message (length = codeword -
    // parity = 170). Belt-and-braces length check in case the RS
    // primitive ever changes contract.
    if (correctedMsg.length !== MARKER_CHUNK_MESSAGE) {
      return {
        ok: false,
        reason: 'rs_failed',
        message:
          `decodeMarkerBytes: chunk ${k} corrected message length ` +
          `${correctedMsg.length} != ${MARKER_CHUNK_MESSAGE}`,
      };
    }
    logicalMsg.set(correctedMsg, k * MARKER_CHUNK_MESSAGE);
  }

  // 2. Version byte.
  if (logicalMsg[0] !== MARKER_FORMAT_VERSION) {
    return {
      ok: false,
      reason: 'bad_version',
      message:
        'decodeMarkerBytes: unknown format version 0x' +
        `${logicalMsg[0].toString(16).padStart(2, '0')} ` +
        `(expected 0x${MARKER_FORMAT_VERSION.toString(16).padStart(2, '0')})`,
    };
  }

  // 3. Node-count N and payload-end bounds.
  const N = logicalMsg[1];
  if (N === 0) {
    return {
      ok: false,
      reason: 'bad_record',
      message: 'decodeMarkerBytes: N=0 (no nodes) is not a valid mindmap',
    };
  }
  if (N > MARKER_PUBLISHED_NODE_CAP) {
    return {
      ok: false,
      reason: 'bad_record',
      message:
        `decodeMarkerBytes: N=${N} exceeds published cap ` +
        `${MARKER_PUBLISHED_NODE_CAP}`,
    };
  }
  const payloadEnd = 2 + N * MARKER_NODE_RECORD_BYTES;
  // CRC occupies payloadEnd..payloadEnd+3. Anything past that is RS
  // zero-padding that we don't inspect.
  if (payloadEnd + 4 > MARKER_LOGICAL_MESSAGE_BYTES) {
    return {
      ok: false,
      reason: 'bad_record',
      message:
        `decodeMarkerBytes: N=${N} requires ${payloadEnd + 4} message ` +
        `bytes, logical capacity is ${MARKER_LOGICAL_MESSAGE_BYTES}`,
    };
  }

  // 4. CRC32 over [0..2+10N-1]. Observed CRC is big-endian at
  //    [2+10N..+3].
  const crcObserved =
    ((logicalMsg[payloadEnd] << 24) |
      (logicalMsg[payloadEnd + 1] << 16) |
      (logicalMsg[payloadEnd + 2] << 8) |
      logicalMsg[payloadEnd + 3]) >>>
    0;
  const crcComputed = crc32(logicalMsg.subarray(0, payloadEnd));
  if (crcObserved !== crcComputed) {
    return {
      ok: false,
      reason: 'crc_failed',
      message:
        'decodeMarkerBytes: CRC mismatch (observed 0x' +
        `${crcObserved.toString(16).padStart(8, '0')}, computed 0x` +
        `${crcComputed.toString(16).padStart(8, '0')})`,
    };
  }

  // 5. Parse the N records and rebuild the tree. Per §6.3:
  //    [0]    parent index (0xFF for root, else index < self)
  //    [1]    shape kind (OVAL for root, RECTANGLE / ROUNDED_RECTANGLE otherwise)
  //    [2..9] bbox x/y/w/h, each uint16 BE
  const tree: Tree = {
    rootId: 0,
    nodesById: new Map<NodeId, MindmapNode>(),
    nextId: N,
  };
  const nodeBboxesById = new Map<NodeId, Rect>();

  for (let i = 0; i < N; i += 1) {
    const off = 2 + i * MARKER_NODE_RECORD_BYTES;
    const parentByte = logicalMsg[off + 0];
    const shapeByte = logicalMsg[off + 1];
    const bboxX = (logicalMsg[off + 2] << 8) | logicalMsg[off + 3];
    const bboxY = (logicalMsg[off + 4] << 8) | logicalMsg[off + 5];
    const bboxW = (logicalMsg[off + 6] << 8) | logicalMsg[off + 7];
    const bboxH = (logicalMsg[off + 8] << 8) | logicalMsg[off + 9];

    if (i === 0) {
      if (parentByte !== MARKER_ROOT_PARENT) {
        return {
          ok: false,
          reason: 'bad_record',
          message:
            'decodeMarkerBytes: root parent byte 0x' +
            `${parentByte.toString(16).padStart(2, '0')} ` +
            `(expected 0x${MARKER_ROOT_PARENT.toString(16)})`,
        };
      }
      if (shapeByte !== ShapeKind.OVAL) {
        return {
          ok: false,
          reason: 'bad_record',
          message:
            `decodeMarkerBytes: root shape byte ${shapeByte} ` +
            `(expected ShapeKind.OVAL = ${ShapeKind.OVAL})`,
        };
      }
    } else {
      // Non-root nodes: parent must be an earlier index. BFS ordering
      // at encode time guarantees parent < self; a decoded record
      // violating that invariant is corrupt.
      if (parentByte === MARKER_ROOT_PARENT) {
        return {
          ok: false,
          reason: 'bad_record',
          message:
            `decodeMarkerBytes: non-root node ${i} uses root parent sentinel`,
        };
      }
      if (parentByte >= i) {
        return {
          ok: false,
          reason: 'bad_record',
          message:
            `decodeMarkerBytes: node ${i} parent index ${parentByte} ` +
            'is not earlier in the record array',
        };
      }
      if (
        shapeByte !== ShapeKind.RECTANGLE &&
        shapeByte !== ShapeKind.ROUNDED_RECTANGLE
      ) {
        return {
          ok: false,
          reason: 'bad_record',
          message:
            `decodeMarkerBytes: node ${i} shape byte ${shapeByte} ` +
            'not in {RECTANGLE, ROUNDED_RECTANGLE}',
        };
      }
    }

    const node: MindmapNode = {
      id: i,
      parentId: i === 0 ? null : parentByte,
      shape: shapeByte as ShapeKind,
      childIds: [],
      collapsed: false,
    };
    tree.nodesById.set(i, node);
    if (i !== 0) {
      // parentByte < i was validated above, so nodesById.get is
      // guaranteed to hit. The explicit guard below is defensive —
      // keeps the type narrowing for TS and surfaces any future
      // invariant slippage as a clean decode error instead of an
      // uncaught null dereference.
      const parent = tree.nodesById.get(parentByte);
      if (!parent) {
        return {
          ok: false,
          reason: 'bad_record',
          message:
            `decodeMarkerBytes: node ${i} parent ${parentByte} ` +
            'missing from partial tree (invariant failure)',
        };
      }
      parent.childIds.push(i);
    }
    nodeBboxesById.set(i, {x: bboxX, y: bboxY, w: bboxW, h: bboxH});
  }

  return {
    ok: true,
    tree,
    nodeBboxesById,
    markerOriginPage: {x: 0, y: 0},
  };
}
