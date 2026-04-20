/**
 * Tests for src/insert.ts — the §F-IN-1..F-IN-5 orchestrator.
 *
 * Mocks sn-plugin-lib's PluginCommAPI / PluginFileAPI / PluginManager
 * so the whole insert path is exercised without a device. Covers:
 *   - §F-IN-1 page-size fall-through at every step
 *   - §F-IN-2 / §8.6 auto-expansion of collapsed subtrees
 *   - §F-IN-3 order-of-calls (insertGeometry × N → lassoElements →
 *     closePluginView) plus showLassoAfterInsert:false on every
 *     inserted geometry
 *   - §F-IN-4 plugin-view dismissal
 *   - §F-IN-5 best-effort cleanup on mid-insert failure
 *   - §F-LY-6 fit-to-page scaling + page-centering of the union rect
 *
 * We intentionally don't re-test emitGeometries' internals here —
 * those live in __tests__/emitGeometries.test.ts. The contract
 * exercised here is the orchestration around emit, not emit itself.
 */
jest.mock('sn-plugin-lib', () => ({
  PluginCommAPI: {
    insertGeometry: jest.fn().mockResolvedValue({success: true}),
    getCurrentFilePath: jest
      .fn()
      .mockResolvedValue({success: true, result: '/note/test.note'}),
    getCurrentPageNum: jest
      .fn()
      .mockResolvedValue({success: true, result: 0}),
    lassoElements: jest.fn().mockResolvedValue({success: true}),
    deleteLassoElements: jest.fn().mockResolvedValue({success: true}),
  },
  PluginFileAPI: {
    getPageSize: jest
      .fn()
      .mockResolvedValue({success: true, result: {width: 1404, height: 1872}}),
  },
  PluginManager: {
    closePluginView: jest.fn().mockResolvedValue(true),
  },
}));

import {PluginCommAPI, PluginFileAPI, PluginManager} from 'sn-plugin-lib';

import {
  DEFAULT_PAGE_HEIGHT,
  DEFAULT_PAGE_WIDTH,
  INSERT_MARGIN_PX,
  insertMindmap,
} from '../src/insert';
import {radialLayout} from '../src/layout/radial';
import {
  MARKER_PEN_COLOR,
  MARKER_PUBLISHED_NODE_CAP,
  MarkerCapacityError,
} from '../src/marker/encode';
import {
  addChild,
  createTree,
  setCollapsed,
  type Tree,
} from '../src/model/tree';

/**
 * Marker strokes are recognizable by pen color 0x9D (§6.4). The
 * phase-3 wire-up means every insert emits outlines + connectors +
 * several hundred marker bits; tests that care about the "primary"
 * emit list (outlines + connectors + preserved strokes) filter these
 * out with `nonMarkerInserts` before counting.
 */
function nonMarkerInserts(
  insertCalls: Array<[{penColor?: number; type?: string}]>,
): Array<[{penColor?: number; type?: string}]> {
  return insertCalls.filter(
    ([geometry]) =>
      !(geometry.type === 'straightLine' && geometry.penColor === MARKER_PEN_COLOR),
  );
}

type AnyMock = jest.Mock;
const asMock = (fn: unknown) => fn as AnyMock;

function resetMocks() {
  asMock(PluginCommAPI.insertGeometry).mockClear();
  asMock(PluginCommAPI.insertGeometry).mockResolvedValue({success: true});
  asMock(PluginCommAPI.getCurrentFilePath).mockClear();
  asMock(PluginCommAPI.getCurrentFilePath).mockResolvedValue({
    success: true,
    result: '/note/test.note',
  });
  asMock(PluginCommAPI.getCurrentPageNum).mockClear();
  asMock(PluginCommAPI.getCurrentPageNum).mockResolvedValue({
    success: true,
    result: 0,
  });
  asMock(PluginCommAPI.lassoElements).mockClear();
  asMock(PluginCommAPI.lassoElements).mockResolvedValue({success: true});
  asMock(PluginCommAPI.deleteLassoElements).mockClear();
  asMock(PluginCommAPI.deleteLassoElements).mockResolvedValue({
    success: true,
  });
  asMock(PluginFileAPI.getPageSize).mockClear();
  asMock(PluginFileAPI.getPageSize).mockResolvedValue({
    success: true,
    result: {width: 1404, height: 1872},
  });
  asMock(PluginManager.closePluginView).mockClear();
  asMock(PluginManager.closePluginView).mockResolvedValue(true);
}

