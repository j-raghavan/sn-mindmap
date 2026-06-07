/**
 * Force-directed layout for concept-map (DAG) mode (§14.5,
 * §F-LY-DAG-1..F-LY-DAG-6). Sibling to radial.ts: the radial layout does
 * not generalise to a DAG (no canonical depth when a node has parents at
 * different depths), so concept maps use a spring/repulsion model
 * instead.
 *
 * It returns the EXACT LayoutResult shape radial.ts produces (imported,
 * not redefined) — centers / bboxes / unionBbox — so emitGeometries,
 * transformLayout, and the insert placement pipeline consume it unchanged.
 * Bboxes are NODE_WIDTH × NODE_HEIGHT centred on each node centre, reusing
 * the same constants the mindmap layout does (so a future node-size bump
 * rescales both modes identically — cf. commit ecdcf02).
 *
 * Determinism (§F-LY-DAG-3) — load-bearing on e-ink, where a wobble
 * between renders looks broken:
 *   - NO Math.random anywhere. Initial positions are seeded from a stable
 *     FNV-1a hash of each node's numeric id (two independent hash variants
 *     for x and y so they are uncorrelated).
 *   - A FIXED iteration budget (default 200) with linear simulated-
 *     annealing cooling and a per-step displacement cap. No convergence
 *     early-exit — a fixed budget is what guarantees determinism.
 *   - All node iteration is in ASCENDING id order so a future out-of-order
 *     insert into nodesById cannot perturb the result.
 *   - Pure: the same graph (same ids + edges) and same options always
 *     yield byte-identical output (asserted via toEqual in the tests).
 *
 * Force model (§F-LY-DAG-1/2/4), Euler-integrated per step from the
 * CURRENT positions (compute all forces, then apply):
 *   - spring: every parent→child edge is a spring of natural length R1.
 *   - repulsion: every unordered node pair repels Coulomb-style (∝ 1/d²).
 *   - anchor: roots (parentIds empty) get a vertical pull toward the top
 *     of the canvas, biasing the graph into a top-down hierarchy while
 *     still allowing multi-parent edges to cross levels.
 *
 * References: §14.5, §F-LY-DAG-1..F-LY-DAG-6.
 */

import type {Point, Rect} from '../geometry';
import {NODE_HEIGHT, NODE_WIDTH, R1} from './constants';
import type {Graph} from '../model/graph';
import type {NodeId} from '../model/tree';
import type {LayoutResult} from './radial';

// ---------------------------------------------------------------------------
// Options
// ---------------------------------------------------------------------------

/**
 * Tunable knobs for the force simulation. Every field has a deterministic
 * default derived (where it makes sense) from the shared layout constants
 * so resizing nodes rescales the graph the same way the radial layout
 * does. Callers normally pass nothing; the insert pipeline relies on the
 * defaults.
 */
export interface ForceOptions {
  /** Fixed iteration budget (§F-LY-DAG-3). */
  iterations?: number;
  /** Spring natural length (§F-LY-DAG-1) — defaults to R1. */
  springLength?: number;
  /** Spring (Hooke) stiffness. */
  springK?: number;
  /** Coulomb repulsion scale, in px² (force = repulsionK / d²). */
  repulsionK?: number;
  /** Vertical pull strength on roots toward the top band (§F-LY-DAG-4). */
  anchorK?: number;
  /** Seed/spread width — defaults to DEFAULT_SEED_WIDTH (Nomad portrait). */
  canvasWidth?: number;
  /** Seed/spread height — defaults to DEFAULT_SEED_HEIGHT (Nomad portrait). */
  canvasHeight?: number;
}

const DEFAULT_ITERATIONS = 200;
const DEFAULT_SPRING_K = 0.05;
const DEFAULT_ANCHOR_K = 0.08;

/**
 * Default seed/spread region for initial node placement, in layout-local
 * pixels. These match the Nomad portrait page (1404 × 1872) but are kept
 * LOCAL to this layout module on purpose: a `layout/` file must not depend
 * on the insert pipeline (insert.ts imports this module, so importing
 * DEFAULT_PAGE_* back from insert.ts would be a dependency cycle). The
 * values only seed and bound initial positions — the real on-device page
 * size is applied later by the insert pipeline's fit-to-page transform,
 * which scales this layout to whatever the device reports.
 */
const DEFAULT_SEED_WIDTH = 1404;
const DEFAULT_SEED_HEIGHT = 1872;

