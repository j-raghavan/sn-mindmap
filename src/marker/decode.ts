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
 * Failure modes (all surface as "marker not found" / "marker
 * corrupted" per §F-ED-4):
 *   - no candidate strokes
 *   - RS decode fails (too many errors)
 *   - CRC mismatch
 *   - byte 0 != MARKER_FORMAT_VERSION
 *   - parent index out of range or referencing self
 */
import type {Geometry, Rect} from '../geometry';
import type {Tree, NodeId} from '../model/tree';

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
  markerOriginPage: import('../geometry').Point;
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
 * TODO(Phase 3, §6.5): implement the full pipeline.
 */
export function decodeMarker(_lassoedGeometries: Geometry[]): DecodeResult {
  throw new Error('TODO(Phase 3, §6.5): decodeMarker not implemented');
}

/**
 * Decode just the binary buffer half of the pipeline (RS -> CRC ->
 * record parse). Exposed for unit tests that want to round-trip
 * bytes without going through the bit-matrix recovery.
 *
 * TODO(Phase 3, §6.5 steps 5-7): implement.
 */
export function decodeMarkerBytes(_codeword: Uint8Array): DecodeResult {
  throw new Error('TODO(Phase 3, §6.5): decodeMarkerBytes not implemented');
}
