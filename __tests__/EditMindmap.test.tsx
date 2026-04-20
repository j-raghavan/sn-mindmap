/**
 * Tests for src/EditMindmap.tsx (Phase 4.3).
 *
 * Coverage:
 *   - Loading phase renders before the async lasso read resolves
 *     (§F-ED-2).
 *   - API-level failure (envelope !success, throw, or non-array
 *     result) surfaces the §F-ED-4 error banner with the "could
 *     not read lasso selection" prefix + Close button.
 *   - Decoder failure surfaces the §F-ED-4 "no mindmap structure
 *     found" banner + Close button (no leak of internal reason
 *     codes to on-screen text).
 *   - Decode success mounts MindmapCanvas with initialTree set
 *     from the decoder, and the Insert button is hidden (edit-mode
 *     is Cancel-only until Phase 4.5 Save lands).
 *
 * The test harness mocks sn-plugin-lib so jest never touches the
 * untransformed ESM in node_modules. Each test can override the
 * getLassoGeometries mock to cover a specific branch.
 *
 * We also stub ./marker/decode so the §F-ED-3 branch is driven by the
 * test rather than by building a real marker bitstream (the marker
 * encode/decode round-trip is already covered by marker.*.test.ts;
 * duplicating it here would make these tests harder to read and slow
 * to fail when decoder internals change).
 */
import React from 'react';
import {create, act, type ReactTestRenderer} from 'react-test-renderer';

// --- Mock sn-plugin-lib --------------------------------------------------

jest.mock('sn-plugin-lib', () => ({
  PluginManager: {
    closePluginView: jest.fn().mockResolvedValue(true),
  },
  PluginCommAPI: {
    getLassoGeometries: jest
      .fn()
      .mockResolvedValue({success: true, result: []}),
    // The §F-ED-'ready' branch mounts MindmapCanvas; its Cancel button
    // calls PluginManager.closePluginView, which is already mocked
    // above. Its Insert button would call the full §F-IN-* pipeline,
    // but isEditMode hides it — so the remaining PluginCommAPI
    // surface shouldn't fire. We still provide defaults so any future
    // regression that accidentally calls them surfaces as a "called
    // unexpectedly" assertion rather than an undefined-method throw.
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
      .mockResolvedValue({
        success: true,
        result: {width: 1404, height: 1872},
      }),
  },
}));

// --- Mock marker/decode --------------------------------------------------
//
// Phase 4.3 only needs the outer state machine to react to the
// decoder's ok/err shape. Stubbing ../src/marker/decode keeps this
// file focused on that state machine and decouples it from the
// marker byte layout. The real decoder's happy and error paths are
// covered in marker.decode.test.ts.

jest.mock('../src/marker/decode', () => ({
  decodeMarker: jest.fn(),
}));

import EditMindmap from '../src/EditMindmap';
import {PluginCommAPI, PluginManager} from 'sn-plugin-lib';
import {decodeMarker} from '../src/marker/decode';
import {createTree, addChild, ShapeKind, type NodeId, type Tree} from '../src/model/tree';
import type {Rect} from '../src/geometry';

const mockGetLasso = PluginCommAPI.getLassoGeometries as jest.Mock;
const mockClose = PluginManager.closePluginView as jest.Mock;
const mockDecode = decodeMarker as jest.Mock;

// --- helpers -------------------------------------------------------------

/**
 * Build a tiny tree with a single root and one child for the "decode
 * success" branch. The render only checks that the decoded tree is
 * passed to MindmapCanvas, so a minimally non-trivial shape is
 * enough.
 */
function buildDecodedTree(): Tree {
  const tree = createTree();
  tree.nodesById.get(tree.rootId)!.shape = ShapeKind.OVAL;
  addChild(tree, tree.rootId);
  return tree;
}

function buildDecodedBboxes(tree: Tree): Map<NodeId, Rect> {
  const m = new Map<NodeId, Rect>();
  for (const id of tree.nodesById.keys()) {
    m.set(id, {x: id * 100, y: id * 100, w: 220, h: 96});
  }
  return m;
}

