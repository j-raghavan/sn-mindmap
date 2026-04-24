/**
 * Tests for src/insert.ts — the §F-IN-1..F-IN-5 orchestrator.
 *
 * Mocks sn-plugin-lib's PluginCommAPI / PluginFileAPI / PluginManager /
 * Element so the whole insert path is exercised without a device.
 * Covers:
 *   - §F-IN-1 page-size fall-through at every step
 *   - §F-IN-2 / §8.6 auto-expansion of collapsed subtrees
 *   - §F-IN-3 order-of-calls: createElement × N → getElements →
 *     replaceElements → lassoElements → closePluginView. Batched
 *     replaceElements is the viable batched path on this firmware
 *     (confirmed on-device 04-24 08:45 probe run); the older
 *     per-geometry insertGeometry loop was ~80 seconds and is gone.
 *   - §F-IN-4 plugin-view dismissal
 *   - §F-IN-5 atomic failure semantics (replaceElements is
 *     all-or-nothing, so there is no partial-insert cleanup to do —
 *     a failed replaceElements throws and the page stays untouched)
 *   - §F-LY-6 fit-to-page scaling + page-centering of the union rect
 *
 * We intentionally don't re-test emitGeometries' internals here —
 * those live in __tests__/emitGeometries.test.ts. The contract
 * exercised here is the orchestration around emit, not emit itself.
 */
jest.mock('sn-plugin-lib', () => {
  // Helper: produce a fresh native-like Element object for each
  // createElement call. Mirrors the shape of the real Element
  // returned by PluginCommAPI.createElement on device — pageNum,
  // layerNum, thickness, geometry are populated by insertMindmap
  // after createElement returns. `uuid` is unique per call so tests
  // can verify N distinct Elements landed in replaceElements.
  let uuidCounter = 0;
  const mintElement = () => ({
    uuid: `test-uuid-${uuidCounter++}`,
    type: 700,
    pageNum: 0,
    layerNum: 0,
    thickness: 0,
    geometry: null as unknown,
  });
  return {
    Element: {TYPE_GEO: 700},
    PluginCommAPI: {
      createElement: jest
        .fn()
        .mockImplementation(async () => ({success: true, result: mintElement()})),
      insertGeometry: jest.fn().mockResolvedValue({success: true}),
      getCurrentFilePath: jest
        .fn()
        .mockResolvedValue({success: true, result: '/note/test.note'}),
      getCurrentPageNum: jest
        .fn()
        .mockResolvedValue({success: true, result: 0}),
      lassoElements: jest.fn().mockResolvedValue({success: true}),
      deleteLassoElements: jest.fn().mockResolvedValue({success: true}),
      setLassoBoxState: jest.fn().mockResolvedValue({success: true}),
      reloadFile: jest.fn().mockResolvedValue({success: true}),
    },
    PluginFileAPI: {
      getPageSize: jest.fn().mockResolvedValue({
        success: true,
        result: {width: 1404, height: 1872},
      }),
      getElements: jest.fn().mockResolvedValue({success: true, result: []}),
      replaceElements: jest.fn().mockResolvedValue({success: true}),
    },
    PluginManager: {
      closePluginView: jest.fn().mockResolvedValue(true),
    },
  };
});

import {PluginCommAPI, PluginFileAPI, PluginManager} from 'sn-plugin-lib';

import type {Point} from '../src/geometry';
import {
  DEFAULT_PAGE_HEIGHT,
  DEFAULT_PAGE_WIDTH,
  INSERT_MARGIN_PX,
  insertMindmap,
} from '../src/insert';
import {radialLayout} from '../src/layout/radial';
import {
  addChild,
  createTree,
  setCollapsed,
  type Tree,
} from '../src/model/tree';

/**
 * Count-helper identity. The emit today is just outlines + connectors
 * (marker strokes were removed with the edit/decode pipeline), so
 * there is nothing to filter out — but tests downstream still talk in
 * terms of "non-marker inserts", which is now synonymous with every
 * inserted geometry.
 */
