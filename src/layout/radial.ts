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
 * F-LY-2 "skipping a wedge" interpretation for v0.1: if the root has
 * ≤ 2 first-level children, fan them right-facing across
 * [-60°, +60°] so the short map reads as a horizontal tree; with ≥ 3
 * first-level children use the full 360° ring so large maps radiate
 * symmetrically. Tunable under §10.
 *
 * This module is pure — no React, no side effects — so it can be
 * unit-tested in isolation (Phase 1, §9). Must be deterministic:
 * given the same Tree it must return the same positions byte-for-byte,
 * because the marker's per-node bbox depends on these values (§6.3).
 *
 * Collapse state is ignored on purpose. §F-IN-2 auto-expands before
 * emit, so the emit path wants every node laid out anyway; the
 * authoring canvas filters collapsed subtrees out of its own render
 * pass per §4.2.
 */
import type {MindmapNode, NodeId, Tree} from '../model/tree';
import type {Rect} from '../geometry';
import {
  LEVEL_RADIUS_INCREMENT,
  NODE_HEIGHT,
  NODE_WIDTH,
  R1,
} from './constants';

export type LayoutResult = {
  /** Center point of each node, mindmap-local coords (root = origin). */
  centers: Map<NodeId, {x: number; y: number}>;
  /** Axis-aligned bbox of each node, mindmap-local coords. */
  bboxes: Map<NodeId, Rect>;
  /** Axis-aligned bbox covering every node (for marker placement, §6.1). */
  unionBbox: Rect;
};

/** Half-angle (radians) of the right-facing fan — 60° on each side of +x. */
const FAN_HALF_ANGLE = Math.PI / 3;

/**
 * First-level fan kicks in when the root has this many children or
 * fewer; beyond this, use the full 360° ring.
 */
const FAN_THRESHOLD = 2;

/**
 * Compute the radial layout for a tree. Collapsed subtrees are
 * included in the layout result because §F-IN-2 auto-expands before
 * emit; the authoring canvas is free to filter them out of its own
 * render pass without changing this function's output.
 */
export function radialLayout(tree: Tree): LayoutResult {
  const centers = new Map<NodeId, {x: number; y: number}>();
  const bboxes = new Map<NodeId, Rect>();

  // Root at origin (§F-LY-1).
  const rootId = tree.rootId;
  centers.set(rootId, {x: 0, y: 0});
  bboxes.set(rootId, centeredRect(0, 0));

  const root = nodeOrThrow(tree, rootId);
  if (root.childIds.length > 0) {
    const leafCounts = computeLeafCounts(tree);
    const isFan = root.childIds.length <= FAN_THRESHOLD;
    const rangeStart = isFan ? -FAN_HALF_ANGLE : -Math.PI;
    const rangeEnd = isFan ? FAN_HALF_ANGLE : Math.PI;
    placeSubtree(tree, root, rangeStart, rangeEnd, R1, leafCounts, centers, bboxes);
  }

  return {
    centers,
    bboxes,
    unionBbox: computeUnionBbox(bboxes),
  };
}

/**
 * Allocate angular slices to each child proportional to its subtree
 * leaf count (§F-LY-3), place each child at the mid-angle of its
 * slice at the given radius, and recurse into each child's own
 * subtree with that slice as the new angular range.
 *
 * Iterative so deep trees can't blow the stack; tree.ts uses the
 * same pattern in deleteSubtree / flattenForEmit.
 */
