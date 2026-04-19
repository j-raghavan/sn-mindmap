/**
 * Mindmap tree model and mutators.
 *
 * Tree identity: each node has an integer id that is its index in the
 * flat records array at encode time (§6.3). The root is always id=0
 * with parentId=null. Ids are stable for the lifetime of an authoring
 * session; the marker records (§6.3) do NOT carry node ids — identity
 * on decode is "position in the records array".
 *
 * Shape-by-creation-action (§F-AC-3):
 *   root               -> OVAL              (shape kind 0x00)
 *   added via addChild -> RECTANGLE         (shape kind 0x01)
 *   added via addSibling-> ROUNDED_RECTANGLE (shape kind 0x02)
 *
 * Collapse state is authoring-time only (§4.2 / §8.6). It lives on
 * nodes here but is intentionally NOT carried into the marker
 * records — at Insert time the tree is fully expanded (§F-IN-2).
 *
 * Mutators in this module mutate the passed `Tree` in place and
 * return whatever information the caller needs (new id, removed ids,
 * etc.). The authoring canvas uses `cloneTree` before dispatching
 * into a reducer so the reducer stays pure from the outside even
 * though the helpers here are imperative.
 */

export type NodeId = number;

/**
 * Shape kind byte enum per §6.3 "Shape-kind enum" and §F-AC-3.
 * Numeric values are the wire bytes used by the marker encoder;
 * do not renumber.
 */
export enum ShapeKind {
  OVAL = 0x00,
  RECTANGLE = 0x01,
  ROUNDED_RECTANGLE = 0x02,
}

export type MindmapNode = {
  id: NodeId;
  parentId: NodeId | null;
  shape: ShapeKind;
  /** Ordered child ids. Order determines radial-slice assignment (§F-LY-3). */
  childIds: NodeId[];
  /**
   * Authoring-time only. Expand/collapse UI affordance per §F-AC-5
   * and §4.2. Never persisted — §F-IN-2 auto-expands before emit.
   */
  collapsed: boolean;
};

export type Tree = {
  /** Always 0 — the root node id. Kept explicit for readability. */
  rootId: NodeId;
  nodesById: Map<NodeId, MindmapNode>;
  /** Monotonic id allocator. Next id handed out by allocateId. */
  nextId: NodeId;
};

/** Create a fresh tree with only the root Oval (id=0). */
export function createTree(): Tree {
  const root: MindmapNode = {
    id: 0,
    parentId: null,
    shape: ShapeKind.OVAL,
    childIds: [],
    collapsed: false,
  };
  return {
    rootId: 0,
    nodesById: new Map([[0, root]]),
    nextId: 1,
  };
}

/**
 * Deep-clone a tree so the caller can mutate the clone without
 * affecting the original. Used by the authoring canvas reducer to
 * keep dispatch pure even though the mutators below work in place.
 */
export function cloneTree(tree: Tree): Tree {
  const cloned = new Map<NodeId, MindmapNode>();
  for (const [id, node] of tree.nodesById) {
    cloned.set(id, {
      id: node.id,
      parentId: node.parentId,
      shape: node.shape,
      childIds: node.childIds.slice(),
      collapsed: node.collapsed,
    });
  }
  return {
    rootId: tree.rootId,
    nodesById: cloned,
    nextId: tree.nextId,
  };
}

/**
 * Look up a node; throw if missing. Internal helper to keep the
 * mutator bodies small.
 */
function mustGet(tree: Tree, id: NodeId): MindmapNode {
  const node = tree.nodesById.get(id);
  if (!node) {
    throw new Error(`tree: unknown node id ${id}`);
  }
  return node;
}

/**
 * Allocate a fresh node, register it in `nodesById`, and return its
 * id. Shared by addChild / addSibling — they differ only in the
 * shape byte and in how the new id is linked into the parent's
 * childIds, so the allocation bookkeeping lives here.
 */
function allocateNode(
  tree: Tree,
  parentId: NodeId,
  shape: ShapeKind,
): NodeId {
  const id = tree.nextId;
  tree.nextId += 1;
  tree.nodesById.set(id, {
    id,
    parentId,
    shape,
    childIds: [],
    collapsed: false,
  });
  return id;
}

/**
 * Add a RECTANGLE child to `parentId`. Returns the new node id.
 * Per §F-AC-3, shape is determined by the creating action, not by
 * depth.
 */
