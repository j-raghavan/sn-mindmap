/* eslint-disable no-bitwise */
/**
 * Tests for src/marker/encode.ts.
 *
 * Coverage (§6.1, §6.2, §6.3, §F-PE-3, §F-PE-4):
 *   - Wire constants (grid, channel, record size, version, caps).
 *   - encodeMarkerBytes returns a full 648-byte channel buffer.
 *   - Header bytes: version 0x02 at [0], N at [1].
 *   - Root record: parent = 0xFF, shape = OVAL.
 *   - Non-root records: parent index < self, shape in
 *     {RECTANGLE, ROUNDED_RECTANGLE}.
 *   - Bbox fields are uint16 BE at record offsets 2..9.
 *   - CRC32 at bytes [2+10N..+3] matches CRC32 of [0..2+10N-1] of the
 *     logical message region reconstructed through the RS layout.
 *   - Determinism: same input -> byte-identical channel output.
 *   - Capacity: N > 50 throws MarkerCapacityError.
 *   - encodeMarker (bit-matrix renderer) is still a TODO; verify the
 *     throw so Phase 3.3 has a signal if it forgets to wire it up.
 */
import {
  MARKER_BIT_STROKE_LEN,
  MARKER_CELL_PX,
  MARKER_CHANNEL_BYTES,
  MARKER_CHUNK_BYTES,
  MARKER_CHUNK_MESSAGE,
  MARKER_CHUNK_PARITY,
  MARKER_FOOTPRINT_PX,
  MARKER_FORMAT_VERSION,
  MARKER_GRID,
  MARKER_LOGICAL_MESSAGE_BYTES,
  MARKER_NODE_RECORD_BYTES,
  MARKER_NUM_CHUNKS,
  MARKER_PEN_COLOR,
  MARKER_PEN_TYPE,
  MARKER_PEN_WIDTH,
  MARKER_PUBLISHED_NODE_CAP,
  MARKER_ROOT_PARENT,
  MARKER_CAPACITY_MESSAGE,
  MarkerCapacityError,
  encodeMarker,
  encodeMarkerBytes,
} from '../src/marker/encode';
import {crc32} from '../src/marker/rs';
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

/**
 * Build a tiny tree plus bboxes for every node, keyed by insertion
 * order. The caller controls tree shape; bboxes are synthesized so the
 * wire bytes are predictable and easy to eyeball in a failure.
 */
function buildTree(
  shape: (tree: Tree) => void,
): {tree: Tree; nodeBboxesById: Map<NodeId, Rect>} {
  const tree = createTree();
  shape(tree);
  const nodeBboxesById = new Map<NodeId, Rect>();
  for (const id of tree.nodesById.keys()) {
    // x and y vary with id so round-trip mismatches show which record
    // broke. Non-zero widths/heights prove we're writing all four
    // uint16 fields, not just zeroing the tail.
    nodeBboxesById.set(id, {
      x: 10 + id * 7,
      y: 20 + id * 11,
      w: 64 + (id % 3),
      h: 32 + (id % 5),
    });
  }
  return {tree, nodeBboxesById};
}

function readUint16BE(buf: Uint8Array, offset: number): number {
  return (buf[offset] << 8) | buf[offset + 1];
}

function readUint32BE(buf: Uint8Array, offset: number): number {
  return (
    ((buf[offset] << 24) |
      (buf[offset + 1] << 16) |
      (buf[offset + 2] << 8) |
      buf[offset + 3]) >>>
    0
  );
}

/**
 * Reverse the interleave: extract the 510-byte logical message out
 * of the 648-byte channel by taking the first MARKER_CHUNK_MESSAGE
 * bytes of each chunk.
 */
function extractLogicalMessage(channel: Uint8Array): Uint8Array {
  const out = new Uint8Array(MARKER_LOGICAL_MESSAGE_BYTES);
  for (let k = 0; k < MARKER_NUM_CHUNKS; k += 1) {
    const src = channel.subarray(
      k * MARKER_CHUNK_BYTES,
      k * MARKER_CHUNK_BYTES + MARKER_CHUNK_MESSAGE,
    );
    out.set(src, k * MARKER_CHUNK_MESSAGE);
  }
  return out;
}

// ---------------------------------------------------------------------
// tests
// ---------------------------------------------------------------------