function placeSubtree(
  tree: Tree,
  root: MindmapNode,
  rangeStart: number,
  rangeEnd: number,
  radius: number,
  leafCounts: Map<NodeId, number>,
  centers: Map<NodeId, {x: number; y: number}>,
  bboxes: Map<NodeId, Rect>,
): void {
  type Frame = {
    parent: MindmapNode;
    rangeStart: number;
    rangeEnd: number;
    radius: number;
  };
  const stack: Frame[] = [{parent: root, rangeStart, rangeEnd, radius}];

  while (stack.length > 0) {
    const frame = stack.pop() as Frame;
    const parent = frame.parent;
    const rangeWidth = frame.rangeEnd - frame.rangeStart;
    // Sum children's leaf counts so each child gets a proportional
    // arc. Every node has leafCount ≥ 1 so totalLeaves > 0 when
    // parent.childIds.length > 0.
    let totalLeaves = 0;
    for (const id of parent.childIds) {
      totalLeaves += leafCounts.get(id) ?? 0;
    }
    if (totalLeaves === 0) {
      continue;
    }

    let cursor = frame.rangeStart;
    for (const childId of parent.childIds) {
      const leafCount = leafCounts.get(childId) ?? 0;
      const sliceWidth = (leafCount / totalLeaves) * rangeWidth;
      const sliceMid = cursor + sliceWidth / 2;

      const x = frame.radius * Math.cos(sliceMid);
      const y = frame.radius * Math.sin(sliceMid);
      centers.set(childId, {x, y});
      bboxes.set(childId, centeredRect(x, y));

      const child = nodeOrThrow(tree, childId);
      if (child.childIds.length > 0) {
        stack.push({
          parent: child,
          rangeStart: cursor,
          rangeEnd: cursor + sliceWidth,
          radius: frame.radius + LEVEL_RADIUS_INCREMENT,
        });
      }

      cursor += sliceWidth;
    }
  }
}

/**
 * Count leaves in each node's subtree (leaves count as 1, internal
 * nodes sum their children). Used by placeSubtree for §F-LY-3
 * angular-slice proportions.
 *
 * Iterative post-order so child counts are available when the parent
 * is processed.
 */
function computeLeafCounts(tree: Tree): Map<NodeId, number> {
  const counts = new Map<NodeId, number>();
  const stack: Array<{id: NodeId; visited: boolean}> = [
    {id: tree.rootId, visited: false},
  ];
  while (stack.length > 0) {
    const top = stack[stack.length - 1];
    if (top.visited) {
      stack.pop();
      const node = nodeOrThrow(tree, top.id);
      if (node.childIds.length === 0) {
        counts.set(top.id, 1);
      } else {
        let sum = 0;
        for (const childId of node.childIds) {
          sum += counts.get(childId) ?? 0;
        }
        counts.set(top.id, sum);
      }
    } else {
      top.visited = true;
      const node = nodeOrThrow(tree, top.id);
      for (const childId of node.childIds) {
        stack.push({id: childId, visited: false});
      }
    }
  }
  return counts;
}

/**
 * Union of every bbox in the map. There is always at least one entry
 * (the root) so the empty-map branch is unreachable in practice; the
 * guard is here for safety, not as a real code path.
 */
function computeUnionBbox(bboxes: Map<NodeId, Rect>): Rect {
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const r of bboxes.values()) {
    if (r.x < minX) {
      minX = r.x;
    }
    if (r.y < minY) {
      minY = r.y;
    }
    if (r.x + r.w > maxX) {
      maxX = r.x + r.w;
    }
    if (r.y + r.h > maxY) {
      maxY = r.y + r.h;
    }
  }
  if (minX === Infinity) {
    return {x: 0, y: 0, w: 0, h: 0};
  }
  return {x: minX, y: minY, w: maxX - minX, h: maxY - minY};
}

/**
 * Node's standard bbox: NODE_WIDTH × NODE_HEIGHT centered on (cx, cy).
 * Shape-specific rendering (oval vs rectangle vs rounded rectangle)
 * is nodeFrame's job at emit time (§F-IN-2); layout only cares about
 * the outline's bounding box.
 */
function centeredRect(cx: number, cy: number): Rect {
  return {
    x: cx - NODE_WIDTH / 2,
    y: cy - NODE_HEIGHT / 2,
    w: NODE_WIDTH,
    h: NODE_HEIGHT,
  };
}

function nodeOrThrow(tree: Tree, id: NodeId): MindmapNode {
  const node = tree.nodesById.get(id);
  if (!node) {
    throw new Error(`radialLayout: unknown node id ${id}`);
  }
  return node;
}
