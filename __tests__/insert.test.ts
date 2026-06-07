/**
 * Tests for src/insert.ts — the §F-IN-1..F-IN-5 orchestrator.
 *
 * Mocks sn-plugin-lib's PluginCommAPI / PluginFileAPI / PluginManager /
 * Element so the whole insert path is exercised without a device.
 * Covers:
 *   - §F-IN-1 page-size fall-through at every step
 *   - §F-IN-2 / §8.6 auto-expansion of collapsed subtrees
 *   - F-NDI-1 order-of-calls: createElement × N → insertElements →
 *     reloadFile → closePluginView. The insert is ADDITIVE — a single
 *     PluginFileAPI.insertElements call adds only the plugin's new
 *     elements; the page's pre-existing content is neither read nor
 *     sent (the old getElements read + replaceElements whole-page
 *     rewrite are gone). insertElements is one host-side fsync, same
 *     batched-call win the prior replaceElements had.
 *   - F-NDI-1-AC3 zero getElements / zero replaceElements calls
 *   - F-NDI-3 non-empty-page regression: pre-existing elements never
 *     enter the insertElements payload (the gap that hid the
 *     "moved my writing to the left" bug)
 *   - §F-IN-4 plugin-view dismissal
 *   - F-NDI-2 failure semantics without whole-page risk: existing
 *     content is never read or sent, so it cannot be corrupted; an
 *     insertElements failure throws and the UI surfaces the banner
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
  // can verify N distinct Elements landed in insertElements.
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
    Element: {TYPE_GEO: 700, TYPE_TEXT: 600},
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
      getLassoRect: jest
        .fn()
        .mockResolvedValue({success: true, result: null}),
      deleteLassoElements: jest.fn().mockResolvedValue({success: true}),
      setLassoBoxState: jest.fn().mockResolvedValue({success: true}),
      reloadFile: jest.fn().mockResolvedValue({success: true}),
    },
    PluginFileAPI: {
      getPageSize: jest.fn().mockResolvedValue({
        success: true,
        result: {width: 1404, height: 1872},
      }),
      // The additive insert path calls insertElements ONLY. getElements
      // and replaceElements are deliberately mocked so the suite can
      // assert they are NEVER invoked (F-NDI-1-AC3) — their presence on
      // the mock object would otherwise let a regression call a
      // jest-undefined and throw an opaque error.
      getElements: jest.fn().mockResolvedValue({success: true, result: []}),
      replaceElements: jest.fn().mockResolvedValue({success: true}),
      insertElements: jest.fn().mockResolvedValue({success: true}),
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
  LASSO_HALO_PX,
  insertConceptMap,
  insertMindmap,
} from '../src/insert';
import {radialLayout} from '../src/layout/radial';
import {
  addChild,
  createTree,
  setCollapsed,
  setLabel,
  type Tree,
} from '../src/model/tree';
import {
  addNodeAsParent,
  addNodeWithParent,
  createGraph,
  setLabel as setGraphLabel,
} from '../src/model/graph';

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
 * PluginFileAPI.insertElements once with an array of Elements (each
 * Element carries its geometry in `.geometry`). This helper walks the
 * most recent insertElements call's payload and yields a
 * `[InsertedGeometry][]` shape that matches the legacy insertGeometry
 * mock.calls shape so assertions elsewhere don't need to change.
 *
 * The additive path sends ONLY the plugin's newly-minted elements —
 * the page's pre-existing content is never read or sent (I-NDI-1) — so
 * unlike the old replaceElements helper there is no "skip leading
 * existing elements" step. We still filter on a truthy `.geometry` to
 * drop TYPE_TEXT label elements (their `.geometry` stays null), which
 * is exactly what the geometry-shaped assertions want.
 */
function getInsertedGeometries(): Array<[InsertedGeometry]> {
  const calls = asMock(PluginFileAPI.insertElements).mock.calls;
  if (calls.length === 0) {
    return [];
  }
  const latest = calls[calls.length - 1];
  const payload = latest[2] as Array<{geometry?: InsertedGeometry}>;
  return payload
    .filter(el => el?.geometry !== null && el?.geometry !== undefined)
    .map(el => [el.geometry as InsertedGeometry]);
}

/**
 * Stage the placement probe so it reports existing-content bounds in
 * page-pixel space: the whole-page lasso selects something
 * (result:true) and getLassoRect returns the given rect. `right`/`bottom`
 * are the content's far corner (what choosePlacementRegion avoids).
 */
function mockExistingContent(rect: {
  left?: number;
  top?: number;
  right: number;
  bottom: number;
}): void {
  asMock(PluginCommAPI.lassoElements).mockResolvedValue({
    success: true,
    result: true,
  });
  asMock(PluginCommAPI.getLassoRect).mockResolvedValue({
    success: true,
    result: {left: 0, top: 0, ...rect},
  });
}

