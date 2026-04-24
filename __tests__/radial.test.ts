/**
 * Tests for src/layout/radial.ts.
 *
 * Phase 1.2 (§9) coverage:
 *   - module surface + constants (kept from scaffold)
 *   - root at origin (§F-LY-1)
 *   - single-child is placed at (R1, 0) (fan mode, center of range)
 *   - two-child fan symmetry around +x axis
 *   - three-child full-ring mode (§F-LY-2 threshold)
 *   - depth-2 nodes sit at R1 + LEVEL_RADIUS_INCREMENT (§F-LY-3)
 *   - unbalanced leaf counts allocate wider slices to heavier
 *     subtrees (§F-LY-3)
 *   - unionBbox covers every node bbox
 *   - determinism across repeat calls (§6.3 marker-bbox stability)
 *   - collapsed subtrees still laid out (§F-IN-2 auto-expand)
 */
import {radialLayout} from '../src/layout/radial';
import {
  LEVEL_RADIUS_INCREMENT,
  NODE_HEIGHT,
  NODE_WIDTH,
  R1,
  ROOT_PEN_WIDTH,
  STANDARD_PEN_WIDTH,
} from '../src/layout/constants';
import {
  addChild,
  addSibling,
  createTree,
  setCollapsed,
} from '../src/model/tree';

