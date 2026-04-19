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
import type {Tree, NodeId} from '../model/tree';

export const MARKER_GRID = 72; // cells per side, §6.1
export const MARKER_CELL_PX = 4; // px per cell, §6.1
export const MARKER_FOOTPRINT_PX = MARKER_GRID * MARKER_CELL_PX; // 288, §6.1
export const MARKER_CHANNEL_BYTES = 648; // 72*72/8, §6.2
export const MARKER_NODE_RECORD_BYTES = 10; // §6.3
export const MARKER_FORMAT_VERSION = 0x02; // v2 header byte, §6.2
export const MARKER_PUBLISHED_NODE_CAP = 50; // §F-PE-4
export const MARKER_THEORETICAL_NODE_CAP = 53; // §6.2 at ≥ 20% parity

export class MarkerCapacityError extends Error {
  constructor(public readonly nodeCount: number) {
    super(
      `Mindmap has ${nodeCount} nodes, exceeding the v0.1 cap of ` +
        `${MARKER_PUBLISHED_NODE_CAP}. (See §F-PE-4 / §8.3.)`,
    );
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
 * Pack a Tree into the on-paper marker geometries.
 *
 * TODO(Phase 3, §6): implement — tree -> binary records -> CRC32 ->
 * RS encode -> bit matrix -> Geometry[] of length-3-px straightLines.
 *
 * Throws MarkerCapacityError if tree.nodesById.size >
 * MARKER_PUBLISHED_NODE_CAP.
 */
export function encodeMarker(_input: EncodeInput): Geometry[] {
  throw new Error('TODO(Phase 3, §6): encodeMarker not implemented');
}

/**
 * Encode just the binary record buffer (header + length + node
 * records + CRC32 + RS parity). Exposed separately so unit tests can
 * round-trip bytes without going through the bit-matrix renderer.
 *
 * TODO(Phase 3, §6.2 / §6.3): implement.
 */
export function encodeMarkerBytes(_input: EncodeInput): Uint8Array {
  throw new Error('TODO(Phase 3, §6.2 / §6.3): encodeMarkerBytes not implemented');
}