describe('marker encode wire constants (§6)', () => {
  it('grid is 72×72 at 4 px per cell (§6.1, §F-PE-3)', () => {
    expect(MARKER_GRID).toBe(72);
    expect(MARKER_CELL_PX).toBe(4);
    expect(MARKER_FOOTPRINT_PX).toBe(288);
  });

  it('raw channel is 648 bytes = 72*72/8 (§6.2)', () => {
    expect(MARKER_CHANNEL_BYTES).toBe(648);
    expect(MARKER_CHANNEL_BYTES).toBe((MARKER_GRID * MARKER_GRID) / 8);
  });

  it('node record is 10 bytes (§6.3)', () => {
    expect(MARKER_NODE_RECORD_BYTES).toBe(10);
  });

  it('format version byte is 0x02 (v2, §6.2)', () => {
    expect(MARKER_FORMAT_VERSION).toBe(0x02);
  });

  it('published node cap is 50 per §F-PE-4', () => {
    expect(MARKER_PUBLISHED_NODE_CAP).toBe(50);
  });

  it('interleaved RS layout: 3 × 216 bytes, 170 msg + 46 parity per chunk', () => {
    expect(MARKER_NUM_CHUNKS).toBe(3);
    expect(MARKER_CHUNK_BYTES).toBe(216);
    expect(MARKER_CHUNK_PARITY).toBe(46);
    expect(MARKER_CHUNK_MESSAGE).toBe(170);
    expect(MARKER_LOGICAL_MESSAGE_BYTES).toBe(510);
    expect(MARKER_NUM_CHUNKS * MARKER_CHUNK_BYTES).toBe(MARKER_CHANNEL_BYTES);
  });

  it('MarkerCapacityError surfaces the §F-PE-4 user-facing message', () => {
    const err = new MarkerCapacityError(51);
    expect(err).toBeInstanceOf(Error);
    expect(err).toBeInstanceOf(MarkerCapacityError);
    expect(err.name).toBe('MarkerCapacityError');
    // Node count is a diagnostic field; the message is the spec text
    // verbatim so the UI can render it straight into the capacity
    // modal without any reformatting that could drift from §F-PE-4.
    expect(err.nodeCount).toBe(51);
    expect(err.message).toBe(MARKER_CAPACITY_MESSAGE);
    expect(err.message).toMatch(/Reduce nodes/);
    expect(err.message).not.toMatch(/§/); // no internal spec references
  });
});

