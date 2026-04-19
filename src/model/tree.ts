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
 * Phase 1 (§9) fills in the mutator bodies; Phase 3 (marker) reads
 * this shape verbatim when encoding.
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
 * Add a RECTANGLE child to `parentId`. Returns the new node id.
 * Per §F-AC-3, shape is determined by the creating action, not by
 * depth.
 *
 * TODO(Phase 1): implement. Must:
 *   - reject if parentId does not exist
 *   - allocate id from tree.nextId
 *   - push id onto parent's childIds
 *   - insert into nodesById
 */
export function addChild(_tree: Tree, _parentId: NodeId): NodeId {
  throw new Error('TODO(Phase 1, §F-AC-3): addChild not implemented');
}

/**
 * Add a ROUNDED_RECTANGLE sibling next to `nodeId` (i.e. a child of
 * nodeId's parent, inserted after nodeId in the parent's childIds).
 * Root has no siblings; calling this on the root must throw per
 * §F-AC-5 (Add Sibling is hidden, not disabled).
 *
 * TODO(Phase 1): implement.
 */
export function addSibling(_tree: Tree, _nodeId: NodeId): NodeId {
  throw new Error('TODO(Phase 1, §F-AC-3): addSibling not implemented');
}

/**
 * Delete the subtree rooted at `nodeId`. Deleting the root is
 * forbidden (§4.3, §F-AC-5). Returns the set of removed node ids so
 * callers (e.g. emit time) can drop associated label strokes.
 *
 * TODO(Phase 1): implement.
 */
export function deleteSubtree(_tree: Tree, _nodeId: NodeId): Set<NodeId> {
  throw new Error('TODO(Phase 1, §4.3): deleteSubtree not implemented');
}

/**
 * Set collapsed state. Any node with ≥ 1 child may be collapsed
 * (§F-AC-5, §4.2) regardless of whether those children came from
 * addChild or addSibling. Leaves cannot be collapsed — enforce or
 * no-op, caller's choice, TBD in Phase 1.
 */
export function setCollapsed(
  _tree: Tree,
  _nodeId: NodeId,
  _collapsed: boolean,
): void {
  throw new Error('TODO(Phase 1, §4.2): setCollapsed not implemented');
}

/**
 * Produce a fully-expanded flat pre-order traversal of the tree.
 * Used by the marker encoder (§6.2 / §6.3) which expects node index
 * in the traversal to equal the node's record offset. Collapsed
 * subtrees are still emitted — §F-IN-2 auto-expansion at Insert
 * time.
 *
 * TODO(Phase 1): implement.
 */
export function flattenForEmit(_tree: Tree): MindmapNode[] {
  throw new Error('TODO(Phase 1, §F-IN-2): flattenForEmit not implemented');
}
