/* eslint-disable no-bitwise */
/**
 * Tests for src/marker/decode.ts — bytes-in-bytes-out round-trip
 * coverage and §F-ED-4 rejection-path coverage.
 *
 * Decode pipeline covered here (§6.5 steps 5-7):
 *   - Zero-error round-trip for root-only, shallow, and 50-node trees.
 *   - Every DecodeErr reason code:
 *       no_candidates  (decodeMarker scaffold)
 *       rs_failed      (too-many-errors in a chunk, wrong-sized input)
 *       crc_failed     (CRC byte flipped post-encode)
 *       bad_version    (version byte != 0x02)
 *       bad_record     (bad N, bad parent index, unknown shape byte)
 *   - Self-correcting behavior: up to MARKER_CHUNK_PARITY/2 = 23 byte
 *     errors per chunk are silently corrected and the round-trip
 *     still reconstructs the tree exactly.
 *   - Determinism: decoder is pure — same bytes -> same tree.
 */
import {decodeMarker, decodeMarkerBytes} from '../src/marker/decode';
import type {DecodeResult} from '../src/marker/decode';
import {
  MARKER_CHANNEL_BYTES,
  MARKER_CHUNK_BYTES,
  MARKER_CHUNK_MESSAGE,
  MARKER_CHUNK_PARITY,
  MARKER_LOGICAL_MESSAGE_BYTES,
  MARKER_NODE_RECORD_BYTES,
  MARKER_NUM_CHUNKS,
  MARKER_PUBLISHED_NODE_CAP,
  encodeMarkerBytes,
} from '../src/marker/encode';
import {
  addChild,
  addSibling,
  createTree,
  ShapeKind,
  type NodeId,
  type Tree,
} from '../src/model/tree';
import type {Rect} from '../src/geometry';

// ---------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------

function buildTree(
  shape: (tree: Tree) => void,
): {tree: Tree; nodeBboxesById: Map<NodeId, Rect>} {
  const tree = createTree();
  shape(tree);
  const nodeBboxesById = new Map<NodeId, Rect>();
  let i = 0;
  for (const id of tree.nodesById.keys()) {
    nodeBboxesById.set(id, {
      x: 10 + i * 7,
      y: 20 + i * 11,
      w: 64 + (i % 3),
      h: 32 + (i % 5),
    });
    i += 1;
  }
  return {tree, nodeBboxesById};
}

/**
 * Compare a decoded tree to the source tree, ignoring authoring-only
 * state (collapsed flag) which isn't carried on the wire (§8.6).
 */
function expectTreesEquivalent(decoded: Tree, original: Tree): void {
  expect(decoded.rootId).toBe(original.rootId);
  expect(decoded.nodesById.size).toBe(original.nodesById.size);
  for (const [id, orig] of original.nodesById) {
    const dec = decoded.nodesById.get(id);
    expect(dec).toBeDefined();
    expect(dec?.id).toBe(orig.id);
    expect(dec?.parentId).toBe(orig.parentId);
    expect(dec?.shape).toBe(orig.shape);
    expect(dec?.childIds).toEqual(orig.childIds);
  }
}

function expectBboxesEquivalent(
  decoded: Map<NodeId, Rect>,
  original: Map<NodeId, Rect>,
): void {
  expect(decoded.size).toBe(original.size);
  for (const [id, orig] of original) {
    const dec = decoded.get(id);
    expect(dec).toEqual(orig);
  }
}

function expectOk(result: DecodeResult): asserts result is Extract<
  DecodeResult,
  {ok: true}
> {
  if (!result.ok) {
    throw new Error(
      `expected ok decode, got ${result.reason}: ${result.message}`,
    );
  }
}

function expectErr(
  result: DecodeResult,
  reason: Extract<DecodeResult, {ok: false}>['reason'],
): void {
  if (result.ok) {
    throw new Error(`expected ${reason}, got ok`);
  }
  expect(result.reason).toBe(reason);
}

// ---------------------------------------------------------------------
// tests
// ---------------------------------------------------------------------