describe('encodeMarkerBytes', () => {
  it('returns a 648-byte channel buffer for a root-only tree', () => {
    const {tree, nodeBboxesById} = buildTree(() => {});
    const out = encodeMarkerBytes({
      tree,
      nodeBboxesById,
      markerOrigin: {x: 0, y: 0},
    });
    expect(out).toBeInstanceOf(Uint8Array);
    expect(out).toHaveLength(MARKER_CHANNEL_BYTES);
  });

  it('writes the version byte at logical-message [0]', () => {
    const {tree, nodeBboxesById} = buildTree(() => {});
    const out = encodeMarkerBytes({
      tree,
      nodeBboxesById,
      markerOrigin: {x: 0, y: 0},
    });
    const msg = extractLogicalMessage(out);
    expect(msg[0]).toBe(MARKER_FORMAT_VERSION);
  });

  it('writes N at logical-message [1] (root-only = 1)', () => {
    const {tree, nodeBboxesById} = buildTree(() => {});
    const msg = extractLogicalMessage(
      encodeMarkerBytes({
        tree,
        nodeBboxesById,
        markerOrigin: {x: 0, y: 0},
      }),
    );
    expect(msg[1]).toBe(1);
  });

  it('root record: parent = 0xFF, shape = OVAL, bbox = uint16 BE', () => {
    const {tree, nodeBboxesById} = buildTree(() => {});
    const msg = extractLogicalMessage(
      encodeMarkerBytes({
        tree,
        nodeBboxesById,
        markerOrigin: {x: 0, y: 0},
      }),
    );
    // Record 0 starts at byte 2.
    expect(msg[2]).toBe(MARKER_ROOT_PARENT);
    expect(msg[3]).toBe(ShapeKind.OVAL);
    const rootBbox = nodeBboxesById.get(0);
    expect(rootBbox).toBeDefined();
    expect(readUint16BE(msg, 4)).toBe(rootBbox?.x);
    expect(readUint16BE(msg, 6)).toBe(rootBbox?.y);
    expect(readUint16BE(msg, 8)).toBe(rootBbox?.w);
    expect(readUint16BE(msg, 10)).toBe(rootBbox?.h);
  });

  it('child records carry RECTANGLE / ROUNDED_RECTANGLE shape bytes', () => {
    const {tree, nodeBboxesById} = buildTree(t => {
      // Build: root, then addChild (RECTANGLE), then addSibling of
      // that (ROUNDED_RECTANGLE).
      const childId = addChild(t, 0);
      addSibling(t, childId);
    });
    const msg = extractLogicalMessage(
      encodeMarkerBytes({
        tree,
        nodeBboxesById,
        markerOrigin: {x: 0, y: 0},
      }),
    );
    // N should be 3.
    expect(msg[1]).toBe(3);
    // Record 1 (child of root).
    expect(msg[2 + MARKER_NODE_RECORD_BYTES + 0]).toBe(0); // parent = root index
    expect(msg[2 + MARKER_NODE_RECORD_BYTES + 1]).toBe(ShapeKind.RECTANGLE);
    // Record 2 (sibling of record 1, parent is also root).
    expect(msg[2 + 2 * MARKER_NODE_RECORD_BYTES + 0]).toBe(0);
    expect(msg[2 + 2 * MARKER_NODE_RECORD_BYTES + 1]).toBe(
      ShapeKind.ROUNDED_RECTANGLE,
    );
  });

  it('every non-root parent index is strictly less than self', () => {
    // Build a deeper tree (~12 nodes) to exercise the BFS order
    // invariant beyond the trivial cases.
    const {tree, nodeBboxesById} = buildTree(t => {
      const a = addChild(t, 0);
      const b = addChild(t, 0);
      const c = addChild(t, a);
      const d = addSibling(t, c);
      const e = addChild(t, b);
      addChild(t, d);
      addChild(t, e);
    });
    const msg = extractLogicalMessage(
      encodeMarkerBytes({
        tree,
        nodeBboxesById,
        markerOrigin: {x: 0, y: 0},
      }),
    );
    const N = msg[1];
    for (let i = 1; i < N; i += 1) {
      const parentByte = msg[2 + i * MARKER_NODE_RECORD_BYTES];
      expect(parentByte).toBeLessThan(i);
    }
  });

  it('CRC32 at [2+10N..+3] matches CRC over [0..2+10N-1]', () => {
    const {tree, nodeBboxesById} = buildTree(t => {
      const a = addChild(t, 0);
      addSibling(t, a);
      addChild(t, a);
    });
    const msg = extractLogicalMessage(
      encodeMarkerBytes({
        tree,
        nodeBboxesById,
        markerOrigin: {x: 0, y: 0},
      }),
    );
    const N = msg[1];
    const payloadEnd = 2 + N * MARKER_NODE_RECORD_BYTES;
    const expected = crc32(msg.subarray(0, payloadEnd));
    const observed = readUint32BE(msg, payloadEnd);
    expect(observed).toBe(expected);
  });

  it('is deterministic: same input -> byte-identical channel', () => {
    const build = () =>
      buildTree(t => {
        const a = addChild(t, 0);
        const b = addChild(t, 0);
        addChild(t, a);
        addSibling(t, b);
      });
    const first = build();
    const second = build();
    const outA = encodeMarkerBytes({
      tree: first.tree,
      nodeBboxesById: first.nodeBboxesById,
      markerOrigin: {x: 0, y: 0},
    });
    const outB = encodeMarkerBytes({
      tree: second.tree,
      nodeBboxesById: second.nodeBboxesById,
      markerOrigin: {x: 0, y: 0},
    });
    expect(Array.from(outA)).toEqual(Array.from(outB));
  });

  it('throws MarkerCapacityError when N exceeds the published cap', () => {
    const {tree, nodeBboxesById} = buildTree(t => {
      // Add MARKER_PUBLISHED_NODE_CAP children of the root — tree
      // then has N = cap + 1 (the root itself).
      for (let i = 0; i < MARKER_PUBLISHED_NODE_CAP; i += 1) {
        addChild(t, 0);
      }
    });
    expect(() =>
      encodeMarkerBytes({
        tree,
        nodeBboxesById,
        markerOrigin: {x: 0, y: 0},
      }),
    ).toThrow(MarkerCapacityError);
  });

  it('throws on a tree missing a bbox entry for some node', () => {
    const {tree} = buildTree(t => {
      addChild(t, 0);
    });
    const partial = new Map<NodeId, Rect>();
    partial.set(0, {x: 0, y: 0, w: 10, h: 10}); // missing id=1
    expect(() =>
      encodeMarkerBytes({
        tree,
        nodeBboxesById: partial,
        markerOrigin: {x: 0, y: 0},
      }),
    ).toThrow(/no bbox/);
  });
});