beforeEach(() => {
  resetMocks();
});

function buildSmallTree(): Tree {
  // Root + 3 first-level children. Keeps the map well within the
  // page so no fit-scale kicks in — the happy-path tests don't need
  // scaling noise.
  const tree = createTree();
  addChild(tree, 0);
  addChild(tree, 0);
  addChild(tree, 0);
  return tree;
}

describe('insertMindmap — happy path (§F-IN-1..F-IN-4)', () => {
  it('resolves page size via the three-step chain and passes it to getPageSize', async () => {
    const tree = buildSmallTree();
    await insertMindmap({tree});

    expect(PluginCommAPI.getCurrentFilePath).toHaveBeenCalledTimes(1);
    expect(PluginCommAPI.getCurrentPageNum).toHaveBeenCalledTimes(1);
    expect(PluginFileAPI.getPageSize).toHaveBeenCalledWith(
      '/note/test.note',
      0,
    );
  });

  it('inserts every emitted geometry, then lassos once, then closes the plugin', async () => {
    const tree = buildSmallTree();
    await insertMindmap({tree});

    const insertCalls = asMock(PluginCommAPI.insertGeometry).mock.calls;
    // 4 outlines (root + 3 children) + 3 connectors = 7 non-marker;
    // the balance is marker strokes (penColor 0x9D). Plus at least one
    // marker stroke — the root-containing tree always produces some.
    expect(nonMarkerInserts(insertCalls).length).toBe(7);
    expect(insertCalls.length).toBeGreaterThan(7);
    expect(PluginCommAPI.lassoElements).toHaveBeenCalledTimes(1);
    expect(PluginManager.closePluginView).toHaveBeenCalledTimes(1);

    // Order: lasso fires after the last insertGeometry, close fires
    // after the lasso. Jest's mock.invocationCallOrder gives a global
    // monotonic counter across all mocks so we can assert the
    // relative sequence directly.
    const lastInsertOrder = Math.max(
      ...insertCalls.map(
        (_call, i) =>
          asMock(PluginCommAPI.insertGeometry).mock.invocationCallOrder[i],
      ),
    );
    const lassoOrder = asMock(PluginCommAPI.lassoElements).mock
      .invocationCallOrder[0];
    const closeOrder = asMock(PluginManager.closePluginView).mock
      .invocationCallOrder[0];

    expect(lassoOrder).toBeGreaterThan(lastInsertOrder);
    expect(closeOrder).toBeGreaterThan(lassoOrder);
  });

  it('forces showLassoAfterInsert:false on every inserted geometry (§F-IN-3)', async () => {
    const tree = buildSmallTree();
    await insertMindmap({tree});

    const insertCalls = asMock(PluginCommAPI.insertGeometry).mock.calls;
    for (const [geometry] of insertCalls) {
      expect(geometry.showLassoAfterInsert).toBe(false);
    }
  });

  it('lassos a rectangle that covers every inserted point', async () => {
    const tree = buildSmallTree();
    await insertMindmap({tree});

    const [rect] = asMock(PluginCommAPI.lassoElements).mock.calls[0];
    expect(rect).toEqual(
      expect.objectContaining({
        left: expect.any(Number),
        top: expect.any(Number),
        right: expect.any(Number),
        bottom: expect.any(Number),
      }),
    );
    expect(rect.right).toBeGreaterThan(rect.left);
    expect(rect.bottom).toBeGreaterThan(rect.top);

    // Every inserted geometry's extreme points lie within the lasso
    // rect. Only points-based geometries are in v0.1's emit mix
    // (outlines + connectors are polygons and straightLines), so the
    // naive extend-from-points is correct.
    const insertCalls = asMock(PluginCommAPI.insertGeometry).mock.calls;
    for (const [geometry] of insertCalls) {
      for (const p of geometry.points) {
        expect(p.x).toBeGreaterThanOrEqual(rect.left - 1e-6);
        expect(p.x).toBeLessThanOrEqual(rect.right + 1e-6);
        expect(p.y).toBeGreaterThanOrEqual(rect.top - 1e-6);
        expect(p.y).toBeLessThanOrEqual(rect.bottom + 1e-6);
      }
    }
  });
});

