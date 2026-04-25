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
 * Shape of a node's outline. Drives both the on-canvas rendering and
 * the polygon points emitted on Insert.
 *
 * v1.0 assigns shape by tree DEPTH rather than by the gesture used
 * to create the node — siblings now match their layer instead of
 * always being a rounded rectangle. The depth → shape table:
 *
 *   depth 0 (central idea)        OVAL
 *   depth 1 (first-level child)   ROUNDED_RECTANGLE
 *   depth 2 (second-level child)  RECTANGLE
 *   depth ≥ 3                     PARALLELOGRAM
 *
 * The numeric values stay stable across releases — earlier marker /
 * decoder code relied on them and even though the marker pipeline is
 * gone today, keeping the values fixed lets us re-introduce a decoder
 * later without renumbering. Do NOT change these numbers.
 */
export enum ShapeKind {
  /** Central idea (root). Oval / stadium outline. */
  OVAL = 0x00,
  /** Second-level (depth 2) child. Rectangle outline. */
  RECTANGLE = 0x01,
  /** First-level (depth 1) child. Rounded-rectangle outline. */
  ROUNDED_RECTANGLE = 0x02,
  /** Third-level (depth ≥ 3) descendant. Parallelogram outline. */
  PARALLELOGRAM = 0x03,
}

/**
 * v1.0 shape-by-depth table (see ShapeKind doc). Pure helper —
 * hand back the right ShapeKind for the depth the new node will
 * sit at. Depths beyond 3 fall through to PARALLELOGRAM so deep
 * sub-trees stay visually consistent.
 */
export function shapeForDepth(depth: number): ShapeKind {
  switch (depth) {
    case 0:
      return ShapeKind.OVAL;
    case 1:
      return ShapeKind.ROUNDED_RECTANGLE;
    case 2:
      return ShapeKind.RECTANGLE;
    default:
      return ShapeKind.PARALLELOGRAM;
  }
}

/**
 * Walk parent links from `nodeId` up to the root; return how many
 * hops it took. Root → 0, root's children → 1, grandchildren → 2,
 * etc. Used by addChild / addSibling to pick the new node's shape
 * via shapeForDepth.
 *
 * @throws if `nodeId` doesn't exist.
 */
export function nodeDepth(tree: Tree, nodeId: NodeId): number {
  let depth = 0;
  let current: MindmapNode | undefined = getNode(tree, nodeId, 'nodeDepth');
  while (current && current.parentId !== null) {
    depth += 1;
    current = tree.nodesById.get(current.parentId);
  }
  return depth;
}

/** A single node in the mindmap. */
export interface MindmapNode {
  id: NodeId;
  parentId: NodeId | null; // null only for the root
  childIds: NodeId[];
  shape: ShapeKind;
  /** True when the subtree below this node is hidden in the authoring canvas. */
  collapsed: boolean;
  /**
   * Optional label rendered inside the node's outline and emitted as a
   * TYPE_TEXT element on Insert. Undefined / empty means an unlabeled
   * node — the authoring canvas still renders its outline so the user
   * can navigate the tree, but no text appears inside it.
   */
  label?: string;
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
 * The optional `label` argument seeds the root's text; omit it to
 * create an unlabeled root (the authoring canvas opens the label
 * modal automatically when the root is unlabeled).
 */
export function createTree(label?: string): Tree {
  const root: MindmapNode = {
    id: 0,
    parentId: null,
    childIds: [],
    shape: ShapeKind.OVAL,
    collapsed: false,
    label,
  };
  return {
    rootId: 0,
    nodesById: new Map([[0, root]]),
    nextId: 1,
  };
}

/**
 * Add a child under `parentId` and return the new node's id.
 * Appends to the end of the parent's childIds list. The optional
 * `label` argument seeds the child's text. The new child's shape
 * is picked from shapeForDepth(parentDepth + 1) — ROUNDED_RECTANGLE
 * for the root's direct children, RECTANGLE for grand-children,
 * PARALLELOGRAM for everything deeper.
 *
 * @throws if `parentId` does not exist in the tree.
 */
export function addChild(
  tree: Tree,
  parentId: NodeId,
  label?: string,
): NodeId {
  const parent = getNode(tree, parentId, 'addChild');
  const id = tree.nextId++;
  const child: MindmapNode = {
    id,
    parentId,
    childIds: [],
    shape: shapeForDepth(nodeDepth(tree, parentId) + 1),
    collapsed: false,
    label,
  };
  tree.nodesById.set(id, child);
  parent.childIds.push(id);
  return id;
}

/**
 * Add a sibling immediately after `nodeId` in the parent's childIds
 * list and return the new node's id. The optional `label` argument
 * seeds the sibling's text. Siblings sit at the same depth as the
 * tapped node, so the new sibling's shape matches `nodeId`'s shape
 * via shapeForDepth(nodeDepth(nodeId)).
 *
 * @throws if `nodeId` is the root (no parent) or does not exist.
 */
export function addSibling(
  tree: Tree,
  nodeId: NodeId,
  label?: string,
): NodeId {
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
    shape: shapeForDepth(nodeDepth(tree, nodeId)),
    collapsed: false,
    label,
  };
  tree.nodesById.set(id, sibling);
  const idx = parent.childIds.indexOf(nodeId);
  parent.childIds.splice(idx + 1, 0, id);
  return id;
}

/**
 * Set or update the label of `nodeId`. Empty / undefined labels are
 * stored as undefined (the authoring canvas treats an empty string
 * the same as no label).
 *
 * @throws if `nodeId` does not exist.
 */
export function setLabel(
  tree: Tree,
  nodeId: NodeId,
  label: string | undefined,
): void {
  const node = getNode(tree, nodeId, 'setLabel');
  const trimmed = label?.trim();
  node.label = trimmed && trimmed.length > 0 ? trimmed : undefined;
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
