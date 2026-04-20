/**
 * Tests for src/insert.ts — the §F-IN-1..F-IN-5 orchestrator.
 *
 * Mocks sn-plugin-lib's PluginCommAPI / PluginFileAPI / PluginManager
 * so the whole insert path is exercised without a device. Covers:
 *   - §F-IN-1 page-size fall-through at every step
 *   - §F-IN-2 / §8.6 auto-expansion of collapsed subtrees
 *   - §F-IN-3 order-of-calls (insertElements × 1 → lassoElements →
 *     closePluginView) plus showLassoAfterInsert:false on every
 *     inserted geometry; plus the sequential insertGeometry fallback
 *     when the note context is unresolvable
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
    insertElements: jest.fn().mockResolvedValue({success: true}),
  },
  PluginManager: {
    closePluginView: jest.fn().mockResolvedValue(true),
  },
}));

import {PluginCommAPI, PluginFileAPI, PluginManager} from 'sn-plugin-lib';

import type {Geometry, Point, Rect} from '../src/geometry';
import {
  DEFAULT_PAGE_HEIGHT,
  DEFAULT_PAGE_WIDTH,
  INSERT_MARGIN_PX,
  insertMindmap,
  type PreEditContext,
} from '../src/insert';
import {radialLayout} from '../src/layout/radial';
import {
  MARKER_PEN_COLOR,
  MARKER_PUBLISHED_NODE_CAP,
  MarkerCapacityError,
} from '../src/marker/encode';
import type {StrokeBucket} from '../src/model/strokes';
import {
  addChild,
  createTree,
  deleteSubtree,
  setCollapsed,
  type NodeId,
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

/**
 * Structural view of an emitted geometry. Tests reach into
 * `.points` / `.penColor` / `.showLassoAfterInsert` regardless of
 * the concrete union arm (polygon, line, circle, ellipse). The
 * Geometry discriminated union hides `points` on the circle/ellipse
 * arms which the suite never exercises — keep this view intentionally
 * loose so lasso/fit-to-page assertions don't need per-arm narrowing.
 */
type InsertedGeometry = {
  type?: string;
  penColor?: number;
  penType?: number;
  penWidth?: number;
  showLassoAfterInsert?: boolean;
  points?: Point[];
};

/**
 * Unified view over the emitted geometries, independent of which
 * firmware path insertMindmap actually used. The batched path
 * (PluginFileAPI.insertElements) wraps each geometry as
 * `{type: 700, geometry}` and passes the array in a single call;
 * the fallback path (PluginCommAPI.insertGeometry) calls once per
 * geometry. Returning an `Array<[InsertedGeometry]>` matches the
 * existing per-call shape that the rest of this suite was written
 * against.
 *
 * Tests that explicitly want to exercise one path or the other
 * should still assert on the underlying mock directly (e.g.
 * `expect(PluginFileAPI.insertElements).toHaveBeenCalledTimes(1)`).
 * `getInsertedGeometries` is for the many assertions that only
 * care about the geometry list's contents and order.
 */
function getInsertedGeometries(): Array<[InsertedGeometry]> {
  const batchCalls = asMock(PluginFileAPI.insertElements).mock.calls;
  if (batchCalls.length > 0) {
    const out: Array<[InsertedGeometry]> = [];
    for (const call of batchCalls) {
      const elements = call[2] as Array<{geometry: InsertedGeometry}>;
      for (const element of elements) {
        out.push([element.geometry]);
      }
    }
    return out;
  }
  return asMock(PluginCommAPI.insertGeometry).mock.calls as Array<
    [InsertedGeometry]
  >;
}

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
  asMock(PluginFileAPI.insertElements).mockClear();
  asMock(PluginFileAPI.insertElements).mockResolvedValue({success: true});
  asMock(PluginManager.closePluginView).mockClear();
  asMock(PluginManager.closePluginView).mockResolvedValue(true);
}

/**
 * Force the fallback per-geometry insertGeometry path by making the
 * note-context resolution fall through to defaults. The fallback
 * path lets tests simulate mid-stream failures (resolves 2 inserts,
 * rejects the 3rd) that don't have a corresponding semantic in the
 * batched insertElements path.
 */