describe('insertMindmap — auto-expansion (§F-IN-2 / §8.6)', () => {
  it('emits descendants of a collapsed subtree as though it were expanded', async () => {
    const tree = createTree();
    const child = addChild(tree, 0);
    addChild(tree, child);
    addChild(tree, child);
    setCollapsed(tree, child, true);

    await insertMindmap({tree});

    // 4 nodes × 1 outline + 3 connectors = 7 non-marker geometries,
    // same as the small tree above — i.e., collapse did not hide
    // any node. Marker strokes are filtered out of the count so an
    // unrelated change in the marker bit-population doesn't break
    // the auto-expansion assertion.
    const insertCalls = asMock(PluginCommAPI.insertGeometry).mock.calls;
    expect(nonMarkerInserts(insertCalls).length).toBe(7);
  });

  it('does not mutate the caller\'s collapse state', async () => {
    // setCollapsed is intentionally a no-op on leaves (tree.ts:221),
    // so we need at least one grandchild before we can collapse the
    // child node.
    const tree = createTree();
    const child = addChild(tree, 0);
    addChild(tree, child);
    setCollapsed(tree, child, true);
    expect(tree.nodesById.get(child)?.collapsed).toBe(true); // sanity

    await insertMindmap({tree});

    expect(tree.nodesById.get(child)?.collapsed).toBe(true);
  });
});

describe('insertMindmap — page-size fall-through (§F-IN-1)', () => {
  it('uses defaults when getCurrentFilePath rejects', async () => {
    asMock(PluginCommAPI.getCurrentFilePath).mockRejectedValueOnce(
      new Error('native bridge unavailable'),
    );

    const tree = createTree();
    await insertMindmap({tree});

    expect(PluginFileAPI.getPageSize).not.toHaveBeenCalled();
    // Root center should land in the middle of the default page.
    const [firstGeom] = asMock(PluginCommAPI.insertGeometry).mock.calls[0];
    const xs = firstGeom.points.map((p: {x: number}) => p.x);
    const ys = firstGeom.points.map((p: {y: number}) => p.y);
    const cx = (Math.min(...xs) + Math.max(...xs)) / 2;
    const cy = (Math.min(...ys) + Math.max(...ys)) / 2;
    expect(cx).toBeCloseTo(DEFAULT_PAGE_WIDTH / 2, 0);
    expect(cy).toBeCloseTo(DEFAULT_PAGE_HEIGHT / 2, 0);
  });

  it('uses defaults when getPageSize returns success:false', async () => {
    asMock(PluginFileAPI.getPageSize).mockResolvedValueOnce({success: false});

    const tree = createTree();
    await insertMindmap({tree});

    expect(PluginFileAPI.getPageSize).toHaveBeenCalledTimes(1);
    const [firstGeom] = asMock(PluginCommAPI.insertGeometry).mock.calls[0];
    const xs = firstGeom.points.map((p: {x: number}) => p.x);
    const cx = (Math.min(...xs) + Math.max(...xs)) / 2;
    expect(cx).toBeCloseTo(DEFAULT_PAGE_WIDTH / 2, 0);
  });

  it('uses the returned page size when every step succeeds', async () => {
    asMock(PluginCommAPI.getCurrentFilePath).mockResolvedValueOnce({
      success: true,
      result: '/note/landscape.note',
    });
    asMock(PluginCommAPI.getCurrentPageNum).mockResolvedValueOnce({
      success: true,
      result: 5,
    });
    asMock(PluginFileAPI.getPageSize).mockResolvedValueOnce({
      success: true,
      result: {width: 1920, height: 1080},
    });

    const tree = createTree();
    await insertMindmap({tree});

    expect(PluginFileAPI.getPageSize).toHaveBeenCalledWith(
      '/note/landscape.note',
      5,
    );
    const [firstGeom] = asMock(PluginCommAPI.insertGeometry).mock.calls[0];
    const xs = firstGeom.points.map((p: {x: number}) => p.x);
    const ys = firstGeom.points.map((p: {y: number}) => p.y);
    const cx = (Math.min(...xs) + Math.max(...xs)) / 2;
    const cy = (Math.min(...ys) + Math.max(...ys)) / 2;
    expect(cx).toBeCloseTo(1920 / 2, 0);
    expect(cy).toBeCloseTo(1080 / 2, 0);
  });
});

