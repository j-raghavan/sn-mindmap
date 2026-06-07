/**
 * Tests for src/model/graph.ts — concept-map (DAG) data model (§14.3 /
 * §14.4). Parallels __tests__/tree.test.ts in structure; the graph model
 * is a SIBLING to the mindmap Tree (the mindmap path stays byte-identical
 * and untouched — tree.test.ts continues to guard it).
 *
 * G1 coverage (keyed to the design TEST PLAN):
 *   - createGraph starting shape (root OVAL, empty edges, ids)
 *   - addNodeWithParent (F-AC-DAG-1) sole-parent + min-depth shape
 *   - addNodeAsParent (F-AC-DAG-2) the genealogy son+Father+Mother case
 *   - addParentEdge / validateParentEdge (F-AC-DAG-3) happy / duplicate /
 *     self-loop / cycle, rules IN ORDER, existence THROWS
 *   - removeParentEdge symmetric removal + miss
 *   - setLabel trims / empties / throws
 *   - deleteNode (F-AC-DAG-4) single-node, orphan-aware — THE divergence
 *     from deleteSubtree: a child losing its only parent is orphaned, NOT
 *     removed
 *   - cloneGraph deep-copy isolation
 *   - shape rule: derived OVAL ↔ RECTANGLE by parent count
 *
 * Shape-rule note: the architect ruled a FLAT, DERIVED shape rule — a
 * concept node's shape is NOT stored; it is computed on read by
 * conceptShape(node): no parents (root or orphan) → OVAL, ≥ 1 parent →
 * RECTANGLE. There is no depth-based ROUNDED_RECTANGLE / PARALLELOGRAM in
 * concept mode (that table is mindmap-only, in tree.ts). The assertions
 * below read shape via the shapeOf() helper and verify the only shape
 * transition that exists: OVAL ↔ RECTANGLE as a node gains or loses its
 * last parent.
 */
import {
  addNodeAsParent,
  addNodeWithParent,
  addParentEdge,
  cloneGraph,
  conceptShape,
  createGraph,
  deleteNode,
  removeParentEdge,
  setLabel,
  validateParentEdge,
  type ConceptNode,
  type Graph,
} from '../src/model/graph';
import {ShapeKind} from '../src/model/tree';

/**
 * Concept-node shape is DERIVED on read (graph.ts conceptShape) rather
 * than stored on the node — a node is OVAL iff it has no parents, else
 * RECTANGLE. This helper resolves an id to its ConceptNode and returns
 * its derived shape, so the assertions read like the old `node.shape`
 * checks while honouring the computed-on-read contract.
 */
function shapeOf(graph: Graph, id: number): ShapeKind {
  const node = graph.nodesById.get(id) as ConceptNode;
  return conceptShape(node);
}