async function flushAsync(renderer: ReactTestRenderer): Promise<void> {
  // Two microtask flushes: one for the `await getLassoGeometries`,
  // one for any setState that scheduled a re-render. Wrapping in act
  // suppresses the "not wrapped in act" warning and applies the
  // state transitions synchronously for assertions.
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
  });
  // Force a re-render to pick up the last setState if React batched it.
  act(() => {
    renderer.update(<EditMindmap />);
  });
}

function findByAccessibilityLabel(
  renderer: ReactTestRenderer,
  label: string,
): ReturnType<ReactTestRenderer['root']['findAllByProps']> {
  return renderer.root.findAllByProps({accessibilityLabel: label});
}

// --- tests ---------------------------------------------------------------

describe('EditMindmap (Phase 4.3)', () => {
  beforeEach(() => {
    mockGetLasso.mockReset();
    mockClose.mockReset();
    mockDecode.mockReset();
    // Re-apply the default behavior after mockReset — otherwise the
    // next test that doesn't override the mock sees undefined.
    mockGetLasso.mockResolvedValue({success: true, result: []});
    mockClose.mockResolvedValue(true);
  });

  it('renders the loading phase before the lasso read resolves', () => {
    // Block the lasso read on a pending promise so we can observe the
    // pre-resolve state.
    let resolve!: (v: unknown) => void;
    mockGetLasso.mockReturnValue(
      new Promise(r => {
        resolve = r;
      }),
    );
    let renderer: ReactTestRenderer | undefined;
    act(() => {
      renderer = create(<EditMindmap />);
    });
    expect(
      findByAccessibilityLabel(renderer!, 'edit-mindmap-loading').length,
    ).toBeGreaterThan(0);
    // Unblock so the effect's promise chain completes before unmount.
    act(() => {
      resolve({success: true, result: []});
    });
    act(() => {
      renderer!.unmount();
    });
  });

  it('surfaces "could not read lasso" when the envelope is not successful', async () => {
    mockGetLasso.mockResolvedValue({
      success: false,
      error: {message: 'firmware busy'},
    });
    let renderer!: ReactTestRenderer;
    act(() => {
      renderer = create(<EditMindmap />);
    });
    await flushAsync(renderer);
    const errors = findByAccessibilityLabel(renderer, 'edit-mindmap-error');
    expect(errors.length).toBeGreaterThan(0);
    const msgs = findByAccessibilityLabel(
      renderer,
      'edit-mindmap-error-message',
    );
    expect(msgs.length).toBeGreaterThan(0);
    // The firmware's own error message is surfaced to help on-device
    // diagnosis (logcat-style).
    const firstMsg = msgs[0];
    const text = JSON.stringify(firstMsg.props.children);
    expect(text).toContain('Could not read the lasso selection');
    expect(text).toContain('firmware busy');
    // Decoder should never have been invoked for an API-level failure.
    expect(mockDecode).not.toHaveBeenCalled();
    act(() => {
      renderer.unmount();
    });
  });

  it('surfaces "could not read lasso" when getLassoGeometries throws', async () => {
    mockGetLasso.mockRejectedValue(new Error('native bridge timeout'));
    let renderer!: ReactTestRenderer;
    act(() => {
      renderer = create(<EditMindmap />);
    });
    await flushAsync(renderer);
    const msgs = findByAccessibilityLabel(
      renderer,
      'edit-mindmap-error-message',
    );
    const text = JSON.stringify(msgs[0].props.children);
    expect(text).toContain('Could not read the lasso selection');
    expect(text).toContain('native bridge timeout');
    expect(mockDecode).not.toHaveBeenCalled();
    act(() => {
      renderer.unmount();
    });
  });

  it('surfaces "could not read lasso" when the result is not an array', async () => {
    // Defensive path: the native bridge shouldn't return non-array
    // success results, but Object types in sn-plugin-lib leave it
    // possible. Better to show the user a recoverable error than to
    // blow up downstream.
    mockGetLasso.mockResolvedValue({success: true, result: 'weird'});
    let renderer!: ReactTestRenderer;
    act(() => {
      renderer = create(<EditMindmap />);
    });
    await flushAsync(renderer);
    expect(
      findByAccessibilityLabel(renderer, 'edit-mindmap-error').length,
    ).toBeGreaterThan(0);
    expect(mockDecode).not.toHaveBeenCalled();
    act(() => {
      renderer.unmount();
    });
  });

  it('surfaces the §F-ED-4 "no mindmap structure" hint on decode failure', async () => {
    mockGetLasso.mockResolvedValue({success: true, result: []});
    mockDecode.mockReturnValue({
      ok: false,
      reason: 'no_candidates',
      message: 'internal: no marker candidate strokes',
    });
    let renderer!: ReactTestRenderer;
    act(() => {
      renderer = create(<EditMindmap />);
    });
    await flushAsync(renderer);
    const msgs = findByAccessibilityLabel(
      renderer,
      'edit-mindmap-error-message',
    );
    expect(msgs.length).toBeGreaterThan(0);
    const text = JSON.stringify(msgs[0].props.children);
    expect(text).toContain('No mindmap structure found in this selection');
    expect(text).toContain('Lasso the full mindmap and try again');
    // We deliberately don't surface the decoder's internal `reason`
    // or `message` — user-facing text is the §F-ED-4 hint only.
    expect(text).not.toContain('no_candidates');
    expect(text).not.toContain('internal: no marker candidate strokes');
    act(() => {
      renderer.unmount();
    });
  });

  it('Close button dismisses the plugin from the error surface', async () => {
    mockGetLasso.mockResolvedValue({success: true, result: []});
    mockDecode.mockReturnValue({
      ok: false,
      reason: 'rs_failed',
      message: 'fake',
    });
    let renderer!: ReactTestRenderer;
    act(() => {
      renderer = create(<EditMindmap />);
    });
    await flushAsync(renderer);
    const closeBtns = findByAccessibilityLabel(
      renderer,
      'edit-mindmap-close',
    );
    // react-test-renderer surfaces both the Pressable composite and
    // its host View for the same accessibilityLabel, so the count is
    // > 1. We only need to fire onPress on the composite (first match).
    expect(closeBtns.length).toBeGreaterThan(0);
    act(() => {
      closeBtns[0].props.onPress();
    });
    expect(mockClose).toHaveBeenCalledTimes(1);
    act(() => {
      renderer.unmount();
    });
  });

  it('mounts MindmapCanvas with the decoded tree on success', async () => {
    const tree = buildDecodedTree();
    const bboxes = buildDecodedBboxes(tree);
    mockGetLasso.mockResolvedValue({success: true, result: []});
    mockDecode.mockReturnValue({
      ok: true,
      tree,
      nodeBboxesById: bboxes,
      markerOriginPage: {x: 100, y: 200},
    });
    let renderer!: ReactTestRenderer;
    act(() => {
      renderer = create(<EditMindmap />);
    });
    await flushAsync(renderer);

    // One node-id label per tree node — proves the decoded tree was
    // passed through to MindmapCanvas's render.
    for (const id of tree.nodesById.keys()) {
      expect(
        findByAccessibilityLabel(renderer, `node-${id}`).length,
      ).toBeGreaterThan(0);
    }

    // decodeMarker received the raw geometry list from the envelope.
    expect(mockDecode).toHaveBeenCalledTimes(1);
    expect(mockDecode.mock.calls[0][0]).toEqual([]);
    act(() => {
      renderer.unmount();
    });
  });

  it('hides the Insert button on success (edit-mode Cancel-only until Phase 4.5)', async () => {
    const tree = buildDecodedTree();
    const bboxes = buildDecodedBboxes(tree);
    mockGetLasso.mockResolvedValue({success: true, result: []});
    mockDecode.mockReturnValue({
      ok: true,
      tree,
      nodeBboxesById: bboxes,
      markerOriginPage: {x: 0, y: 0},
    });
    let renderer!: ReactTestRenderer;
    act(() => {
      renderer = create(<EditMindmap />);
    });
    await flushAsync(renderer);

    // Cancel is still present (it's the only way out in edit mode
    // until Save lands in Phase 4.5). react-test-renderer surfaces
    // the label on both the Pressable composite and its host View, so
    // the count is > 1 — asserting >0 is enough.
    expect(findByAccessibilityLabel(renderer, 'Cancel').length).toBeGreaterThan(
      0,
    );
    // Insert is hidden. Without the isEditMode guard MindmapCanvas
    // always renders a Pressable labeled "Insert", so the count would
    // be > 0; asserting 0 exactly is the right regression guard.
    expect(findByAccessibilityLabel(renderer, 'Insert').length).toBe(0);
    act(() => {
      renderer.unmount();
    });
  });

  it('does not call getLassoGeometries a second time across re-renders', async () => {
    mockGetLasso.mockResolvedValue({success: true, result: []});
    mockDecode.mockReturnValue({
      ok: false,
      reason: 'rs_failed',
      message: 'fake',
    });
    let renderer!: ReactTestRenderer;
    act(() => {
      renderer = create(<EditMindmap />);
    });
    await flushAsync(renderer);
    // Re-render with identical props. The effect has an empty deps
    // array, so it must not fire again.
    act(() => {
      renderer.update(<EditMindmap />);
    });
    expect(mockGetLasso).toHaveBeenCalledTimes(1);
    act(() => {
      renderer.unmount();
    });
  });
});