describe('insertMindmap — fit-to-page scaling (§F-LY-6)', () => {
  it('does not scale when the map already fits with margin', async () => {
    const tree = createTree();
    await insertMindmap({tree});

    const [firstGeom] = asMock(PluginCommAPI.insertGeometry).mock.calls[0];
    const xs = firstGeom.points.map((p: {x: number}) => p.x);
    const ys = firstGeom.points.map((p: {y: number}) => p.y);
    const width = Math.max(...xs) - Math.min(...xs);
    const height = Math.max(...ys) - Math.min(...ys);

    // Root's native bbox is 220×96 (see src/layout/constants.ts). At
    // scale=1 the emitted outline should be approximately the same.
    expect(width).toBeCloseTo(220, 0);
    expect(height).toBeCloseTo(96, 0);
  });

  it('scales down when the map is wider than the page minus margins', async () => {
    // Fabricate a wide tree: the first ring alone caps at roughly
    // R1 + node half-width ≈ 450 px from center, which fits the
    // 1244 px available width easily. We have to reach into the
    // second level (radius = R1 + LEVEL_RADIUS_INCREMENT = 600) so
    // the union bbox actually exceeds the page. Six first-level
    // children × two grandchildren each (= 19 nodes) overflows.
    const tree = createTree();
    const firstLevel: number[] = [];
    for (let i = 0; i < 6; i += 1) {
      firstLevel.push(addChild(tree, 0));
    }
    for (const p of firstLevel) {
      addChild(tree, p);
      addChild(tree, p);
    }
    const baseLayout = radialLayout(tree);
    // Sanity: only run the assertion if the tree truly exceeds the
    // available page area. If someone tightens the layout constants
    // later and this tree starts fitting, bump the child count.
    const available = DEFAULT_PAGE_WIDTH - 2 * INSERT_MARGIN_PX;
    if (baseLayout.unionBbox.w <= available) {
      throw new Error(
        `test setup broken: unionBbox.w=${baseLayout.unionBbox.w} <= ${available}`,
      );
    }

    await insertMindmap({tree});

    // The root outline (first emitted geometry) should have been
    // scaled down from its native 220×96 bbox. We compute the
    // expected scale factor the same way insert.ts does and assert
    // the emitted outline matches.
    const expectedScale = Math.min(
      1,
      available / baseLayout.unionBbox.w,
      (DEFAULT_PAGE_HEIGHT - 2 * INSERT_MARGIN_PX) / baseLayout.unionBbox.h,
    );
    const [firstGeom] = asMock(PluginCommAPI.insertGeometry).mock.calls[0];
    const xs = firstGeom.points.map((p: {x: number}) => p.x);
    const ys = firstGeom.points.map((p: {y: number}) => p.y);
    const width = Math.max(...xs) - Math.min(...xs);
    const height = Math.max(...ys) - Math.min(...ys);
    expect(width).toBeCloseTo(220 * expectedScale, 0);
    expect(height).toBeCloseTo(96 * expectedScale, 0);
  });

  it('centers the union rect on the page', async () => {
    const tree = createTree();
    for (let i = 0; i < 6; i += 1) {
      addChild(tree, 0);
    }

    await insertMindmap({tree});

    const [rect] = asMock(PluginCommAPI.lassoElements).mock.calls[0];
    const cx = (rect.left + rect.right) / 2;
    const cy = (rect.top + rect.bottom) / 2;
    expect(cx).toBeCloseTo(DEFAULT_PAGE_WIDTH / 2, 0);
    expect(cy).toBeCloseTo(DEFAULT_PAGE_HEIGHT / 2, 0);
  });
});