describe('graph (concept-map DAG model, §14.3)', () => {
  describe('createGraph', () => {
    it('creates a graph with only the root Oval (§14.2)', () => {
      const graph = createGraph();
      expect(graph.rootId).toBe(0);
      expect(graph.nodesById.size).toBe(1);
      const root = graph.nodesById.get(0);
      expect(root).toBeDefined();
      expect(root?.parentIds).toEqual([]);
      expect(root?.childIds).toEqual([]);
      expect(shapeOf(graph, 0)).toBe(ShapeKind.OVAL);
    });

    it('starts the id allocator at 1 (root took 0)', () => {
      expect(createGraph().nextId).toBe(1);
    });

    it('seeds and trims the optional root label', () => {
      // createGraph stores the label verbatim (the trim contract is on
      // setLabel); a provided label is carried onto the root node.
      const graph = createGraph('Central');
      expect(graph.nodesById.get(0)?.label).toBe('Central');
    });

    it('leaves the root label undefined when omitted', () => {
      expect(createGraph().nodesById.get(0)?.label).toBeUndefined();
    });

    it('ConceptNode carries NO stored shape field (architect directive)', () => {
      // Shape is a PURE compute-on-read via conceptShape(node); the
      // architect deliberately dropped §14.3's example `shape` field so it
      // can never disagree with the structure. Lock that deviation: a
      // future change that re-adds a stored shape field (which could go
      // stale) trips this guard. Node shape is asserted via conceptShape()
      // everywhere else in this file (the shapeOf() helper).
      const graph = createGraph();
      const a = addNodeWithParent(graph, 0);
      expect(graph.nodesById.get(0)).not.toHaveProperty('shape');
      expect(graph.nodesById.get(a)).not.toHaveProperty('shape');
      // The node's keys carry id + the two mirror edge lists (+ an optional
      // label slot) — and crucially NO shape key.
      expect(Object.keys(graph.nodesById.get(a)!)).toEqual(
        expect.arrayContaining(['id', 'parentIds', 'childIds']),
      );
      expect(Object.keys(graph.nodesById.get(a)!)).not.toContain('shape');
    });
  });

  describe('addNodeWithParent (F-AC-DAG-1 Add Child)', () => {
    it('allocates an ascending id with the parent as sole parent', () => {
      const graph = createGraph();
      const childId = addNodeWithParent(graph, 0);
      expect(childId).toBe(1);
      expect(graph.nextId).toBe(2);
      const child = graph.nodesById.get(childId);
      expect(child?.parentIds).toEqual([0]);
      expect(child?.childIds).toEqual([]);
    });

    it('keeps the childIds/parentIds mirror symmetric', () => {
      const graph = createGraph();
      const childId = addNodeWithParent(graph, 0);
      expect(graph.nodesById.get(0)?.childIds).toEqual([childId]);
    });

    it('a node with a parent renders RECTANGLE (flat rule)', () => {
      const graph = createGraph();
      const childId = addNodeWithParent(graph, 0);
      expect(shapeOf(graph, childId)).toBe(ShapeKind.RECTANGLE);
    });

    it('a grandchild (still ≥ 1 parent) also renders RECTANGLE', () => {
      const graph = createGraph();
      const a = addNodeWithParent(graph, 0);
      const b = addNodeWithParent(graph, a);
      expect(shapeOf(graph, b)).toBe(ShapeKind.RECTANGLE);
    });

    it('seeds the optional label', () => {
      const graph = createGraph();
      const childId = addNodeWithParent(graph, 0, 'leaf');
      expect(graph.nodesById.get(childId)?.label).toBe('leaf');
    });

    it('throws on an unknown parent id (boundary)', () => {
      const graph = createGraph();
      expect(() => addNodeWithParent(graph, 999)).toThrow(/unknown node/);
    });
  });

  describe('addNodeAsParent (F-AC-DAG-2 Add Parent)', () => {
    it('the new node is a root (OVAL) with the tapped node as sole child', () => {
      const graph = createGraph();
      const son = addNodeWithParent(graph, 0);
      const father = addNodeAsParent(graph, son);
      const fatherNode = graph.nodesById.get(father);
      expect(fatherNode?.parentIds).toEqual([]);
      expect(fatherNode?.childIds).toEqual([son]);
      expect(shapeOf(graph, father)).toBe(ShapeKind.OVAL);
    });

    it('the genealogy case: son + Add Parent ×2 → both parents link to son', () => {
      // §14.4 F-AC-DAG-2 canonical example. Start with a lone son node,
      // add Father then Mother as parents; son must end with BOTH parents
      // and each parent must mirror son as its only child.
      const graph = createGraph('son');
      const son = 0;
      const father = addNodeAsParent(graph, son, 'Father');
      const mother = addNodeAsParent(graph, son, 'Mother');
      expect(graph.nodesById.get(son)?.parentIds).toEqual([father, mother]);
      expect(graph.nodesById.get(father)?.childIds).toEqual([son]);
      expect(graph.nodesById.get(mother)?.childIds).toEqual([son]);
    });

    it('keeps the child a RECTANGLE when a second parent is added', () => {
      // Flat rule: gaining another parent does not change shape — the node
      // already has ≥ 1 parent (RECTANGLE) and stays RECTANGLE.
      const graph = createGraph();
      const a = addNodeWithParent(graph, 0);
      const b = addNodeWithParent(graph, a);
      expect(shapeOf(graph, b)).toBe(ShapeKind.RECTANGLE);
      addNodeAsParent(graph, b);
      expect(shapeOf(graph, b)).toBe(ShapeKind.RECTANGLE);
    });

    it('flips a parentless root (OVAL) to RECTANGLE when given a parent', () => {
      // The canonical OVAL→RECTANGLE transition: the central idea is an
      // OVAL until Add Parent gives it a parent edge.
      const graph = createGraph(); // root 0 is OVAL
      expect(shapeOf(graph, 0)).toBe(ShapeKind.OVAL);
      addNodeAsParent(graph, 0);
      expect(shapeOf(graph, 0)).toBe(ShapeKind.RECTANGLE);
    });

    it('throws on an unknown child id (boundary)', () => {
      const graph = createGraph();
      expect(() => addNodeAsParent(graph, 999)).toThrow(/unknown node/);
    });
  });

  describe('addParentEdge (F-AC-DAG-3 Link to existing)', () => {
    it('happy path links symmetrically and returns true', () => {
      // Two children of root; link child b under child a as an extra
      // parent edge (a → b). b then has two parents (root + a).
      const graph = createGraph();
      const a = addNodeWithParent(graph, 0);
      const b = addNodeWithParent(graph, 0);
      expect(addParentEdge(graph, b, a)).toBe(true);
      expect(graph.nodesById.get(b)?.parentIds).toEqual([0, a]);
      expect(graph.nodesById.get(a)?.childIds).toEqual([b]);
    });

    it('duplicate edge returns false and does not double-link', () => {
      const graph = createGraph();
      const a = addNodeWithParent(graph, 0);
      const b = addNodeWithParent(graph, 0);
      expect(addParentEdge(graph, b, a)).toBe(true);
      expect(addParentEdge(graph, b, a)).toBe(false);
      expect(graph.nodesById.get(b)?.parentIds).toEqual([0, a]);
      expect(graph.nodesById.get(a)?.childIds).toEqual([b]);
    });

    it('self-loop returns false', () => {
      const graph = createGraph();
      const a = addNodeWithParent(graph, 0);
      expect(addParentEdge(graph, a, a)).toBe(false);
    });

    it('cycle-closing edge returns false', () => {
      // Chain root → a → b → c. Trying to make a a child of c
      // (parent c → child a) would close a cycle a→b→c→a.
      const graph = createGraph();
      const a = addNodeWithParent(graph, 0);
      const b = addNodeWithParent(graph, a);
      const c = addNodeWithParent(graph, b);
      expect(addParentEdge(graph, a, c)).toBe(false);
      // No mutation happened on rejection.
      expect(graph.nodesById.get(a)?.parentIds).toEqual([0]);
      expect(graph.nodesById.get(c)?.childIds).toEqual([]);
    });

    it('throws on an unknown id (boundary, not a soft reject)', () => {
      const graph = createGraph();
      const a = addNodeWithParent(graph, 0);
      expect(() => addParentEdge(graph, a, 999)).toThrow(/unknown node/);
      expect(() => addParentEdge(graph, 999, a)).toThrow(/unknown node/);
    });

    it('flips a former-orphan OVAL→RECTANGLE when linked to a parent', () => {
      // Designer FINAL delta — lock the OVAL→RECTANGLE flip via
      // addParentEdge. Build root → a → orphan, then delete `a` so
      // `orphan` loses its only parent (parentIds [], OVAL). Re-link it
      // under the root: it gains a parent → RECTANGLE.
      const graph = createGraph();
      const a = addNodeWithParent(graph, 0);
      const orphan = addNodeWithParent(graph, a);
      deleteNode(graph, a);
      expect(graph.nodesById.get(orphan)?.parentIds).toEqual([]);
      expect(shapeOf(graph, orphan)).toBe(ShapeKind.OVAL);
      expect(addParentEdge(graph, orphan, 0)).toBe(true);
      expect(shapeOf(graph, orphan)).toBe(ShapeKind.RECTANGLE);
    });

    it('leaves the child a RECTANGLE after gaining an extra parent edge', () => {
      // Flat rule: a node deep in a chain is a RECTANGLE (it has a parent);
      // adding another parent edge keeps it a RECTANGLE.
      const graph = createGraph();
      const a = addNodeWithParent(graph, 0);
      const b = addNodeWithParent(graph, a);
      const c = addNodeWithParent(graph, b);
      expect(shapeOf(graph, c)).toBe(ShapeKind.RECTANGLE);
      expect(addParentEdge(graph, c, 0)).toBe(true);
      expect(shapeOf(graph, c)).toBe(ShapeKind.RECTANGLE);
    });
  });

  describe('validateParentEdge (rules IN ORDER)', () => {
    it('returns ok for a valid new edge', () => {
      const graph = createGraph();
      const a = addNodeWithParent(graph, 0);
      const b = addNodeWithParent(graph, 0);
      expect(validateParentEdge(graph, b, a)).toEqual({ok: true});
    });

    it('self-loop fires before duplicate/cycle', () => {
      const graph = createGraph();
      const a = addNodeWithParent(graph, 0);
      expect(validateParentEdge(graph, a, a)).toEqual({
        ok: false,
        reason: 'self-loop',
      });
    });

    it('duplicate fires before cycle', () => {
      const graph = createGraph();
      const a = addNodeWithParent(graph, 0);
      // 0 is already a's parent → 'duplicate', not 'cycle'.
      expect(validateParentEdge(graph, a, 0)).toEqual({
        ok: false,
        reason: 'duplicate',
      });
    });

    it('reports cycle on a diamond back-edge (A→B, A→C, B→D, C→D)', () => {
      // Diamond: root(A) → B, A → C, B → D, C → D. D reaches nothing
      // below it, but D→A (parent D, child A) would close a cycle since
      // A reaches D via both branches.
      const graph = createGraph(); // A = 0
      const b = addNodeWithParent(graph, 0);
      const c = addNodeWithParent(graph, 0);
      const d = addNodeWithParent(graph, b);
      expect(addParentEdge(graph, d, c)).toBe(true); // C → D second parent
      // Now attempt to make A a child of D → cycle.
      expect(validateParentEdge(graph, 0, d)).toEqual({
        ok: false,
        reason: 'cycle',
      });
    });

    it('handles a diamond where the cycle-check BFS revisits a node', () => {
      // Build A → B, A → C, B → D, C → D (a convergent diamond rooted at
      // A) plus a SEPARATE node `other` that A cannot reach. Validating a
      // new edge (other → A, i.e. A becomes a child of `other`) runs
      // canReach(A, other): BFS from A enqueues B, C, then reaches D via
      // B and AGAIN via C — the second arrival finds D already in the
      // visited set, exercising the convergent-path branch. `other` is
      // never reached, so the BFS exhausts and the edge is acyclic (ok).
      const graph = createGraph(); // A = 0
      const a = addNodeWithParent(graph, 0); // a, the diamond apex below root
      const b = addNodeWithParent(graph, a);
      const c = addNodeWithParent(graph, a);
      const d = addNodeWithParent(graph, b);
      addParentEdge(graph, d, c); // C → D: D now reached via both B and C
      const other = addNodeWithParent(graph, 0); // sibling of a, not below a
      // canReach(a, other): walks b, c, d (d twice), never reaches other.
      expect(validateParentEdge(graph, a, other)).toEqual({ok: true});
    });

    it('allows a valid cross-link in a diamond (a sibling edge)', () => {
      // Same diamond; linking B as a parent of C (B → C) is acyclic
      // because C does not reach B.
      const graph = createGraph();
      const b = addNodeWithParent(graph, 0);
      const c = addNodeWithParent(graph, 0);
      addNodeWithParent(graph, b); // d, deepens b
      expect(validateParentEdge(graph, c, b)).toEqual({ok: true});
    });

    it('throws on an unknown id (existence is rule 1, HARD)', () => {
      const graph = createGraph();
      expect(() => validateParentEdge(graph, 0, 999)).toThrow(/unknown node/);
      expect(() => validateParentEdge(graph, 999, 0)).toThrow(/unknown node/);
    });
  });

  describe('removeParentEdge', () => {
    it('removes symmetrically and returns true when the edge existed', () => {
      const graph = createGraph();
      const a = addNodeWithParent(graph, 0);
      const b = addNodeWithParent(graph, 0);
      addParentEdge(graph, b, a);
      expect(removeParentEdge(graph, b, a)).toBe(true);
      expect(graph.nodesById.get(b)?.parentIds).toEqual([0]);
      expect(graph.nodesById.get(a)?.childIds).toEqual([]);
    });

    it('returns false when no such edge exists', () => {
      const graph = createGraph();
      const a = addNodeWithParent(graph, 0);
      const b = addNodeWithParent(graph, 0);
      expect(removeParentEdge(graph, b, a)).toBe(false);
    });

    it('flips the child OVAL when its LAST parent edge is removed', () => {
      // Flat rule: a node with one parent is a RECTANGLE; removing that
      // sole parent orphans it → OVAL. This is the RECTANGLE→OVAL half of
      // the only shape transition in concept mode.
      const graph = createGraph();
      const a = addNodeWithParent(graph, 0);
      const b = addNodeWithParent(graph, a);
      expect(shapeOf(graph, b)).toBe(ShapeKind.RECTANGLE);
      removeParentEdge(graph, b, a);
      expect(shapeOf(graph, b)).toBe(ShapeKind.OVAL);
    });

    it('keeps the child a RECTANGLE when a non-last parent edge is removed', () => {
      // Two parents (root via Add Child, plus a linked edge). Removing one
      // leaves a parent behind → stays RECTANGLE.
      const graph = createGraph();
      const a = addNodeWithParent(graph, 0);
      const b = addNodeWithParent(graph, a);
      addParentEdge(graph, b, 0); // b now has parents [a, 0]
      removeParentEdge(graph, b, 0);
      expect(graph.nodesById.get(b)?.parentIds).toEqual([a]);
      expect(shapeOf(graph, b)).toBe(ShapeKind.RECTANGLE);
    });

    it('throws on unknown ids (boundary)', () => {
      const graph = createGraph();
      const a = addNodeWithParent(graph, 0);
      expect(() => removeParentEdge(graph, a, 999)).toThrow(/unknown node/);
      expect(() => removeParentEdge(graph, 999, a)).toThrow(/unknown node/);
    });
  });

  describe('setLabel (mirrors tree.setLabel)', () => {
    it('trims surrounding whitespace', () => {
      const graph = createGraph();
      setLabel(graph, 0, '  hello  ');
      expect(graph.nodesById.get(0)?.label).toBe('hello');
    });

    it('stores an empty / whitespace-only label as undefined', () => {
      const graph = createGraph('seed');
      setLabel(graph, 0, '   ');
      expect(graph.nodesById.get(0)?.label).toBeUndefined();
      setLabel(graph, 0, '');
      expect(graph.nodesById.get(0)?.label).toBeUndefined();
      setLabel(graph, 0, undefined);
      expect(graph.nodesById.get(0)?.label).toBeUndefined();
    });

    it('throws on unknown node id', () => {
      const graph = createGraph();
      expect(() => setLabel(graph, 42, 'x')).toThrow(/unknown node/);
    });
  });

  describe('deleteNode (F-AC-DAG-4 single-node, orphan-aware)', () => {
    it('removes the node from every parent.childIds and child.parentIds', () => {
      // root → mid → leaf. Deleting mid unlinks it from root and leaf
      // (mirror both sides) and removes only mid from the map.
      const graph = createGraph();
      const mid = addNodeWithParent(graph, 0);
      const leaf = addNodeWithParent(graph, mid);
      deleteNode(graph, mid);
      expect(graph.nodesById.has(mid)).toBe(false);
      expect(graph.nodesById.get(0)?.childIds).toEqual([]);
      expect(graph.nodesById.get(leaf)?.parentIds).toEqual([]);
    });

    it('orphans (but does NOT delete) a child that loses its only parent', () => {
      // THE divergence from deleteSubtree: deleting the sole parent leaves
      // the child alive as an orphan rather than cascade-deleting it.
      const graph = createGraph();
      const parent = addNodeWithParent(graph, 0);
      const child = addNodeWithParent(graph, parent);
      deleteNode(graph, parent);
      expect(graph.nodesById.has(child)).toBe(true);
      expect(graph.nodesById.get(child)?.parentIds).toEqual([]);
      // An orphan (no parents) recomputes to the depth-0 OVAL shape.
      expect(shapeOf(graph, child)).toBe(ShapeKind.OVAL);
    });

    it('keeps the other parent edge when a multi-parent child loses one', () => {
      // Diamond: son has Father + Mother. Deleting Father leaves son with
      // Mother only — still a child, not an orphan.
      const graph = createGraph('son');
      const son = 0;
      const father = addNodeAsParent(graph, son, 'Father');
      const mother = addNodeAsParent(graph, son, 'Mother');
      deleteNode(graph, father);
      expect(graph.nodesById.has(son)).toBe(true);
      expect(graph.nodesById.get(son)?.parentIds).toEqual([mother]);
      expect(graph.nodesById.get(mother)?.childIds).toEqual([son]);
    });

    it('sets rootId to null when the advisory root is deleted', () => {
      const graph = createGraph();
      addNodeWithParent(graph, 0);
      deleteNode(graph, 0);
      expect(graph.rootId).toBeNull();
      expect(graph.nodesById.has(0)).toBe(false);
    });

    it('leaves rootId intact when a non-root is deleted', () => {
      const graph = createGraph();
      const a = addNodeWithParent(graph, 0);
      deleteNode(graph, a);
      expect(graph.rootId).toBe(0);
    });

    it('throws on unknown node id', () => {
      const graph = createGraph();
      expect(() => deleteNode(graph, 123)).toThrow(/unknown node/);
    });
  });

  describe('cloneGraph (deep copy, mirrors cloneTree)', () => {
    it('shares no references — mutating the clone leaves the original intact', () => {
      const graph = createGraph();
      const a = addNodeWithParent(graph, 0);
      const b = addNodeWithParent(graph, 0);
      addParentEdge(graph, b, a);
      const clone = cloneGraph(graph);

      // Mutate the clone via real mutators; the original must not move.
      // deleteNode(clone, a) rewrites several mirror arrays and removes a
      // node — if any array were aliased, the original would change too.
      deleteNode(clone, a);

      // Original is untouched: arrays are independent copies and the node
      // set is a separate Map.
      expect(graph.nodesById.get(0)?.childIds).toEqual([a, b]);
      expect(graph.nodesById.get(b)?.parentIds).toEqual([0, a]);
      expect(graph.nodesById.get(a)?.childIds).toEqual([b]);
      expect(graph.nodesById.has(a)).toBe(true);
    });

    it('preserves nextId and rootId', () => {
      const graph = createGraph();
      addNodeWithParent(graph, 0);
      const clone = cloneGraph(graph);
      expect(clone.nextId).toBe(graph.nextId);
      expect(clone.rootId).toBe(graph.rootId);
    });

    it('preserves a null rootId across a clone', () => {
      const graph: Graph = createGraph();
      deleteNode(graph, 0);
      expect(cloneGraph(graph).rootId).toBeNull();
    });
  });

  describe('flat shape rule (§14.3 — architect ruling)', () => {
    it('a multi-parent node is a RECTANGLE regardless of its parents', () => {
      // A node reachable from the root via two different paths still just
      // has ≥ 1 parent → RECTANGLE. The flat rule deliberately ignores
      // depth (there is no canonical depth in a DAG).
      const graph = createGraph();
      const mid = addNodeWithParent(graph, 0);
      const x = addNodeWithParent(graph, mid);
      addParentEdge(graph, x, 0);
      expect(graph.nodesById.get(x)?.parentIds).toEqual([mid, 0]);
      expect(shapeOf(graph, x)).toBe(ShapeKind.RECTANGLE);
    });

    it('only the root/orphans (parentIds empty) are OVAL', () => {
      const graph = createGraph();
      const a = addNodeWithParent(graph, 0);
      expect(shapeOf(graph, 0)).toBe(ShapeKind.OVAL); // root
      expect(shapeOf(graph, a)).toBe(ShapeKind.RECTANGLE);
    });
  });
});