describe('radial layout', () => {
  describe('scaffold guarantees (kept from Phase 0)', () => {
    it('exposes radialLayout', () => {
      expect(typeof radialLayout).toBe('function');
    });

    it('layout constants match §F-LY-5 / §11 starting values', () => {
      expect(R1).toBeGreaterThan(0);
      expect(LEVEL_RADIUS_INCREMENT).toBeGreaterThan(0);
      expect(NODE_WIDTH).toBeGreaterThan(0);
      expect(NODE_HEIGHT).toBeGreaterThan(0);
      // §F-AC-2 root oval pen width ≥ 500.
      expect(ROOT_PEN_WIDTH).toBeGreaterThanOrEqual(500);
      // §11 standard outline weight.
      expect(STANDARD_PEN_WIDTH).toBe(400);
    });
  });

  describe('§F-LY-1 root at origin', () => {
    it('places the root at (0, 0) for a single-node tree', () => {
      const tree = createTree();
      const result = radialLayout(tree);
      expect(result.centers.get(0)).toEqual({x: 0, y: 0});
      expect(result.bboxes.get(0)).toEqual({
        x: -NODE_WIDTH / 2,
        y: -NODE_HEIGHT / 2,
        w: NODE_WIDTH,
        h: NODE_HEIGHT,
      });
      expect(result.centers.size).toBe(1);
    });

    it('unionBbox for single-node equals the root bbox', () => {
      const tree = createTree();
      const result = radialLayout(tree);
      expect(result.unionBbox).toEqual(result.bboxes.get(0));
    });
  });

  describe('§F-LY-2 first-level distribution (fan vs full ring)', () => {
    it('single child lands straight-right at (R1, 0)', () => {
      const tree = createTree();
      const a = addChild(tree, 0);
      const result = radialLayout(tree);
      const pos = result.centers.get(a);
      expect(pos?.x).toBeCloseTo(R1, 6);
      expect(pos?.y).toBeCloseTo(0, 6);
    });

    it('two equal children fan symmetrically around +x (±30°)', () => {
      const tree = createTree();
      const a = addChild(tree, 0);
      const b = addChild(tree, 0);
      const result = radialLayout(tree);
      const posA = result.centers.get(a);
      const posB = result.centers.get(b);
      // Both at distance R1 from origin.
      expect(Math.hypot(posA!.x, posA!.y)).toBeCloseTo(R1, 6);
      expect(Math.hypot(posB!.x, posB!.y)).toBeCloseTo(R1, 6);
      // Symmetric around the +x axis: same x, opposite y.
      expect(posA!.x).toBeCloseTo(posB!.x, 6);
      expect(posA!.y).toBeCloseTo(-posB!.y, 6);
      // Angular positions are ±30° (mid of ±60° slices).
      const angleA = Math.atan2(posA!.y, posA!.x);
      const angleB = Math.atan2(posB!.y, posB!.x);
      expect(Math.abs(angleA)).toBeCloseTo(Math.PI / 6, 6);
      expect(Math.abs(angleB)).toBeCloseTo(Math.PI / 6, 6);
    });

    it('three equal children switch to full 360° ring', () => {
      const tree = createTree();
      const a = addChild(tree, 0);
      const b = addChild(tree, 0);
      const c = addChild(tree, 0);
      const result = radialLayout(tree);
      // Adjacent slice centers should be 120° apart in full-ring mode.
      // In fan mode ([-60°, +60°]) they'd only be 40° apart for 3 kids,
      // so this is the cleanest threshold test.
      const angles = [a, b, c]
        .map(id => result.centers.get(id)!)
        .map(p => Math.atan2(p.y, p.x));
      const step = (2 * Math.PI) / 3; // 120°
      expect(Math.abs(angles[1] - angles[0])).toBeCloseTo(step, 6);
      expect(Math.abs(angles[2] - angles[1])).toBeCloseTo(step, 6);
    });

    it('four children in full ring are 90° apart', () => {
      const tree = createTree();
      const ids = [
        addChild(tree, 0),
        addChild(tree, 0),
        addChild(tree, 0),
        addChild(tree, 0),
      ];
      const result = radialLayout(tree);
      const angles = ids
        .map(id => result.centers.get(id)!)
        .map(p => Math.atan2(p.y, p.x));
      const step = Math.PI / 2;
      expect(Math.abs(angles[1] - angles[0])).toBeCloseTo(step, 6);
      expect(Math.abs(angles[2] - angles[1])).toBeCloseTo(step, 6);
      expect(Math.abs(angles[3] - angles[2])).toBeCloseTo(step, 6);
    });
  });

  describe('§F-LY-3 deeper levels and leaf-count slices', () => {
    it('depth-2 nodes sit at R1 + LEVEL_RADIUS_INCREMENT from origin', () => {
      const tree = createTree();
      const a = addChild(tree, 0);
      const aa = addChild(tree, a);
      const result = radialLayout(tree);
      const dist = Math.hypot(
        result.centers.get(aa)!.x,
        result.centers.get(aa)!.y,
      );
      expect(dist).toBeCloseTo(R1 + LEVEL_RADIUS_INCREMENT, 6);
    });

    it('unbalanced leaves → heavier subtree gets a wider slice', () => {
      // Root has two children: A with 3 leaves (via 3 grandchildren)
      // and B stays a leaf. Total leaves under root = 4.
      // Fan range [-60°, +60°] = 120°. A gets 3/4 (90°), B gets 1/4
      // (30°). A's slice [-60°, +30°] → center at -15°.
      // B's slice [+30°, +60°] → center at +45°.
      const tree = createTree();
      const a = addChild(tree, 0);
      const b = addChild(tree, 0);
      addChild(tree, a);
      addChild(tree, a);
      addChild(tree, a);
      const result = radialLayout(tree);
      const angleA = Math.atan2(
        result.centers.get(a)!.y,
        result.centers.get(a)!.x,
      );
      const angleB = Math.atan2(
        result.centers.get(b)!.y,
        result.centers.get(b)!.x,
      );
      expect(angleA).toBeCloseTo(-Math.PI / 12, 6); // -15°
      expect(angleB).toBeCloseTo(Math.PI / 4, 6); // +45°
      // And the angular span from A to B should be 60° (half of A's
      // slice + half of B's = 45° + 15°).
      expect(angleB - angleA).toBeCloseTo(Math.PI / 3, 6);
    });

    it('addSibling children get their own slice allocation', () => {
      const tree = createTree();
      const a = addChild(tree, 0);
      const s = addSibling(tree, a);
      const result = radialLayout(tree);
      // Same topology shape as two equal children; same ±30° layout.
      const posA = result.centers.get(a);
      const posS = result.centers.get(s);
      expect(posA!.x).toBeCloseTo(posS!.x, 6);
      expect(posA!.y).toBeCloseTo(-posS!.y, 6);
    });
  });

  describe('unionBbox', () => {
    it('contains every node bbox', () => {
      const tree = createTree();
      const a = addChild(tree, 0);
      addChild(tree, 0);
      addChild(tree, a);
      const result = radialLayout(tree);
      const u = result.unionBbox;
      // Small epsilon to absorb floating-point drift from the
      // `minY + (maxY - minY)` that reconstructs the right edge from
      // width — that sum isn't byte-identical to maxY when minY≠0.
      const EPS = 1e-9;
      for (const bbox of result.bboxes.values()) {
        expect(bbox.x).toBeGreaterThanOrEqual(u.x - EPS);
        expect(bbox.y).toBeGreaterThanOrEqual(u.y - EPS);
        expect(bbox.x + bbox.w).toBeLessThanOrEqual(u.x + u.w + EPS);
        expect(bbox.y + bbox.h).toBeLessThanOrEqual(u.y + u.h + EPS);
      }
    });

    it('width and height are non-negative', () => {
      const tree = createTree();
      addChild(tree, 0);
      addChild(tree, 0);
      addChild(tree, 0);
      const result = radialLayout(tree);
      expect(result.unionBbox.w).toBeGreaterThan(0);
      expect(result.unionBbox.h).toBeGreaterThan(0);
    });
  });

  describe('determinism (§6.3 marker-bbox stability)', () => {
    it('returns byte-identical centers for the same tree across calls', () => {
      const tree = createTree();
      const a = addChild(tree, 0);
      const b = addChild(tree, 0);
      addChild(tree, a);
      addChild(tree, b);
      const r1 = radialLayout(tree);
      const r2 = radialLayout(tree);
      for (const [id, pos] of r1.centers) {
        expect(r2.centers.get(id)).toEqual(pos);
      }
      for (const [id, bbox] of r1.bboxes) {
        expect(r2.bboxes.get(id)).toEqual(bbox);
      }
      expect(r2.unionBbox).toEqual(r1.unionBbox);
    });
  });

  describe('collapse state is ignored by layout (§F-IN-2 auto-expand)', () => {
    it('still includes every collapsed descendant in centers + bboxes', () => {
      const tree = createTree();
      const a = addChild(tree, 0);
      const aa = addChild(tree, a);
      setCollapsed(tree, a, true);
      const result = radialLayout(tree);
      expect(result.centers.has(aa)).toBe(true);
      expect(result.bboxes.has(aa)).toBe(true);
      // And the layout is the same as if `a` were expanded.
      setCollapsed(tree, a, false);
      const expanded = radialLayout(tree);
      expect(result.centers.get(aa)).toEqual(expanded.centers.get(aa));
    });
  });
});
