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
import type {Geometry, Point, Rect} from '../geometry';
import {
  ShapeKind,
  type MindmapNode,
  type NodeId,
  type Tree,
} from '../model/tree';
import {
  MARKER_CHANNEL_BYTES,
  MARKER_CHUNK_BYTES,
  MARKER_CHUNK_MESSAGE,
  MARKER_CHUNK_PARITY,
  MARKER_FORMAT_VERSION,
  MARKER_LOGICAL_MESSAGE_BYTES,
  MARKER_NODE_RECORD_BYTES,
  MARKER_NUM_CHUNKS,
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
 * TODO(Phase 3.3, §6.5 steps 1-4): bit-matrix recovery from lassoed
 * strokes. decodeMarker chains the projection pipeline (steps 1-4)
 * into decodeMarkerBytes (steps 5-7). Phase 3.2 only implements the
 * bytes-in-bytes-out half.
 */
export function decodeMarker(_lassoedGeometries: Geometry[]): DecodeResult {
  throw new Error('TODO(Phase 3.3, §6.5): decodeMarker not implemented');
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