describe('insertMindmap — error + cleanup (§F-IN-5)', () => {
  it('re-raises the insertGeometry error and does not call close', async () => {
    asMock(PluginCommAPI.insertGeometry)
      .mockResolvedValueOnce({success: true})
      .mockResolvedValueOnce({
        success: false,
        error: {message: 'simulated: insertGeometry failed at index 1'},
      });

    const tree = buildSmallTree();
    await expect(insertMindmap({tree})).rejects.toThrow(
      /insertGeometry failed at index 1/,
    );
    expect(PluginManager.closePluginView).not.toHaveBeenCalled();
  });

  it('attempts cleanup via lasso + deleteLassoElements when some inserts succeeded', async () => {
    asMock(PluginCommAPI.insertGeometry)
      .mockResolvedValueOnce({success: true})
      .mockResolvedValueOnce({success: true})
      .mockResolvedValueOnce({success: false, error: {message: 'boom'}});

    const tree = buildSmallTree();
    await expect(insertMindmap({tree})).rejects.toThrow(/boom/);

    // One lasso call for cleanup (no final full-map lasso, since we
    // never reached that step).
    expect(PluginCommAPI.lassoElements).toHaveBeenCalledTimes(1);
    expect(PluginCommAPI.deleteLassoElements).toHaveBeenCalledTimes(1);
  });

  it('skips cleanup when no geometries were inserted', async () => {
    asMock(PluginCommAPI.insertGeometry).mockResolvedValueOnce({
      success: false,
      error: {message: 'failed on first geometry'},
    });

    const tree = buildSmallTree();
    await expect(insertMindmap({tree})).rejects.toThrow(
      /failed on first geometry/,
    );

    expect(PluginCommAPI.lassoElements).not.toHaveBeenCalled();
    expect(PluginCommAPI.deleteLassoElements).not.toHaveBeenCalled();
  });

  it('swallows cleanup failures and still re-raises the original error', async () => {
    asMock(PluginCommAPI.insertGeometry)
      .mockResolvedValueOnce({success: true})
      .mockResolvedValueOnce({
        success: false,
        error: {message: 'primary error'},
      });
    asMock(PluginCommAPI.lassoElements).mockRejectedValueOnce(
      new Error('cleanup lasso failed'),
    );

    const tree = buildSmallTree();
    await expect(insertMindmap({tree})).rejects.toThrow(/primary error/);
  });

  it('re-raises a lassoElements failure at the end of insert', async () => {
    asMock(PluginCommAPI.lassoElements)
      // First call is the §F-IN-3 post-insert lasso; second call is
      // the §F-IN-5 cleanup lasso, allowed to succeed so the cleanup
      // path doesn't mask the original error.
      .mockResolvedValueOnce({
        success: false,
        error: {message: 'lassoElements failed'},
      })
      .mockResolvedValueOnce({success: true});

    const tree = buildSmallTree();
    await expect(insertMindmap({tree})).rejects.toThrow(
      /lassoElements failed/,
    );
    expect(PluginManager.closePluginView).not.toHaveBeenCalled();
    // Cleanup ran because every insertGeometry succeeded first.
    expect(PluginCommAPI.deleteLassoElements).toHaveBeenCalledTimes(1);
  });
});

describe('insertMindmap — marker capacity (§F-PE-4)', () => {
  it('throws MarkerCapacityError before touching the page when tree exceeds the cap', async () => {
    // MARKER_PUBLISHED_NODE_CAP + 1 nodes (root + cap-many children
    // trips the ceiling by one).
    const tree = createTree();
    for (let i = 0; i < MARKER_PUBLISHED_NODE_CAP; i += 1) {
      addChild(tree, tree.rootId);
    }

    let thrown: unknown;
    try {
      await insertMindmap({tree});
    } catch (err) {
      thrown = err;
    }
    expect(thrown).toBeInstanceOf(MarkerCapacityError);
    if (thrown instanceof MarkerCapacityError) {
      // N = 1 (root) + MARKER_PUBLISHED_NODE_CAP children.
      expect(thrown.nodeCount).toBe(MARKER_PUBLISHED_NODE_CAP + 1);
    }

    // No geometry was ever inserted: emitGeometries throws before
    // the insertion loop. No lasso, no cleanup, no plugin close.
    expect(PluginCommAPI.insertGeometry).not.toHaveBeenCalled();
    expect(PluginCommAPI.lassoElements).not.toHaveBeenCalled();
    expect(PluginCommAPI.deleteLassoElements).not.toHaveBeenCalled();
    expect(PluginManager.closePluginView).not.toHaveBeenCalled();
  });

  it('accepts a tree exactly at the published node cap', async () => {
    // MARKER_PUBLISHED_NODE_CAP total nodes: root + (cap-1) children.
    const tree = createTree();
    for (let i = 0; i < MARKER_PUBLISHED_NODE_CAP - 1; i += 1) {
      addChild(tree, tree.rootId);
    }

    await expect(insertMindmap({tree})).resolves.toBeUndefined();
    const insertCalls = asMock(PluginCommAPI.insertGeometry).mock.calls;
    // cap nodes × 1 outline + (cap-1) connectors = 2*cap - 1 non-marker.
    expect(nonMarkerInserts(insertCalls).length).toBe(
      2 * MARKER_PUBLISHED_NODE_CAP - 1,
    );
  });
});
