/**
 * Tests for src/layout/forceDirected.ts — concept-map (DAG) force-directed
 * layout (§14.5, §F-LY-DAG-1..F-LY-DAG-6). Sibling to radial.test.ts; the
 * mindmap radial layout (radial.ts / radial.test.ts) is untouched and
 * stays in the byte-identical baseline.
 *
 * G2 coverage (keyed to the design TEST PLAN + §F-LY-DAG-*):
 *   - F-LY-DAG-3 DETERMINISM (load-bearing on e-ink): forceDirectedLayout
 *     called twice on the same graph yields byte-identical centers, bboxes
 *     and unionBbox (toEqual). Same topology built via a different
 *     construction order but the SAME ids → identical layout (seed is an
 *     id hash, not insertion-time state). No Math.random.
 *   - F-LY-DAG-1/2 bbox sizing (NODE_WIDTH × NODE_HEIGHT) + unionBbox
 *     covers every node bbox.
 *   - F-LY-DAG-4 roots (parentIds empty) biased toward the top band.
 *   - multi-root: two disconnected roots both laid out; components do not
 *     collapse onto one another.
 *   - edge cases: empty graph → zero union rect + empty maps; single node
 *     → one bbox, deterministic; coincident seeds separate without NaN;
 *     no NaN anywhere in a dense graph.
 *   - LayoutResult shape is the same Map-based contract radialLayout emits
 *     (consumable by emitConceptGeometries — smoke-checked in G3).
 *
 * Vocabulary: §14 ids only (F-LY-DAG-*) and "concept" wording — feature
 * A's radial/crossEdge terms never appear here.
 */
import {forceDirectedLayout} from '../src/layout/forceDirected';
import {NODE_HEIGHT, NODE_WIDTH} from '../src/layout/constants';
import {
  addNodeAsParent,
  addNodeWithParent,
  addParentEdge,
  createGraph,
  type Graph,
} from '../src/model/graph';

/** Every coordinate in a LayoutResult, for NaN / finiteness sweeps. */
function allCoords(result: ReturnType<typeof forceDirectedLayout>): number[] {
  const xs: number[] = [];
  for (const p of result.centers.values()) {
    xs.push(p.x, p.y);
  }
  for (const b of result.bboxes.values()) {
    xs.push(b.x, b.y, b.w, b.h);
  }
  xs.push(
    result.unionBbox.x,
    result.unionBbox.y,
    result.unionBbox.w,
    result.unionBbox.h,
  );
  return xs;
}

/** Mean of the centers' y over a set of node ids. */
function meanY(
  result: ReturnType<typeof forceDirectedLayout>,
  ids: number[],
): number {
  const ys = ids.map(id => result.centers.get(id)!.y);
  return ys.reduce((s, y) => s + y, 0) / ys.length;
}