describe('decodeMarker (Phase 3.3 scaffold)', () => {
  it('exposes decodeMarker and decodeMarkerBytes', () => {
    expect(typeof decodeMarker).toBe('function');
    expect(typeof decodeMarkerBytes).toBe('function');
  });

  it('decodeMarker still throws — the bit-matrix recovery is a Phase 3.3 TODO', () => {
    expect(() => decodeMarker([])).toThrow(/Phase 3\.3/);
  });

  it('DecodeResult type accepts every §F-ED-4 reason code', () => {
    // Compile-time check dressed up as a runtime one.
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

describe('decodeMarkerBytes: round-trip (no errors)', () => {
  it('round-trips a root-only tree', () => {
    const {tree, nodeBboxesById} = buildTree(() => {});
    const bytes = encodeMarkerBytes({
      tree,
      nodeBboxesById,
      markerOrigin: {x: 0, y: 0},
    });
    const result = decodeMarkerBytes(bytes);
    expectOk(result);
    expectTreesEquivalent(result.tree, tree);
    expectBboxesEquivalent(result.nodeBboxesById, nodeBboxesById);
  });

  it('round-trips a shallow tree (root + 2 children + grandchild)', () => {
    const {tree, nodeBboxesById} = buildTree(t => {
      const a = addChild(t, 0);
      addSibling(t, a);
      addChild(t, a);
    });
    const bytes = encodeMarkerBytes({
      tree,
      nodeBboxesById,
      markerOrigin: {x: 0, y: 0},
    });
    const result = decodeMarkerBytes(bytes);
    expectOk(result);
    expectTreesEquivalent(result.tree, tree);
    expectBboxesEquivalent(result.nodeBboxesById, nodeBboxesById);
  });

  it('round-trips the capacity-cap tree (N = 50)', () => {
    const {tree, nodeBboxesById} = buildTree(t => {
      // Build a deepish-but-bounded tree: root + 49 descendants in a
      // snake pattern so parent indices aren't all zero.
      let cursor: NodeId = 0;
      for (let i = 0; i < MARKER_PUBLISHED_NODE_CAP - 1; i += 1) {
        cursor = addChild(t, cursor);
      }
    });
    expect(tree.nodesById.size).toBe(MARKER_PUBLISHED_NODE_CAP);
    const bytes = encodeMarkerBytes({
      tree,
      nodeBboxesById,
      markerOrigin: {x: 0, y: 0},
    });
    const result = decodeMarkerBytes(bytes);
    expectOk(result);
    expectTreesEquivalent(result.tree, tree);
    expectBboxesEquivalent(result.nodeBboxesById, nodeBboxesById);
  });

  it('is deterministic: decoding the same bytes twice gives identical trees', () => {
    const {tree, nodeBboxesById} = buildTree(t => {
      addChild(t, 0);
      const b = addChild(t, 0);
      addSibling(t, b);
    });
    const bytes = encodeMarkerBytes({
      tree,
      nodeBboxesById,
      markerOrigin: {x: 0, y: 0},
    });
    const a = decodeMarkerBytes(bytes);
    const b = decodeMarkerBytes(bytes);
    expectOk(a);
    expectOk(b);
    expectTreesEquivalent(a.tree, b.tree);
    expectBboxesEquivalent(a.nodeBboxesById, b.nodeBboxesById);
  });

  it('markerOriginPage is (0, 0) on the bytes-only path', () => {
    const {tree, nodeBboxesById} = buildTree(() => {});
    const bytes = encodeMarkerBytes({
      tree,
      nodeBboxesById,
      markerOrigin: {x: 123, y: 456},
    });
    const result = decodeMarkerBytes(bytes);
    expectOk(result);
    expect(result.markerOriginPage).toEqual({x: 0, y: 0});
  });
});

describe('decodeMarkerBytes: RS correction', () => {
  /**
   * Flip `count` distinct byte positions in the first chunk, spread
   * uniformly. RS correction capability is
   * floor(MARKER_CHUNK_PARITY / 2) = 23 errors per chunk — inside
   * that budget the decoder must silently correct.
   */
  function flipChunk(buf: Uint8Array, count: number): void {
    const step = Math.max(1, Math.floor(MARKER_CHUNK_BYTES / (count + 1)));
    for (let k = 0; k < count; k += 1) {
      buf[step * (k + 1)] ^= 0x5c;
    }
  }

  it('corrects up to floor(parity/2) = 23 errors inside a single chunk', () => {
    const {tree, nodeBboxesById} = buildTree(t => {
      addChild(t, 0);
      addChild(t, 0);
    });
    const bytes = encodeMarkerBytes({
      tree,
      nodeBboxesById,
      markerOrigin: {x: 0, y: 0},
    });
    const corrupted = new Uint8Array(bytes);
    flipChunk(corrupted, Math.floor(MARKER_CHUNK_PARITY / 2));
    const result = decodeMarkerBytes(corrupted);
    expectOk(result);
    expectTreesEquivalent(result.tree, tree);
  });

  it('returns rs_failed when a chunk exceeds its correction capability', () => {
    const {tree, nodeBboxesById} = buildTree(t => {
      addChild(t, 0);
    });
    const bytes = encodeMarkerBytes({
      tree,
      nodeBboxesById,
      markerOrigin: {x: 0, y: 0},
    });
    const corrupted = new Uint8Array(bytes);
    // 24 flips in one chunk -> one over the floor(46/2) = 23 limit.
    flipChunk(corrupted, Math.floor(MARKER_CHUNK_PARITY / 2) + 1);
    expectErr(decodeMarkerBytes(corrupted), 'rs_failed');
  });

  it('rejects a codeword of the wrong length as rs_failed', () => {
    expectErr(
      decodeMarkerBytes(new Uint8Array(MARKER_CHANNEL_BYTES - 1)),
      'rs_failed',
    );
    expectErr(
      decodeMarkerBytes(new Uint8Array(MARKER_CHANNEL_BYTES + 1)),
      'rs_failed',
    );
  });
});

describe('decodeMarkerBytes: header / record validation', () => {
  /**
   * Re-encode a single chunk in place after mutating the logical
   * message slice within it. Useful for constructing "valid RS,
   * invalid payload" buffers — which is what each bad_* reason code
   * requires.
   *
   * When `repairCrc` is true (the default for record-level tests),
   * the helper recomputes the CRC32 over the mutated payload region
   * so the integrity check passes and the decoder proceeds into
   * record validation. The decoder checks CRC before records, so
   * otherwise a record-level mutation would surface as crc_failed.
   */
  const {rsEncode, crc32} = require('../src/marker/rs');

  function reEncodeChunkWithMutation(
    bytes: Uint8Array,
    mutate: (msg: Uint8Array) => void,
    opts: {repairCrc?: boolean} = {},
  ): Uint8Array {
    const {repairCrc = false} = opts;
    const corrupted = new Uint8Array(bytes);
    // Work in logical-message space.
    const logical = new Uint8Array(MARKER_LOGICAL_MESSAGE_BYTES);
    for (let k = 0; k < MARKER_NUM_CHUNKS; k += 1) {
      logical.set(
        corrupted.subarray(
          k * MARKER_CHUNK_BYTES,
          k * MARKER_CHUNK_BYTES + MARKER_CHUNK_MESSAGE,
        ),
        k * MARKER_CHUNK_MESSAGE,
      );
    }
    mutate(logical);
    if (repairCrc) {
      const N = logical[1];
      const payloadEnd = 2 + N * MARKER_NODE_RECORD_BYTES;
      const crc = crc32(logical.subarray(0, payloadEnd)) >>> 0;
      logical[payloadEnd + 0] = (crc >>> 24) & 0xff;
      logical[payloadEnd + 1] = (crc >>> 16) & 0xff;
      logical[payloadEnd + 2] = (crc >>> 8) & 0xff;
      logical[payloadEnd + 3] = crc & 0xff;
    }
    // Re-encode all chunks from the mutated logical message.
    for (let k = 0; k < MARKER_NUM_CHUNKS; k += 1) {
      const msgStart = k * MARKER_CHUNK_MESSAGE;
      const chunkMsg = logical.subarray(
        msgStart,
        msgStart + MARKER_CHUNK_MESSAGE,
      );
      const chunkCw = rsEncode(chunkMsg, MARKER_CHUNK_PARITY);
      corrupted.set(chunkCw, k * MARKER_CHUNK_BYTES);
    }
    return corrupted;
  }

  function validBytes(): {
    bytes: Uint8Array;
    tree: Tree;
    nodeBboxesById: Map<NodeId, Rect>;
  } {
    const {tree, nodeBboxesById} = buildTree(t => {
      addChild(t, 0);
      addChild(t, 0);
    });
    const bytes = encodeMarkerBytes({
      tree,
      nodeBboxesById,
      markerOrigin: {x: 0, y: 0},
    });
    return {bytes, tree, nodeBboxesById};
  }

  it('rejects a version byte that is not MARKER_FORMAT_VERSION (bad_version)', () => {
    const {bytes} = validBytes();
    const corrupted = reEncodeChunkWithMutation(bytes, msg => {
      msg[0] = 0x01; // v1 — unsupported by the decoder.
    });
    expectErr(decodeMarkerBytes(corrupted), 'bad_version');
  });

  it('rejects N = 0 (bad_record)', () => {
    const {bytes} = validBytes();
    const corrupted = reEncodeChunkWithMutation(bytes, msg => {
      msg[1] = 0;
    });
    expectErr(decodeMarkerBytes(corrupted), 'bad_record');
  });

  it('rejects N greater than the published cap (bad_record)', () => {
    const {bytes} = validBytes();
    const corrupted = reEncodeChunkWithMutation(bytes, msg => {
      msg[1] = MARKER_PUBLISHED_NODE_CAP + 1;
    });
    expectErr(decodeMarkerBytes(corrupted), 'bad_record');
  });

  it('rejects a root with a shape byte other than OVAL (bad_record)', () => {
    const {bytes} = validBytes();
    const corrupted = reEncodeChunkWithMutation(
      bytes,
      msg => {
        // Record 0 starts at byte 2. Shape byte is at [3].
        msg[3] = ShapeKind.RECTANGLE;
      },
      {repairCrc: true},
    );
    expectErr(decodeMarkerBytes(corrupted), 'bad_record');
  });

  it('rejects a root whose parent byte is not 0xFF (bad_record)', () => {
    const {bytes} = validBytes();
    const corrupted = reEncodeChunkWithMutation(
      bytes,
      msg => {
        msg[2] = 0x00;
      },
      {repairCrc: true},
    );
    expectErr(decodeMarkerBytes(corrupted), 'bad_record');
  });

  it('rejects a non-root node with an out-of-range parent index (bad_record)', () => {
    const {bytes} = validBytes();
    const corrupted = reEncodeChunkWithMutation(
      bytes,
      msg => {
        // Record 1 parent is at byte 2 + 10 = 12. Point it at an index
        // greater than or equal to its own (invalid).
        msg[2 + MARKER_NODE_RECORD_BYTES] = 5;
      },
      {repairCrc: true},
    );
    expectErr(decodeMarkerBytes(corrupted), 'bad_record');
  });

  it('rejects a non-root node carrying the root sentinel as parent (bad_record)', () => {
    const {bytes} = validBytes();
    const corrupted = reEncodeChunkWithMutation(
      bytes,
      msg => {
        // Record 2 parent at byte 2 + 20 = 22.
        msg[2 + 2 * MARKER_NODE_RECORD_BYTES] = 0xff;
      },
      {repairCrc: true},
    );
    expectErr(decodeMarkerBytes(corrupted), 'bad_record');
  });

  it('rejects an unknown shape byte in a non-root record (bad_record)', () => {
    const {bytes} = validBytes();
    const corrupted = reEncodeChunkWithMutation(
      bytes,
      msg => {
        // Record 1 shape byte at [3 + 10] = [13].
        msg[2 + MARKER_NODE_RECORD_BYTES + 1] = 0x7f; // unknown
      },
      {repairCrc: true},
    );
    expectErr(decodeMarkerBytes(corrupted), 'bad_record');
  });

  it('detects a payload byte flip as crc_failed when CRC itself is untouched', () => {
    const {bytes} = validBytes();
    const corrupted = reEncodeChunkWithMutation(bytes, msg => {
      // Flip bbox x high byte on record 1 — validity-preserving at
      // the record level, but invalidates the CRC.
      msg[2 + MARKER_NODE_RECORD_BYTES + 2] ^= 0x10;
    });
    expectErr(decodeMarkerBytes(corrupted), 'crc_failed');
  });
});
