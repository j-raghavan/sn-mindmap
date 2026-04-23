/* eslint-disable no-bitwise */
/**
 * Marker encoding — converts a Tree + per-node bboxes into the 648-byte
 * interleaved Reed-Solomon channel and into a list of tiny horizontal
 * dot geometries that are inserted invisibly with the mindmap.
 *
 * Wire layout (§6.1, §6.2, §6.3):
 *
 *   Channel: 648 bytes = 72×72 bits, row-major, MSB-first within each
 *   byte. Divided into 3 RS(216, 170) chunks (3 × 170 = 510 logical
 *   message bytes, 3 × 46 = 138 parity bytes, total = 648).
 *
 *   Logical message (510 bytes):
 *     [0]        format version = 0x02
 *     [1]        N = node count (1..50)
 *     [2..2+10N-1] N node records, 10 bytes each:
 *                  [+0] parent index (0xFF = root sentinel)
 *                  [+1] shape byte (ShapeKind)
 *                  [+2..+3] bbox.x uint16 BE
 *                  [+4..+5] bbox.y uint16 BE
 *                  [+6..+7] bbox.w uint16 BE
 *                  [+8..+9] bbox.h uint16 BE
 *     [2+10N..+3] CRC32 (IEEE 802.3) over [0..2+10N-1], uint32 BE
 *     rest        zero-padded
 *
 *   Interleave: the 510 logical bytes are split into 3 consecutive
 *   170-byte slices, each encoded separately with rsEncode(slice, 46)
 *   to produce a 216-byte chunk. The three chunks are concatenated to
 *   fill the 648-byte channel. Interleaving is per-chunk (contiguous),
 *   NOT bit-interleaved.
 *
 *   Dot geometry (§6.4): one `straightLine` per set bit, horizontal,
 *   length MARKER_BIT_STROKE_LEN px, aligned to the 4-px cell grid
 *   anchored at `markerOrigin`. Pen color 0x9D, pen type 10
 *   (Fineliner), pen width 100.
 */
import type {LineGeometry, Point, Rect} from '../geometry';
import {type NodeId, type Tree} from '../model/tree';
import {crc32, rsEncode} from './rs';

// -----------------------------------------------------------------
// Wire constants (§6.1, §6.2, §6.3, §6.4, §F-PE-3, §F-PE-4)
// -----------------------------------------------------------------

/** Grid dimension (rows = cols = 72). §6.1 */
export const MARKER_GRID = 72;

/** Pixels per grid cell on-device. §6.1 */
export const MARKER_CELL_PX = 4;

/** Total pixel footprint of the marker block (288 × 288). §F-PE-3 */
export const MARKER_FOOTPRINT_PX = MARKER_GRID * MARKER_CELL_PX; // 288

/** Raw channel size in bytes = 72×72 / 8 bits. §6.2 */
export const MARKER_CHANNEL_BYTES = (MARKER_GRID * MARKER_GRID) / 8; // 648

/** Bytes per encoded node record. §6.3 */
export const MARKER_NODE_RECORD_BYTES = 10;

/** Marker format version byte, written at logical-message[0]. */
export const MARKER_FORMAT_VERSION = 0x02;

/** Published node count ceiling per §F-PE-4. */
export const MARKER_PUBLISHED_NODE_CAP = 50;

/** Number of interleaved RS chunks. §6.2 */
export const MARKER_NUM_CHUNKS = 3;

/** Bytes per RS chunk (message + parity). §6.2 */
export const MARKER_CHUNK_BYTES = 216;

/** Parity bytes per RS chunk = floor(216 × 0.213). §6.2 */
export const MARKER_CHUNK_PARITY = 46;

/** Message bytes per RS chunk = 216 - 46. §6.2 */
export const MARKER_CHUNK_MESSAGE = MARKER_CHUNK_BYTES - MARKER_CHUNK_PARITY; // 170

/** Total logical message bytes = 3 × 170. §6.2 */
export const MARKER_LOGICAL_MESSAGE_BYTES =
  MARKER_NUM_CHUNKS * MARKER_CHUNK_MESSAGE; // 510

/** Parent-index sentinel used in record[0] (the root). §6.3 */
export const MARKER_ROOT_PARENT = 0xff;

/**
 * Pen color used for marker dot geometries (§6.4).
 * 0x9D is in the "light grey" palette slot — visually near-invisible
 * on white paper and unique enough that the decoder can use it as a
 * discriminator without additional metadata.
 */
export const MARKER_PEN_COLOR = 0x9d;

/**
 * Pen type for marker dots. Must be in the firmware allow-list
 * {1=Pressure, 10=Fineliner, 11=Marker, 14=Calligraphy}.
 */
