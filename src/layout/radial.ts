/**
 * Radial mindmap layout (§F-LY-1..F-LY-6).
 *
 * Inputs a Tree; outputs a Map<NodeId, {x, y}> plus per-node
 * bounding-rect anchored at those positions using NODE_WIDTH /
 * NODE_HEIGHT. Positions are in mindmap-local coordinates: the root
 * sits at the origin (0, 0). The caller is responsible for
 * translating into page-space when inserting (§F-IN-1's
 * resolvePageSize / fit-to-page scaling per §F-LY-6).
 *
 * Rules:
 *   F-LY-1  root at origin
 *   F-LY-2  first-level children distributed on circle radius R1,
 *           skipping a wedge behind the root when a parent is set
 *   F-LY-3  deeper levels radiate outward; each node's angular slice
 *           is proportional to leaf count in its subtree
 *   F-LY-4  connectors are straight lines (phase-2: curved)
 *   F-LY-5  constants live in ./constants.ts
 *   F-LY-6  fit-to-page scaling happens at insert, not here
 *
 * This module is pure — no React, no side effects — so it can be
 * unit-tested in isolation (Phase 1, §9). Must be deterministic:
 * given the same Tree it must return the same positions byte-for-byte,
 * because the marker's per-node bbox depends on these values (§6.3).
 */
import type {NodeId, Tree} from '../model/tree';
import type {Rect} from '../geometry';

export type LayoutResult = {
  /** Center point of each node, mindmap-local coords (root = origin). */
  centers: Map<NodeId, {x: number; y: number}>;
  /** Axis-aligned bbox of each node, mindmap-local coords. */
  bboxes: Map<NodeId, Rect>;
  /** Axis-aligned bbox covering every node (for marker placement, §6.1). */
  unionBbox: Rect;
};

/**
 * Compute the radial layout for a tree. Collapsed subtrees are
 * included in the layout result because §F-IN-2 auto-expands before
 * emit; the authoring canvas is free to filter them out of its own
 * render pass without changing this function's output.
 *
 * TODO(Phase 1, §F-LY-*): implement.
 */
export function radialLayout(_tree: Tree): LayoutResult {
  throw new Error('TODO(Phase 1, §F-LY-*): radialLayout not implemented');
}
