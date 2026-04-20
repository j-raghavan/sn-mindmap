/* eslint-disable no-bitwise */
/**
 * Marker encoder — Tree -> binary records -> RS codeword -> bit
 * matrix -> Geometry[] (§6).
 *
 * Wire format v2 (header byte 0x02), per §6.2:
 *
 *   Byte 0           format version (uint8; 0x02 for v2)
 *   Byte 1           node count N (uint8; max 255 by type, max 50 by §F-PE-4)
 *   Bytes 2..2+10N-1 packed node records, 10 bytes each (§6.3)
 *   Bytes 2+10N..+3  CRC32 of bytes 0..2+10N-1 (big-endian)
 *   Bytes ..647      Reed-Solomon parity (fill to 648 bytes)
 *
 * Grid:  72 × 72 cells, 4 px each, 288×288 px footprint (§6.1, §F-PE-3).
 * Cell rendering: each "1" bit becomes one straightLine of length 3 px
 *                 at the bit's (col, row) position within the 4-px
 *                 cell, pen color 0x9D, pen width 100 (§6.4).
 * Anchor: top-left of the mindmap's bounding rectangle, with a small
 *         fixed offset so it is reliably captured by a full-map lasso
 *         (§6.1).
 *
 * Capacity (§6.2 / §8.3):
 *   message bytes = 2 + 10N + 4
 *   parity bytes  = 648 - message bytes
 *   parity ratio  = parity / message; design rule ≥ 20%
 *   theoretical ceiling N = 53; published v0.1 cap N = 50 (§F-PE-4).
 *
 * If the encoded payload exceeds capacity, the caller (insert.ts /
 * MindmapCanvas) must surface the §F-PE-4 modal — no silent
 * truncation. encodeMarker throws MarkerCapacityError so the caller
 * can detect this case explicitly.
 */
import type {Geometry, Point, Rect} from '../geometry';
import {ShapeKind, type Tree, type NodeId} from '../model/tree';
import {crc32, rsEncode} from './rs';

export const MARKER_GRID = 72; // cells per side, §6.1
export const MARKER_CELL_PX = 4; // px per cell, §6.1
export const MARKER_FOOTPRINT_PX = MARKER_GRID * MARKER_CELL_PX; // 288, §6.1
export const MARKER_CHANNEL_BYTES = 648; // 72*72/8, §6.2
export const MARKER_NODE_RECORD_BYTES = 10; // §6.3
export const MARKER_FORMAT_VERSION = 0x02; // v2 header byte, §6.2
export const MARKER_PUBLISHED_NODE_CAP = 50; // §F-PE-4

/**
 * Interleaved-chunk RS layout constants.
 *
 * §6.2 describes the 648-byte channel as a single RS codeword, but
 * GF(256) caps codewords at 255 bytes — so a pure single-block
 * encoding is not representable in the field the codec actually uses.
 * The smallest adjustment that preserves §6.2's capacity math
 * (N ≤ 50 at ≥ 20% parity) is to interleave K = 3 independent
 * RS(216, 170) codewords across the 648-byte channel:
 *
 *   chunk 0 : buf[  0 .. 215]  (first 170 = message, last 46 = parity)
 *   chunk 1 : buf[216 .. 431]
 *   chunk 2 : buf[432 .. 647]
 *
 * Global logical message (510 bytes total) is the concatenation of
 * each chunk's message region: logicalMsg[k*170 + j] <-> buf[k*216 + j].
 * Per-chunk parity is fixed at 46 bytes (≈27% ratio) regardless of
 * node count; the decoder never has to guess the split from the
 * (possibly corrupted) raw byte 1 as a result. Channel bytes beyond
 * the actual encoded message get zero-padded — RS treats the pad as
 * ordinary message bytes, so those zeros are corrected along with
 * everything else.
 *
 * This diverges from the letter of §6.2 (which describes a single
 * contiguous parity tail at buf[2+10N+4..647]); §10 tracks the spec
 * update required to codify the interleaved layout. The capacity
 * table in §6.2 still applies: max N with fixed 138-byte global
 * parity is exactly 50.
 */