function resetMocks() {
  // createElement mints a fresh native-like Element per call. Tests
  // that want to observe all N elements should read
  // insertElements.mock.calls; this factory guarantees each Element
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
  asMock(PluginCommAPI.getLassoRect).mockClear();
  asMock(PluginCommAPI.getLassoRect).mockResolvedValue({
    success: true,
    result: null,
  });
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
  asMock(PluginFileAPI.insertElements).mockClear();
  asMock(PluginFileAPI.insertElements).mockResolvedValue({success: true});
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

  it('insertElements fires once with every emitted geometry, then reloads, then closes (F-NDI-1)', async () => {
    const tree = buildSmallTree();
    await insertMindmap({tree});

    // 4 outlines (root + 3 children) + 3 connectors = 7 geometries
    // total. No marker strokes — the marker / decode pipeline was
    // removed along with edit-mode.
    const insertCalls = getInsertedGeometries();
    expect(insertCalls.length).toBe(7);
    expect(PluginFileAPI.insertElements).toHaveBeenCalledTimes(1);
    // I-NDI-1/2: the additive path NEVER rewrites the whole page
    // (replaceElements) — that was the buggy v1.0.2 displacement path —
    // and never even READS existing elements (getElements); placement
    // reads only their bounds via the lasso probe (proven by the
    // non-empty-page regression below), so existing content is never
    // displaced.
    expect(PluginFileAPI.replaceElements).not.toHaveBeenCalled();
    expect(PluginFileAPI.getElements).not.toHaveBeenCalled();
    // On an EMPTY page (this happy-path default) the probe selects
    // nothing, so it never clears a selection: setLassoBoxState stays
    // untouched and the map's own auto-lasso (below) PERSISTS so the user
    // can drag the inserted map. (On a populated page the probe DOES
    // clear its transient whole-page selection — covered separately.)
    expect(PluginCommAPI.setLassoBoxState).not.toHaveBeenCalled();
    expect(PluginCommAPI.reloadFile).toHaveBeenCalledTimes(1);
    expect(PluginManager.closePluginView).toHaveBeenCalledTimes(1);

    // lassoElements is called TWICE: first the read-only placement probe
    // (whole-page rect, to read existing-content bounds in pixel space),
    // then the map's own grab-lasso (§F-IN-3). Both carry integer
    // {left,top,right,bottom} rects.
    expect(PluginCommAPI.lassoElements).toHaveBeenCalledTimes(2);
    const lassoCalls = asMock(PluginCommAPI.lassoElements).mock.calls;
    const probeArg = lassoCalls[0][0] as {
      left: number;
      top: number;
      right: number;
      bottom: number;
    };
    // Probe spans the whole page (0,0 → pageW,pageH).
    expect(probeArg).toEqual({left: 0, top: 0, right: 1404, bottom: 1872});
    const lassoArg = lassoCalls[1][0] as {
      left: number;
      top: number;
      right: number;
      bottom: number;
    };
    for (const v of Object.values(lassoArg)) {
      expect(Number.isInteger(v)).toBe(true);
    }
    expect(lassoArg.left).toBeLessThan(lassoArg.right);
    expect(lassoArg.top).toBeLessThan(lassoArg.bottom);

    // Order: createElement × N → insertElements → reloadFile →
    // (map) lassoElements → close. The MAP lasso MUST come AFTER reloadFile
    // — pre-reload the inserted elements aren't in the rendered page so
    // the lasso matches nothing, and a later reload would clear it. (The
    // placement probe lasso runs earlier, before insertElements.)
    const lastCreateOrder = Math.max(
      ...asMock(PluginCommAPI.createElement).mock.invocationCallOrder,
    );
    const insertOrder = asMock(PluginFileAPI.insertElements).mock
      .invocationCallOrder[0];
    const reloadOrder = asMock(PluginCommAPI.reloadFile).mock
      .invocationCallOrder[0];
    const mapLassoOrder = Math.max(
      ...asMock(PluginCommAPI.lassoElements).mock.invocationCallOrder,
    );
    const closeOrder = asMock(PluginManager.closePluginView).mock
      .invocationCallOrder[0];
    expect(insertOrder).toBeGreaterThan(lastCreateOrder);
    expect(reloadOrder).toBeGreaterThan(insertOrder);
    expect(mapLassoOrder).toBeGreaterThan(reloadOrder);
    expect(closeOrder).toBeGreaterThan(mapLassoOrder);
  });

  it('passes (notePath, page, elements) to insertElements in that order (F-NDI-1-FR4)', async () => {
    // Arg-order pin. getElements is the only host API with the
    // REVERSED (page, notePath) order; a copy-paste of that signature
    // into the write call would silently swap notePath and page. Lock
    // the order so that regression fails loudly here.
    asMock(PluginCommAPI.getCurrentFilePath).mockResolvedValueOnce({
      success: true,
      result: '/note/argorder.note',
    });
    asMock(PluginCommAPI.getCurrentPageNum).mockResolvedValueOnce({
      success: true,
      result: 7,
    });

    const tree = buildSmallTree();
    await insertMindmap({tree});

    const call = asMock(PluginFileAPI.insertElements).mock.calls[0];
    expect(call[0]).toBe('/note/argorder.note'); // notePath first
    expect(call[1]).toBe(7); // page index second (a number)
    expect(Array.isArray(call[2])).toBe(true); // elements array third
  });

  it('passes showLassoAfterInsert:false through to every inserted geometry (§F-IN-3)', async () => {
    // emitGeometries sets showLassoAfterInsert:false on every
    // emitted geometry so the host doesn't auto-lasso each element
    // individually during the batched write. The single map-wide
    // grab-lasso is applied explicitly afterward and deliberately
    // PERSISTS (we do NOT setLassoBoxState(2) it away) so the user can
    // drag the inserted map straight away.
    const tree = buildSmallTree();
    await insertMindmap({tree});

    const insertCalls = getInsertedGeometries();
    for (const [geometry] of insertCalls) {
      expect(geometry.showLassoAfterInsert).toBe(false);
    }
  });

  it('expands the map grab-lasso by LASSO_HALO_PX beyond the inserted geometry (§F-IN-3)', async () => {
    // The grab-lasso must clear the geometry on every side by LASSO_HALO_PX
    // so strokes sitting exactly on the union-rect boundary are captured —
    // a tight rect can miss edge strokes. Compare the SECOND lassoElements
    // call (the map grab; the first is the whole-page placement probe) to
    // the bounding box of the actually-inserted geometry points.
    const tree = buildSmallTree();
    await insertMindmap({tree});

    let gMinX = Infinity;
    let gMinY = Infinity;
    let gMaxX = -Infinity;
    let gMaxY = -Infinity;
    for (const [geometry] of getInsertedGeometries()) {
      for (const p of geometry.points ?? []) {
        gMinX = Math.min(gMinX, p.x);
        gMinY = Math.min(gMinY, p.y);
        gMaxX = Math.max(gMaxX, p.x);
        gMaxY = Math.max(gMaxY, p.y);
      }
    }
    const mapLasso = asMock(PluginCommAPI.lassoElements).mock.calls[1][0] as {
      left: number;
      top: number;
      right: number;
      bottom: number;
    };
    // Each side sits ~LASSO_HALO_PX outside the geometry bbox (±1 px for the
    // integer rounding of points vs the unrounded union rect).
    const TOL = 1;
    expect(Math.abs(gMinX - mapLasso.left - LASSO_HALO_PX)).toBeLessThanOrEqual(TOL);
    expect(Math.abs(mapLasso.right - gMaxX - LASSO_HALO_PX)).toBeLessThanOrEqual(TOL);
    expect(Math.abs(gMinY - mapLasso.top - LASSO_HALO_PX)).toBeLessThanOrEqual(TOL);
    expect(Math.abs(mapLasso.bottom - gMaxY - LASSO_HALO_PX)).toBeLessThanOrEqual(TOL);
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

describe('insertMindmap — non-destructive insert (F-NDI-1..F-NDI-3)', () => {
  it('sends ONLY the plugin\'s new elements; the read-then-rewrite path is gone (F-NDI-3-AC1)', async () => {
    // THE regression that hid the shipped bug was a read-then-rewrite:
    // getElements → concat existing + new → replaceElements rewrote the
    // WHOLE page and displaced the user's ink. That path is gone. The
    // insert is purely additive (insertElements with only the new
    // elements) and never READS the page's existing elements at all —
    // placement reads only their pixel BOUNDS, via the lasso probe
    // (resolveContentExtentPx), which returns a rect, not element data.
    //
    // Simulate a populated page (the probe reports content bounds) and
    // prove the destructive read/rewrite calls never fire and the
    // payload is exactly the plugin's own elements.
    mockExistingContent({right: 600, bottom: 500});

    const tree = buildSmallTree();
    await insertMindmap({tree});

    // Exactly one additive call; the old read + whole-page rewrite calls
    // are never made (their return into the payload was the displacement
    // bug).
    expect(PluginFileAPI.insertElements).toHaveBeenCalledTimes(1);
    expect(PluginFileAPI.getElements).not.toHaveBeenCalled();
    expect(PluginFileAPI.replaceElements).not.toHaveBeenCalled();

    const payload = asMock(PluginFileAPI.insertElements).mock
      .calls[0][2] as Array<Record<string, unknown>>;
    // Payload length == ONLY the plugin's new elements (7 geometries +
    // 0 labels for the small tree).
    expect(payload).toHaveLength(7);
    // Every payload element is one the plugin minted this run
    // (test-uuid-*), so no foreign / pre-existing element could be in it.
    for (const el of payload) {
      expect(String(el.uuid)).toMatch(/^test-uuid-/);
    }
  });

  it('non-empty page: payload length is geometries + labels only, with labels present (F-NDI-3-FR2)', async () => {
    // Same populated page, but now with two labeled nodes so the
    // payload is geometries + labels. Still: only the plugin's new
    // elements, never the existing page content.
    mockExistingContent({right: 600, bottom: 500});

    const tree = createTree();
    setLabel(tree, 0, 'Root idea');
    addChild(tree, 0, 'Child A');
    addChild(tree, 0); // unlabeled
    addChild(tree, 0); // unlabeled

    await insertMindmap({tree});

    const payload = asMock(PluginFileAPI.insertElements).mock
      .calls[0][2] as Array<Record<string, unknown>>;
    // 4 outlines + 3 connectors = 7 geometries; 2 labels = 2 TYPE_TEXT.
    expect(payload).toHaveLength(9);
    for (const el of payload) {
      expect(el.__preExisting).toBeUndefined();
    }
  });

  it('empty page: insert still lands the full geometry set page-centered (F-NDI-1-AC2 — no regression)', async () => {
    // The working case must stay working. On an empty page the additive
    // insert sends the full geometry+label set, identical to v1.0.2
    // minus the (now removed) whole-page read. The placement probe finds
    // no content (default lasso → result-less) so the map centers.
    const tree = buildSmallTree();
    await insertMindmap({tree});

    expect(PluginFileAPI.insertElements).toHaveBeenCalledTimes(1);
    const payload = asMock(PluginFileAPI.insertElements).mock
      .calls[0][2] as unknown[];
    // 7 geometries, no labels.
    expect(payload).toHaveLength(7);

    // Page-centered, exactly as the empty-page fit-to-page tests assert.
    const insertCalls = getInsertedGeometries();
    let minX = Infinity;
    let minY = Infinity;
    let maxX = -Infinity;
    let maxY = -Infinity;
    for (const [geometry] of insertCalls) {
      for (const p of geometry.points ?? []) {
        minX = Math.min(minX, p.x);
        minY = Math.min(minY, p.y);
        maxX = Math.max(maxX, p.x);
        maxY = Math.max(maxY, p.y);
      }
    }
    expect((minX + maxX) / 2).toBeCloseTo(DEFAULT_PAGE_WIDTH / 2, 0);
    expect((minY + maxY) / 2).toBeCloseTo(DEFAULT_PAGE_HEIGHT / 2, 0);
  });

  it('places the map in the empty band BELOW existing content (RA-2)', async () => {
    // Existing content occupies the top of the page (bottom edge at
    // maxY=400). With ~1472px of room below it (1872-400), the map must
    // land entirely below the content so its auto-lasso rect doesn't
    // overlap — and thus dragging the map won't drag the user's ink.
    const contentMaxY = 400;
    mockExistingContent({right: DEFAULT_PAGE_WIDTH - 50, bottom: contentMaxY});

    const tree = buildSmallTree();
    await insertMindmap({tree});

    const insertCalls = getInsertedGeometries();
    let minY = Infinity;
    for (const [geometry] of insertCalls) {
      for (const p of geometry.points ?? []) {
        minY = Math.min(minY, p.y);
      }
    }
    // Every emitted point sits below the existing content's bottom edge.
    expect(minY).toBeGreaterThanOrEqual(contentMaxY);
  });

  it('falls back to page-center when the page is too full for an empty band (RA-2)', async () => {
    // Content extends nearly to both the bottom and right edges, so
    // neither the below-band nor the right-band meets MIN_PLACEMENT_BAND;
    // placement falls back to centering on the whole page (overlap
    // accepted — the firmware lasso can't do better on a full page).
    mockExistingContent({
      right: DEFAULT_PAGE_WIDTH - 50,
      bottom: DEFAULT_PAGE_HEIGHT - 50,
    });

    const tree = buildSmallTree();
    await insertMindmap({tree});

    const insertCalls = getInsertedGeometries();
    let minX = Infinity;
    let minY = Infinity;
    let maxX = -Infinity;
    let maxY = -Infinity;
    for (const [geometry] of insertCalls) {
      for (const p of geometry.points ?? []) {
        minX = Math.min(minX, p.x);
        minY = Math.min(minY, p.y);
        maxX = Math.max(maxX, p.x);
        maxY = Math.max(maxY, p.y);
      }
    }
    expect((minX + maxX) / 2).toBeCloseTo(DEFAULT_PAGE_WIDTH / 2, 0);
    expect((minY + maxY) / 2).toBeCloseTo(DEFAULT_PAGE_HEIGHT / 2, 0);
  });

  it('places the map to the RIGHT when the below-band is too short (RA-2)', async () => {
    // Content reaches near the bottom (below-band < MIN_PLACEMENT_BAND)
    // but only the left portion horizontally, so the right-band has room.
    mockExistingContent({right: 400, bottom: DEFAULT_PAGE_HEIGHT - 200});

    const tree = buildSmallTree();
    await insertMindmap({tree});

    const insertCalls = getInsertedGeometries();
    let minX = Infinity;
    for (const [geometry] of insertCalls) {
      for (const p of geometry.points ?? []) {
        minX = Math.min(minX, p.x);
      }
    }
    // Map sits to the right of the existing content's right edge.
    expect(minX).toBeGreaterThanOrEqual(400);
  });

  it('falls back to page-center when the placement read throws (RA-2, non-fatal)', async () => {
    // resolveContentExtentPx swallows any probe error and returns null,
    // so placement falls back to centering on the whole page — a read
    // failure must never abort the insert. The probe is the FIRST
    // lassoElements call; the map's own grab-lasso still fires after.
    asMock(PluginCommAPI.lassoElements).mockRejectedValueOnce(
      new Error('simulated: lasso probe threw during placement'),
    );

    const tree = buildSmallTree();
    await expect(insertMindmap({tree})).resolves.toBeUndefined();
    expect(PluginFileAPI.insertElements).toHaveBeenCalledTimes(1);

    const insertCalls = getInsertedGeometries();
    let minX = Infinity;
    let minY = Infinity;
    let maxX = -Infinity;
    let maxY = -Infinity;
    for (const [geometry] of insertCalls) {
      for (const p of geometry.points ?? []) {
        minX = Math.min(minX, p.x);
        minY = Math.min(minY, p.y);
        maxX = Math.max(maxX, p.x);
        maxY = Math.max(maxY, p.y);
      }
    }
    expect((minX + maxX) / 2).toBeCloseTo(DEFAULT_PAGE_WIDTH / 2, 0);
    expect((minY + maxY) / 2).toBeCloseTo(DEFAULT_PAGE_HEIGHT / 2, 0);
  });

  it('falls back to page-center when the probe selects but getLassoRect is unusable (RA-2)', async () => {
    // The whole-page lasso DID select something (result:true) but
    // getLassoRect comes back with no usable rect — placement treats the
    // extent as unknown and centers on the whole page. Because the probe
    // made a selection, it MUST be cleared (setLassoBoxState(2)) so only
    // the map's own auto-lasso survives.
    asMock(PluginCommAPI.lassoElements).mockResolvedValueOnce({
      success: true,
      result: true,
    });
    asMock(PluginCommAPI.getLassoRect).mockResolvedValueOnce({
      success: true,
      result: null,
    });

    const tree = buildSmallTree();
    await expect(insertMindmap({tree})).resolves.toBeUndefined();

    const insertCalls = getInsertedGeometries();
    let minX = Infinity;
    let minY = Infinity;
    let maxX = -Infinity;
    let maxY = -Infinity;
    for (const [geometry] of insertCalls) {
      for (const p of geometry.points ?? []) {
        minX = Math.min(minX, p.x);
        minY = Math.min(minY, p.y);
        maxX = Math.max(maxX, p.x);
        maxY = Math.max(maxY, p.y);
      }
    }
    expect((minX + maxX) / 2).toBeCloseTo(DEFAULT_PAGE_WIDTH / 2, 0);
    expect((minY + maxY) / 2).toBeCloseTo(DEFAULT_PAGE_HEIGHT / 2, 0);
    // Probe selection cleared exactly once.
    expect(PluginCommAPI.setLassoBoxState).toHaveBeenCalledWith(2);
  });
});

describe('insertMindmap — labeled nodes (TYPE_TEXT path)', () => {
  it('emits one TYPE_TEXT element per labeled node alongside the geometry elements', async () => {
    // Build a tree where root + one child carry labels; the other
    // two children are unlabeled and should NOT contribute TYPE_TEXT
    // elements (collectLabeledNodes filters them by trim() emptiness).
    const tree = createTree();
    setLabel(tree, 0, 'Root idea');
    addChild(tree, 0, 'Child A');
    addChild(tree, 0); // unlabeled
    addChild(tree, 0); // unlabeled

    await insertMindmap({tree});

    // 4 outlines + 3 connectors = 7 TYPE_GEO; 2 labels = 2 TYPE_TEXT.
    const createCalls = asMock(PluginCommAPI.createElement).mock.calls;
    const geoCount = createCalls.filter(([k]) => k === 700).length;
    const textCount = createCalls.filter(([k]) => k === 600).length;
    expect(geoCount).toBe(7);
    expect(textCount).toBe(2);
  });

  it('populates textBox with the label, padded textRect, fitted fontSize and centre alignment', async () => {
    const tree = createTree();
    setLabel(tree, 0, '  Padded label  ');

    await insertMindmap({tree});

    const insertCall = asMock(PluginFileAPI.insertElements).mock.calls[0];
    const payload = insertCall[2] as Array<{
      textBox?: {
        textContentFull?: string;
        textRect?: {left: number; top: number; right: number; bottom: number};
        fontSize?: number;
        textAlign?: number;
      };
    }>;
    const textElements = payload.filter(el => el?.textBox !== undefined);
    expect(textElements).toHaveLength(1);
    const tb = textElements[0].textBox!;
    // setLabel already trimmed the stored label.
    expect(tb.textContentFull).toBe('Padded label');
    // 8 px padding on every side.
    expect(tb.textRect!.left).toBeLessThan(tb.textRect!.right);
    expect(tb.textRect!.top).toBeLessThan(tb.textRect!.bottom);
    // fontSize fits the box: capped at 48, above the degenerate floor, and
    // — the whole point — small enough that the label's predicted rendered
    // width (length × size × ~0.6) stays inside the padded textRect, so the
    // firmware can't clip it ("Padded label" no longer becomes "Padded l…").
    const rectW = tb.textRect!.right - tb.textRect!.left;
    expect(tb.fontSize!).toBeGreaterThanOrEqual(6);
    expect(tb.fontSize!).toBeLessThanOrEqual(48);
    expect('Padded label'.length * tb.fontSize! * 0.6).toBeLessThanOrEqual(
      rectW + 1e-6,
    );
    // Centre alignment.
    expect(tb.textAlign).toBe(1);
  });

  it('shrinks the font so a long label fits the box width instead of clipping', async () => {
    // A long single-node label at the SAME box size must get a smaller font
    // than a short one — width-fit, not height-only sizing.
    const longTree = createTree();
    setLabel(longTree, 0, 'A very long central idea label');
    await insertMindmap({tree: longTree});
    const longTb = (
      asMock(PluginFileAPI.insertElements).mock.calls[0][2] as Array<{
        textBox?: {fontSize?: number; textRect?: {left: number; right: number}};
      }>
    ).filter(el => el?.textBox)[0].textBox!;
    const longRectW = longTb.textRect!.right - longTb.textRect!.left;
    // The long label still fits its padded rect (no clip).
    expect(
      'A very long central idea label'.length * longTb.fontSize! * 0.6,
    ).toBeLessThanOrEqual(longRectW + 1e-6);

    asMock(PluginFileAPI.insertElements).mockClear();

    const shortTree = createTree();
    setLabel(shortTree, 0, 'Hi');
    await insertMindmap({tree: shortTree});
    const shortTb = (
      asMock(PluginFileAPI.insertElements).mock.calls[0][2] as Array<{
        textBox?: {fontSize?: number};
      }>
    ).filter(el => el?.textBox)[0].textBox!;
    // Same box, shorter label → larger (height-governed) font.
    expect(shortTb.fontSize!).toBeGreaterThan(longTb.fontSize!);
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
  it('throws when getCurrentFilePath rejects (notePath required for insertElements) (F-NDI-1-FR5)', async () => {
    // insertElements needs an explicit notePath + page index; there is
    // no implicit "current page" fallback. A note-context resolution
    // failure is therefore terminal — the UI layer surfaces the error
    // banner and the user retries. The guard message names
    // insertElements (NOT the removed replaceElements).
    asMock(PluginCommAPI.getCurrentFilePath).mockRejectedValueOnce(
      new Error('native bridge unavailable'),
    );

    const tree = createTree();
    await expect(insertMindmap({tree})).rejects.toThrow(
      /insertElements requires both/,
    );
    expect(PluginFileAPI.getPageSize).not.toHaveBeenCalled();
    expect(PluginFileAPI.insertElements).not.toHaveBeenCalled();
  });

  it('throws when getPageSize returns success:false (notePath required) (F-NDI-1-FR5)', async () => {
    asMock(PluginFileAPI.getPageSize).mockResolvedValueOnce({success: false});

    const tree = createTree();
    await expect(insertMindmap({tree})).rejects.toThrow(
      /insertElements requires both/,
    );
    expect(PluginFileAPI.getPageSize).toHaveBeenCalledTimes(1);
    expect(PluginFileAPI.insertElements).not.toHaveBeenCalled();
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

    // The root outline (a polygon, NOT a 2-point straightLine) should
    // have been scaled down from its native 220×96 bbox. Find it by
    // looking for the polygon with the most points — the root oval
    // is sampled densely on its rounded edges, while child rectangles
    // are 5-point closed polygons.
    const expectedScale = Math.min(
      1,
      available / baseLayout.unionBbox.w,
      (DEFAULT_PAGE_HEIGHT - 2 * INSERT_MARGIN_PX) / baseLayout.unionBbox.h,
    );
    const insertCalls = getInsertedGeometries();
    const polygons = insertCalls.filter(
      ([g]) => g.type === 'GEO_polygon',
    );
    const rootPoly = polygons.reduce((acc, cur) =>
      (cur[0].points?.length ?? 0) > (acc[0].points?.length ?? 0) ? cur : acc,
    );
    const xs = (rootPoly[0].points ?? []).map((p: {x: number}) => p.x);
    const ys = (rootPoly[0].points ?? []).map((p: {y: number}) => p.y);
    const width = Math.max(...xs) - Math.min(...xs);
    const height = Math.max(...ys) - Math.min(...ys);
    // Tolerance widened to ±1 to accommodate integer rounding at the
    // insertElements boundary (roundGeometryPoints rounds every
    // point.x/y to integers — the native firmware rejects fractional
    // coords). The max-min of rounded coords can drift by up to ±1
    // from the pre-rounding float value.
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
    // createElement failing mid-build aborts before insertElements —
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
      /createElement\(geo\) failed at index 1/,
    );
    expect(PluginFileAPI.insertElements).not.toHaveBeenCalled();
    expect(PluginManager.closePluginView).not.toHaveBeenCalled();
  });

  // F-NDI-3-FR3: the old getElements-failure tests are GONE. The insert
  // no longer reads existing elements at all; the placement probe (a
  // read-only lasso) swallows any failure and falls back to page-center —
  // it cannot abort the insert, so there is no failure path to exercise.

  it('re-raises an insertElements failure and leaves the existing page untouched (F-NDI-2-AC1)', async () => {
    // insertElements rejecting throws the host message. The user's
    // existing content is provably untouched: it is never whole-page
    // rewritten (replaceElements), and the placement probe only reads
    // bounds (a lasso select/deselect, never a stroke edit).
    // closePluginView is skipped so the UI stays open and shows the
    // error banner.
    asMock(PluginFileAPI.insertElements).mockResolvedValueOnce({
      success: false,
      error: {message: 'simulated: insertElements rejected'},
    });

    const tree = buildSmallTree();
    await expect(insertMindmap({tree})).rejects.toThrow(
      /insertElements rejected/,
    );
    expect(PluginManager.closePluginView).not.toHaveBeenCalled();
    // No DESTRUCTIVE call was ever issued — the page is never rewritten.
    expect(PluginFileAPI.replaceElements).not.toHaveBeenCalled();
    // Only the read-only placement probe (whole-page rect) ran; the map's
    // own grab-lasso is never reached after the insert fails.
    expect(PluginCommAPI.lassoElements).toHaveBeenCalledTimes(1);
    expect(asMock(PluginCommAPI.lassoElements).mock.calls[0][0]).toEqual({
      left: 0,
      top: 0,
      right: 1404,
      bottom: 1872,
    });
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
    expect(PluginFileAPI.insertElements).toHaveBeenCalledTimes(1);
    expect(PluginManager.closePluginView).toHaveBeenCalledTimes(1);
    expect(PluginCommAPI.deleteLassoElements).not.toHaveBeenCalled();
  });

  it('completes even if the auto-lasso returns failure (non-fatal)', async () => {
    // The post-insert auto-lasso is a UX nicety (grab-ready map). The
    // geometries are already committed by the time it fires, so a lasso
    // failure must NOT roll back the insert — reloadFile + close still
    // run and the user sees the inserted map (just not pre-selected).
    // First lassoElements call is the placement probe (benign here); the
    // SECOND is the map grab-lasso we force to fail.
    asMock(PluginCommAPI.lassoElements)
      .mockResolvedValueOnce({success: true})
      .mockResolvedValueOnce({
        success: false,
        error: {code: 904, message: 'simulated: lasso refused'},
      });

    const tree = buildSmallTree();
    await expect(insertMindmap({tree})).resolves.toBeUndefined();
    expect(PluginCommAPI.lassoElements).toHaveBeenCalledTimes(2);
    expect(PluginCommAPI.reloadFile).toHaveBeenCalledTimes(1);
    expect(PluginManager.closePluginView).toHaveBeenCalledTimes(1);
  });

  it('falls back to the default "createElement failed" message when the host omits error.message', async () => {
    // The `?? 'unknown error'` nullish-coalesce branch fires when the
    // host rejects a createElement but doesn't populate error.message.
    asMock(PluginCommAPI.createElement).mockResolvedValueOnce({success: false});

    const tree = buildSmallTree();
    await expect(insertMindmap({tree})).rejects.toThrow(
      /createElement\(geo\) failed at index 0: unknown error/,
    );
    expect(PluginFileAPI.insertElements).not.toHaveBeenCalled();
  });

  it('falls back to "insertElements failed" when error.message is missing', async () => {
    // The `?? 'insertElements failed'` nullish-coalesce branch fires
    // when the host rejects insertElements without an error.message.
    asMock(PluginFileAPI.insertElements).mockResolvedValueOnce({success: false});

    const tree = buildSmallTree();
    await expect(insertMindmap({tree})).rejects.toThrow(/insertElements failed/);
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
    expect(PluginFileAPI.insertElements).toHaveBeenCalledTimes(1);
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
    expect(PluginFileAPI.insertElements).not.toHaveBeenCalled();
  });

  it('re-raises a createElement(text) failure for labeled nodes', async () => {
    // First N createElement calls (TYPE_GEO) succeed, then the
    // TYPE_TEXT createElement for the labeled root fails. Pipeline
    // must abort before insertElements.
    let geoCalls = 0;
    asMock(PluginCommAPI.createElement).mockImplementation(
      async (kind: number) => {
        if (kind === 600) {
          // TYPE_TEXT
          return {
            success: false,
            error: {message: 'simulated: text element rejected'},
          };
        }
        geoCalls += 1;
        return {
          success: true,
          result: {
            uuid: `geo-${geoCalls}`,
            type: 700,
            pageNum: 0,
            layerNum: 0,
            thickness: 0,
            geometry: null,
          },
        };
      },
    );

    const tree = buildSmallTree();
    setLabel(tree, 0, 'root');
    await expect(insertMindmap({tree})).rejects.toThrow(
      /createElement\(text\) failed at index 0/,
    );
    expect(PluginFileAPI.insertElements).not.toHaveBeenCalled();
  });

  it('falls back to "createElement(text)" default message when error.message missing', async () => {
    asMock(PluginCommAPI.createElement).mockImplementation(
      async (kind: number) => {
        if (kind === 600) {
          return {success: false};
        }
        return {
          success: true,
          result: {
            uuid: `geo-${Math.random()}`,
            type: 700,
            pageNum: 0,
            layerNum: 0,
            thickness: 0,
            geometry: null,
          },
        };
      },
    );

    const tree = buildSmallTree();
    setLabel(tree, 0, 'root');
    await expect(insertMindmap({tree})).rejects.toThrow(
      /createElement\(text\) failed at index 0: unknown error/,
    );
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

  it('logs a NON-Error closePluginView rejection via the String(err) arm', async () => {
    // Companion to the Error-rejection test above. The fire-and-forget
    // close handler logs via
    //   `err instanceof Error ? err.message : String(err)`.
    // Rejecting with a plain string drives the FALSE arm (String(err)),
    // which the Error case never exercises. Like its sibling, the
    // rejection is swallowed — it must not propagate to the caller nor
    // raise an unhandled-rejection warning.
    asMock(PluginManager.closePluginView).mockRejectedValueOnce(
      'bridge closed (string)',
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

// ===========================================================================
// insertConceptMap — concept-map (DAG) insert flow (§14.6 / §F-IN-DAG-1/2).
// Sibling to insertMindmap; shares the mode-agnostic finalizeInsert tail
// (placement / fit-to-page / additive write / lasso / close), so those
// branches are already exercised by the mindmap suite above. These tests
// cover the concept-SPECIFIC orchestration: forceDirectedLayout (not
// radial), NO auto-expand, emitConceptGeometries (one connector per parent
// edge), and graph-label collection. §14 vocabulary only.
// ===========================================================================

/** A small concept graph: root + two children of root, fully on-page. */
function buildSmallGraph(): ReturnType<typeof createGraph> {
  const graph = createGraph();
  addNodeWithParent(graph, 0);
  addNodeWithParent(graph, 0);
  return graph;
}

describe('insertConceptMap — happy path (§F-IN-DAG-1)', () => {
  it('exposes insertConceptMap', () => {
    expect(typeof insertConceptMap).toBe('function');
  });

  it('resolves page size via the three-step chain', async () => {
    await insertConceptMap({graph: buildSmallGraph()});
    expect(PluginCommAPI.getCurrentFilePath).toHaveBeenCalledTimes(1);
    expect(PluginCommAPI.getCurrentPageNum).toHaveBeenCalledTimes(1);
    expect(PluginFileAPI.getPageSize).toHaveBeenCalledTimes(1);
  });

  it('fires ONE additive insertElements with every geometry, then reloads, lassos, closes', async () => {
    // root + 2 children: 3 outlines + 2 connectors (one per parent edge) = 5.
    await insertConceptMap({graph: buildSmallGraph()});

    const insertCalls = getInsertedGeometries();
    expect(insertCalls.length).toBe(5);
    expect(PluginFileAPI.insertElements).toHaveBeenCalledTimes(1);
    // Additive: never the whole-page replace path.
    expect(PluginFileAPI.replaceElements).not.toHaveBeenCalled();
    expect(PluginCommAPI.reloadFile).toHaveBeenCalledTimes(1);
    // Two lassoElements: the read-only placement probe, then the map grab.
    expect(PluginCommAPI.lassoElements).toHaveBeenCalledTimes(2);
    expect(PluginManager.closePluginView).toHaveBeenCalledTimes(1);

    // Order: createElement × N → insertElements → reloadFile →
    // (map) lasso → close. The map grab-lasso is the LAST lasso call
    // (the placement probe runs before insertElements).
    const lastCreateOrder = Math.max(
      ...asMock(PluginCommAPI.createElement).mock.invocationCallOrder,
    );
    const insertOrder = asMock(PluginFileAPI.insertElements).mock
      .invocationCallOrder[0];
    const reloadOrder = asMock(PluginCommAPI.reloadFile).mock
      .invocationCallOrder[0];
    const mapLassoOrder = Math.max(
      ...asMock(PluginCommAPI.lassoElements).mock.invocationCallOrder,
    );
    const closeOrder = asMock(PluginManager.closePluginView).mock
      .invocationCallOrder[0];
    expect(insertOrder).toBeGreaterThan(lastCreateOrder);
    expect(reloadOrder).toBeGreaterThan(insertOrder);
    expect(mapLassoOrder).toBeGreaterThan(reloadOrder);
    expect(closeOrder).toBeGreaterThan(mapLassoOrder);
  });

  it('emits one connector per parent edge — a two-parent node inserts both', async () => {
    // Genealogy: son(0) + Father + Mother. son has 2 parentIds, so the
    // insert payload carries 2 connectors + 3 outlines = 5 geometries.
    const graph = createGraph('son');
    addNodeAsParent(graph, 0, 'Father');
    addNodeAsParent(graph, 0, 'Mother');
    await insertConceptMap({graph});
    const geos = getInsertedGeometries();
    const connectors = geos.filter(([g]) => g.type === 'straightLine');
    const outlines = geos.filter(([g]) => g.type === 'GEO_polygon');
    expect(connectors.length).toBe(2); // one per parent edge of son
    expect(outlines.length).toBe(3); // one per node
  });

  it('every inserted geometry carries showLassoAfterInsert:false (§F-IN-3)', async () => {
    await insertConceptMap({graph: buildSmallGraph()});
    for (const [g] of getInsertedGeometries()) {
      expect(g.showLassoAfterInsert).toBe(false);
    }
  });
});

describe('insertConceptMap — labeled nodes (TYPE_TEXT path)', () => {
  it('emits one TYPE_TEXT element per labeled concept node', async () => {
    // root labeled, one child labeled, one child unlabeled.
    const graph = createGraph('Central');
    const a = addNodeWithParent(graph, 0);
    setGraphLabel(graph, a, 'Child A');
    addNodeWithParent(graph, 0); // unlabeled

    await insertConceptMap({graph});

    const createCalls = asMock(PluginCommAPI.createElement).mock.calls;
    const geoCount = createCalls.filter(([k]) => k === 700).length;
    const textCount = createCalls.filter(([k]) => k === 600).length;
    // 3 outlines + 2 connectors = 5 TYPE_GEO; 2 labels = 2 TYPE_TEXT.
    expect(geoCount).toBe(5);
    expect(textCount).toBe(2);
  });
});

describe('insertConceptMap — failure semantics (§F-IN-1 / F-NDI-2)', () => {
  it('throws the insertConceptMap-prefixed error when notePath resolves null', async () => {
    // getCurrentFilePath success:false → resolvePageContext falls through
    // to defaults (notePath/page null) → finalizeInsert rejects with the
    // CONTEXT-prefixed message. Assert the exact 'insertConceptMap:' prefix
    // so the concept path's error is distinct from insertMindmap's (the
    // context string is the only difference, per the shared finalizeInsert).
    asMock(PluginCommAPI.getCurrentFilePath).mockResolvedValueOnce({
      success: false,
    });
    await expect(
      insertConceptMap({graph: buildSmallGraph()}),
    ).rejects.toThrow(
      /^insertConceptMap: resolvePageContext returned null notePath\/page/,
    );
    // No additive write happened.
    expect(PluginFileAPI.insertElements).not.toHaveBeenCalled();
  });

  it('throws the insertConceptMap-prefixed error when getPageSize fails', async () => {
    asMock(PluginFileAPI.getPageSize).mockResolvedValueOnce({success: false});
    await expect(
      insertConceptMap({graph: buildSmallGraph()}),
    ).rejects.toThrow(
      /^insertConceptMap: resolvePageContext returned null notePath\/page/,
    );
  });

  it('throws when insertElements fails (existing content never at risk)', async () => {
    asMock(PluginFileAPI.insertElements).mockResolvedValueOnce({
      success: false,
    });
    await expect(
      insertConceptMap({graph: buildSmallGraph()}),
    ).rejects.toThrow();
    // Additive path: existing content is never read-and-rewritten.
    expect(PluginFileAPI.replaceElements).not.toHaveBeenCalled();
  });
});

describe('insertConceptMap — concept-specific layout (§F-IN-DAG-2)', () => {
  it('lands a single-root graph page-centered on an empty page (force layout)', async () => {
    // A lone root concept graph still inserts its one outline; the
    // force-directed layout + finalizeInsert place it without throwing.
    const graph = createGraph('only');
    await expect(insertConceptMap({graph})).resolves.toBeUndefined();
    // One outline geometry (no connectors — no parent edges).
    const geos = getInsertedGeometries();
    expect(geos.length).toBe(1);
    expect(geos[0][0].type).toBe('GEO_polygon');
  });

  it('places the concept map below existing ink (shared RA-2 placement path)', async () => {
    // insertConceptMap reuses the same finalizeInsert placement tail as
    // insertMindmap. Lock that the lasso-probe overlap-avoidance applies to
    // DAG mode too: with existing ink ending at maxY=400 and ~1472 px of
    // room below it, the whole concept map must land below the ink so its
    // auto-lasso can't grab the user's notes.
    const contentMaxY = 400;
    mockExistingContent({right: DEFAULT_PAGE_WIDTH - 50, bottom: contentMaxY});

    await insertConceptMap({graph: buildSmallGraph()});

    let minY = Infinity;
    for (const [geometry] of getInsertedGeometries()) {
      for (const p of geometry.points ?? []) {
        minY = Math.min(minY, p.y);
      }
    }
    expect(minY).toBeGreaterThanOrEqual(contentMaxY);
  });

  it('places the concept map to the RIGHT when the below-band is too short (shared RA-2)', async () => {
    // Existing ink reaches near the bottom (below-band < MIN_PLACEMENT_BAND)
    // but only the left portion horizontally, so the right-band has room.
    // Mirrors the mindmap RIGHT-band test for the shared finalizeInsert path.
    mockExistingContent({right: 400, bottom: DEFAULT_PAGE_HEIGHT - 200});

    await insertConceptMap({graph: buildSmallGraph()});

    let minX = Infinity;
    for (const [geometry] of getInsertedGeometries()) {
      for (const p of geometry.points ?? []) {
        minX = Math.min(minX, p.x);
      }
    }
    // The map sits to the right of the existing content's right edge.
    expect(minX).toBeGreaterThanOrEqual(400);
  });

  it('falls back to page-center when the page is too full for an empty band (shared RA-2)', async () => {
    // Ink extends near both the bottom and right edges, so neither band
    // meets MIN_PLACEMENT_BAND; placement centres on the whole page (overlap
    // accepted — the firmware lasso can do no better on a full page).
    mockExistingContent({
      right: DEFAULT_PAGE_WIDTH - 50,
      bottom: DEFAULT_PAGE_HEIGHT - 50,
    });

    await insertConceptMap({graph: buildSmallGraph()});

    let minX = Infinity;
    let minY = Infinity;
    let maxX = -Infinity;
    let maxY = -Infinity;
    for (const [geometry] of getInsertedGeometries()) {
      for (const p of geometry.points ?? []) {
        minX = Math.min(minX, p.x);
        minY = Math.min(minY, p.y);
        maxX = Math.max(maxX, p.x);
        maxY = Math.max(maxY, p.y);
      }
    }
    expect((minX + maxX) / 2).toBeCloseTo(DEFAULT_PAGE_WIDTH / 2, 0);
    expect((minY + maxY) / 2).toBeCloseTo(DEFAULT_PAGE_HEIGHT / 2, 0);
  });
});