/**
 * y-coordinate roots are pulled toward (§F-LY-DAG-4). One node-height
 * below the top so root outlines are not flush with the canvas edge.
 */
const ANCHOR_TOP = NODE_HEIGHT;

/**
 * Per-step displacement is capped at `temperature × MAX_STEP` so a large
 * transient force can't fling a node across the canvas. R1 (one natural
 * spring length) is a natural ceiling for a single step.
 */
const MAX_STEP = R1;

/**
 * Floor on the squared distance used in the repulsion denominator, so two
 * coincident (or near-coincident) seeds don't produce an infinite /
 * NaN force. 1 px² is well below any meaningful node separation.
 */
const EPS_SQ = 1;

// FNV-1a 32-bit constants (deterministic id → seed hashing).
const FNV_OFFSET = 2166136261 >>> 0;
const FNV_PRIME = 16777619;
/** Golden-ratio mix constant — xored into the id for the y-seed variant. */
const Y_SEED_MIX = 0x9e3779b9;

// ---------------------------------------------------------------------------
// Deterministic seeding
// ---------------------------------------------------------------------------

/**
 * FNV-1a 32-bit hash of a node id's four little-endian bytes. Pure and
 * deterministic — the seed source for initial positions (§F-LY-DAG-3, no
 * Math.random). Returns an unsigned 32-bit integer.
 */
function hash32(id: NodeId): number {
  let h = FNV_OFFSET;
  const bytes = [id & 0xff, (id >>> 8) & 0xff, (id >>> 16) & 0xff, (id >>> 24) & 0xff];
  for (const b of bytes) {
    h ^= b;
    h = Math.imul(h, FNV_PRIME) >>> 0;
  }
  return h >>> 0;
}

// ---------------------------------------------------------------------------
// Internal simulation state
// ---------------------------------------------------------------------------

interface SimNode {
  id: NodeId;
  x: number;
  y: number;
  /** True iff this node has no parents (a root) — pulled to the top band. */
  isRoot: boolean;
}

/**
 * Build the per-node simulation state in ascending-id order with
 * deterministic seed positions. Two independent FNV hashes (the second
 * over `id ^ Y_SEED_MIX`) decorrelate the x and y seeds so nodes don't
 * start collinear.
 */
function seedNodes(graph: Graph, width: number, height: number): SimNode[] {
  const ids = [...graph.nodesById.keys()].sort((a, b) => a - b);
  return ids.map(id => {
    const node = graph.nodesById.get(id)!;
    return {
      id,
      x: hash32(id) % width,
      y: hash32(id ^ Y_SEED_MIX) % height,
      isRoot: node.parentIds.length === 0,
    };
  });
}

/**
 * Unique undirected parent↔child edge pairs (each counted once) as index
 * pairs into the `nodes` array. Springs act on these. We walk childIds so
 * each structural edge contributes exactly one spring regardless of how
 * many parents a node has. Iterated in ascending id order so the spring
 * list (and therefore the force accumulation order) is deterministic.
 */