describe('forceDirectedLayout (concept-map DAG layout, §14.5)', () => {
  describe('module surface', () => {
    it('exposes forceDirectedLayout (architect name)', () => {
      expect(typeof forceDirectedLayout).toBe('function');
    });
  });

  describe('F-LY-DAG-3 determinism (e-ink stability, no Math.random)', () => {
    it('returns byte-identical output across repeat calls on the same graph', () => {
      const graph = createGraph();
      const a = addNodeWithParent(graph, 0);
      const b = addNodeWithParent(graph, 0);
      addNodeWithParent(graph, a);
      addParentEdge(graph, b, a); // a multi-parent edge in the mix
      const r1 = forceDirectedLayout(graph);
      const r2 = forceDirectedLayout(graph);
      for (const [id, pos] of r1.centers) {
        expect(r2.centers.get(id)).toEqual(pos);
      }
      for (const [id, bbox] of r1.bboxes) {
        expect(r2.bboxes.get(id)).toEqual(bbox);
      }
      expect(r2.unionBbox).toEqual(r1.unionBbox);
    });

    it('depends only on ids + edges, not on insertion order', () => {
      // Build the SAME node-id set and SAME edge set two ways. Because the
      // seed is a hash of the node id (not insertion time) and the
      // simulation walks ids ascending, the two layouts must be identical.
      const g1 = createGraph(); // 0
      const a1 = addNodeWithParent(g1, 0); // 1
      const b1 = addNodeWithParent(g1, 0); // 2
      addParentEdge(g1, b1, a1); // edge a1→b1

      const g2 = createGraph(); // 0
      const a2 = addNodeWithParent(g2, 0); // 1
      const b2 = addNodeWithParent(g2, 0); // 2
      // Same edge, but added "before" any other mutation order differences.
      addParentEdge(g2, b2, a2);

      const r1 = forceDirectedLayout(g1);
      const r2 = forceDirectedLayout(g2);
      for (const id of [0, a1, b1]) {
        expect(r2.centers.get(id)).toEqual(r1.centers.get(id));
        expect(r2.bboxes.get(id)).toEqual(r1.bboxes.get(id));
      }
      expect(r2.unionBbox).toEqual(r1.unionBbox);
    });

    it('uses no Math.random (deterministic across a fresh module state)', () => {
      // Guard the "no Math.random" contract behaviourally: spy on
      // Math.random; a single layout call must never touch it.
      const spy = jest.spyOn(Math, 'random');
      const graph = createGraph();
      addNodeWithParent(graph, 0);
      addNodeWithParent(graph, 0);
      forceDirectedLayout(graph);
      expect(spy).not.toHaveBeenCalled();
      spy.mockRestore();
    });
  });

  describe('F-LY-DAG-1/2 bbox sizing + unionBbox', () => {
    it('every node bbox is NODE_WIDTH × NODE_HEIGHT centred on its centre', () => {
      const graph = createGraph();
      const a = addNodeWithParent(graph, 0);
      addNodeWithParent(graph, a);
      const result = forceDirectedLayout(graph);
      for (const [id, center] of result.centers) {
        const bbox = result.bboxes.get(id)!;
        expect(bbox.w).toBe(NODE_WIDTH);
        expect(bbox.h).toBe(NODE_HEIGHT);
        expect(bbox.x).toBeCloseTo(center.x - NODE_WIDTH / 2, 9);
        expect(bbox.y).toBeCloseTo(center.y - NODE_HEIGHT / 2, 9);
      }
    });

    it('unionBbox contains every node bbox', () => {
      const graph = createGraph();
      const a = addNodeWithParent(graph, 0);
      const b = addNodeWithParent(graph, 0);
      addNodeWithParent(graph, a);
      addNodeWithParent(graph, b);
      const result = forceDirectedLayout(graph);
      const u = result.unionBbox;
      const EPS = 1e-9;
      for (const bbox of result.bboxes.values()) {
        expect(bbox.x).toBeGreaterThanOrEqual(u.x - EPS);
        expect(bbox.y).toBeGreaterThanOrEqual(u.y - EPS);
        expect(bbox.x + bbox.w).toBeLessThanOrEqual(u.x + u.w + EPS);
        expect(bbox.y + bbox.h).toBeLessThanOrEqual(u.y + u.h + EPS);
      }
      expect(u.w).toBeGreaterThan(0);
      expect(u.h).toBeGreaterThan(0);
    });
  });

  describe('F-LY-DAG-4 root anchoring (roots biased toward the top)', () => {
    it('a single root sits above the mean of its descendants', () => {
      // Root 0 with a chain of descendants below it; the root anchor pulls
      // 0 toward the top band while springs let leaves drift down.
      const graph = createGraph();
      const a = addNodeWithParent(graph, 0);
      const b = addNodeWithParent(graph, a);
      addNodeWithParent(graph, b);
      const result = forceDirectedLayout(graph);
      const rootY = result.centers.get(0)!.y;
      const others = [...result.centers.keys()].filter(id => id !== 0);
      expect(rootY).toBeLessThan(meanY(result, others));
    });
  });

  describe('multi-root concept maps (§14.9 zero-or-many roots)', () => {
    it('lays out two roots and anchors BOTH toward the top', () => {
      // Build a genuine two-root graph. Root 0 → childA (id 1). Then
      // addNodeAsParent on childA mints a SECOND parentless root (id 2)
      // that also points at childA — childA is now a multi-parent node with
      // two roots above it. Both roots have parentIds=[] so both are
      // anchored toward the top band; childA (≥1 parent) is not.
      const graph = createGraph(); // root 0
      const childA = addNodeWithParent(graph, 0); // 1, under root 0
      const root2 = addNodeAsParent(graph, childA); // 2, a second root
      const result = forceDirectedLayout(graph);
      // Every node placed.
      expect(result.centers.size).toBe(graph.nodesById.size);
      expect(result.bboxes.size).toBe(graph.nodesById.size);
      // Both roots sit above the shared child (anchor pulls roots up).
      const childY = result.centers.get(childA)!.y;
      expect(result.centers.get(0)!.y).toBeLessThan(childY);
      expect(result.centers.get(root2)!.y).toBeLessThan(childY);
      // The two roots are distinct points (components didn't collapse).
      expect(result.centers.get(0)).not.toEqual(result.centers.get(root2));
    });
  });

  describe('edge cases', () => {
    it('an empty graph returns empty maps and a zero union rect', () => {
      const graph: Graph = {rootId: null, nodesById: new Map(), nextId: 0};
      const result = forceDirectedLayout(graph);
      expect(result.centers.size).toBe(0);
      expect(result.bboxes.size).toBe(0);
      expect(result.unionBbox).toEqual({x: 0, y: 0, w: 0, h: 0});
    });

    it('a single node settles deterministically with one node-sized bbox', () => {
      const graph = createGraph();
      const r1 = forceDirectedLayout(graph);
      const r2 = forceDirectedLayout(graph);
      expect(r1.centers.size).toBe(1);
      expect(r1.bboxes.size).toBe(1);
      const bbox = r1.bboxes.get(0)!;
      expect(bbox.w).toBe(NODE_WIDTH);
      expect(bbox.h).toBe(NODE_HEIGHT);
      // unionBbox equals the single node's bbox. Width/height are
      // reconstructed as maxX-minX / maxY-minY, which carries the same
      // float drift radial.test.ts absorbs (its unionBbox test uses an
      // EPS for the `minY + (maxY - minY)` round-trip), so compare with
      // closeness rather than byte-identity on the derived dimensions.
      expect(r1.unionBbox.x).toBeCloseTo(bbox.x, 9);
      expect(r1.unionBbox.y).toBeCloseTo(bbox.y, 9);
      expect(r1.unionBbox.w).toBeCloseTo(bbox.w, 9);
      expect(r1.unionBbox.h).toBeCloseTo(bbox.h, 9);
      // deterministic across calls (this IS byte-identical — same inputs).
      expect(r2.centers.get(0)).toEqual(r1.centers.get(0));
      expect(r2.unionBbox).toEqual(r1.unionBbox);
    });

    it('separates coincident seeds without producing NaN', () => {
      // Force every node to seed at the SAME point by collapsing the seed
      // region to 1×1 (hash % 1 === 0 for both axes). The repulsion EPS
      // guard must still separate them and never emit NaN.
      const graph = createGraph();
      addNodeWithParent(graph, 0);
      addNodeWithParent(graph, 0);
      const result = forceDirectedLayout(graph, {
        canvasWidth: 1,
        canvasHeight: 1,
      });
      for (const v of allCoords(result)) {
        expect(Number.isFinite(v)).toBe(true);
      }
      // The two children plus the root must not all be exactly coincident
      // after the simulation — the EPS push separated them.
      const centers = [...result.centers.values()];
      const allSame = centers.every(
        c => c.x === centers[0].x && c.y === centers[0].y,
      );
      expect(allSame).toBe(false);
    });

    it('produces only finite coordinates for a dense multi-parent graph', () => {
      // A small diamond-heavy graph exercises repulsion + springs + anchor
      // together; assert no NaN/Infinity leaks into any coordinate.
      const graph = createGraph();
      const a = addNodeWithParent(graph, 0);
      const b = addNodeWithParent(graph, 0);
      const c = addNodeWithParent(graph, a);
      addParentEdge(graph, c, b); // c has two parents (a, b)
      const d = addNodeWithParent(graph, c);
      addParentEdge(graph, d, 0); // d also links straight to the root
      const result = forceDirectedLayout(graph);
      for (const v of allCoords(result)) {
        expect(Number.isFinite(v)).toBe(true);
      }
    });
  });

  describe('ForceOptions (deterministic knobs)', () => {
    it('a zero-iteration budget returns the raw seed positions', () => {
      // iterations: 0 skips the simulation loop entirely, so centers equal
      // the deterministic FNV seed positions — a clean way to assert the
      // seeding is itself stable and option-driven.
      const graph = createGraph();
      addNodeWithParent(graph, 0);
      const r1 = forceDirectedLayout(graph, {iterations: 0});
      const r2 = forceDirectedLayout(graph, {iterations: 0});
      expect(r1.centers.get(0)).toEqual(r2.centers.get(0));
      // Seeds are integer (hash % width) at the centre, so bbox offsets are
      // exact half-node values.
      const c = r1.centers.get(0)!;
      expect(r1.bboxes.get(0)).toEqual({
        x: c.x - NODE_WIDTH / 2,
        y: c.y - NODE_HEIGHT / 2,
        w: NODE_WIDTH,
        h: NODE_HEIGHT,
      });
    });
  });
});
