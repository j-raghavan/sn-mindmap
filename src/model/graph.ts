/**
 * Concept-map (DAG) graph model — the second authoring mode's data
 * model, parallel to the mindmap `Tree` in tree.ts (§14.3).
 *
 * Design notes:
 *   - This is a SIBLING file to tree.ts; tree.ts is left untouched so the
 *     v1.0 mindmap path stays byte-identical and well-tested. The two
 *     models share only NodeId / ShapeKind, imported from tree.ts
 *     (REUSE-FIRST; do not redefine them here).
 *   - SHAPE RULE (architect's call): a force-directed DAG has no canonical
 *     depth, so concept nodes do NOT use the mindmap's shapeForDepth table.
 *     A node is OVAL iff it has no parents (a root or an orphan), else
 *     RECTANGLE. Shape is a PURE FUNCTION OF STRUCTURE, COMPUTED ON READ via
 *     conceptShape(node) — it is NOT stored on ConceptNode, so it can never
 *     go stale as edges are added/removed. The canvas render and
 *     emitConceptGeometries call conceptShape() at the point they need a
 *     shape; mutators never touch a shape field. A node's shape therefore
 *     "flips" OVAL↔RECTANGLE the instant its parent count crosses zero —
 *     intended and deterministic.
 *   - A concept node has 0..N parents and 0..N children — a DAG, not a
 *     tree. childIds is a structural MIRROR of parentIds across the graph:
 *     every mutator keeps `parent.childIds ∋ child  ⟺  child.parentIds ∋
 *     parent` so either direction can be walked in O(1) per node.
 *   - Mutations are applied in-place (the caller owns the Graph and clones
 *     it via cloneGraph() before passing it to a React reducer if needed),
 *     mirroring tree.ts's in-place style.
 *   - Acyclicity is enforced at the addParentEdge boundary via
 *     validateParentEdge (the "link to existing" gesture is the only path
 *     that can close a cycle — addNodeWithParent / addNodeAsParent mint a
 *     FRESH node, which can never cycle or duplicate).
 *   - deleteNode is SINGLE-NODE and orphan-aware (§14.4 F-AC-DAG-4): it
 *     drops the node from every neighbour's mirror list but does NOT
 *     cascade-delete its children (they may have other parents, or be
 *     intentionally orphaned). This is a deliberate divergence from
 *     tree.ts's deleteSubtree.
 *
 * References: §14.3, §14.4, §F-AC-DAG-1..F-AC-DAG-5, §F-LY-DAG-*.
 */

import {ShapeKind, type NodeId} from './tree';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/**
 * A single node in the concept-map DAG (§14.3). Shape is intentionally
 * NOT a field — it is derived from parentIds via conceptShape(node) at
 * read time, so it can never disagree with the structure.
 */
export interface ConceptNode {
  id: NodeId;
  /** 0..N parents; root(s) and orphans have an empty list. */
  parentIds: NodeId[];
  /** Structural mirror of parentIds across the graph; kept symmetric. */
  childIds: NodeId[];
  /**
   * Optional label rendered inside the node's outline and emitted as a
   * TYPE_TEXT element on Insert. Undefined / empty means an unlabeled
   * node (same semantics as MindmapNode.label).
   */
  label?: string;
}

/**
 * The full concept-map graph. Mutated in-place by the functions below;
 * use cloneGraph() to create an independent copy before mutation when the
 * original must remain unchanged (e.g. inside a React reducer).
 */
export interface Graph {
  /**
   * The first-created node (the central idea). May become null after the
   * root is deleted — concept maps may have zero or many roots, so rootId
   * is advisory (used to seed the canvas), not a structural invariant.
   */
  rootId: NodeId | null;
  /** All nodes keyed by their id. */
  nodesById: Map<NodeId, ConceptNode>;
  /** Next id to assign. Starts at 1 (root consumed 0). */
  nextId: number;
}

/**
 * Typed rejection reason for a parent edge that fails validation
 * (mirrors tree.ts's CrossEdgeRejection idiom). There is no 'tree-edge'
 * reason here: unlike the mindmap's tree backbone + cross-edge overlay,
 * the concept graph has a single edge set (parentIds/childIds ARE the
 * edges), so a "duplicate existing branch" collapses into 'duplicate'.
 */
export type ParentEdgeRejection =
  | 'self-loop' // childId === parentId (rule 2)
  | 'duplicate' // parentId already in childId.parentIds (rule 3)
  | 'cycle'; // adding parentId → childId would create a directed cycle (rule 4)

/**
 * Result of validating a candidate parent edge. Rule 1 (existence)
 * throws rather than returning a reason — a programmatic caller passing
 * a bad id is a bug, not a soft reject (consistent with getNode).
 */
export type ValidateParentEdgeResult =
  | {ok: true}
  | {ok: false; reason: ParentEdgeRejection};

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function getNode(graph: Graph, id: NodeId, context: string): ConceptNode {
  const node = graph.nodesById.get(id);
  if (!node) {
    throw new Error(`[graph] unknown node ${id} in ${context}`);
  }
  return node;
}