export function addChild(tree: Tree, parentId: NodeId): NodeId {
  const parent = mustGet(tree, parentId);
  const id = allocateNode(tree, parentId, ShapeKind.RECTANGLE);
  parent.childIds.push(id);
  return id;
}

/**
 * Add a ROUNDED_RECTANGLE sibling next to `nodeId` (a child of
 * nodeId's parent, inserted immediately after nodeId in the
 * parent's childIds). Root has no siblings; calling this on the
 * root throws per §F-AC-5 (Add Sibling is hidden, not disabled, so
 * reaching this code path is a programming error).
 */
export function addSibling(tree: Tree, nodeId: NodeId): NodeId {
  const pivot = mustGet(tree, nodeId);
  if (pivot.parentId === null) {
    throw new Error('tree: addSibling on root is forbidden (§F-AC-5)');
  }
  const parent = mustGet(tree, pivot.parentId);
  const id = allocateNode(tree, pivot.parentId, ShapeKind.ROUNDED_RECTANGLE);
  const pivotIdx = parent.childIds.indexOf(nodeId);
  // pivotIdx cannot be -1 — parent.childIds is the source of truth
  // for parent/child linkage. If we ever find it missing, the tree
  // is corrupt; surface loudly rather than appending silently.
  if (pivotIdx < 0) {
    throw new Error(
      `tree: inconsistent state — node ${nodeId} not found in parent ${pivot.parentId}.childIds`,
    );
  }
  parent.childIds.splice(pivotIdx + 1, 0, id);
  return id;
}

/**
 * Delete the subtree rooted at `nodeId`. Deleting the root is
 * forbidden (§4.3, §F-AC-5). Returns the set of removed node ids so
 * callers (e.g. emit time) can drop associated label strokes.
 */
export function deleteSubtree(tree: Tree, nodeId: NodeId): Set<NodeId> {
  const target = mustGet(tree, nodeId);
  if (target.parentId === null) {
    throw new Error('tree: cannot delete root (§4.3, §F-AC-5)');
  }
  const removed = new Set<NodeId>();
  // Iterative DFS to avoid recursion depth surprises on pathological
  // trees. Order does not matter — callers only care about set
  // membership.
  const stack: NodeId[] = [nodeId];
  while (stack.length > 0) {
    const id = stack.pop() as NodeId;
    const node = tree.nodesById.get(id);
    if (!node) {
      continue;
    }
    removed.add(id);
    for (const childId of node.childIds) {
      stack.push(childId);
    }
    tree.nodesById.delete(id);
  }
  // Unlink from parent.
  const parent = mustGet(tree, target.parentId);
  const idx = parent.childIds.indexOf(nodeId);
  if (idx >= 0) {
    parent.childIds.splice(idx, 1);
  }
  return removed;
}

/**
 * Set collapsed state. Any node with ≥ 1 child may be collapsed
 * (§F-AC-5, §4.2) regardless of whether those children came from
 * addChild or addSibling. Calling this on a leaf is a no-op so UI
 * handlers can dispatch speculatively without guard races.
 */
export function setCollapsed(
  tree: Tree,
  nodeId: NodeId,
  collapsed: boolean,
): void {
  const node = mustGet(tree, nodeId);
  if (node.childIds.length === 0) {
    // Leaf: no-op. §F-AC-5 says the toggle is hidden on leaves; if
    // we somehow get here, silently ignoring is safer than throwing
    // from a UI callback.
    return;
  }
  node.collapsed = collapsed;
}

/**
 * Produce a fully-expanded flat pre-order traversal of the tree.
 * Used by the marker encoder (§6.2 / §6.3) which expects node index
 * in the traversal to equal the node's record offset. Collapsed
 * subtrees are still emitted — §F-IN-2 auto-expansion at Insert
 * time.
 *
 * Order is depth-first, visiting children in their `childIds`
 * order, starting from the root. The root is always index 0, which
 * matches the §6.3 wire-format requirement.
 */
export function flattenForEmit(tree: Tree): MindmapNode[] {
  const out: MindmapNode[] = [];
  const stack: NodeId[] = [tree.rootId];
  while (stack.length > 0) {
    const id = stack.pop() as NodeId;
    const node = mustGet(tree, id);
    out.push(node);
    // Push children in reverse so the top-of-stack is the first
    // child — this gives us left-to-right pre-order.
    for (let i = node.childIds.length - 1; i >= 0; i -= 1) {
      stack.push(node.childIds[i]);
    }
  }
  return out;
}