export const MARKER_NUM_CHUNKS = 3;
export const MARKER_CHUNK_BYTES = MARKER_CHANNEL_BYTES / MARKER_NUM_CHUNKS; // 216
export const MARKER_CHUNK_PARITY = 46;
export const MARKER_CHUNK_MESSAGE =
  MARKER_CHUNK_BYTES - MARKER_CHUNK_PARITY; // 170
export const MARKER_LOGICAL_MESSAGE_BYTES =
  MARKER_NUM_CHUNKS * MARKER_CHUNK_MESSAGE; // 510

/**
 * Root node uses 0xFF as a sentinel parent index. Non-root nodes
 * always have parent < self in the serialized array, so 0xFF can
 * never collide with a valid parent index.
 */
export const MARKER_ROOT_PARENT = 0xff;

/**
 * §6.4 marker pen style. Pen color 0x9D is the "invisible-ish" channel
 * the firmware provides for technical/metadata strokes — it's how we
 * keep the marker strokes out of the authoring viewport while still
 * persisting them to the page's stroke list. Pen width 100 keeps the
 * per-cell stroke well under the 4 px cell footprint.
 *
 * penType: 10 (Fineliner) is **required** by the firmware allow-list
 * — the insertGeometry API rejects anything outside
 * {1=Pressure, 10=Fineliner, 11=Marker, 14=Calligraphy}. See the same
 * note in geometry.ts's PEN_DEFAULTS for the on-device fallout of
 * getting this wrong.
 */
export const MARKER_PEN_COLOR = 0x9d;
export const MARKER_PEN_WIDTH = 100;
export const MARKER_PEN_TYPE = 10;

/**
 * Length (in pixels) of each per-bit straightLine inside its 4-px
 * cell (§6.4). Keeping it strictly less than the cell size means
 * adjacent "1" bits never touch — the decoder projects stroke
 * midpoints to cells without risk of a single stroke being claimed
 * by two cells.
 */
export const MARKER_BIT_STROKE_LEN = 3;

/**
 * User-facing capacity message verbatim from §F-PE-4. This is the
 * string the UI shows in the capacity modal — no spec references, no
 * numeric counts. A bare message means the same error bubbles up
 * through the insert pipeline, gets caught in MindmapCanvas, and is
 * rendered into the modal without any translation step that could
 * drift from the spec's exact wording. `nodeCount` is still attached
 * as an instance field for diagnostics / logcat.
 */
export const MARKER_CAPACITY_MESSAGE =
  'This mindmap has more structure than can be embedded. Reduce ' +
  'nodes, or split across multiple mindmaps.';

export class MarkerCapacityError extends Error {
  constructor(public readonly nodeCount: number) {
    super(MARKER_CAPACITY_MESSAGE);
    this.name = 'MarkerCapacityError';
  }
}

export type EncodeInput = {
  tree: Tree;
  /** Per-node bbox in mindmap-local coords (origin = marker top-left). */
  nodeBboxesById: Map<NodeId, Rect>;
  /** Top-left anchor for the marker grid in page-pixel coords. */
  markerOrigin: Point;
};

/**
 * Pack a Tree into the on-paper marker geometries (§6.4).
 *
 * Delegates to encodeMarkerBytes for the 648-byte channel, then
 * unpacks the 5184 bits in row-major order and emits one
 * MARKER_BIT_STROKE_LEN-px horizontal straightLine per "1" bit at
 * the cell's top-left corner. Cells holding a "0" bit emit nothing —
 * the decoder treats absent cells as 0 bits.
 *
 * Bit packing convention (matched in decodeMarker): bit index
 * `row * MARKER_GRID + col` lands in byte `bitIndex >>> 3`,
 * MSB-first (bit 0 is the 0x80 mask). Row 0 spans bytes [0..8]
 * inclusive (72 bits = 9 bytes), row 1 spans bytes [9..17], etc.
 *
 * Every emitted geometry has showLassoAfterInsert=false — the caller
 * in insert.ts lassos the union rect of outlines + marker explicitly
 * at the end of the emit pipeline (§F-IN-3).
 */