/**
 * True iff `target` is reachable from `start` by walking childIds only
 * (descendants). Iterative BFS, O(V+E) over the ≤ 50-node graph. Pure —
 * no mutation. The concept graph has a single edge set — the
 * parentIds/childIds mirror — so this walks childIds directly. A
 * visited-set guards against an (acyclicity-enforced) cycle so a
 * malformed graph can never infinite-loop here.
 */
function canReach(graph: Graph, start: NodeId, target: NodeId): boolean {
  const seen = new Set<NodeId>([start]);
  const queue: NodeId[] = [start];
  while (queue.length > 0) {
    const cur = queue.shift()!;
    const node = graph.nodesById.get(cur)!;
    for (const next of node.childIds) {
      if (next === target) {
        return true;
      }
      if (!seen.has(next)) {
        seen.add(next);
        queue.push(next);
      }
    }
  }
  return false;
}


// ---------------------------------------------------------------------------
// Public API — shape (derived), construction & mutation
// ---------------------------------------------------------------------------

/**
 * The ShapeKind for `node`, derived purely from its parent count
 * (architect's flat SHAPE RULE): a node with no parents is a root/orphan
 * and renders as an OVAL; any node with ≥ 1 parent renders as a
 * RECTANGLE. Pure — no traversal, no mutation. This is the single source
 * of truth for concept-node shape: the canvas render and
 * emitConceptGeometries call it at read time so the shape is never stored
 * and can never go stale as edges change.
 */
export function conceptShape(node: ConceptNode): ShapeKind {
  return node.parentIds.length === 0 ? ShapeKind.OVAL : ShapeKind.RECTANGLE;
}

/**
 * Create a fresh graph containing only the root node (§14.2 — the
 * central-idea modal seeds the document). The optional `label` seeds the
 * root's text. Mirrors createTree: root id 0, nextId 1. The root has no
 * parents, so conceptShape() reports it as OVAL.
 */
export function createGraph(label?: string): Graph {
  const root: ConceptNode = {
    id: 0,
    parentIds: [],
    childIds: [],
    label,
  };
  return {
    rootId: 0,
    nodesById: new Map([[0, root]]),
    nextId: 1,
  };
}

/**
 * Add a child under `parentId` (F-AC-DAG-1 "Add Child") and return the
 * new node's id. The new node has `parentId` as its sole parent, so
 * conceptShape() reports it as a RECTANGLE (≥ 1 parent). A fresh node can
 * neither cycle nor duplicate, so no validation beyond parent existence.
 *
 * @throws if `parentId` does not exist.
 */
export function addNodeWithParent(
  graph: Graph,
  parentId: NodeId,
  label?: string,
): NodeId {
  const parent = getNode(graph, parentId, 'addNodeWithParent');
  const id = graph.nextId++;
  const child: ConceptNode = {
    id,
    parentIds: [parentId],
    childIds: [],
    label,
  };
  graph.nodesById.set(id, child);
  parent.childIds.push(id);
  return id;
}

/**
 * Add a parent above `childId` (F-AC-DAG-2 "Add Parent", the dual of Add
 * Child) and return the new node's id. The new node has `childId` as its
 * sole child. Useful for the genealogy case (tap `son`, Add Parent twice
 * → `Father` and `Mother`). Adding a parent can make a former root a
 * non-root; rootId is left pointing at the original first node.
 *
 * A fresh node cannot cycle or duplicate, so no validation beyond child
 * existence. The new parent has no parents of its own, so conceptShape()
 * reports it as OVAL. The tapped `childId` GAINS a parent: if it was a
 * parentless OVAL (a root or orphan), conceptShape() now reports it as a
 * RECTANGLE — no field to update, since shape is derived on read.
 *
 * @throws if `childId` does not exist.
 */
export function addNodeAsParent(
  graph: Graph,
  childId: NodeId,
  label?: string,
): NodeId {
  const child = getNode(graph, childId, 'addNodeAsParent');
  const id = graph.nextId++;
  const parent: ConceptNode = {
    id,
    parentIds: [],
    childIds: [childId],
    label,
  };
  graph.nodesById.set(id, parent);
  child.parentIds.push(id);
  return id;
}

/**
 * Validate a candidate parent edge `parentId → childId` against the
 * rules, IN ORDER (§14.3 — the "link to existing" gesture, F-AC-DAG-3).
 * Pure (no mutation). Rule 1 (existence) THROWS via getNode — a
 * programmatic caller passing a bad id is a bug, not a soft reject
 * (CLAUDE.md "validate at boundaries"). Rules 2–4 return a typed
 * rejection so the UI can show a reason.
 */