describe('EditMindmap (Phase 4.4) — preserved-stroke wiring', () => {
  // Phase 4.4 extends the §F-ED-3 ready branch with §F-ED-5
  // associateStrokes + to-node-local projection. These tests cover:
  //   - bboxes are projected to page coords (decoder returns
  //     mindmap-local; raw strokes are in page).
  //   - in-map strokes reach MindmapCanvas keyed on the right node
  //     and render (validated via the §F-ED-6 rendering from
  //     MindmapCanvas.tsx, whose own tests cover the render math).
  //   - out-of-map strokes don't render in Phase 4.4 but are carried
  //     through state to the initialOutOfMapStrokes prop (Phase 4.6
  //     will consume them).

  beforeEach(() => {
    mockGetLasso.mockReset();
    mockClose.mockReset();
    mockDecode.mockReset();
    mockGetLasso.mockResolvedValue({success: true, result: []});
    mockClose.mockResolvedValue(true);
  });

  /**
   * Build a two-node tree (root + one child) for the stroke-routing
   * tests. Each test then defines its own stroke list to exercise
   * routing to a specific bucket.
   */
  function buildTwoNodeTree(): {tree: Tree; childId: NodeId} {
    const tree = createTree();
    addChild(tree, tree.rootId);
    const childId = tree.nodesById.get(tree.rootId)!.childIds[0];
    return {tree, childId};
  }

  /**
   * Bboxes in MINDMAP-LOCAL coords (what the decoder returns). Root
   * at (0, 0); child bucketed off to (300, 0). Widths/heights are
   * arbitrary but non-overlapping so association is unambiguous.
   */
  function buildTwoNodeBboxes(tree: Tree, childId: NodeId): Map<NodeId, Rect> {
    const m = new Map<NodeId, Rect>();
    m.set(tree.rootId, {x: 0, y: 0, w: 200, h: 100});
    m.set(childId, {x: 300, y: 0, w: 200, h: 100});
    return m;
  }

  it('projects decoder bboxes to page coords before association', async () => {
    const {tree, childId} = buildTwoNodeTree();
    const mindmapLocalBboxes = buildTwoNodeBboxes(tree, childId);
    const markerOriginPage = {x: 1000, y: 2000};

    // Raw lasso geometry: one polyline whose centroid lands inside
    // the ROOT's bbox *after* page projection. Root's page bbox will
    // be (1000, 2000, 200, 100), so a stroke centered at (1050, 2050)
    // hits it. Without page projection (i.e. using mindmap-local
    // bboxes directly) the centroid at (1050, 2050) would fall
    // outside both (root is still at 0..200 mindmap-local; child at
    // 300..500), so the stroke would end up in outOfMap — meaning a
    // successful association assertion double-proves the projection
    // happened.
    const lassoStroke = {
      type: 'GEO_polygon',
      points: [
        {x: 1020, y: 2020},
        {x: 1080, y: 2080},
      ],
      penColor: 0x00,
      penType: 10,
      penWidth: 400,
    };
    mockGetLasso.mockResolvedValue({success: true, result: [lassoStroke]});
    mockDecode.mockReturnValue({
      ok: true,
      tree,
      nodeBboxesById: mindmapLocalBboxes,
      markerOriginPage,
    });

    let renderer!: ReactTestRenderer;
    act(() => {
      renderer = create(<EditMindmap />);
    });
    await flushAsync(renderer);

    // The §F-ED-6 render produces one `preserved-stroke-node-<rootId>`
    // host View per polyline segment. One segment between two points
    // → at least one host match (react-test-renderer surfaces both
    // the composite and host for some wrappers, but a plain <View>
    // with backgroundColor only surfaces at the host level, so
    // counting by accessibility label matches user intent here).
    const rootStrokes = renderer.root.findAllByProps({
      accessibilityLabel: `preserved-stroke-node-${tree.rootId}`,
    });
    expect(rootStrokes.length).toBeGreaterThan(0);
    // And the child bucket should NOT have received the stroke.
    const childStrokes = renderer.root.findAllByProps({
      accessibilityLabel: `preserved-stroke-node-${childId}`,
    });
    expect(childStrokes.length).toBe(0);
    act(() => {
      renderer.unmount();
    });
  });

  it('routes strokes to the node whose projected page bbox contains their centroid', async () => {
    const {tree, childId} = buildTwoNodeTree();
    const mindmapLocalBboxes = buildTwoNodeBboxes(tree, childId);
    const markerOriginPage = {x: 500, y: 600};
    // Stroke 1 centroid at (600, 650) → inside root's page bbox
    // (500..700 × 600..700). Stroke 2 centroid at (900, 650) → inside
    // child's page bbox (800..1000 × 600..700).
    const strokeA = {
      type: 'GEO_polygon',
      points: [
        {x: 580, y: 630},
        {x: 620, y: 670},
      ],
      penColor: 0x00,
      penType: 10,
      penWidth: 400,
    };
    const strokeB = {
      type: 'GEO_polygon',
      points: [
        {x: 880, y: 630},
        {x: 920, y: 670},
      ],
      penColor: 0x00,
      penType: 10,
      penWidth: 400,
    };
    mockGetLasso.mockResolvedValue({
      success: true,
      result: [strokeA, strokeB],
    });
    mockDecode.mockReturnValue({
      ok: true,
      tree,
      nodeBboxesById: mindmapLocalBboxes,
      markerOriginPage,
    });

    let renderer!: ReactTestRenderer;
    act(() => {
      renderer = create(<EditMindmap />);
    });
    await flushAsync(renderer);

    // Each single-segment polyline produces one labeled host View in
    // its own node's bucket.
    const rootHits = renderer.root.findAllByProps({
      accessibilityLabel: `preserved-stroke-node-${tree.rootId}`,
    });
    const childHits = renderer.root.findAllByProps({
      accessibilityLabel: `preserved-stroke-node-${childId}`,
    });
    expect(rootHits.length).toBeGreaterThan(0);
    expect(childHits.length).toBeGreaterThan(0);
    act(() => {
      renderer.unmount();
    });
  });

  it('drops strokes whose centroid falls outside every bbox (outOfMap)', async () => {
    const {tree, childId} = buildTwoNodeTree();
    const mindmapLocalBboxes = buildTwoNodeBboxes(tree, childId);
    const markerOriginPage = {x: 0, y: 0};
    // Centroid at (-100, -100) — left/above every bbox.
    const orphanStroke = {
      type: 'GEO_polygon',
      points: [
        {x: -120, y: -120},
        {x: -80, y: -80},
      ],
      penColor: 0x00,
      penType: 10,
      penWidth: 400,
    };
    mockGetLasso.mockResolvedValue({success: true, result: [orphanStroke]});
    mockDecode.mockReturnValue({
      ok: true,
      tree,
      nodeBboxesById: mindmapLocalBboxes,
      markerOriginPage,
    });

    let renderer!: ReactTestRenderer;
    act(() => {
      renderer = create(<EditMindmap />);
    });
    await flushAsync(renderer);

    // Neither node gets the orphan stroke; §F-ED-6 render surface
    // stays empty of preserved-stroke labels. Phase 4.6 will surface
    // the out-of-map bucket in a confirmation dialog, but that's
    // explicitly scoped out of Phase 4.4.
    expect(
      renderer.root.findAllByProps({
        accessibilityLabel: `preserved-stroke-node-${tree.rootId}`,
      }).length,
    ).toBe(0);
    expect(
      renderer.root.findAllByProps({
        accessibilityLabel: `preserved-stroke-node-${childId}`,
      }).length,
    ).toBe(0);
    act(() => {
      renderer.unmount();
    });
  });

  it('renders no strokes when the lasso result is empty', async () => {
    // Regression for the Phase 4.3 baseline — an empty stroke list
    // must still reach the ready phase cleanly, with no strokes
    // rendered and no associateStrokes/translateStrokes errors.
    const {tree, childId} = buildTwoNodeTree();
    const mindmapLocalBboxes = buildTwoNodeBboxes(tree, childId);
    mockGetLasso.mockResolvedValue({success: true, result: []});
    mockDecode.mockReturnValue({
      ok: true,
      tree,
      nodeBboxesById: mindmapLocalBboxes,
      markerOriginPage: {x: 0, y: 0},
    });
    let renderer!: ReactTestRenderer;
    act(() => {
      renderer = create(<EditMindmap />);
    });
    await flushAsync(renderer);
    // Canvas mounted (node labels exist)…
    expect(
      findByAccessibilityLabel(renderer, `node-${tree.rootId}`).length,
    ).toBeGreaterThan(0);
    // …but no preserved strokes.
    const allStrokes = renderer.root.findAll(
      node =>
        typeof node.type === 'string' &&
        typeof node.props.accessibilityLabel === 'string' &&
        node.props.accessibilityLabel.startsWith('preserved-stroke-'),
    );
    expect(allStrokes).toHaveLength(0);
    act(() => {
      renderer.unmount();
    });
  });

  it('translates each in-map stroke to its node\'s page-bbox-local frame for the canvas render', async () => {
    // This test probes the to-node-local conversion step. We know:
    //   decoder bbox (mindmap-local) root: (0, 0, 200, 100)
    //   markerOriginPage:                   (500, 600)
    //   root page bbox:                     (500, 600, 200, 100)
    //   stroke polyline in page coords:
    //     (550, 650) → (590, 650)   length = 40, thickness = 10
    //
    // After to-node-local conversion (subtract page bbox.topLeft):
    //   (50, 50) → (90, 50)          same length/thickness
    //
    // The canvas then renders anchored to the root's CURRENT radial-
    // layout bbox. For a lone-root tree the root bbox top-left is
    // (-NODE_WIDTH/2, -NODE_HEIGHT/2) and the stage origin equals
    // that same value, so bbox.x - origin.x = 0 / bbox.y - origin.y
    // = 0 and the rendered segment sits at
    //   left = midX - length/2 = 70 - 20 = 50
    //   top  = midY - thickness/2 = 50 - 5 = 45
    //
    // Whereas without the to-node-local step (i.e. if the stroke were
    // still in page coords), left would be 550 and top 645 — way
    // outside the root bbox. An observed left=50, top=45 therefore
    // directly proves the node-local conversion happened.
    const tree = createTree();
    const mindmapLocalBboxes = new Map<NodeId, Rect>([
      [tree.rootId, {x: 0, y: 0, w: 200, h: 100}],
    ]);
    const markerOriginPage = {x: 500, y: 600};
    const lassoStroke = {
      type: 'GEO_polygon',
      points: [
        {x: 550, y: 650},
        {x: 590, y: 650},
      ],
      penColor: 0x00,
      penType: 10,
      penWidth: 400,
    };
    mockGetLasso.mockResolvedValue({success: true, result: [lassoStroke]});
    mockDecode.mockReturnValue({
      ok: true,
      tree,
      nodeBboxesById: mindmapLocalBboxes,
      markerOriginPage,
    });

    let renderer!: ReactTestRenderer;
    act(() => {
      renderer = create(<EditMindmap />);
    });
    await flushAsync(renderer);

    const hits = renderer.root.findAll(
      node =>
        typeof node.type === 'string' &&
        node.props.accessibilityLabel === `preserved-stroke-node-${tree.rootId}`,
    );
    expect(hits).toHaveLength(1);
    const styleArr = hits[0].props.style;
    // Flatten the style array into a single object (same pattern the
    // canvas test suite uses).
    const flat: Record<string, unknown> = {};
    const flatten = (s: unknown): void => {
      if (!s) {
        return;
      }
      if (Array.isArray(s)) {
        s.forEach(flatten);
        return;
      }
      Object.assign(flat, s as Record<string, unknown>);
    };
    flatten(styleArr);
    expect(flat.width).toBe(40);
    expect(flat.left).toBe(50);
    expect(flat.top).toBe(45);
    expect(flat.height).toBe(10);
    act(() => {
      renderer.unmount();
    });
  });
});