export function encodeMarker(input: EncodeInput): Geometry[] {
  const bytes = encodeMarkerBytes(input);
  const {markerOrigin} = input;
  const out: Geometry[] = [];
  for (let row = 0; row < MARKER_GRID; row += 1) {
    for (let col = 0; col < MARKER_GRID; col += 1) {
      const bitIndex = row * MARKER_GRID + col;
      const byteIdx = bitIndex >>> 3;
      const bitMask = 0x80 >>> (bitIndex & 7);
      if ((bytes[byteIdx] & bitMask) === 0) {
        continue;
      }
      const x = markerOrigin.x + col * MARKER_CELL_PX;
      const y = markerOrigin.y + row * MARKER_CELL_PX;
      out.push({
        type: 'straightLine',
        points: [
          {x, y},
          {x: x + MARKER_BIT_STROKE_LEN, y},
        ],
        penColor: MARKER_PEN_COLOR,
        penType: MARKER_PEN_TYPE,
        penWidth: MARKER_PEN_WIDTH,
        showLassoAfterInsert: false,
      });
    }
  }
  return out;
}

/**
 * Encode a tree into the 648-byte marker channel buffer — header +
 * length + node records + CRC32, RS-protected via interleaved
 * RS(216, 170) chunks (see MARKER_NUM_CHUNKS and friends).
 *
 * Traversal order: BFS from the root. The root lives at index 0 with
 * parent = 0xFF (MARKER_ROOT_PARENT); every non-root node has
 * parent index < its own index by construction. BFS is deterministic
 * because Tree.nodesById uses insertion-ordered Maps and childIds is
 * an ordered array.
 *
 * Throws MarkerCapacityError if the tree has more than
 * MARKER_PUBLISHED_NODE_CAP nodes; callers surface the §F-PE-4
 * modal and abort insert.
 */
export function encodeMarkerBytes(input: EncodeInput): Uint8Array {
  const {tree, nodeBboxesById} = input;
  const orderedIds = bfsOrder(tree);
  const N = orderedIds.length;
  if (N === 0) {
    throw new Error('encodeMarkerBytes: empty tree (no nodes)');
  }
  if (N > MARKER_PUBLISHED_NODE_CAP) {
    throw new MarkerCapacityError(N);
  }
  if (N > 0xff) {
    // Belt-and-braces: MARKER_PUBLISHED_NODE_CAP is 50 so we're
    // nowhere near 0xFF (255), but N is stored in a single byte so
    // the ceiling is hard-capped at 255 regardless of what the
    // published cap eventually grows to.
    throw new MarkerCapacityError(N);
  }

  // Build logical message: header + records + CRC + zero pad.
  const logicalMsg = new Uint8Array(MARKER_LOGICAL_MESSAGE_BYTES);
  logicalMsg[0] = MARKER_FORMAT_VERSION;
  logicalMsg[1] = N;

  const idxById = new Map<NodeId, number>();
  for (let i = 0; i < orderedIds.length; i += 1) {
    idxById.set(orderedIds[i], i);
  }

  for (let i = 0; i < N; i += 1) {
    const id = orderedIds[i];
    const node = tree.nodesById.get(id);
    if (!node) {
      throw new Error(`encodeMarkerBytes: orphan id ${id} in orderedIds`);
    }
    const bbox = nodeBboxesById.get(id);
    if (!bbox) {
      throw new Error(`encodeMarkerBytes: no bbox for node ${id}`);
    }
    const parentIdx =
      node.parentId === null
        ? MARKER_ROOT_PARENT
        : idxById.get(node.parentId) ?? MARKER_ROOT_PARENT;
    writeRecord(
      logicalMsg,
      2 + i * MARKER_NODE_RECORD_BYTES,
      parentIdx,
      node.shape,
      bbox,
    );
  }

  // CRC32 covers header + records (bytes 0..2+10N-1).
  const crcScope = 2 + N * MARKER_NODE_RECORD_BYTES;
  const crc = crc32(logicalMsg.subarray(0, crcScope));
  writeUint32BE(logicalMsg, crcScope, crc);

  // Interleaved RS encode: one chunk at a time into the channel.
  const channel = new Uint8Array(MARKER_CHANNEL_BYTES);
  for (let k = 0; k < MARKER_NUM_CHUNKS; k += 1) {
    const msgStart = k * MARKER_CHUNK_MESSAGE;
    const chunkMsg = logicalMsg.subarray(
      msgStart,
      msgStart + MARKER_CHUNK_MESSAGE,
    );
    const chunkCw = rsEncode(chunkMsg, MARKER_CHUNK_PARITY);
    channel.set(chunkCw, k * MARKER_CHUNK_BYTES);
  }
  return channel;
}