export const MARKER_PEN_TYPE = 10; // Fineliner

/**
 * Pen width for marker dot geometries (§6.4).
 * Equals the firmware's minimum pen width so dots are as small as
 * possible and visually imperceptible at normal zoom.
 */
export const MARKER_PEN_WIDTH = 100;

/**
 * Length in pixels of each horizontal "bit stroke". Kept at 3 so the
 * stroke's midpoint is offset by exactly 1.5 px from the cell's left
 * edge, making the decode's midpoint formula exact:
 *   col = round((midX - origin.x - 1.5) / CELL_PX)
 * Length 3 < CELL_PX + 0.5 = 4.5, so the decoder's candidate filter
 * (length ≤ 4.5 px) also accepts these strokes.
 */
export const MARKER_BIT_STROKE_LEN = 3;

/**
 * Error message shown in the capacity-error modal when the tree exceeds
 * the marker's maximum node count (§F-PE-4, §6.3: N ≤ 50). Must not
 * contain internal spec references (no "§") and must contain the phrase
 * "Reduce nodes" so the UI can match it without a string literal copy.
 */
export const MARKER_CAPACITY_MESSAGE =
  'This mindmap has more structure than can be embedded (maximum 50 nodes). ' +
  'Reduce nodes or split it into multiple mindmaps.';

// -----------------------------------------------------------------
// MarkerCapacityError
// -----------------------------------------------------------------

/**
 * Thrown by encodeMarkerBytes / encodeMarker when the tree exceeds
 * MARKER_PUBLISHED_NODE_CAP. Carries the actual node count as a
 * diagnostic field so the UI can render it in the capacity modal
 * without re-counting (§F-PE-4).
 */
export class MarkerCapacityError extends Error {
  readonly nodeCount: number;
  constructor(nodeCount: number) {
    super(MARKER_CAPACITY_MESSAGE);
    this.name = 'MarkerCapacityError';
    this.nodeCount = nodeCount;
    // Maintain proper prototype chain for instanceof checks in ES5
    // transpiled environments.
    Object.setPrototypeOf(this, new.target.prototype);
  }
}

// -----------------------------------------------------------------
// encodeMarkerBytes
// -----------------------------------------------------------------

export type EncodeInput = {
  tree: Tree;
  nodeBboxesById: Map<NodeId, Rect>;
  markerOrigin: Point;
};

/**
 * Serialize the tree into a 648-byte interleaved RS channel buffer.
 *
 * Algorithm:
 *   1. BFS-traverse the tree to establish node→position mapping.
 *   2. Build the 510-byte logical message (header + records + CRC32).
 *   3. Split into 3 × 170-byte slices, RS-encode each with 46 parity
 *      bytes, concatenate into the 648-byte channel.
 *
 * All bboxes in `nodeBboxesById` must be in mindmap-local coords
 * (origin = markerOrigin page coords). The `markerOrigin` param is
 * unused by encodeMarkerBytes itself but kept in the signature so
 * encodeMarker can accept the same EncodeInput struct.
 *
 * Throws MarkerCapacityError when N > MARKER_PUBLISHED_NODE_CAP.
 * Throws Error when a node is missing from nodeBboxesById.
 */
