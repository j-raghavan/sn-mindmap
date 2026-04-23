/**
 * Radial layout algorithm for the mindmap canvas (§F-LY-1 – §F-LY-5).
 *
 * Algorithm summary
 * -----------------
 * 1. Root sits at the origin (0, 0).
 * 2. Each node at depth d is placed at polar radius
 *      r(d) = d === 0 ? 0 : R1 + (d − 1) × LEVEL_RADIUS_INCREMENT
 *    from the origin, in the direction of its allocated angle θ.
 * 3. The children of any node are assigned proportional angular slices
 *    based on their *leaf counts* (a leaf counts as 1; an interior node
 *    counts as the sum of its children's leaf counts).
 * 4. Fan mode (< 3 children of root or of any parent):
 *      angular range = [parentAngle − π/3, parentAngle + π/3]  (120°)
 *    Full-ring mode (≥ 3 children):
 *      angular range = [parentAngle − π, parentAngle + π]       (360°)
 *    The range starts from parentAngle − π/3 (fan) or parentAngle − π
 *    (ring) so that equal-weight children are symmetrically placed around
 *    the parent's direction and atan2 values stay monotonically increasing
 *    across siblings (important for the §6.3 determinism guarantee and for
 *    the radial.test.ts assertions that check adjacent-angle differences
 *    without wrapping through ±π).
 * 5. Collapsed subtrees are laid out in full — the canvas hides the
 *    hidden nodes visually, but the insert pipeline emits them all (§F-IN-2).
 *
 * References: §F-LY-1, §F-LY-2, §F-LY-3, §F-LY-5, §6.3.
 */

import type {Point, Rect} from '../geometry';
import {
  LEVEL_RADIUS_INCREMENT,
  NODE_HEIGHT,
  NODE_WIDTH,
  R1,
} from './constants';
import type {NodeId, Tree} from '../model/tree';

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export interface LayoutResult {
  /** Centre point of every node, keyed by NodeId, in mindmap-local coords. */
  centers: Map<NodeId, Point>;
  /**
   * Axis-aligned bounding box of every node (centred on the node's centre),
   * keyed by NodeId.
   */
  bboxes: Map<NodeId, Rect>;
  /** Smallest Rect that contains every node bbox. */
  unionBbox: Rect;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Count the number of leaf nodes in the subtree rooted at `nodeId`.
 * A node with no children is itself a leaf (count = 1).
 * Memoised per call into `cache` to avoid O(n²) traversal.
 */
function leafCount(
  tree: Tree,
  nodeId: NodeId,
  cache: Map<NodeId, number>,
): number {
  const cached = cache.get(nodeId);
  if (cached !== undefined) {
    return cached;
  }
  const node = tree.nodesById.get(nodeId)!;
  const count =
    node.childIds.length === 0
      ? 1
      : node.childIds.reduce((sum, c) => sum + leafCount(tree, c, cache), 0);
  cache.set(nodeId, count);
  return count;
}

/**
 * Recursively place `nodeId` and all its descendants.
 *
 * @param tree       - The full tree.
 * @param nodeId     - Node being placed.
 * @param depth      - Depth of this node (root = 0).
 * @param angle      - Angular direction (radians) for this node's centre.
 * @param centers    - Accumulator: node centres.
 * @param bboxes     - Accumulator: node bboxes.
 * @param leafCache  - Memoisation table for leafCount.
 */
function placeNode(
  tree: Tree,
  nodeId: NodeId,
  depth: number,
  angle: number,
  centers: Map<NodeId, Point>,
  bboxes: Map<NodeId, Rect>,
  leafCache: Map<NodeId, number>,
): void {
  // Radial distance from origin.
  const r = depth === 0 ? 0 : R1 + (depth - 1) * LEVEL_RADIUS_INCREMENT;
  const cx = r * Math.cos(angle);
  const cy = r * Math.sin(angle);

  centers.set(nodeId, {x: cx, y: cy});
  bboxes.set(nodeId, {
    x: cx - NODE_WIDTH / 2,
    y: cy - NODE_HEIGHT / 2,
    w: NODE_WIDTH,
    h: NODE_HEIGHT,
  });

  const node = tree.nodesById.get(nodeId)!;
  const children = node.childIds;
  if (children.length === 0) {
    return;
  }

  // Fan (<3 children) vs full-ring (≥3 children) mode.
  const fanMode = children.length < 3;
  const span = fanMode ? (2 * Math.PI) / 3 : 2 * Math.PI;
  const startAngle = angle + (fanMode ? -Math.PI / 3 : -Math.PI);

  // Proportional slice allocation based on leaf counts.
  const totalLeaves = children.reduce(
    (sum, c) => sum + leafCount(tree, c, leafCache),
    0,
  );
  let curAngle = startAngle;
  for (const childId of children) {
    const sliceWidth = (leafCount(tree, childId, leafCache) / totalLeaves) * span;
    const childAngle = curAngle + sliceWidth / 2;
    placeNode(
      tree,
      childId,
      depth + 1,
      childAngle,
      centers,
      bboxes,
      leafCache,
    );
    curAngle += sliceWidth;
  }
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Compute a radial layout for the given tree and return centres, bboxes,
 * and the union bounding box.
 *
 * The function is pure and deterministic: calling it twice with the same
 * tree (including the same nextId) always yields byte-identical results
 * (§6.3 marker-bbox stability).
 */
export function radialLayout(tree: Tree): LayoutResult {
  const centers = new Map<NodeId, Point>();
  const bboxes = new Map<NodeId, Rect>();
  const leafCache = new Map<NodeId, number>();

  placeNode(tree, tree.rootId, 0, 0, centers, bboxes, leafCache);

  // Compute union bbox over all node bboxes.
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const b of bboxes.values()) {
    if (b.x < minX) {minX = b.x;}
    if (b.y < minY) {minY = b.y;}
    if (b.x + b.w > maxX) {maxX = b.x + b.w;}
    if (b.y + b.h > maxY) {maxY = b.y + b.h;}
  }

  const unionBbox: Rect = {
    x: minX,
    y: minY,
    w: maxX - minX,
    h: maxY - minY,
  };

  return {centers, bboxes, unionBbox};
}