// -------------------------------------------------------------------
// internal helpers
// -------------------------------------------------------------------

/**
 * BFS the tree starting at the root. The resulting array establishes
 * the (node id -> record index) mapping used throughout the marker
 * codec.
 */
function bfsOrder(tree: Tree): NodeId[] {
  const out: NodeId[] = [];
  const queue: NodeId[] = [tree.rootId];
  const seen = new Set<NodeId>([tree.rootId]);
  while (queue.length > 0) {
    const id = queue.shift() as NodeId;
    out.push(id);
    const node = tree.nodesById.get(id);
    if (!node) {
      continue;
    }
    for (const childId of node.childIds) {
      if (seen.has(childId)) {
        continue;
      }
      seen.add(childId);
      queue.push(childId);
    }
  }
  return out;
}

/**
 * Write a single 10-byte node record into `buf` at `offset`. Layout:
 *
 *   [0]    parent index (uint8, 0xFF for root)
 *   [1]    shape kind (uint8, ShapeKind enum)
 *   [2..3] bbox x (uint16 big-endian)
 *   [4..5] bbox y (uint16 big-endian)
 *   [6..7] bbox w (uint16 big-endian)
 *   [8..9] bbox h (uint16 big-endian)
 *
 * Per §6.3 coords must fit uint16. We clamp negative values to 0
 * defensively — mindmap-local coords after the origin shift in §F-IN-2
 * are guaranteed non-negative, but a caller bug that passes a raw
 * page-space bbox with a negative x shouldn't produce undefined
 * behavior silently.
 */
function writeRecord(
  buf: Uint8Array,
  offset: number,
  parentIdx: number,
  shape: ShapeKind,
  bbox: Rect,
): void {
  buf[offset + 0] = parentIdx & 0xff;
  buf[offset + 1] = shape & 0xff;
  writeUint16BE(buf, offset + 2, clampU16(bbox.x));
  writeUint16BE(buf, offset + 4, clampU16(bbox.y));
  writeUint16BE(buf, offset + 6, clampU16(bbox.w));
  writeUint16BE(buf, offset + 8, clampU16(bbox.h));
}

function writeUint16BE(buf: Uint8Array, offset: number, value: number): void {
  buf[offset + 0] = (value >>> 8) & 0xff;
  buf[offset + 1] = value & 0xff;
}

function writeUint32BE(buf: Uint8Array, offset: number, value: number): void {
  buf[offset + 0] = (value >>> 24) & 0xff;
  buf[offset + 1] = (value >>> 16) & 0xff;
  buf[offset + 2] = (value >>> 8) & 0xff;
  buf[offset + 3] = value & 0xff;
}

function clampU16(value: number): number {
  if (!Number.isFinite(value)) {
    return 0;
  }
  const v = Math.round(value);
  if (v < 0) {
    return 0;
  }
  if (v > 0xffff) {
    return 0xffff;
  }
  return v;
}