describe('encodeMarker (bit-matrix renderer, §6.4)', () => {
  it('emits only straightLine geometries with §6.4 pen style', () => {
    const {tree, nodeBboxesById} = buildTree(t => {
      addChild(t, 0);
      addChild(t, 0);
    });
    const geoms = encodeMarker({
      tree,
      nodeBboxesById,
      markerOrigin: {x: 0, y: 0},
    });
    expect(geoms.length).toBeGreaterThan(0);
    for (const g of geoms) {
      expect(g.type).toBe('straightLine');
      expect(g.penColor).toBe(MARKER_PEN_COLOR);
      expect(g.penType).toBe(MARKER_PEN_TYPE);
      expect(g.penWidth).toBe(MARKER_PEN_WIDTH);
      expect(g.showLassoAfterInsert).toBe(false);
    }
  });

  it('emits one geometry per set bit (popcount match)', () => {
    const {tree, nodeBboxesById} = buildTree(t => {
      addChild(t, 0);
      addSibling(t, 1);
    });
    const bytes = encodeMarkerBytes({
      tree,
      nodeBboxesById,
      markerOrigin: {x: 0, y: 0},
    });
    let popcount = 0;
    for (let i = 0; i < bytes.length; i += 1) {
      let v = bytes[i];
      while (v !== 0) {
        v &= v - 1;
        popcount += 1;
      }
    }
    const geoms = encodeMarker({
      tree,
      nodeBboxesById,
      markerOrigin: {x: 0, y: 0},
    });
    expect(geoms.length).toBe(popcount);
  });

  it('each stroke is MARKER_BIT_STROKE_LEN px long and grid-aligned', () => {
    const {tree, nodeBboxesById} = buildTree(t => {
      addChild(t, 0);
    });
    const origin = {x: 100, y: 200};
    const geoms = encodeMarker({tree, nodeBboxesById, markerOrigin: origin});
    for (const g of geoms) {
      expect(g.type).toBe('straightLine');
      if (g.type !== 'straightLine') {
        return;
      }
      expect(g.points).toHaveLength(2);
      const [p0, p1] = g.points;
      // Horizontal stroke of length MARKER_BIT_STROKE_LEN.
      expect(p0.y).toBe(p1.y);
      expect(p1.x - p0.x).toBe(MARKER_BIT_STROKE_LEN);
      // Top-left corner (p0) aligns to the origin + cell grid.
      const col = (p0.x - origin.x) / MARKER_CELL_PX;
      const row = (p0.y - origin.y) / MARKER_CELL_PX;
      expect(Number.isInteger(col)).toBe(true);
      expect(Number.isInteger(row)).toBe(true);
      expect(col).toBeGreaterThanOrEqual(0);
      expect(col).toBeLessThan(MARKER_GRID);
      expect(row).toBeGreaterThanOrEqual(0);
      expect(row).toBeLessThan(MARKER_GRID);
    }
  });

  it('markerOrigin translates every stroke by the same offset', () => {
    const {tree, nodeBboxesById} = buildTree(t => {
      addChild(t, 0);
      addSibling(t, 1);
    });
    const a = encodeMarker({
      tree,
      nodeBboxesById,
      markerOrigin: {x: 0, y: 0},
    });
    const b = encodeMarker({
      tree,
      nodeBboxesById,
      markerOrigin: {x: 40, y: 80},
    });
    expect(a).toHaveLength(b.length);
    for (let i = 0; i < a.length; i += 1) {
      const ga = a[i];
      const gb = b[i];
      if (ga.type !== 'straightLine' || gb.type !== 'straightLine') {
        throw new Error('expected straightLine');
      }
      for (let p = 0; p < 2; p += 1) {
        expect(gb.points[p].x - ga.points[p].x).toBe(40);
        expect(gb.points[p].y - ga.points[p].y).toBe(80);
      }
    }
  });

  it('is deterministic: same input -> identical geometry array', () => {
    const build = () =>
      buildTree(t => {
        addChild(t, 0);
        const b = addChild(t, 0);
        addSibling(t, b);
      });
    const first = build();
    const second = build();
    const a = encodeMarker({
      tree: first.tree,
      nodeBboxesById: first.nodeBboxesById,
      markerOrigin: {x: 0, y: 0},
    });
    const b = encodeMarker({
      tree: second.tree,
      nodeBboxesById: second.nodeBboxesById,
      markerOrigin: {x: 0, y: 0},
    });
    expect(a).toEqual(b);
  });

  it('throws MarkerCapacityError when the tree is over-capacity', () => {
    const {tree, nodeBboxesById} = buildTree(t => {
      for (let i = 0; i < MARKER_PUBLISHED_NODE_CAP; i += 1) {
        addChild(t, 0);
      }
    });
    expect(() =>
      encodeMarker({
        tree,
        nodeBboxesById,
        markerOrigin: {x: 0, y: 0},
      }),
    ).toThrow(MarkerCapacityError);
  });
});
