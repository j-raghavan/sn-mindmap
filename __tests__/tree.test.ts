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
  addSibling,
  cloneTree,
  createTree,
  deleteSubtree,
  flattenForEmit,
  setCollapsed,
  setLabel,
  shapeForDepth,
  ShapeKind,
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
});
