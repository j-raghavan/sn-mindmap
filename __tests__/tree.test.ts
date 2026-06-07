/**
 * Tests for src/model/tree.ts.
 *
 * Phase 1.1 (§9) coverage:
 *   - createTree starting shape (§F-AC-2, §F-AC-3)
 *   - ShapeKind wire bytes (§6.3)
 *   - addChild assigns RECTANGLE, allocates fresh ids, appends
 *   - addSibling assigns ROUNDED_RECTANGLE, inserts after pivot,
 *     throws on root (§F-AC-5)
 *   - deleteSubtree removes subtree, returns removed ids, throws
 *     on root (§4.3, §F-AC-5)
 *   - setCollapsed toggles only on nodes with children (§F-AC-5,
 *     §4.2)
 *   - flattenForEmit yields pre-order regardless of collapse state
 *     (§F-IN-2, §6.3)
 *   - cloneTree is a deep copy (no aliased childIds, independent
 *     nodesById)
 */
import {
  addChild,
  addCrossEdge,
  addSibling,
  cloneTree,
  createTree,
  deleteCrossEdge,
  deleteSubtree,
  flattenForEmit,
  setCollapsed,
  setLabel,
  shapeForDepth,
  ShapeKind,
  validateCrossEdge,
  type Tree,
} from '../src/model/tree';

