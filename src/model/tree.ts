/**
 * Mindmap tree model — immutable-style mutations operating on a mutable
 * Tree object passed by reference.
 *
 * Design notes:
 *   - NodeId is a plain integer so it serialises cheaply into the 2-byte
 *     marker record format (§6.3).  The root always has id 0; subsequent
 *     nodes get monotonically increasing ids from `tree.nextId`.
 *   - Mutations are applied in-place (the caller owns the Tree and clones
 *     it via cloneTree() before passing it to the React reducer if needed).
 *   - Collapse state is a UI concern; flattenForEmit always traverses the
 *     full tree regardless (§F-IN-2: "auto-expand on insert").
 *
 * References: §F-AC-2, §F-AC-3, §F-AC-5, §4.2, §4.3, §6.3, §F-IN-2.
 */

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/**
 * Numeric node identifier.  Root is always 0; subsequent nodes receive
 * strictly increasing integers from Tree.nextId.  Values ≤ 0xFFFF (65535)
 * to fit in the 2-byte marker field (§6.3).
 */
export type NodeId = number;

/**
 * Shape of a node's outline — also the wire byte stored in the marker
 * record (§6.3).  Do NOT renumber: the decoder depends on these exact values.
 */
export enum ShapeKind {
  /** Root node.  Oval / ellipse outline. (§F-AC-2) */
  OVAL = 0x00,
  /** Child node added via "Add Child".  Rectangle outline. (§F-AC-3) */
  RECTANGLE = 0x01,
  /** Sibling node added via "Add Sibling".  Rounded-rectangle. (§F-AC-3) */
  ROUNDED_RECTANGLE = 0x02,
}

/** A single node in the mindmap. */
export interface MindmapNode {
  id: NodeId;
  parentId: NodeId | null; // null only for the root
  childIds: NodeId[];
  shape: ShapeKind;
  /** True when the subtree below this node is hidden in the authoring canvas. */
  collapsed: boolean;
}

/**
 * The full mindmap tree.  Mutated in-place by the functions below; use
 * cloneTree() to create an independent copy before mutation when the
 * original must remain unchanged (e.g. inside a React reducer).
 */
export interface Tree {
  rootId: NodeId; // always 0
  /** All nodes keyed by their id. */
  nodesById: Map<NodeId, MindmapNode>;
  /** Next id to assign.  Starts at 1 (root consumed 0). */
  nextId: number;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function getNode(tree: Tree, id: NodeId, context: string): MindmapNode {
  const node = tree.nodesById.get(id);
  if (!node) {
    throw new Error(`[tree] unknown node ${id} in ${context}`);
  }
  return node;
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Create a fresh tree containing only the root Oval node (§F-AC-2).
 */
export function createTree(): Tree {
  const root: MindmapNode = {
    id: 0,
    parentId: null,
    childIds: [],
    shape: ShapeKind.OVAL,
    collapsed: false,
  };
  return {
    rootId: 0,
    nodesById: new Map([[0, root]]),
    nextId: 1,
  };
}

/**
 * Add a Rectangle child under `parentId` and return the new node's id.
 * Appends to the end of the parent's childIds list (§F-AC-3).
 *
 * @throws if `parentId` does not exist in the tree.
 */
export function addChild(tree: Tree, parentId: NodeId): NodeId {
  const parent = getNode(tree, parentId, 'addChild');
  const id = tree.nextId++;
  const child: MindmapNode = {
    id,
    parentId,
    childIds: [],
    shape: ShapeKind.RECTANGLE,
    collapsed: false,
  };
  tree.nodesById.set(id, child);
  parent.childIds.push(id);
  return id;
}

/**
 * Add a Rounded-Rectangle sibling immediately after `nodeId` in the
 * parent's childIds list and return the new node's id (§F-AC-3).
 *
 * @throws if `nodeId` is the root (no parent) or does not exist.
 */
export function addSibling(tree: Tree, nodeId: NodeId): NodeId {
  const node = getNode(tree, nodeId, 'addSibling');
  if (node.parentId === null) {
    throw new Error('[tree] cannot add a sibling to the root');
  }
  const parent = getNode(tree, node.parentId, 'addSibling/parent');
  const id = tree.nextId++;
  const sibling: MindmapNode = {
    id,
    parentId: node.parentId,
    childIds: [],
    shape: ShapeKind.ROUNDED_RECTANGLE,
    collapsed: false,
  };
  tree.nodesById.set(id, sibling);
  const idx = parent.childIds.indexOf(nodeId);
  parent.childIds.splice(idx + 1, 0, id);
  return id;
}

/**
 * Delete the subtree rooted at `nodeId` (inclusive) and return the Set of
 * all removed ids (§4.3, §F-AC-5).
 *
 * @throws if `nodeId` is the root or does not exist.
 */
export function deleteSubtree(tree: Tree, nodeId: NodeId): Set<NodeId> {
  const node = getNode(tree, nodeId, 'deleteSubtree');
  if (node.parentId === null) {
    throw new Error('[tree] cannot delete the root');
  }

  // Collect all ids in the subtree via BFS.
  const removed = new Set<NodeId>();
  const queue: NodeId[] = [nodeId];
  while (queue.length > 0) {
    const current = queue.shift()!;
    removed.add(current);
    const n = tree.nodesById.get(current)!;
    for (const c of n.childIds) {
      queue.push(c);
    }
  }

  // Remove from parent's childIds.
  const parent = getNode(tree, node.parentId, 'deleteSubtree/parent');
  parent.childIds = parent.childIds.filter(c => c !== nodeId);

  // Remove all collected nodes from the map.
  for (const id of removed) {
    tree.nodesById.delete(id);
  }

  return removed;
}

/**
 * Set the collapsed state of `nodeId` (§F-AC-5, §4.2).
 * Silently ignores the call when `nodeId` has no children (leaves cannot
 * be collapsed — the toggle icon is hidden for them in the canvas).
 *
 * @throws if `nodeId` does not exist.
 */
export function setCollapsed(
  tree: Tree,
  nodeId: NodeId,
  collapsed: boolean,
): void {
  const node = getNode(tree, nodeId, 'setCollapsed');
  if (node.childIds.length === 0) {
    return; // no-op for leaves
  }
  node.collapsed = collapsed;
}

/**
 * Return all nodes in pre-order depth-first traversal, regardless of
 * collapse state (§F-IN-2: the insert pipeline auto-expands everything).
 * The root is always index 0, matching the §6.3 marker-record offset
 * convention.
 */
export function flattenForEmit(tree: Tree): MindmapNode[] {
  const result: MindmapNode[] = [];
  // Pre-order DFS: push children in REVERSE so the leftmost child is
  // popped first, matching the "root → child₀ → grandchildren → child₁ …"
  // order required by §6.3 (record offset == pre-order index).
  const stack: NodeId[] = [tree.rootId];
  while (stack.length > 0) {
    const id = stack.pop()!;
    const node = tree.nodesById.get(id)!;
    result.push(node);
    for (let i = node.childIds.length - 1; i >= 0; i--) {
      stack.push(node.childIds[i]);
    }
  }
  return result;
}

/**
 * Produce a deep clone of `tree` that shares no object references with
 * the original.  The clone's `nextId` is preserved so it can continue
 * allocating fresh ids independently.
 */
export function cloneTree(tree: Tree): Tree {
  const nodesById = new Map<NodeId, MindmapNode>();
  for (const [id, node] of tree.nodesById) {
    nodesById.set(id, {
      ...node,
      childIds: [...node.childIds],
    });
  }
  return {
    rootId: tree.rootId,
    nodesById,
    nextId: tree.nextId,
  };
}