export function validateParentEdge(
  graph: Graph,
  childId: NodeId,
  parentId: NodeId,
): ValidateParentEdgeResult {
  // Rule 1 — existence (HARD: throws, consistent with getNode contract).
  const child = getNode(graph, childId, 'validateParentEdge/child');
  getNode(graph, parentId, 'validateParentEdge/parent');
  // Rule 2 — self-loop.
  if (childId === parentId) {
    return {ok: false, reason: 'self-loop'};
  }
  // Rule 3 — duplicate: the edge already exists.
  if (child.parentIds.includes(parentId)) {
    return {ok: false, reason: 'duplicate'};
  }
  // Rule 4 — acyclic: adding parentId → childId closes a cycle iff
  // `parentId` is already a DESCENDANT of `childId` (reachable by walking
  // childIds from the child). Reject in that case.
  if (canReach(graph, childId, parentId)) {
    return {ok: false, reason: 'cycle'};
  }
  return {ok: true};
}

/**
 * Add a validated parent edge `parentId → childId` (F-AC-DAG-3 "Link to
 * existing"). Returns true on success, false on any soft rejection
 * (rules 2–4); existence failures (rule 1) throw via validateParentEdge.
 * Keeps the childIds/parentIds mirror symmetric. Delegates ALL validation
 * to validateParentEdge so the model boundary is the single source of
 * truth — no forked rule logic. Shape is derived on read (conceptShape),
 * so gaining a parent automatically reports the child as RECTANGLE — no
 * field to update here.
 */
export function addParentEdge(
  graph: Graph,
  childId: NodeId,
  parentId: NodeId,
): boolean {
  const result = validateParentEdge(graph, childId, parentId);
  if (!result.ok) {
    return false;
  }
  const child = getNode(graph, childId, 'addParentEdge/child');
  const parent = getNode(graph, parentId, 'addParentEdge/parent');
  child.parentIds.push(parentId);
  parent.childIds.push(childId);
  return true;
}

/**
 * Remove the parent edge `parentId → childId`, keeping the mirror
 * symmetric. Returns true iff an edge existed. Shape is derived on read
 * (conceptShape): losing its last parent makes the child report as OVAL
 * again (an orphan/root) — no field to update here.
 *
 * @throws if either id does not exist.
 */
export function removeParentEdge(
  graph: Graph,
  childId: NodeId,
  parentId: NodeId,
): boolean {
  const child = getNode(graph, childId, 'removeParentEdge/child');
  const parent = getNode(graph, parentId, 'removeParentEdge/parent');
  const hadEdge = child.parentIds.includes(parentId);
  if (!hadEdge) {
    return false;
  }
  child.parentIds = child.parentIds.filter(p => p !== parentId);
  parent.childIds = parent.childIds.filter(c => c !== childId);
  return true;
}

/**
 * Set or update the label of `nodeId`. Empty / undefined labels are
 * stored as undefined. Identical semantics to tree.setLabel.
 *
 * @throws if `nodeId` does not exist.
 */
export function setLabel(
  graph: Graph,
  nodeId: NodeId,
  label: string | undefined,
): void {
  const node = getNode(graph, nodeId, 'setLabel');
  const trimmed = label?.trim();
  node.label = trimmed && trimmed.length > 0 ? trimmed : undefined;
}

/**
 * Delete a SINGLE node (F-AC-DAG-4) — NOT a subtree. Removes `nodeId`
 * from every parent's childIds and every child's parentIds (keeping the
 * mirror symmetric), then drops the node from the map. Children that lose
 * their last parent become orphans (parentIds empty) but are NOT
 * cascade-deleted — they may be intentionally orphaned or carry other
 * structure (§14.3/§14.4). A child that loses its last parent simply
 * reports as OVAL again via conceptShape() — there is no stored shape to
 * update.
 *
 * If the deleted node was the advisory root, rootId is set to null
 * (concept maps tolerate zero roots; the canvas re-seeds on next create).
 *
 * @throws if `nodeId` does not exist.
 */
export function deleteNode(graph: Graph, nodeId: NodeId): void {
  const node = getNode(graph, nodeId, 'deleteNode');

  for (const parentId of node.parentIds) {
    // Non-null: parentIds/childIds are kept a symmetric mirror by every
    // mutator, so each parentId is always a live node — same invariant
    // idiom as tree.ts (deleteSubtree/canReach/flattenForEmit).
    const parent = graph.nodesById.get(parentId)!;
    parent.childIds = parent.childIds.filter(c => c !== nodeId);
  }
  for (const childId of node.childIds) {
    // Non-null by the same mirror invariant (every childId is live).
    const child = graph.nodesById.get(childId)!;
    child.parentIds = child.parentIds.filter(p => p !== nodeId);
  }

  graph.nodesById.delete(nodeId);
  if (graph.rootId === nodeId) {
    graph.rootId = null;
  }
}

/**
 * Produce a deep clone of `graph` that shares no object references with
 * the original (mirrors cloneTree). nextId and rootId are preserved so
 * the clone keeps allocating fresh ids independently and the reducer's
 * edge/node mutations stay isolated from the caller's reference.
 */
export function cloneGraph(graph: Graph): Graph {
  const nodesById = new Map<NodeId, ConceptNode>();
  for (const [id, node] of graph.nodesById) {
    nodesById.set(id, {
      ...node,
      parentIds: [...node.parentIds],
      childIds: [...node.childIds],
    });
  }
  return {
    rootId: graph.rootId,
    nodesById,
    nextId: graph.nextId,
  };
}