function nonMarkerInserts(
  insertCalls: Array<[{penColor?: number; type?: string}]>,
): Array<[{penColor?: number; type?: string}]> {
  return insertCalls;
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
 * View over the emitted geometries. insertMindmap now calls
 * PluginFileAPI.replaceElements once with an array of Elements
 * (each Element carries its geometry in `.geometry`). This helper
 * walks the most recent replaceElements call, skips any pre-existing
 * elements the mock returned from getElements, and yields a
 * `[InsertedGeometry][]` shape that matches the legacy insertGeometry
 * mock.calls shape so assertions elsewhere don't need to change.
 */
function getInsertedGeometries(): Array<[InsertedGeometry]> {
  const calls = asMock(PluginFileAPI.replaceElements).mock.calls;
  if (calls.length === 0) {
    return [];
  }
  const latest = calls[calls.length - 1];
  const combined = latest[2] as Array<{geometry?: InsertedGeometry}>;
  // Existing page elements fed in by the getElements mock land at the
  // front of `combined`; our newly-minted elements sit at the tail.
  // We drop any leading element whose `.geometry` is falsy — the
  // mintElement factory initialises `.geometry` to null and
  // insertMindmap overwrites it with the emitted Geometry, so every
  // real insert has a truthy `.geometry`.
  return combined
    .filter(el => el?.geometry !== null && el?.geometry !== undefined)
    .map(el => [el.geometry as InsertedGeometry]);
}

function resetMocks() {
  // createElement mints a fresh native-like Element per call. Tests
  // that want to observe all N elements should read
  // replaceElements.mock.calls; this factory guarantees each Element
  // carries a unique uuid so duplicate-detection assertions work.
  let uuidCounter = 0;
  asMock(PluginCommAPI.createElement).mockReset();
  asMock(PluginCommAPI.createElement).mockImplementation(async () => ({
    success: true,
    result: {
      uuid: `test-uuid-${uuidCounter++}`,
      type: 700,
      pageNum: 0,
      layerNum: 0,
      thickness: 0,
      geometry: null,
    },
  }));
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
  asMock(PluginFileAPI.getElements).mockClear();
  asMock(PluginFileAPI.getElements).mockResolvedValue({success: true, result: []});
  asMock(PluginFileAPI.replaceElements).mockClear();
  asMock(PluginFileAPI.replaceElements).mockResolvedValue({success: true});
  asMock(PluginCommAPI.setLassoBoxState).mockClear();
  asMock(PluginCommAPI.setLassoBoxState).mockResolvedValue({success: true});
  asMock(PluginCommAPI.reloadFile).mockClear();
  asMock(PluginCommAPI.reloadFile).mockResolvedValue({success: true});
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

  it('replaceElements fires once with every emitted geometry, then reloads, then closes', async () => {
    const tree = buildSmallTree();
    await insertMindmap({tree});

    // 4 outlines (root + 3 children) + 3 connectors = 7 geometries
    // total. No marker strokes — the marker / decode pipeline was
    // removed along with edit-mode.
    const insertCalls = getInsertedGeometries();
    expect(insertCalls.length).toBe(7);
    expect(PluginFileAPI.replaceElements).toHaveBeenCalledTimes(1);
    // setLassoBoxState(2) is only meaningful after an explicit lasso,
    // which our flow never does — confirmed on device by APIError 904
    // "No lasso action has been performed". The call is skipped.
    expect(PluginCommAPI.setLassoBoxState).not.toHaveBeenCalled();
    expect(PluginCommAPI.reloadFile).toHaveBeenCalledTimes(1);
    expect(PluginManager.closePluginView).toHaveBeenCalledTimes(1);

    // Order: replaceElements → reloadFile → close.
    const replaceOrder = asMock(PluginFileAPI.replaceElements).mock
      .invocationCallOrder[0];
    const reloadOrder = asMock(PluginCommAPI.reloadFile).mock
      .invocationCallOrder[0];
    const closeOrder = asMock(PluginManager.closePluginView).mock
      .invocationCallOrder[0];
    expect(reloadOrder).toBeGreaterThan(replaceOrder);
    expect(closeOrder).toBeGreaterThan(reloadOrder);
  });

  it('passes showLassoAfterInsert:false through to every inserted geometry (§F-IN-3)', async () => {
    // emitGeometries sets showLassoAfterInsert:false on every
    // emitted geometry so the host doesn't auto-lasso anything in
    // the batched write. Post-insert we explicitly clear the lasso
    // with setLassoBoxState(2) to leave the pen in write mode.
    const tree = buildSmallTree();
    await insertMindmap({tree});

    const insertCalls = getInsertedGeometries();
    for (const [geometry] of insertCalls) {
      expect(geometry.showLassoAfterInsert).toBe(false);
    }
  });

  it('rounds every emitted geometry point to integers before insertGeometry (native firmware banner guard)', async () => {
    // Regression guard for the native firmware toast
    //   "Invalid API parameters. Cannot call the API. Please check
    //    parameter validity!"
    // which surfaces from com.ratta.supernote.note's insertPageTrails
    // when polygon/line points arrive as floats. sn-plugin-lib's
    // JS-side GeometrySchema does NOT enforce integer x/y (PointSchema
    // only checks `{x: number, y: number}`), so radial-layout fractional
    // coords pass JS validation but are rejected host-side. Rounding at
    // the insertGeometry boundary (roundGeometryPoints) is required.
    const tree = buildSmallTree();
    await insertMindmap({tree});

    const insertCalls = getInsertedGeometries();
    for (const [geometry] of insertCalls) {
      for (const p of geometry.points ?? []) {
        expect(Number.isInteger(p.x)).toBe(true);
        expect(Number.isInteger(p.y)).toBe(true);
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
  it('throws when getCurrentFilePath rejects (notePath required for replaceElements)', async () => {
    // replaceElements needs an explicit notePath + page index; there is
    // no implicit "current page" fallback. A note-context resolution
    // failure is therefore terminal in the batched path — the UI layer
    // surfaces the error banner and the user retries.
    asMock(PluginCommAPI.getCurrentFilePath).mockRejectedValueOnce(
      new Error('native bridge unavailable'),
    );

    const tree = createTree();
    await expect(insertMindmap({tree})).rejects.toThrow(
      /notePath\/page/,
    );
    expect(PluginFileAPI.getPageSize).not.toHaveBeenCalled();
    expect(PluginFileAPI.replaceElements).not.toHaveBeenCalled();
  });

  it('throws when getPageSize returns success:false (notePath required)', async () => {
    asMock(PluginFileAPI.getPageSize).mockResolvedValueOnce({success: false});

    const tree = createTree();
    await expect(insertMindmap({tree})).rejects.toThrow(
      /notePath\/page/,
    );
    expect(PluginFileAPI.getPageSize).toHaveBeenCalledTimes(1);
    expect(PluginFileAPI.replaceElements).not.toHaveBeenCalled();
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
    // Tolerance widened to ±1 to accommodate integer rounding at the
    // insertElements boundary (wrapGeometryAsElement rounds every
    // point.x/y to integers — the native firmware rejects fractional
    // coords, see roundGeometryPoints). The max-min of rounded coords
    // can drift by up to ±1 from the pre-rounding float value.
    expect(Math.abs(width - 220 * expectedScale)).toBeLessThanOrEqual(1);
    expect(Math.abs(height - 96 * expectedScale)).toBeLessThanOrEqual(1);
  });

  it('centers the emitted geometries on the page', async () => {
    const tree = createTree();
    for (let i = 0; i < 6; i += 1) {
      addChild(tree, 0);
    }

    await insertMindmap({tree});

    // Walk every inserted geometry's points and derive their bbox;
    // that bbox should sit centered on the page.
    const insertCalls = getInsertedGeometries();
    let minX = Infinity;
    let minY = Infinity;
    let maxX = -Infinity;
    let maxY = -Infinity;
    for (const [geometry] of insertCalls) {
      for (const p of geometry.points ?? []) {
        if (p.x < minX) {
          minX = p.x;
        }
        if (p.y < minY) {
          minY = p.y;
        }
        if (p.x > maxX) {
          maxX = p.x;
        }
        if (p.y > maxY) {
          maxY = p.y;
        }
      }
    }
    const cx = (minX + maxX) / 2;
    const cy = (minY + maxY) / 2;
    expect(cx).toBeCloseTo(DEFAULT_PAGE_WIDTH / 2, 0);
    expect(cy).toBeCloseTo(DEFAULT_PAGE_HEIGHT / 2, 0);
  });
});

describe('insertMindmap — error + cleanup (§F-IN-5)', () => {
  it('re-raises a createElement failure and does not touch the page', async () => {
    // createElement failing mid-build aborts before replaceElements —
    // no geometries land on the page, so no cleanup is needed.
    let callCount = 0;
    asMock(PluginCommAPI.createElement).mockImplementation(async () => {
      callCount += 1;
      if (callCount === 2) {
        return {
          success: false,
          error: {message: 'simulated: createElement failed at index 1'},
        };
      }
      return {
        success: true,
        result: {
          uuid: `test-uuid-err-${callCount}`,
          type: 700,
          pageNum: 0,
          layerNum: 0,
          thickness: 0,
          geometry: null,
        },
      };
    });

    const tree = buildSmallTree();
    await expect(insertMindmap({tree})).rejects.toThrow(
      /createElement failed at index 1/,
    );
    expect(PluginFileAPI.replaceElements).not.toHaveBeenCalled();
    expect(PluginManager.closePluginView).not.toHaveBeenCalled();
  });

  it('re-raises a getElements failure and does not touch the page', async () => {
    asMock(PluginFileAPI.getElements).mockResolvedValueOnce({
      success: false,
      error: {message: 'simulated: getElements refused'},
    });

    const tree = buildSmallTree();
    await expect(insertMindmap({tree})).rejects.toThrow(
      /getElements refused/,
    );
    expect(PluginFileAPI.replaceElements).not.toHaveBeenCalled();
    expect(PluginManager.closePluginView).not.toHaveBeenCalled();
  });

  it('re-raises a replaceElements failure atomically (no partial-insert cleanup needed)', async () => {
    // replaceElements is all-or-nothing on the host side. On failure
    // the page is unchanged — there is no partial-insert state to
    // clean up, so lassoElements / deleteLassoElements are never
    // called. closePluginView is skipped so the UI stays open and
    // shows the error banner.
    asMock(PluginFileAPI.replaceElements).mockResolvedValueOnce({
      success: false,
      error: {message: 'simulated: replaceElements rejected'},
    });

    const tree = buildSmallTree();
    await expect(insertMindmap({tree})).rejects.toThrow(
      /replaceElements rejected/,
    );
    expect(PluginManager.closePluginView).not.toHaveBeenCalled();
    expect(PluginCommAPI.lassoElements).not.toHaveBeenCalled();
    expect(PluginCommAPI.deleteLassoElements).not.toHaveBeenCalled();
  });

  it('completes even if reloadFile returns failure', async () => {
    // reloadFile is post-write cosmetic housekeeping — the geometries
    // are already committed on the page by the time it fires. A
    // failure here does NOT roll back the insert; closePluginView
    // still fires so the user sees the inserted result.
    asMock(PluginCommAPI.reloadFile).mockResolvedValueOnce({
      success: false,
    });

    const tree = buildSmallTree();
    await expect(insertMindmap({tree})).resolves.toBeUndefined();
    expect(PluginFileAPI.replaceElements).toHaveBeenCalledTimes(1);
    expect(PluginManager.closePluginView).toHaveBeenCalledTimes(1);
    expect(PluginCommAPI.deleteLassoElements).not.toHaveBeenCalled();
  });

  it('falls back to the default "createElement failed" message when the host omits error.message', async () => {
    // The `?? 'unknown error'` nullish-coalesce branch fires when the
    // host rejects a createElement but doesn't populate error.message.
    asMock(PluginCommAPI.createElement).mockResolvedValueOnce({success: false});

    const tree = buildSmallTree();
    await expect(insertMindmap({tree})).rejects.toThrow(
      /createElement failed at index 0: unknown error/,
    );
    expect(PluginFileAPI.replaceElements).not.toHaveBeenCalled();
  });

  it('falls back to "getElements failed" when error.message is missing', async () => {
    asMock(PluginFileAPI.getElements).mockResolvedValueOnce({success: false});

    const tree = buildSmallTree();
    await expect(insertMindmap({tree})).rejects.toThrow(/getElements failed/);
    expect(PluginFileAPI.replaceElements).not.toHaveBeenCalled();
  });

  it('rejects when getElements returns success:true but a non-array result', async () => {
    // Second half of the getElements guard: `!Array.isArray(getRes.result)`.
    // Host contract guarantees an array, so the only way to hit this
    // branch is a malformed mock — same error message as the
    // success:false path, because the fallback string is shared.
    asMock(PluginFileAPI.getElements).mockResolvedValueOnce({
      success: true,
      result: {notAnArray: true},
    });

    const tree = buildSmallTree();
    await expect(insertMindmap({tree})).rejects.toThrow(/getElements failed/);
    expect(PluginFileAPI.replaceElements).not.toHaveBeenCalled();
  });

  it('falls back to "replaceElements failed" when error.message is missing', async () => {
    asMock(PluginFileAPI.replaceElements).mockResolvedValueOnce({success: false});

    const tree = buildSmallTree();
    await expect(insertMindmap({tree})).rejects.toThrow(/replaceElements failed/);
  });

  it('stringifies non-serialisable log details via the String(detail) fallback', async () => {
    // Force log()'s JSON.stringify to throw by feeding it a circular
    // object. reloadFile's result flows straight into
    // log('reloadFile:after', …) — returning a self-referencing object
    // drops the pipeline into the String(detail) fallback (catch arm
    // of log). The insert itself still completes, since reloadFile
    // failure is non-fatal.
    const circular: {success: boolean; self?: unknown} = {success: true};
    circular.self = circular;
    asMock(PluginCommAPI.reloadFile).mockResolvedValueOnce(circular);

    const tree = buildSmallTree();
    await expect(insertMindmap({tree})).resolves.toBeUndefined();
    expect(PluginFileAPI.replaceElements).toHaveBeenCalledTimes(1);
  });

  it('re-raises a non-Error thrown value via the String(err) branch of the outer catch', async () => {
    // The outer catch logs via
    //   `err instanceof Error ? err.message : String(err)`.
    // To exercise the false arm we throw a plain string from
    // createElement — the value propagates all the way back to the
    // insertMindmap caller unchanged.
    asMock(PluginCommAPI.createElement).mockImplementationOnce(async () => {
      throw 'plain string failure';
    });

    const tree = buildSmallTree();
    await expect(insertMindmap({tree})).rejects.toBe('plain string failure');
    expect(PluginFileAPI.replaceElements).not.toHaveBeenCalled();
  });

  it('swallows closePluginView rejection (fire-and-forget)', async () => {
    // closePluginView is fired but NOT awaited by insertMindmap — the
    // native bridge's response can lag and we don't want to pin the
    // caller's "Inserting…" UI state on it. A post-insert rejection
    // is logged via the err-arm of .then but must NOT propagate back
    // to the caller or trigger an unhandled-rejection warning.
    asMock(PluginManager.closePluginView).mockRejectedValueOnce(
      new Error('bridge closed'),
    );

    const tree = buildSmallTree();
    await expect(insertMindmap({tree})).resolves.toBeUndefined();
    expect(PluginManager.closePluginView).toHaveBeenCalledTimes(1);
    // Flush microtasks so the fire-and-forget rejection handler runs
    // before the test ends (otherwise Jest flags the unhandled rejection).
    await Promise.resolve();
    await Promise.resolve();
  });
});