export function encodeMarkerBytes(input: EncodeInput): Uint8Array {
  const {tree, nodeBboxesById} = input;

  // BFS traversal to build an ordered node list and a position map
  // (NodeId → record index). BFS guarantees parent index < self for
  // every non-root record, which is required by the decoder (§6.3).
  const ordered: NodeId[] = bfsOrder(tree);
  const N = ordered.length;

  if (N > MARKER_PUBLISHED_NODE_CAP) {
    throw new MarkerCapacityError(N);
  }

  // Position map: NodeId → index in BFS order.
  const pos = new Map<NodeId, number>();
  for (let i = 0; i < N; i += 1) {
    pos.set(ordered[i], i);
  }

  // Build 510-byte logical message.
  const msg = new Uint8Array(MARKER_LOGICAL_MESSAGE_BYTES);
  msg[0] = MARKER_FORMAT_VERSION;
  msg[1] = N;

  for (let i = 0; i < N; i += 1) {
    const id = ordered[i];
    const node = tree.nodesById.get(id);
    if (!node) {
      throw new Error(`encodeMarkerBytes: no node for id ${id}`);
    }
    const bbox = nodeBboxesById.get(id);
    if (!bbox) {
      throw new Error(`encodeMarkerBytes: no bbox for node id ${id}`);
    }
    const off = 2 + i * MARKER_NODE_RECORD_BYTES;

    // Parent index: root uses the sentinel 0xFF; others use BFS
    // position of their parent.
    const parentByte =
      node.parentId === null
        ? MARKER_ROOT_PARENT
        : (pos.get(node.parentId) as number);

    msg[off + 0] = parentByte;
    msg[off + 1] = node.shape;

    // bbox fields as uint16 BE, clamped to [0, 65535].
    writeUint16BE(msg, off + 2, bbox.x);
    writeUint16BE(msg, off + 4, bbox.y);
    writeUint16BE(msg, off + 6, bbox.w);
    writeUint16BE(msg, off + 8, bbox.h);
  }

  // CRC32 over [0..2+10N-1].
  const payloadEnd = 2 + N * MARKER_NODE_RECORD_BYTES;
  const checksum = crc32(msg.subarray(0, payloadEnd));
  msg[payloadEnd + 0] = (checksum >>> 24) & 0xff;
  msg[payloadEnd + 1] = (checksum >>> 16) & 0xff;
  msg[payloadEnd + 2] = (checksum >>> 8) & 0xff;
  msg[payloadEnd + 3] = checksum & 0xff;

  // Split into 3 × 170-byte chunks, RS-encode each, concatenate.
  const channel = new Uint8Array(MARKER_CHANNEL_BYTES);
  for (let k = 0; k < MARKER_NUM_CHUNKS; k += 1) {
    const start = k * MARKER_CHUNK_MESSAGE;
    const chunkMsg = msg.subarray(start, start + MARKER_CHUNK_MESSAGE);
    const chunkCw = rsEncode(chunkMsg, MARKER_CHUNK_PARITY);
    channel.set(chunkCw, k * MARKER_CHUNK_BYTES);
  }

  return channel;
}

// -----------------------------------------------------------------
// encodeMarker
// -----------------------------------------------------------------

/**
 * Convert the tree into a list of horizontal dot geometries, one per
 * set bit in the 648-byte channel produced by encodeMarkerBytes.
 *
 * Each bit at grid position (row, col) becomes a straightLine with:
 *   p0 = { x: markerOrigin.x + col * CELL_PX,
 *           y: markerOrigin.y + row * CELL_PX }
 *   p1 = { x: p0.x + MARKER_BIT_STROKE_LEN, y: p0.y }
 *
 * Pen style: color = 0x9D, type = Fineliner, width = 100,
 * showLassoAfterInsert = false.
 *
 * Throws MarkerCapacityError (via encodeMarkerBytes) when N > cap.
 */
export function encodeMarker(input: EncodeInput): LineGeometry[] {
  const {markerOrigin} = input;
  const channel = encodeMarkerBytes(input);
  const geoms: LineGeometry[] = [];

  for (let byteIdx = 0; byteIdx < channel.length; byteIdx += 1) {
    const byte = channel[byteIdx];
    if (byte === 0) {
      continue;
    }
    for (let bit = 7; bit >= 0; bit -= 1) {
      if ((byte >>> bit) & 1) {
        const bitIndex = byteIdx * 8 + (7 - bit);
        const row = Math.floor(bitIndex / MARKER_GRID);
        const col = bitIndex % MARKER_GRID;
        const x0 = markerOrigin.x + col * MARKER_CELL_PX;
        const y0 = markerOrigin.y + row * MARKER_CELL_PX;
        geoms.push({
          type: 'straightLine',
          penColor: MARKER_PEN_COLOR,
          penType: MARKER_PEN_TYPE,
          penWidth: MARKER_PEN_WIDTH,
          showLassoAfterInsert: false,
          points: [
            {x: x0, y: y0},
            {x: x0 + MARKER_BIT_STROKE_LEN, y: y0},
          ],
        });
      }
    }
  }

  return geoms;
}

// -----------------------------------------------------------------
// Internal helpers
// -----------------------------------------------------------------

/**
 * BFS traversal of the tree. Returns node IDs in breadth-first order,
 * root first. This ordering guarantees parent index < self for every
 * non-root record in the marker byte layout (§6.3).
 */
function bfsOrder(tree: Tree): NodeId[] {
  const result: NodeId[] = [];
  const queue: NodeId[] = [tree.rootId];
  while (queue.length > 0) {
    const id = queue.shift() as NodeId;
    result.push(id);
    const node = tree.nodesById.get(id);
    if (node) {
      for (const childId of node.childIds) {
        queue.push(childId);
      }
    }
  }
  return result;
}

function writeUint16BE(buf: Uint8Array, offset: number, value: number): void {
  const v = Math.max(0, Math.min(0xffff, Math.round(value)));
  buf[offset] = (v >>> 8) & 0xff;
  buf[offset + 1] = v & 0xff;
}