describe('tree', () => {
  describe('createTree', () => {
    it('creates a tree with only the root Oval (§F-AC-2, §F-AC-3)', () => {
      const tree = createTree();
      expect(tree.rootId).toBe(0);
      expect(tree.nodesById.size).toBe(1);
      const root = tree.nodesById.get(0);
      expect(root).toBeDefined();
      expect(root?.parentId).toBeNull();
      expect(root?.shape).toBe(ShapeKind.OVAL);
      expect(root?.childIds).toEqual([]);
      expect(root?.collapsed).toBe(false);
    });

    it('ShapeKind wire bytes match §6.3', () => {
      // These numeric values ARE the marker-record bytes. If they
      // ever change, the marker encoder/decoder change with them.
      // Do not renumber casually.
      expect(ShapeKind.OVAL).toBe(0x00);
      expect(ShapeKind.RECTANGLE).toBe(0x01);
      expect(ShapeKind.ROUNDED_RECTANGLE).toBe(0x02);
    });

    it('starts the id allocator at 1 (root took 0)', () => {
      const tree = createTree();
      expect(tree.nextId).toBe(1);
    });

    it('initializes an empty crossEdges overlay (F-DAG-1-FR2)', () => {
      const tree = createTree();
      expect(tree.crossEdges).toEqual([]);
    });
  });

  describe('addChild', () => {
    it('appends a depth-1 ROUNDED_RECTANGLE child with a fresh id', () => {
      // v1.0 shape-by-depth: depth 1 → ROUNDED_RECTANGLE.
      const tree = createTree();
      const childId = addChild(tree, 0);
      expect(childId).toBe(1);
      expect(tree.nextId).toBe(2);
      const child = tree.nodesById.get(childId);
      expect(child?.parentId).toBe(0);
      expect(child?.shape).toBe(ShapeKind.ROUNDED_RECTANGLE);
      expect(child?.childIds).toEqual([]);
      expect(child?.collapsed).toBe(false);
      const root = tree.nodesById.get(0);
      expect(root?.childIds).toEqual([1]);
    });

    it('allocates strictly increasing ids and preserves child order', () => {
      const tree = createTree();
      const a = addChild(tree, 0);
      const b = addChild(tree, 0);
      const c = addChild(tree, 0);
      expect([a, b, c]).toEqual([1, 2, 3]);
      expect(tree.nodesById.get(0)?.childIds).toEqual([1, 2, 3]);
    });

    it('depth-2 grandchild renders as RECTANGLE (shape-by-depth)', () => {
      // depth-2 sits one level below the rounded rectangles, with
      // sharp-corner rectangle outlines.
      const tree = createTree();
      const a = addChild(tree, 0);
      const b = addChild(tree, a);
      expect(tree.nodesById.get(a)?.childIds).toEqual([b]);
      expect(tree.nodesById.get(b)?.parentId).toBe(a);
      expect(tree.nodesById.get(b)?.shape).toBe(ShapeKind.RECTANGLE);
    });

    it('depth-3 great-grandchild renders as PARALLELOGRAM', () => {
      const tree = createTree();
      const a = addChild(tree, 0);
      const b = addChild(tree, a);
      const c = addChild(tree, b);
      expect(tree.nodesById.get(c)?.shape).toBe(ShapeKind.PARALLELOGRAM);
    });

    it('depth-4 and deeper stays PARALLELOGRAM', () => {
      const tree = createTree();
      let cursor = 0;
      for (let depth = 0; depth < 5; depth += 1) {
        cursor = addChild(tree, cursor);
      }
      // cursor is now the depth-5 leaf.
      expect(tree.nodesById.get(cursor)?.shape).toBe(
        ShapeKind.PARALLELOGRAM,
      );
    });

    it('throws on unknown parent id', () => {
      const tree = createTree();
      expect(() => addChild(tree, 999)).toThrow(/unknown node/);
    });
  });

  describe('addSibling', () => {
    it('inserts a ROUNDED_RECTANGLE immediately after the pivot (§F-AC-3)', () => {
      const tree = createTree();
      const a = addChild(tree, 0);
      const b = addChild(tree, 0);
      const c = addChild(tree, 0);
      // Siblings of `a` should land between `a` and `b`.
      const s = addSibling(tree, a);
      const sib = tree.nodesById.get(s);
      expect(sib?.parentId).toBe(0);
      expect(sib?.shape).toBe(ShapeKind.ROUNDED_RECTANGLE);
      expect(tree.nodesById.get(0)?.childIds).toEqual([a, s, b, c]);
    });

    it('throws on the root (§F-AC-5 — Add Sibling is hidden, not disabled)', () => {
      const tree = createTree();
      expect(() => addSibling(tree, 0)).toThrow(/root/);
    });

    it('throws on unknown node id', () => {
      const tree = createTree();
      expect(() => addSibling(tree, 42)).toThrow(/unknown node/);
    });
  });

  describe('deleteSubtree', () => {
    it('removes the target and all descendants, returns the id set', () => {
      const tree = createTree();
      const a = addChild(tree, 0);
      const b = addChild(tree, a);
      const c = addChild(tree, a);
      const d = addChild(tree, b);
      const removed = deleteSubtree(tree, a);
      expect(removed).toEqual(new Set([a, b, c, d]));
      expect(tree.nodesById.has(a)).toBe(false);
      expect(tree.nodesById.has(b)).toBe(false);
      expect(tree.nodesById.has(c)).toBe(false);
      expect(tree.nodesById.has(d)).toBe(false);
      expect(tree.nodesById.get(0)?.childIds).toEqual([]);
    });

    it('unlinks from parent childIds without touching siblings', () => {
      const tree = createTree();
      const a = addChild(tree, 0);
      const b = addChild(tree, 0);
      const c = addChild(tree, 0);
      deleteSubtree(tree, b);
      expect(tree.nodesById.get(0)?.childIds).toEqual([a, c]);
    });

    it('throws on the root (§4.3, §F-AC-5)', () => {
      const tree = createTree();
      expect(() => deleteSubtree(tree, 0)).toThrow(/root/);
    });

    it('throws on unknown node id', () => {
      const tree = createTree();
      expect(() => deleteSubtree(tree, 123)).toThrow(/unknown node/);
    });
  });

  describe('setCollapsed', () => {
    it('toggles collapsed on a node with children (§F-AC-5, §4.2)', () => {
      const tree = createTree();
      const a = addChild(tree, 0);
      addChild(tree, a);
      setCollapsed(tree, a, true);
      expect(tree.nodesById.get(a)?.collapsed).toBe(true);
      setCollapsed(tree, a, false);
      expect(tree.nodesById.get(a)?.collapsed).toBe(false);
    });

    it('is a no-op on a leaf (toggle is hidden for leaves — §F-AC-5)', () => {
      const tree = createTree();
      const a = addChild(tree, 0);
      setCollapsed(tree, a, true);
      expect(tree.nodesById.get(a)?.collapsed).toBe(false);
    });

    it('throws on unknown node id', () => {
      const tree = createTree();
      expect(() => setCollapsed(tree, 77, true)).toThrow(/unknown node/);
    });
  });

  describe('flattenForEmit', () => {
    it('yields pre-order with root first (§6.3)', () => {
      const tree = createTree();
      const a = addChild(tree, 0);
      const b = addChild(tree, 0);
      const aa = addChild(tree, a);
      const ab = addChild(tree, a);
      const flat = flattenForEmit(tree);
      expect(flat.map(n => n.id)).toEqual([0, a, aa, ab, b]);
      // Root must be index 0 because §6.3 encodes record offset ==
      // pre-order index.
      expect(flat[0].id).toBe(0);
    });

    it('still emits collapsed subtrees fully expanded (§F-IN-2)', () => {
      const tree = createTree();
      const a = addChild(tree, 0);
      const b = addChild(tree, a);
      setCollapsed(tree, a, true);
      const flat = flattenForEmit(tree);
      expect(flat.map(n => n.id)).toEqual([0, a, b]);
    });

    it('handles a single-node tree', () => {
      const tree = createTree();
      const flat = flattenForEmit(tree);
      expect(flat).toHaveLength(1);
      expect(flat[0].id).toBe(0);
    });
  });

  describe('cloneTree', () => {
    it('produces an independent deep copy', () => {
      const tree = createTree();
      const a = addChild(tree, 0);
      addChild(tree, a);
      const clone = cloneTree(tree);

      // Mutating the clone must not bleed into the original.
      addChild(clone, a);
      expect(clone.nodesById.get(a)?.childIds.length).toBe(2);
      expect(tree.nodesById.get(a)?.childIds.length).toBe(1);

      // The maps themselves must not be aliased.
      expect(clone.nodesById).not.toBe(tree.nodesById);
      // Each node object must be a fresh reference.
      for (const [id, node] of clone.nodesById) {
        if (tree.nodesById.has(id)) {
          expect(node).not.toBe(tree.nodesById.get(id));
          expect(node.childIds).not.toBe(tree.nodesById.get(id)?.childIds);
        }
      }
    });

    it('preserves nextId so clones keep allocating fresh ids', () => {
      const tree = createTree();
      addChild(tree, 0);
      addChild(tree, 0);
      const clone = cloneTree(tree);
      expect(clone.nextId).toBe(tree.nextId);
      const fresh = addChild(clone, 0);
      expect(fresh).toBe(tree.nextId);
    });

    it('clones a tree that still satisfies Tree typing', () => {
      // Redundant TS/runtime sanity: the cloned object has the same
      // shape as the source so consumers can use it interchangeably.
      const tree: Tree = createTree();
      const clone: Tree = cloneTree(tree);
      expect(clone.rootId).toBe(tree.rootId);
    });

    it('deep-copies crossEdges so clone mutations stay independent (F-DAG-1-AC1)', () => {
      // Build a tree with a cross-edge, clone it, then mutate the
      // clone's overlay (push + splice). The original must be untouched
      // AND the edge OBJECTS must be distinct references — a shallow
      // [...arr] copy would alias the {from,to} objects, so this pins
      // the per-edge `.map(e => ({...e}))` deep copy.
      const tree = createTree();
      const a = addChild(tree, 0);
      const b = addChild(tree, 0);
      addCrossEdge(tree, a, b);
      expect(tree.crossEdges).toHaveLength(1);

      const clone = cloneTree(tree);
      // The edge objects are different references.
      expect(clone.crossEdges[0]).not.toBe(tree.crossEdges[0]);
      // ...but carry the same value.
      expect(clone.crossEdges[0]).toEqual({from: a, to: b});

      // Mutate the clone's overlay: push a new edge, then splice the
      // original one out.
      clone.crossEdges.push({from: b, to: a});
      clone.crossEdges.splice(0, 1);
      expect(clone.crossEdges).toEqual([{from: b, to: a}]);

      // Original is unchanged by either operation.
      expect(tree.crossEdges).toEqual([{from: a, to: b}]);
    });
  });

  describe('shapeForDepth', () => {
    it('depth 0 → OVAL (root central idea)', () => {
      expect(shapeForDepth(0)).toBe(ShapeKind.OVAL);
    });

    it('depth 1 → ROUNDED_RECTANGLE', () => {
      expect(shapeForDepth(1)).toBe(ShapeKind.ROUNDED_RECTANGLE);
    });

    it('depth 2 → RECTANGLE', () => {
      expect(shapeForDepth(2)).toBe(ShapeKind.RECTANGLE);
    });

    it('depth ≥ 3 → PARALLELOGRAM', () => {
      expect(shapeForDepth(3)).toBe(ShapeKind.PARALLELOGRAM);
      expect(shapeForDepth(7)).toBe(ShapeKind.PARALLELOGRAM);
    });
  });

  describe('setLabel', () => {
    it('stores a trimmed label', () => {
      const tree = createTree();
      const a = addChild(tree, 0);
      setLabel(tree, a, '  hello  ');
      expect(tree.nodesById.get(a)?.label).toBe('hello');
    });

    it('treats an empty string as no label', () => {
      const tree = createTree('seed');
      setLabel(tree, 0, '');
      expect(tree.nodesById.get(0)?.label).toBeUndefined();
    });

    it('treats a whitespace-only string as no label', () => {
      const tree = createTree('seed');
      setLabel(tree, 0, '   ');
      expect(tree.nodesById.get(0)?.label).toBeUndefined();
    });

    it('treats undefined as no label', () => {
      const tree = createTree('seed');
      setLabel(tree, 0, undefined);
      expect(tree.nodesById.get(0)?.label).toBeUndefined();
    });

    it('throws on unknown node id', () => {
      const tree = createTree();
      expect(() => setLabel(tree, 999, 'x')).toThrow(/unknown node/);
    });
  });

  // -------------------------------------------------------------------------
  // DAG cross-edge overlay (Part B / F-DAG-1, F-DAG-2)
  // -------------------------------------------------------------------------

  describe('deleteSubtree — cross-edge cascade (F-DAG-1-FR3/AC2, I-DAG-2)', () => {
    it('removes cross-edges whose endpoint is in the deleted subtree, keeps the rest', () => {
      // Tree: root(0) → A → B (these get deleted); root → C, root → e2,
      // root → f (all survive). The three cross-edges below touch
      // DISJOINT node pairs so none feeds another transitively (avoiding
      // accidental cycles), letting us isolate the cascade-by-endpoint:
      //   (a) edge FROM a removed node (B → C)  → removed
      //   (b) edge TO   a removed node (e2 → A) → removed
      //   (c) edge with BOTH endpoints OUTSIDE the removed set (C → f)
      //       → KEPT.
      const tree = createTree();
      const a = addChild(tree, 0);
      const b = addChild(tree, a);
      const c = addChild(tree, 0);
      const e2 = addChild(tree, 0);
      const f = addChild(tree, 0);

      // (a) from-endpoint in the removed set: B → C.
      expect(addCrossEdge(tree, b, c)).not.toBeNull();
      // (b) to-endpoint in the removed set: e2 → A. (A's reachable set
      //     never includes e2, so this is a valid forward edge whose
      //     `to` will be removed with A's subtree.)
      expect(addCrossEdge(tree, e2, a)).not.toBeNull();
      // (c) both endpoints survive: C → f.
      expect(addCrossEdge(tree, c, f)).not.toBeNull();
      expect(tree.crossEdges).toHaveLength(3);

      const removed = deleteSubtree(tree, a); // removes {a, b}
      expect(removed).toEqual(new Set([a, b]));

      // Only the both-survive edge (C → f) remains.
      expect(tree.crossEdges).toEqual([{from: c, to: f}]);
    });

    it('leaves crossEdges untouched when no endpoint is removed', () => {
      const tree = createTree();
      const a = addChild(tree, 0);
      const b = addChild(tree, 0);
      const c = addChild(tree, 0);
      addCrossEdge(tree, a, b);
      // Delete an unrelated leaf c (no edge touches it).
      deleteSubtree(tree, c);
      expect(tree.crossEdges).toEqual([{from: a, to: b}]);
    });
  });

  describe('validateCrossEdge / addCrossEdge — five rules (F-DAG-2)', () => {
    // Rule 1 — existence (HARD throw via getNode), both args.
    it('rule 1: throws when `from` does not exist', () => {
      const tree = createTree();
      addChild(tree, 0);
      expect(() => addCrossEdge(tree, 999, 0)).toThrow(/unknown node/);
      expect(() => validateCrossEdge(tree, 999, 0)).toThrow(/unknown node/);
    });

    it('rule 1: throws when `to` does not exist', () => {
      const tree = createTree();
      addChild(tree, 0);
      expect(() => addCrossEdge(tree, 0, 999)).toThrow(/unknown node/);
      expect(() => validateCrossEdge(tree, 0, 999)).toThrow(/unknown node/);
    });

    // Rule 2 — self-loop.
    it('rule 2: self-loop is rejected with reason "self-loop" and no mutation', () => {
      const tree = createTree();
      const a = addChild(tree, 0);
      expect(validateCrossEdge(tree, a, a)).toEqual({
        ok: false,
        reason: 'self-loop',
      });
      expect(addCrossEdge(tree, a, a)).toBeNull();
      expect(tree.crossEdges).toHaveLength(0);
    });

    // Rule 3 — parent→child is a tree-edge dup.
    it('rule 3: parent→child is rejected with reason "tree-edge" (F-DAG-2-AC4)', () => {
      // Tree A(root) → B. Linking A→B duplicates the tree connector.
      const tree = createTree();
      const b = addChild(tree, 0);
      expect(validateCrossEdge(tree, 0, b)).toEqual({
        ok: false,
        reason: 'tree-edge',
      });
      expect(addCrossEdge(tree, 0, b)).toBeNull();
      expect(tree.crossEdges).toHaveLength(0);
    });

    // Rule 4 — duplicate cross-edge.
    it('rule 4: a second identical cross-edge is rejected as "duplicate" (F-DAG-2-AC3)', () => {
      // B and D are siblings under root, so B→D is a genuine non-tree
      // cross-edge. Adding it twice must reject the second.
      const tree = createTree();
      const b = addChild(tree, 0);
      const d = addChild(tree, 0);
      expect(addCrossEdge(tree, b, d)).toEqual({from: b, to: d});
      expect(validateCrossEdge(tree, b, d)).toEqual({
        ok: false,
        reason: 'duplicate',
      });
      expect(addCrossEdge(tree, b, d)).toBeNull();
      expect(tree.crossEdges).toHaveLength(1); // unchanged
    });

    // Rule 5a — DIRECT 2-cycle (child→parent via the tree edge).
    it('rule 5a: child→parent is rejected as "cycle" (F-DAG-2-AC1 direct)', () => {
      // Tree A(root) → B. Linking B→A: A already reaches B via
      // childIds, so canReach(to=A, from=B) is true → cycle.
      const tree = createTree();
      const b = addChild(tree, 0);
      expect(validateCrossEdge(tree, b, 0)).toEqual({
        ok: false,
        reason: 'cycle',
      });
      expect(addCrossEdge(tree, b, 0)).toBeNull();
      expect(tree.crossEdges).toHaveLength(0);
    });

    // Rule 5b — INDIRECT N-cycle over the tree chain.
    it('rule 5b: transitive child→ancestor is rejected as "cycle" (F-DAG-2-AC1 transitive)', () => {
      // Tree A(root) → B → C. Linking C→A: A reaches C through the
      // chain, so canReach(to=A, from=C) is true → cycle.
      const tree = createTree();
      const b = addChild(tree, 0);
      const c = addChild(tree, b);
      expect(validateCrossEdge(tree, c, 0)).toEqual({
        ok: false,
        reason: 'cycle',
      });
      expect(addCrossEdge(tree, c, 0)).toBeNull();
    });

    // Rule 5c — TRANSITIVE cycle purely via cross-edges. THE case that
    // catches a childIds-only reachability bug.
    it('rule 5c: a cycle formed only through cross-edges is rejected (canReach walks crossEdges)', () => {
      // Four siblings A,B,C,D under root with NO tree path among them.
      // Add cross-edges A→B and B→C, then link C→A. Reachability from
      // A to C exists ONLY via crossEdges (A→B→C); closing C→A cycles.
      const tree = createTree();
      const a = addChild(tree, 0);
      const b = addChild(tree, 0);
      const c = addChild(tree, 0);
      expect(addCrossEdge(tree, a, b)).not.toBeNull();
      expect(addCrossEdge(tree, b, c)).not.toBeNull();
      // Now C→A would complete A→B→C→A purely over crossEdges.
      expect(validateCrossEdge(tree, c, a)).toEqual({
        ok: false,
        reason: 'cycle',
      });
      expect(addCrossEdge(tree, c, a)).toBeNull();
      expect(tree.crossEdges).toHaveLength(2); // unchanged
    });
  });

  describe('addCrossEdge — canonical diamond accept (F-DAG-2-AC2)', () => {
    it('two non-tree parents converging on one node both succeed (no over-rejection)', () => {
      // A(root); B, C, D all children of A (siblings, no tree path
      // among them). Link B→D and C→D — both genuine non-tree
      // cross-edges, no cycle. "Two parents converge on one node."
      const tree = createTree();
      const b = addChild(tree, 0);
      const c = addChild(tree, 0);
      const d = addChild(tree, 0);

      const e1 = addCrossEdge(tree, b, d);
      const e2 = addCrossEdge(tree, c, d);
      expect(e1).toEqual({from: b, to: d});
      expect(e2).toEqual({from: c, to: d});
      expect(tree.crossEdges).toHaveLength(2);
    });

    it('directional nuance: parent→child is "tree-edge", child→parent is "cycle"', () => {
      // Tree A(root) → B. The single judgment call in the validator:
      // the two directions of the same tree pair get DIFFERENT reasons.
      const tree = createTree();
      const b = addChild(tree, 0);
      // parent→child duplicates the tree connector → tree-edge (rule 3).
      expect(validateCrossEdge(tree, 0, b)).toEqual({
        ok: false,
        reason: 'tree-edge',
      });
      // child→parent would cycle (parent already reaches child) → cycle
      // (rule 5). There is NO 5th 'reverse-tree-edge' reason.
      expect(validateCrossEdge(tree, b, 0)).toEqual({
        ok: false,
        reason: 'cycle',
      });
    });

    it('accepts a forward cross-edge between unrelated branches', () => {
      // A(root) → B; A → C. Linking B→C is forward, non-tree, no cycle.
      const tree = createTree();
      const b = addChild(tree, 0);
      const c = addChild(tree, 0);
      expect(validateCrossEdge(tree, b, c)).toEqual({ok: true});
      expect(addCrossEdge(tree, b, c)).toEqual({from: b, to: c});
    });

    it('reachability de-dups a convergent node reached by two cross-paths (seen-set branch)', () => {
      // Siblings B,C,D,W,E under root with a DIAMOND of cross-edges:
      // B→C, B→D, C→W, D→W. From B, a BFS reaches W via C, then tries
      // to reach W again via D — W is already in the seen set, so the
      // second visit takes the de-dup path (does not re-queue). We then
      // validate E→B (canReach(B, E)): BFS walks B→{C,D}, C→W, D→W
      // (de-dup hit), never finds E → edge accepted. This is the only
      // case that exercises the "already seen" arm.
      const tree = createTree();
      const b = addChild(tree, 0);
      const c = addChild(tree, 0);
      const d = addChild(tree, 0);
      const w = addChild(tree, 0);
      const e = addChild(tree, 0);
      expect(addCrossEdge(tree, b, c)).not.toBeNull();
      expect(addCrossEdge(tree, b, d)).not.toBeNull();
      expect(addCrossEdge(tree, c, w)).not.toBeNull();
      expect(addCrossEdge(tree, d, w)).not.toBeNull(); // converges on W
      // E→B: BFS from B re-encounters W via D after C already queued it.
      expect(validateCrossEdge(tree, e, b)).toEqual({ok: true});
      expect(addCrossEdge(tree, e, b)).toEqual({from: e, to: b});
    });

    it('accepts an edge whose acyclicity check walks a multi-hop cross-path that never reaches the source', () => {
      // Siblings B,C,D,E under root with a cross-chain B→C→D. Linking
      // E→B is forward and non-cyclic: the acyclicity check runs
      // canReach(to=B, from=E)? — i.e. "does B reach E?" — and BFS from
      // B traverses B→C (≠E), C→D (≠E), exhausts without finding E, so
      // the edge is accepted. This forces the reachability search to
      // visit MULTIPLE non-target nodes before returning false (the
      // continue-BFS path), not just short-circuit on the first hop.
      const tree = createTree();
      const b = addChild(tree, 0);
      const c = addChild(tree, 0);
      const d = addChild(tree, 0);
      const e = addChild(tree, 0);
      expect(addCrossEdge(tree, b, c)).not.toBeNull();
      expect(addCrossEdge(tree, c, d)).not.toBeNull();
      // E→B: canReach(B, E) walks B→C→D, none is E → accept.
      expect(validateCrossEdge(tree, e, b)).toEqual({ok: true});
      expect(addCrossEdge(tree, e, b)).toEqual({from: e, to: b});
    });
  });

  describe('deleteCrossEdge (F-DAG-2-FR4)', () => {
    it('removes a matching edge and returns true; second removal returns false', () => {
      const tree = createTree();
      const b = addChild(tree, 0);
      const d = addChild(tree, 0);
      addCrossEdge(tree, b, d);
      expect(tree.crossEdges).toHaveLength(1);

      expect(deleteCrossEdge(tree, b, d)).toBe(true);
      expect(tree.crossEdges).toHaveLength(0);
      // Nothing left to remove.
      expect(deleteCrossEdge(tree, b, d)).toBe(false);
    });

    it('returns false for a pair that was never an edge', () => {
      const tree = createTree();
      const b = addChild(tree, 0);
      const d = addChild(tree, 0);
      expect(deleteCrossEdge(tree, b, d)).toBe(false);
      // Direction matters: deleting the reverse of an existing edge is a
      // no-op (edges are directed).
      addCrossEdge(tree, b, d);
      expect(deleteCrossEdge(tree, d, b)).toBe(false);
      expect(tree.crossEdges).toHaveLength(1);
    });
  });

  describe('reachability over a larger graph (F-DAG-2-FR2)', () => {
    it('rejects a long transitive loop, accepts a parallel non-looping edge', () => {
      // A 13-node graph: a root chain plus a fan, with cross-edges that
      // build a long forward path, then assert a back-edge that closes
      // the loop is rejected while a forward edge is accepted.
      const tree = createTree(); // 0
      // Linear-ish backbone: 0 → 1 → 2 → 3 → 4.
      const n1 = addChild(tree, 0);
      const n2 = addChild(tree, n1);
      const n3 = addChild(tree, n2);
      const n4 = addChild(tree, n3);
      // A separate fan under root: 0 → {5,6,7,8}.
      const f5 = addChild(tree, 0);
      const f6 = addChild(tree, 0);
      const f7 = addChild(tree, 0);
      const f8 = addChild(tree, 0);
      // Grandchildren to push past 10 nodes: 9,10,11,12 under the fan.
      addChild(tree, f5);
      addChild(tree, f6);
      addChild(tree, f7);
      addChild(tree, f8);
      expect(tree.nodesById.size).toBe(13);

      // Cross-edges weaving a forward path across the fan and into the
      // backbone tail: f5 → f6 → f7 → n4.
      expect(addCrossEdge(tree, f5, f6)).not.toBeNull();
      expect(addCrossEdge(tree, f6, f7)).not.toBeNull();
      expect(addCrossEdge(tree, f7, n4)).not.toBeNull();

      // A back-edge from the backbone tail to the path head closes a
      // long transitive loop (n4 → ... ⇒ f5 already reaches n4 via the
      // cross-path AND n4's ancestor 0 reaches f5) → cycle.
      // Concretely: canReach(to=f5, from=n4)? f5 reaches n4 via the
      // cross-path, but we need n4 ⇒ f5. n4's only outgoing are none
      // (leaf), so the cycle must be detected the other way: linking
      // n4→f5 means canReach(f5, n4) — f5 reaches n4 via f5→f6→f7→n4,
      // so the candidate n4→f5 would let n4 reach f5 and f5 reach n4.
      expect(validateCrossEdge(tree, n4, f5)).toEqual({
        ok: false,
        reason: 'cycle',
      });

      // A parallel forward edge that does NOT close a loop is accepted:
      // f8 → n4 (f8 has no inbound from n4's reachable set).
      expect(validateCrossEdge(tree, f8, n4)).toEqual({ok: true});
      expect(addCrossEdge(tree, f8, n4)).toEqual({from: f8, to: n4});
    });
  });
});