function edgePairs(
  nodes: SimNode[],
  graph: Graph,
  indexById: Map<NodeId, number>,
): Array<[number, number]> {
  const pairs: Array<[number, number]> = [];
  // nodes is already ascending-id (seedNodes sorts), so this walk is
  // deterministic without re-sorting.
  for (const {id} of nodes) {
    const ai = indexById.get(id)!;
    const node = graph.nodesById.get(id)!;
    for (const childId of node.childIds) {
      // Non-null: childIds/parentIds are a symmetric mirror kept by every
      // graph mutator, so every childId resolves to a seeded SimNode —
      // same invariant idiom as graph.ts's deleteNode.
      const bi = indexById.get(childId)!;
      pairs.push([ai, bi]);
    }
  }
  return pairs;
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Compute a deterministic force-directed layout for `graph` and return
 * centres, bboxes, and the union bounding box in concept-map-local coords
 * (same coordinate contract as radialLayout). Pure and deterministic.
 *
 * An empty graph returns an empty layout with a zero union rect (mirrors
 * radialLayout's reducer over no bboxes). A single node settles at its
 * seed position.
 */
export function forceDirectedLayout(
  graph: Graph,
  opts: ForceOptions = {},
): LayoutResult {
  const iterations = opts.iterations ?? DEFAULT_ITERATIONS;
  const springLength = opts.springLength ?? R1;
  const springK = opts.springK ?? DEFAULT_SPRING_K;
  const repulsionK = opts.repulsionK ?? R1 * R1;
  const anchorK = opts.anchorK ?? DEFAULT_ANCHOR_K;
  const width = opts.canvasWidth ?? DEFAULT_SEED_WIDTH;
  const height = opts.canvasHeight ?? DEFAULT_SEED_HEIGHT;

  const nodes = seedNodes(graph, width, height);
  const n = nodes.length;

  const indexById = new Map<NodeId, number>();
  nodes.forEach((node, i) => indexById.set(node.id, i));
  const springs = edgePairs(nodes, graph, indexById);

  for (let step = 0; step < iterations; step += 1) {
    // Linear annealing: temperature falls from ~1 to 0 across the budget,
    // shrinking the per-step displacement cap so the layout settles.
    const temperature = 1 - step / iterations;
    const maxDisp = temperature * MAX_STEP;

    // Accumulate forces from CURRENT positions, then apply (Euler).
    const fx = new Array<number>(n).fill(0);
    const fy = new Array<number>(n).fill(0);

    // Coulomb repulsion over every unordered pair.
    for (let i = 0; i < n; i += 1) {
      for (let j = i + 1; j < n; j += 1) {
        let dx = nodes[i].x - nodes[j].x;
        let dy = nodes[i].y - nodes[j].y;
        let distSq = dx * dx + dy * dy;
        if (distSq < EPS_SQ) {
          // Coincident seeds: push deterministically along +x (lower id,
          // which by ascending order is index i, goes right) so the pair
          // separates without randomness.
          dx = 1;
          dy = 0;
          distSq = EPS_SQ;
        }
        const dist = Math.sqrt(distSq);
        const force = repulsionK / distSq;
        const ux = dx / dist;
        const uy = dy / dist;
        fx[i] += ux * force;
        fy[i] += uy * force;
        fx[j] -= ux * force;
        fy[j] -= uy * force;
      }
    }

    // Hooke springs along each parent↔child edge.
    for (const [a, b] of springs) {
      let dx = nodes[b].x - nodes[a].x;
      let dy = nodes[b].y - nodes[a].y;
      let dist = Math.hypot(dx, dy);
      if (dist === 0) {
        dx = 1;
        dy = 0;
        dist = 1;
      }
      const force = springK * (dist - springLength);
      const ux = dx / dist;
      const uy = dy / dist;
      // a pulled toward b, b pulled toward a.
      fx[a] += ux * force;
      fy[a] += uy * force;
      fx[b] -= ux * force;
      fy[b] -= uy * force;
    }

    // Root anchoring: pull roots vertically toward the top band
    // (§F-LY-DAG-4). Leaves drift down naturally via the springs.
    for (let i = 0; i < n; i += 1) {
      if (nodes[i].isRoot) {
        fy[i] += anchorK * (ANCHOR_TOP - nodes[i].y);
      }
    }

    // Apply, capping displacement at the annealed maximum.
    for (let i = 0; i < n; i += 1) {
      let dxStep = fx[i];
      let dyStep = fy[i];
      const mag = Math.hypot(dxStep, dyStep);
      if (mag > maxDisp && mag > 0) {
        const scale = maxDisp / mag;
        dxStep *= scale;
        dyStep *= scale;
      }
      nodes[i].x += dxStep;
      nodes[i].y += dyStep;
    }
  }

  // Build the LayoutResult (centres + node-sized bboxes + union rect).
  const centers = new Map<NodeId, Point>();
  const bboxes = new Map<NodeId, Rect>();
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;

  for (const node of nodes) {
    centers.set(node.id, {x: node.x, y: node.y});
    const bbox: Rect = {
      x: node.x - NODE_WIDTH / 2,
      y: node.y - NODE_HEIGHT / 2,
      w: NODE_WIDTH,
      h: NODE_HEIGHT,
    };
    bboxes.set(node.id, bbox);
    if (bbox.x < minX) {minX = bbox.x;}
    if (bbox.y < minY) {minY = bbox.y;}
    if (bbox.x + bbox.w > maxX) {maxX = bbox.x + bbox.w;}
    if (bbox.y + bbox.h > maxY) {maxY = bbox.y + bbox.h;}
  }

  const unionBbox: Rect =
    n === 0
      ? {x: 0, y: 0, w: 0, h: 0}
      : {x: minX, y: minY, w: maxX - minX, h: maxY - minY};

  return {centers, bboxes, unionBbox};
}