function forceSequentialInsertPath(): void {
  asMock(PluginCommAPI.getCurrentFilePath).mockResolvedValueOnce({
    success: false,
  });
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

  it('batches every emitted geometry into a single insertElements call, then lassos, then closes', async () => {
    const tree = buildSmallTree();
    await insertMindmap({tree});

    // Fast path — a single PluginFileAPI.insertElements call carries
    // every emitted geometry, wrapped as Element-typed records.
    expect(PluginFileAPI.insertElements).toHaveBeenCalledTimes(1);
    expect(PluginCommAPI.insertGeometry).not.toHaveBeenCalled();

    const [notePath, page, elements] = asMock(PluginFileAPI.insertElements)
      .mock.calls[0];
    expect(notePath).toBe('/note/test.note');
    expect(page).toBe(0);

    // 4 outlines (root + 3 children) + 3 connectors = 7 non-marker;
    // the balance is marker strokes (penColor 0x9D). Plus at least one
    // marker stroke — the root-containing tree always produces some.
    const insertCalls = getInsertedGeometries();
    expect(insertCalls.length).toBe(elements.length);
    expect(nonMarkerInserts(insertCalls).length).toBe(7);
    expect(insertCalls.length).toBeGreaterThan(7);
    expect(PluginCommAPI.lassoElements).toHaveBeenCalledTimes(1);
    expect(PluginManager.closePluginView).toHaveBeenCalledTimes(1);

    // Order: lasso fires after insertElements, close fires after the
    // lasso. Jest's mock.invocationCallOrder gives a global monotonic
    // counter across all mocks so we can assert the relative sequence
    // directly.
    const insertOrder = asMock(PluginFileAPI.insertElements).mock
      .invocationCallOrder[0];
    const lassoOrder = asMock(PluginCommAPI.lassoElements).mock
      .invocationCallOrder[0];
    const closeOrder = asMock(PluginManager.closePluginView).mock
      .invocationCallOrder[0];

    expect(lassoOrder).toBeGreaterThan(insertOrder);
    expect(closeOrder).toBeGreaterThan(lassoOrder);
  });

  it('wraps every inserted geometry as an Element of TYPE_GEO (700)', async () => {
    const tree = buildSmallTree();
    await insertMindmap({tree});

    const [, , elements] = asMock(PluginFileAPI.insertElements).mock.calls[0];
    for (const element of elements) {
      expect(element.type).toBe(700);
      expect(element.geometry).toBeDefined();
    }
  });

  it('forces showLassoAfterInsert:false on every inserted geometry (§F-IN-3)', async () => {
    const tree = buildSmallTree();
    await insertMindmap({tree});

    const insertCalls = getInsertedGeometries();
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
    const insertCalls = getInsertedGeometries();
    for (const [geometry] of insertCalls) {
      for (const p of geometry.points ?? []) {
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
    const insertCalls = getInsertedGeometries();
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
  it('uses defaults when getCurrentFilePath rejects, and falls back to per-geometry insertGeometry', async () => {
    asMock(PluginCommAPI.getCurrentFilePath).mockRejectedValueOnce(
      new Error('native bridge unavailable'),
    );

    const tree = createTree();
    await insertMindmap({tree});

    expect(PluginFileAPI.getPageSize).not.toHaveBeenCalled();
    // No note context → batched insertElements path is skipped.
    expect(PluginFileAPI.insertElements).not.toHaveBeenCalled();
    expect(PluginCommAPI.insertGeometry).toHaveBeenCalled();
    // Root center should land in the middle of the default page.
    const [firstGeom] = getInsertedGeometries()[0];
    const xs = (firstGeom.points ?? []).map((p: {x: number}) => p.x);
    const ys = (firstGeom.points ?? []).map((p: {y: number}) => p.y);
    const cx = (Math.min(...xs) + Math.max(...xs)) / 2;
    const cy = (Math.min(...ys) + Math.max(...ys)) / 2;
    expect(cx).toBeCloseTo(DEFAULT_PAGE_WIDTH / 2, 0);
    expect(cy).toBeCloseTo(DEFAULT_PAGE_HEIGHT / 2, 0);
  });

  it('uses defaults when getPageSize returns success:false, and falls back to per-geometry insertGeometry', async () => {
    asMock(PluginFileAPI.getPageSize).mockResolvedValueOnce({success: false});

    const tree = createTree();
    await insertMindmap({tree});

    expect(PluginFileAPI.getPageSize).toHaveBeenCalledTimes(1);
    expect(PluginFileAPI.insertElements).not.toHaveBeenCalled();
    expect(PluginCommAPI.insertGeometry).toHaveBeenCalled();
    const [firstGeom] = getInsertedGeometries()[0];
    const xs = (firstGeom.points ?? []).map((p: {x: number}) => p.x);
    const cx = (Math.min(...xs) + Math.max(...xs)) / 2;
    expect(cx).toBeCloseTo(DEFAULT_PAGE_WIDTH / 2, 0);
  });

  it('uses the returned page size when every step succeeds, and hits the batched insertElements path', async () => {
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
    // Batched path — insertElements targets the same note+page.
    expect(PluginFileAPI.insertElements).toHaveBeenCalledTimes(1);
    const [notePath, page] = asMock(PluginFileAPI.insertElements).mock
      .calls[0];
    expect(notePath).toBe('/note/landscape.note');
    expect(page).toBe(5);

    const [firstGeom] = getInsertedGeometries()[0];
    const xs = (firstGeom.points ?? []).map((p: {x: number}) => p.x);
    const ys = (firstGeom.points ?? []).map((p: {y: number}) => p.y);
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

    const [firstGeom] = getInsertedGeometries()[0];
    const xs = (firstGeom.points ?? []).map((p: {x: number}) => p.x);
    const ys = (firstGeom.points ?? []).map((p: {y: number}) => p.y);
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
    const [firstGeom] = getInsertedGeometries()[0];
    const xs = (firstGeom.points ?? []).map((p: {x: number}) => p.x);
    const ys = (firstGeom.points ?? []).map((p: {y: number}) => p.y);
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
  it('re-raises a batched insertElements failure and does not call close', async () => {
    asMock(PluginFileAPI.insertElements).mockResolvedValueOnce({
      success: false,
      error: {message: 'simulated: insertElements rejected batch'},
    });

    const tree = buildSmallTree();
    await expect(insertMindmap({tree})).rejects.toThrow(
      /insertElements rejected batch/,
    );
    expect(PluginManager.closePluginView).not.toHaveBeenCalled();
    // Batched failure is all-or-nothing; nothing landed on the page so
    // no cleanup lasso / delete should fire.
    expect(PluginCommAPI.lassoElements).not.toHaveBeenCalled();
    expect(PluginCommAPI.deleteLassoElements).not.toHaveBeenCalled();
  });

  it('re-raises the sequential insertGeometry error and does not call close (fallback path)', async () => {
    forceSequentialInsertPath();
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

  it('attempts cleanup via lasso + deleteLassoElements when some inserts succeeded (fallback path)', async () => {
    forceSequentialInsertPath();
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

  it('skips cleanup when no geometries were inserted (fallback path)', async () => {
    forceSequentialInsertPath();
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

  it('swallows cleanup failures and still re-raises the original error (fallback path)', async () => {
    forceSequentialInsertPath();
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

  it('re-raises a lassoElements failure at the end of a batched insert, and cleans up the whole batch', async () => {
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
    // Cleanup ran because insertElements succeeded before the lasso
    // step failed — the whole batch is on the page and needs to go.
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
    expect(PluginFileAPI.insertElements).not.toHaveBeenCalled();
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
    const insertCalls = getInsertedGeometries();
    // cap nodes × 1 outline + (cap-1) connectors = 2*cap - 1 non-marker.
    expect(nonMarkerInserts(insertCalls).length).toBe(
      2 * MARKER_PUBLISHED_NODE_CAP - 1,
    );
  });
});

describe('insertMindmap — Save round-trip (§F-ED-7)', () => {
  /**
   * Minimal stroke fixture at a known page-coord position. We use
   * polylines (GEO_polygon / straightLine) because they carry a
   * `points` array that makes before/after translation assertions
   * direct: every point shifts by the same (dx, dy).
   *
   * penType=10 (Fineliner) satisfies the firmware allow-list; tests
   * that filter by pen color use 0x00 (black) so a simple filter
   * separates preserved strokes from the 0x9D marker bits.
   */
  function polyline(points: Array<{x: number; y: number}>): Geometry {
    return {
      type: 'GEO_polygon',
      points,
      penColor: 0x00,
      penType: 10,
      penWidth: 400,
      showLassoAfterInsert: true,
    };
  }

  /**
   * Extract preserved-stroke inserts from the insertGeometry mock
   * call log. Preserved strokes survive emit with their original
   * `points` array translated by the move delta, so we can
   * fingerprint them by their fixture's exact point count (2) —
   * rectangular outlines are 5-point closed polygons, oval outlines
   * sample at 64+ points, and marker strokes carry penColor 0x9D.
   * A 2-point GEO_polygon with penColor != marker is always one of
   * our preserved fixtures.
   */
  function preservedStrokeInserts(
    insertCalls: Array<[InsertedGeometry]>,
  ): Array<Array<{x: number; y: number}>> {
    const out: Array<Array<{x: number; y: number}>> = [];
    for (const [g] of insertCalls) {
      if (g.type !== 'GEO_polygon' || g.penColor === MARKER_PEN_COLOR) {
        continue;
      }
      const pts = g.points;
      if (!pts || pts.length !== 2) {
        continue;
      }
      out.push(pts);
    }
    return out;
  }

  /**
   * Re-capture per-node page bboxes that insertMindmap just produced.
   * Used by tests to assert that strokes landed at the expected
   * post-edit page coordinates. We compute it the same way
   * insertMindmap does: radialLayout + fit-to-page, so the numbers
   * stay in sync with the orchestrator without poking at private
   * helpers.
   */
  function postEditPageBboxes(tree: Tree): Map<NodeId, Rect> {
    const base = radialLayout(tree);
    const available = DEFAULT_PAGE_WIDTH - 2 * INSERT_MARGIN_PX;
    const availableH = DEFAULT_PAGE_HEIGHT - 2 * INSERT_MARGIN_PX;
    const scale = Math.min(
      1,
      available / Math.max(1, base.unionBbox.w),
      availableH / Math.max(1, base.unionBbox.h),
    );
    const scaledU = {
      x: base.unionBbox.x * scale,
      y: base.unionBbox.y * scale,
      w: base.unionBbox.w * scale,
      h: base.unionBbox.h * scale,
    };
    const tx = DEFAULT_PAGE_WIDTH / 2 - (scaledU.x + scaledU.w / 2);
    const ty = DEFAULT_PAGE_HEIGHT / 2 - (scaledU.y + scaledU.h / 2);
    const out = new Map<NodeId, Rect>();
    for (const [id, r] of base.bboxes) {
      out.set(id, {
        x: r.x * scale + tx,
        y: r.y * scale + ty,
        w: r.w * scale,
        h: r.h * scale,
      });
    }
    return out;
  }

  it('calls deleteLassoElements BEFORE the batched insertElements call when preEdit is present', async () => {
    const tree = buildSmallTree();
    const post = postEditPageBboxes(tree);
    // Fabricate a matching pre-edit: identical bboxes (delta=0) so
    // the "clears old mindmap" assertion doesn't depend on the
    // delta math. Empty stroke bucket — this test is about
    // ordering, not stroke translation.
    const preEdit: PreEditContext = {
      preEditPageBboxes: new Map(post),
      strokesByNodePage: new Map(),
    };

    await insertMindmap({tree, preEdit});

    expect(PluginCommAPI.deleteLassoElements).toHaveBeenCalledTimes(1);
    const delOrder = asMock(PluginCommAPI.deleteLassoElements).mock
      .invocationCallOrder[0];
    const insertOrder = asMock(PluginFileAPI.insertElements).mock
      .invocationCallOrder[0];
    expect(insertOrder).toBeGreaterThan(delOrder);
  });

  it('does NOT call deleteLassoElements on first-insert (preEdit undefined)', async () => {
    const tree = buildSmallTree();
    await insertMindmap({tree});

    // Successful first-insert: no pre-edit delete. The standard
    // §F-IN-3 post-insert lasso still fires exactly once.
    expect(PluginCommAPI.deleteLassoElements).not.toHaveBeenCalled();
    expect(PluginCommAPI.lassoElements).toHaveBeenCalledTimes(1);
  });

  it('aborts before any insert when deleteLassoElements fails', async () => {
    asMock(PluginCommAPI.deleteLassoElements).mockResolvedValueOnce({
      success: false,
      error: {message: 'simulated: delete refused'},
    });

    const tree = buildSmallTree();
    const post = postEditPageBboxes(tree);
    const preEdit: PreEditContext = {
      preEditPageBboxes: new Map(post),
      strokesByNodePage: new Map(),
    };

    await expect(insertMindmap({tree, preEdit})).rejects.toThrow(
      /delete refused/,
    );

    // No geometry was ever inserted and no cleanup lasso was needed
    // — the old mindmap is still on the page intact.
    expect(PluginCommAPI.insertGeometry).not.toHaveBeenCalled();
    expect(PluginFileAPI.insertElements).not.toHaveBeenCalled();
    expect(PluginCommAPI.lassoElements).not.toHaveBeenCalled();
    expect(PluginManager.closePluginView).not.toHaveBeenCalled();
  });

  it('translates a preserved stroke by the node move delta', async () => {
    // Pre-edit: root at an offset 100px right and 50px down from
    // where radialLayout would place it on a fresh page. Post-edit
    // layout lands at the centered page position. Move delta =
    // post − pre, applied to every stroke point.
    const tree = buildSmallTree();
    const post = postEditPageBboxes(tree);
    const rootPost = post.get(tree.rootId);
    if (!rootPost) {
      throw new Error('test bug: root missing from post-edit bboxes');
    }
    const rootPre: Rect = {
      x: rootPost.x + 100,
      y: rootPost.y + 50,
      w: rootPost.w,
      h: rootPost.h,
    };
    // A single 2-point polyline on the root, in PRE-edit page coords
    // — points relative to the pre-edit bbox position. Expected
    // post-edit points are shifted by (post − pre) = (−100, −50).
    const strokeP1 = {x: rootPre.x + 10, y: rootPre.y + 20};
    const strokeP2 = {x: rootPre.x + 30, y: rootPre.y + 40};
    const strokesByNodePage: StrokeBucket = new Map();
    strokesByNodePage.set(tree.rootId, [polyline([strokeP1, strokeP2])]);

    const preEditPageBboxes = new Map<NodeId, Rect>();
    // Only the root carries a preserved stroke for this test; other
    // nodes can have identical pre/post bboxes (delta=0) since no
    // strokes are keyed on them.
    for (const [id, bb] of post) {
      preEditPageBboxes.set(id, id === tree.rootId ? rootPre : bb);
    }

    await insertMindmap({
      tree,
      preEdit: {preEditPageBboxes, strokesByNodePage},
    });

    // The bucketed stroke reached emitGeometries and was inserted.
    const preservedPointLists = preservedStrokeInserts(
      getInsertedGeometries(),
    );
    expect(preservedPointLists).toHaveLength(1);
    const [pts] = preservedPointLists;
    expect(pts).toEqual([
      {x: strokeP1.x - 100, y: strokeP1.y - 50},
      {x: strokeP2.x - 100, y: strokeP2.y - 50},
    ]);
    // And these coincide with (rootPost.x + 10, rootPost.y + 20) etc.
    expect(pts[0]).toEqual({x: rootPost.x + 10, y: rootPost.y + 20});
    expect(pts[1]).toEqual({x: rootPost.x + 30, y: rootPost.y + 40});
  });

  it('drops strokes for nodes that were deleted during the edit session', async () => {
    // Build a tree with one child, run the delete via deleteSubtree
    // so the post-edit tree only has the root. The pre-edit bbox
    // map still includes the child (that's the "pre-edit"
    // snapshot), and its stroke bucket should be silently dropped —
    // no throw, no emit.
    const tree = createTree();
    const childId = addChild(tree, tree.rootId);
    // Pre-edit: both the root and the (still-present) child had
    // page bboxes at known locations.
    const preEditPageBboxes = new Map<NodeId, Rect>([
      [tree.rootId, {x: 700, y: 900, w: 220, h: 96}],
      [childId, {x: 1000, y: 900, w: 220, h: 96}],
    ]);
    const strokesByNodePage: StrokeBucket = new Map();
    strokesByNodePage.set(childId, [
      polyline([
        {x: 1010, y: 910},
        {x: 1050, y: 950},
      ]),
    ]);
    // Now delete the child — post-edit tree has root only.
    deleteSubtree(tree, childId);
    expect(tree.nodesById.has(childId)).toBe(false); // sanity

    await insertMindmap({
      tree,
      preEdit: {preEditPageBboxes, strokesByNodePage},
    });

    // The child's stroke was dropped because the child no longer
    // exists in the post-edit tree. No preserved strokes reached
    // emitGeometries.
    const preservedPointLists = preservedStrokeInserts(
      getInsertedGeometries(),
    );
    expect(preservedPointLists).toHaveLength(0);
  });

  it('drops strokes when the pre-edit bbox map is missing a node (defensive)', async () => {
    // Associator/decoder mismatch: a stroke is bucketed on a node
    // id that isn't in the pre-edit bbox map. We can't compute a
    // move delta without a pre bbox, so the bucket must be dropped
    // silently rather than crashing the whole Save.
    const tree = buildSmallTree();
    const post = postEditPageBboxes(tree);
    // Deliberately empty pre-edit bbox map.
    const preEditPageBboxes = new Map<NodeId, Rect>();
    const strokesByNodePage: StrokeBucket = new Map();
    strokesByNodePage.set(tree.rootId, [
      polyline([
        {x: 500, y: 500},
        {x: 550, y: 550},
      ]),
    ]);

    await expect(
      insertMindmap({
        tree,
        preEdit: {preEditPageBboxes, strokesByNodePage},
      }),
    ).resolves.toBeUndefined();

    const insertCalls = getInsertedGeometries();
    const preservedPointLists = preservedStrokeInserts(insertCalls);
    expect(preservedPointLists).toHaveLength(0);
    // Delete still happened, even though no strokes were preserved.
    expect(PluginCommAPI.deleteLassoElements).toHaveBeenCalledTimes(1);
    // Sanity: non-preserved emits (outlines + connectors + marker)
    // still went through for the new map.
    expect(post.size).toBe(4); // buildSmallTree: root + 3 children
    expect(nonMarkerInserts(insertCalls).length).toBe(7);
  });

  it('cleanup path still runs when preEdit is present and insert fails mid-stream (fallback path)', async () => {
    // After the pre-edit delete succeeds, simulate an insertGeometry
    // failure partway through. §F-IN-5 cleanup should still run
    // (lasso + delete on the partial emit), re-raising the original
    // insert error. The pre-edit delete has already fired and is
    // counted separately from the cleanup delete.
    //
    // Mid-stream failure only has a meaning on the sequential
    // insertGeometry fallback — the batched insertElements call is
    // all-or-nothing. forceSequentialInsertPath() drives the
    // orchestrator into the per-geometry loop so this scenario can
    // be exercised.
    forceSequentialInsertPath();
    asMock(PluginCommAPI.insertGeometry)
      .mockResolvedValueOnce({success: true})
      .mockResolvedValueOnce({success: true})
      .mockResolvedValueOnce({
        success: false,
        error: {message: 'simulated: insert failed mid-stream'},
      });

    const tree = buildSmallTree();
    const post = postEditPageBboxes(tree);
    const preEdit: PreEditContext = {
      preEditPageBboxes: new Map(post),
      strokesByNodePage: new Map(),
    };

    await expect(insertMindmap({tree, preEdit})).rejects.toThrow(
      /insert failed mid-stream/,
    );

    // Two deletes total: one for the pre-edit mindmap (step 0), one
    // for the §F-IN-5 cleanup of the partial new emit.
    expect(PluginCommAPI.deleteLassoElements).toHaveBeenCalledTimes(2);
    // Cleanup lasso ran (and it's the only lasso — the final
    // §F-IN-3 auto-lasso is skipped on failure).
    expect(PluginCommAPI.lassoElements).toHaveBeenCalledTimes(1);
    expect(PluginManager.closePluginView).not.toHaveBeenCalled();
  });
});
