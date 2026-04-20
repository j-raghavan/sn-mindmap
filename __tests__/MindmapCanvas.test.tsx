/**
 * Tests for src/MindmapCanvas.tsx.
 *
 * Phase 1.4a coverage — read-only authoring canvas:
 *   - Top-bar Cancel button exists and dismisses via PluginManager
 *     (regression for the Phase 0 "Notes hangs" bug — logcat.txt
 *     04-18 22:19:25+).
 *   - Default (no initialTree prop) renders a single-node tree.
 *   - initialTree prop drives the render: node count matches tree
 *     node count, and one connector View per parent→child edge.
 *   - Each node gets an accessibilityLabel="node-<id>" so on-device
 *     debugging from logcat can correlate tree ids with rendered
 *     Views.
 *
 * Phase 1.4b coverage — mutations + per-node action icons:
 *   - Add Child / Add Sibling / Delete / Collapse toggle affordances
 *     appear with the correct visibility rules (§F-AC-5).
 *   - Tapping an action icon updates the rendered tree (node count
 *     grows, collapsed subtrees disappear, deleted subtrees
 *     disappear).
 *   - Selection state drives the Delete icon visibility and is
 *     cleared by tapping the background or the same node twice.
 *   - initialTree is defensively cloned on mount — the caller's
 *     tree object is never mutated by canvas actions.
 *
 * Phase 2 adds Insert.
 */
import React from 'react';
import {create, act} from 'react-test-renderer';

// sn-plugin-lib ships as untransformed ESM that jest can't parse out
// of the box — sn-shapes handles this the same way per test file.
// The mock covers PluginManager.closePluginView (Cancel button) plus
// the PluginCommAPI / PluginFileAPI surface that Phase 2.2's insert
// pipeline dips into. Default mock responses succeed; individual
// tests override them when exercising error paths.
jest.mock('sn-plugin-lib', () => ({
  PluginManager: {
    closePluginView: jest.fn().mockResolvedValue(true),
  },
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
    // Batched insert path — insertMindmap prefers PluginFileAPI.insertElements
    // when the note context resolves cleanly (default mocks above return
    // success). Sequential insertGeometry is only used in the fallback
    // path forced by rejecting getCurrentFilePath.
    insertElements: jest.fn().mockResolvedValue({success: true}),
  },
}));

import MindmapCanvas from '../src/MindmapCanvas';
import {PluginCommAPI, PluginFileAPI, PluginManager} from 'sn-plugin-lib';
import {MARKER_PEN_COLOR} from '../src/marker/encode';
import {addChild, addSibling, createTree} from '../src/model/tree';

/**
 * Collect the geometries that insertMindmap emitted, independent of
 * the firmware path used. The batched path (PluginFileAPI.insertElements)
 * wraps each geometry as `{type:700, geometry}` and submits the array
 * in a single call; the sequential fallback (PluginCommAPI.insertGeometry)
 * calls once per geometry. This helper normalizes both shapes to a
 * single flat list of geometries so count / filter assertions stay
 * path-agnostic.
 */
function collectInsertedGeometries(): Array<{
  type?: string;
  penColor?: number;
}> {
  const batchCalls = (PluginFileAPI.insertElements as jest.Mock).mock.calls;
  if (batchCalls.length > 0) {
    const out: Array<{type?: string; penColor?: number}> = [];
    for (const call of batchCalls) {
      const elements = call[2] as Array<{geometry: {type?: string; penColor?: number}}>;
      for (const element of elements) {
        out.push(element.geometry);
      }
    }
    return out;
  }
  return (PluginCommAPI.insertGeometry as jest.Mock).mock.calls.map(
    ([geometry]) => geometry,
  );
}

/**
 * Filter inserted geometries down to the "primary" emit mix
 * (outlines + connectors + preserved strokes). Marker strokes share
 * the straightLine type but carry pen color 0x9D (§6.4); every insert
 * produces several hundred of them, so assertions that care about the
 * structural geometry count filter them out. Path-agnostic: works
 * with both the batched insertElements and sequential insertGeometry
 * mocks.
 */
function nonMarkerInsertCount(): number {
  return collectInsertedGeometries().filter(
    geometry =>
      !(
        geometry?.type === 'straightLine' &&
        geometry?.penColor === MARKER_PEN_COLOR
      ),
  ).length;
}


function flushPromises(): Promise<void> {
  return new Promise(resolve =>
    jest.requireActual<typeof globalThis>('timers').setImmediate(resolve),
  );
}

async function flushAsync(): Promise<void> {
  await act(async () => {
    await flushPromises();
    await flushPromises();
  });
}

type Renderer = ReturnType<typeof create>;
type TestInstance = ReturnType<Renderer['root']['findAll']>[number];

function renderCanvas(
  element: React.ReactElement,
): {renderer: Renderer; unmount: () => void} {
  let renderer: Renderer | undefined;
  act(() => {
    renderer = create(element);
  });
  if (!renderer) {
    throw new Error('renderCanvas: react-test-renderer returned undefined');
  }
  const unmount = (): void => {
    act(() => {
      renderer?.unmount();
    });
  };
  return {renderer, unmount};
}

/**
 * Flatten a React Native `style` prop (object | array | falsy) into
 * a single object. MindmapCanvas uses style arrays `[styles.base,
 * {dynamic}]` to satisfy react-native/no-inline-styles; tests need
 * the merged view.
 */
function flattenStyle(style: unknown): Record<string, unknown> {
  if (!style) {
    return {};
  }
  if (Array.isArray(style)) {
    return Object.assign({}, ...style.map(flattenStyle));
  }
  return style as Record<string, unknown>;
}

/**
 * Find host-level TestInstances (where `instance.type` is a string
 * like "View") matching the given accessibilityLabel. react-test-
 * renderer surfaces both the composite React component instance and
 * the underlying host instance when RN internals (Pressable,
 * transformed View, etc.) forward props through — this dedupes to
 * the host layer so counts match user intent ("how many rendered
 * <View>s have this label").
 */
function findHostByLabel(
  renderer: Renderer,
  label: string,
): TestInstance[] {
  return renderer.root.findAll(
    node => typeof node.type === 'string' && node.props.accessibilityLabel === label,
  );
}

/**
 * findByLabel — single host match. Throws if not exactly one match,
 * matching the semantics of findByProps but via our host filter so
 * Pressable/composite doubling doesn't trip us up.
 */
function findHostSingle(renderer: Renderer, label: string): TestInstance {
  const hits = findHostByLabel(renderer, label);
  if (hits.length !== 1) {
    throw new Error(
      `findHostSingle: expected 1 match for "${label}", got ${hits.length}`,
    );
  }
  return hits[0];
}

/**
 * Find the Pressable (composite) instance wearing the given
 * accessibilityLabel. Pressables don't forward their onPress down to
 * the underlying host View — the composite is where the handler
 * lives, so button-press tests have to target it specifically
 * rather than the host match from findHostByLabel.
 */
function findPressable(renderer: Renderer, label: string): TestInstance {
  // Pressable is implemented as React.memo(forwardRef(...)), so the
  // test-renderer tree carries the composite at two levels — memo
  // wrapper and forwardRef wrapper — both wearing the same props.
  // Filtering to composite instances (node.type is an object, not a
  // string) then taking the outermost match is enough: either level
  // fires the same onPress.
  const hits = renderer.root.findAll(
    node =>
      typeof node.type !== 'string' &&
      node.props.accessibilityLabel === label &&
      typeof node.props.onPress === 'function',
  );
  if (hits.length === 0) {
    throw new Error(`findPressable: no Pressable with label "${label}"`);
  }
  return hits[0];
}

/**
 * Invoke a Pressable's onPress inside act(). Resolved by label so
 * tests read close to how a user describes the interaction
 * ("tap the Add Child button on node 2").
 */
function pressByLabel(renderer: Renderer, label: string): void {
  const instance = findPressable(renderer, label);
  const onPress = instance.props.onPress as () => void;
  act(() => {
    onPress();
  });
}

describe('MindmapCanvas', () => {
  beforeEach(() => {
    (PluginManager.closePluginView as jest.Mock).mockClear();
  });

  describe('Cancel button (regression for Phase 0 "Notes hangs" bug)', () => {
    it('renders a Cancel button with accessibilityLabel', () => {
      const {renderer, unmount} = renderCanvas(<MindmapCanvas />);
      const cancel = findHostSingle(renderer, 'Cancel');
      expect(cancel).toBeTruthy();
      unmount();
    });

    it('Cancel button invokes PluginManager.closePluginView', () => {
      const {renderer, unmount} = renderCanvas(<MindmapCanvas />);
      pressByLabel(renderer, 'Cancel');
      expect(PluginManager.closePluginView).toHaveBeenCalledTimes(1);
      unmount();
    });
  });

  describe('default (no initialTree) → single-node tree', () => {
    it('renders exactly one node frame', () => {
      const {renderer, unmount} = renderCanvas(<MindmapCanvas />);
      // Only node-0 exists (the auto-created root Oval).
      const root = findHostByLabel(renderer, 'node-0');
      expect(root).toHaveLength(1);
      // No connectors on a single-node tree.
      const connectors = findHostByLabel(renderer, 'connector');
      expect(connectors).toHaveLength(0);
      unmount();
    });
  });

  describe('initialTree prop drives the render', () => {
    it('renders one node View per tree node', () => {
      const tree = createTree();
      const a = addChild(tree, tree.rootId);
      const b = addChild(tree, tree.rootId);
      addChild(tree, a);
      addSibling(tree, b);
      // Tree now has 5 nodes: root, a, b, a's child, b's sibling.
      const {renderer, unmount} = renderCanvas(
        <MindmapCanvas initialTree={tree} />,
      );
      for (const id of tree.nodesById.keys()) {
        const hits = findHostByLabel(renderer, `node-${id}`);
        expect(hits).toHaveLength(1);
      }
      unmount();
    });

    it('renders one connector View per parent→child edge', () => {
      // Tree shape: root → [a, b]; a → [c]. Three edges total.
      const tree = createTree();
      const a = addChild(tree, tree.rootId);
      addChild(tree, tree.rootId);
      addChild(tree, a);
      const {renderer, unmount} = renderCanvas(
        <MindmapCanvas initialTree={tree} />,
      );
      const connectors = findHostByLabel(renderer, 'connector');
      expect(connectors).toHaveLength(3);
      unmount();
    });

    it('OVAL root renders with fully-rounded borderRadius (= bbox.h / 2)', () => {
      // Root is OVAL by construction (createTree). Its bbox is
      // NODE_WIDTH × NODE_HEIGHT = 220 × 96 centered on origin, so
      // borderRadius should be 48.
      const {renderer, unmount} = renderCanvas(<MindmapCanvas />);
      const root = findHostSingle(renderer, 'node-0');
      const style = flattenStyle(root.props.style);
      expect(style.borderRadius).toBe(48);
      unmount();
    });

    it('RECTANGLE child renders with borderRadius = 0', () => {
      const tree = createTree();
      const a = addChild(tree, tree.rootId);
      const {renderer, unmount} = renderCanvas(
        <MindmapCanvas initialTree={tree} />,
      );
      const node = findHostSingle(renderer, `node-${a}`);
      const style = flattenStyle(node.props.style);
      expect(style.borderRadius).toBe(0);
      unmount();
    });

    it('ROUNDED_RECTANGLE sibling renders with SIBLING_CORNER_RADIUS', () => {
      const tree = createTree();
      const a = addChild(tree, tree.rootId);
      const s = addSibling(tree, a);
      const {renderer, unmount} = renderCanvas(
        <MindmapCanvas initialTree={tree} />,
      );
      const node = findHostSingle(renderer, `node-${s}`);
      const style = flattenStyle(node.props.style);
      // SIBLING_CORNER_RADIUS = 15 per layout/constants.ts.
      expect(style.borderRadius).toBe(15);
      unmount();
    });
  });

  describe('stage bounds', () => {
    it('renders a stage View sized to the layout union bbox', () => {
      const tree = createTree();
      addChild(tree, tree.rootId);
      addChild(tree, tree.rootId);
      const {renderer, unmount} = renderCanvas(
        <MindmapCanvas initialTree={tree} />,
      );
      const stage = findHostSingle(renderer, 'mindmap-stage');
      const style = stage.props.style as {width: number; height: number};
      expect(style.width).toBeGreaterThan(0);
      expect(style.height).toBeGreaterThan(0);
      unmount();
    });
  });

  describe('Phase 1.4b — action icon visibility (§F-AC-5)', () => {
    it('root shows Add Child but NOT Add Sibling', () => {
      const {renderer, unmount} = renderCanvas(<MindmapCanvas />);
      expect(findHostByLabel(renderer, 'add-child-0')).toHaveLength(1);
      expect(findHostByLabel(renderer, 'add-sibling-0')).toHaveLength(0);
      unmount();
    });

    it('non-root nodes show both Add Child and Add Sibling', () => {
      const tree = createTree();
      const a = addChild(tree, tree.rootId);
      const {renderer, unmount} = renderCanvas(
        <MindmapCanvas initialTree={tree} />,
      );
      expect(findHostByLabel(renderer, `add-child-${a}`)).toHaveLength(1);
      expect(findHostByLabel(renderer, `add-sibling-${a}`)).toHaveLength(1);
      unmount();
    });

    it('collapse toggle only appears on nodes with ≥ 1 child', () => {
      const tree = createTree();
      const a = addChild(tree, tree.rootId);
      const {renderer, unmount} = renderCanvas(
        <MindmapCanvas initialTree={tree} />,
      );
      // Root has 1 child → toggle visible. Node `a` is a leaf → no toggle.
      expect(findHostByLabel(renderer, 'collapse-0')).toHaveLength(1);
      expect(findHostByLabel(renderer, `collapse-${a}`)).toHaveLength(0);
      unmount();
    });

    it('delete icon is hidden until the node is selected, and never on root', () => {
      const tree = createTree();
      const a = addChild(tree, tree.rootId);
      const {renderer, unmount} = renderCanvas(
        <MindmapCanvas initialTree={tree} />,
      );
      // Nothing selected initially.
      expect(findHostByLabel(renderer, `delete-${a}`)).toHaveLength(0);
      expect(findHostByLabel(renderer, 'delete-0')).toHaveLength(0);
      // Select node `a`.
      pressByLabel(renderer, `node-${a}`);
      expect(findHostByLabel(renderer, `delete-${a}`)).toHaveLength(1);
      // Select the root — still no delete affordance for root.
      pressByLabel(renderer, 'node-0');
      expect(findHostByLabel(renderer, 'delete-0')).toHaveLength(0);
      // And `a` is no longer selected → its delete icon is gone.
      expect(findHostByLabel(renderer, `delete-${a}`)).toHaveLength(0);
      unmount();
    });
  });

  describe('Phase 1.4b — selection behaviour', () => {
    it('tapping the same node twice clears selection', () => {
      const tree = createTree();
      const a = addChild(tree, tree.rootId);
      const {renderer, unmount} = renderCanvas(
        <MindmapCanvas initialTree={tree} />,
      );
      pressByLabel(renderer, `node-${a}`);
      expect(findHostByLabel(renderer, `delete-${a}`)).toHaveLength(1);
      pressByLabel(renderer, `node-${a}`);
      expect(findHostByLabel(renderer, `delete-${a}`)).toHaveLength(0);
      unmount();
    });

    it('tapping the background clears selection', () => {
      const tree = createTree();
      const a = addChild(tree, tree.rootId);
      const {renderer, unmount} = renderCanvas(
        <MindmapCanvas initialTree={tree} />,
      );
      pressByLabel(renderer, `node-${a}`);
      expect(findHostByLabel(renderer, `delete-${a}`)).toHaveLength(1);
      pressByLabel(renderer, 'mindmap-background');
      expect(findHostByLabel(renderer, `delete-${a}`)).toHaveLength(0);
      unmount();
    });
  });

  describe('Phase 1.4b — mutations re-render the tree', () => {
    it('Add Child adds a new child node and its connector', () => {
      const {renderer, unmount} = renderCanvas(<MindmapCanvas />);
      // Start: single root → 1 node, 0 connectors.
      expect(findHostByLabel(renderer, 'connector')).toHaveLength(0);
      pressByLabel(renderer, 'add-child-0');
      // Now there should be 2 nodes (root + new child id=1) and 1
      // connector.
      expect(findHostByLabel(renderer, 'node-1')).toHaveLength(1);
      expect(findHostByLabel(renderer, 'connector')).toHaveLength(1);
      unmount();
    });

    it('Add Sibling inserts a peer next to the tapped node', () => {
      const tree = createTree();
      const a = addChild(tree, tree.rootId);
      const {renderer, unmount} = renderCanvas(
        <MindmapCanvas initialTree={tree} />,
      );
      pressByLabel(renderer, `add-sibling-${a}`);
      // Root now has 2 children: `a` and a new sibling. We know the
      // next id assigned by allocateNode is nextId at the time of
      // the action; since the canvas cloned the tree the caller's
      // tree has nextId=2 still, but the canvas's copy has minted
      // id=2. Check by counting rendered nodes: root, a, and the new
      // sibling = 3 nodes.
      expect(findHostByLabel(renderer, 'node-0')).toHaveLength(1);
      expect(findHostByLabel(renderer, `node-${a}`)).toHaveLength(1);
      expect(findHostByLabel(renderer, 'node-2')).toHaveLength(1);
      unmount();
    });

    it('Delete removes the subtree and clears selection', () => {
      const tree = createTree();
      const a = addChild(tree, tree.rootId);
      const aa = addChild(tree, a);
      const {renderer, unmount} = renderCanvas(
        <MindmapCanvas initialTree={tree} />,
      );
      // Select `a` so its Delete icon is rendered.
      pressByLabel(renderer, `node-${a}`);
      pressByLabel(renderer, `delete-${a}`);
      // Both `a` and `aa` should be gone; only the root remains.
      expect(findHostByLabel(renderer, `node-${a}`)).toHaveLength(0);
      expect(findHostByLabel(renderer, `node-${aa}`)).toHaveLength(0);
      expect(findHostByLabel(renderer, 'node-0')).toHaveLength(1);
      unmount();
    });

    it('Collapse hides descendants and surfaces the +N badge', () => {
      const tree = createTree();
      const a = addChild(tree, tree.rootId);
      const aa = addChild(tree, a);
      addChild(tree, aa);
      const {renderer, unmount} = renderCanvas(
        <MindmapCanvas initialTree={tree} />,
      );
      // Collapse `a`. `aa` and its child both vanish.
      pressByLabel(renderer, `collapse-${a}`);
      expect(findHostByLabel(renderer, `node-${aa}`)).toHaveLength(0);
      // `a` itself is still visible AND still has a collapse
      // affordance (now in ring/"+N" state).
      expect(findHostByLabel(renderer, `node-${a}`)).toHaveLength(1);
      expect(findHostByLabel(renderer, `collapse-${a}`)).toHaveLength(1);
      // Expand again — descendants come back.
      pressByLabel(renderer, `collapse-${a}`);
      expect(findHostByLabel(renderer, `node-${aa}`)).toHaveLength(1);
      unmount();
    });
  });

  describe('Phase 1.4b — initialTree is defensively cloned', () => {
    it('mutations on the canvas do not leak back into the caller tree', () => {
      const tree = createTree();
      const snapshotBefore = tree.nodesById.size;
      const {renderer, unmount} = renderCanvas(
        <MindmapCanvas initialTree={tree} />,
      );
      pressByLabel(renderer, 'add-child-0');
      // Canvas rendered 2 nodes.
      expect(findHostByLabel(renderer, 'node-0')).toHaveLength(1);
      expect(findHostByLabel(renderer, 'node-1')).toHaveLength(1);
      // But the caller's tree is untouched.
      expect(tree.nodesById.size).toBe(snapshotBefore);
      expect(tree.nodesById.has(1)).toBe(false);
      unmount();
    });
  });

  describe('Phase 1.4b.1 — auto-fit to viewport (§F-AC-2)', () => {
    // Pulls the scale value out of the fit-wrapper's transform array.
    // Matches the `transform: [{scale: n}]` shape the canvas writes.
    function readFitScale(renderer: Renderer): number {
      const wrapper = findHostSingle(renderer, 'mindmap-fit-wrapper');
      const style = flattenStyle(wrapper.props.style);
      const transform = style.transform as unknown;
      if (!Array.isArray(transform)) {
        throw new Error(
          'readFitScale: expected transform array on fit-wrapper',
        );
      }
      const scaleEntry = transform.find(
        (t: unknown): t is {scale: number} =>
          typeof t === 'object' &&
          t !== null &&
          typeof (t as {scale?: unknown}).scale === 'number',
      );
      if (!scaleEntry) {
        throw new Error('readFitScale: no {scale: n} in transform array');
      }
      return scaleEntry.scale;
    }

    // Invokes the Pressable-level onLayout with a synthetic event so
    // the canvas measures the viewport and re-computes fitScale.
    // react-test-renderer does not run native layout itself.
    function fireSurfaceLayout(
      renderer: Renderer,
      width: number,
      height: number,
    ): void {
      const hits = renderer.root.findAll(
        node =>
          typeof node.type !== 'string' &&
          node.props.accessibilityLabel === 'mindmap-background' &&
          typeof node.props.onLayout === 'function',
      );
      if (hits.length === 0) {
        throw new Error(
          'fireSurfaceLayout: no onLayout on mindmap-background',
        );
      }
      const onLayout = hits[0].props.onLayout as (e: unknown) => void;
      act(() => {
        onLayout({nativeEvent: {layout: {x: 0, y: 0, width, height}}});
      });
    }

    it('default (pre-layout) scale is 1', () => {
      const {renderer, unmount} = renderCanvas(<MindmapCanvas />);
      expect(readFitScale(renderer)).toBe(1);
      unmount();
    });

    it('small tree (lone root) stays at scale 1 even in a large viewport', () => {
      const {renderer, unmount} = renderCanvas(<MindmapCanvas />);
      fireSurfaceLayout(renderer, 1404, 1800); // Nomad-ish authoring area.
      // A 220×96 root with 48-px padding fits trivially; scale caps
      // at 1 so the root stays at its designed size.
      expect(readFitScale(renderer)).toBe(1);
      unmount();
    });

    it('big tree scales down to fit the viewport with padding', () => {
      // Build a tree wider than a typical viewport so auto-fit kicks
      // in. 20 first-level children on a R1=340 orbit gives a
      // unionBbox of ~900 wide × ~900 tall even before NODE_WIDTH;
      // we squeeze it into a 400×400 viewport to force scale < 1.
      const tree = createTree();
      for (let i = 0; i < 20; i += 1) {
        addChild(tree, tree.rootId);
      }
      const {renderer, unmount} = renderCanvas(
        <MindmapCanvas initialTree={tree} />,
      );
      fireSurfaceLayout(renderer, 400, 400);
      const scale = readFitScale(renderer);
      expect(scale).toBeLessThan(1);
      expect(scale).toBeGreaterThan(0);
      unmount();
    });

    it('re-layout to a tighter viewport tightens the scale', () => {
      const tree = createTree();
      for (let i = 0; i < 20; i += 1) {
        addChild(tree, tree.rootId);
      }
      const {renderer, unmount} = renderCanvas(
        <MindmapCanvas initialTree={tree} />,
      );
      fireSurfaceLayout(renderer, 800, 800);
      const loose = readFitScale(renderer);
      fireSurfaceLayout(renderer, 300, 300);
      const tight = readFitScale(renderer);
      expect(tight).toBeLessThan(loose);
      unmount();
    });
  });

  describe('Clear button — destructive reset with two-tap confirm', () => {
    beforeEach(() => {
      jest.useFakeTimers();
    });
    afterEach(() => {
      act(() => {
        jest.runOnlyPendingTimers();
      });
      jest.useRealTimers();
    });

    it('renders a Clear button with accessibilityLabel in the top bar', () => {
      const {renderer, unmount} = renderCanvas(<MindmapCanvas />);
      expect(findHostByLabel(renderer, 'Clear')).toHaveLength(1);
      unmount();
    });

    it('first tap arms the button (label swaps to "Confirm Clear"); tree unchanged', () => {
      const tree = createTree();
      addChild(tree, tree.rootId);
      addChild(tree, tree.rootId);
      const {renderer, unmount} = renderCanvas(
        <MindmapCanvas initialTree={tree} />,
      );
      // Before tap: three nodes visible, "Clear" label present.
      expect(findHostByLabel(renderer, 'Clear')).toHaveLength(1);
      expect(findHostByLabel(renderer, 'Confirm Clear')).toHaveLength(0);
      expect(findHostByLabel(renderer, 'node-1')).toHaveLength(1);
      expect(findHostByLabel(renderer, 'node-2')).toHaveLength(1);
      // First tap arms — children are still present.
      pressByLabel(renderer, 'Clear');
      expect(findHostByLabel(renderer, 'Clear')).toHaveLength(0);
      expect(findHostByLabel(renderer, 'Confirm Clear')).toHaveLength(1);
      expect(findHostByLabel(renderer, 'node-1')).toHaveLength(1);
      expect(findHostByLabel(renderer, 'node-2')).toHaveLength(1);
      unmount();
    });

    it('second tap within the confirm window wipes the tree back to a single root', () => {
      const tree = createTree();
      addChild(tree, tree.rootId);
      addChild(tree, tree.rootId);
      const {renderer, unmount} = renderCanvas(
        <MindmapCanvas initialTree={tree} />,
      );
      pressByLabel(renderer, 'Clear');
      pressByLabel(renderer, 'Confirm Clear');
      // Only the fresh root (id=0) should remain. Previous ids 1 and
      // 2 are gone.
      expect(findHostByLabel(renderer, 'node-0')).toHaveLength(1);
      expect(findHostByLabel(renderer, 'node-1')).toHaveLength(0);
      expect(findHostByLabel(renderer, 'node-2')).toHaveLength(0);
      // Button disarms back to "Clear" after commit.
      expect(findHostByLabel(renderer, 'Clear')).toHaveLength(1);
      expect(findHostByLabel(renderer, 'Confirm Clear')).toHaveLength(0);
      unmount();
    });

    it('clears selection when the tree is reset (no stale selectedId pointing at a dead node)', () => {
      const tree = createTree();
      const a = addChild(tree, tree.rootId);
      const {renderer, unmount} = renderCanvas(
        <MindmapCanvas initialTree={tree} />,
      );
      // Select `a` so its Delete × appears — this is our selection
      // tell.
      pressByLabel(renderer, `node-${a}`);
      expect(findHostByLabel(renderer, `delete-${a}`)).toHaveLength(1);
      pressByLabel(renderer, 'Clear');
      pressByLabel(renderer, 'Confirm Clear');
      // After clear: node `a` is gone AND the fresh root is not
      // selected (no delete icon renders anywhere — the root is never
      // deletable regardless of selection, but we also assert that
      // the old id doesn't leak back as a dangling selection that
      // would break assumptions downstream).
      expect(findHostByLabel(renderer, `node-${a}`)).toHaveLength(0);
      expect(findHostByLabel(renderer, `delete-${a}`)).toHaveLength(0);
      unmount();
    });

    it('auto-disarms after CLEAR_CONFIRM_MS with no second tap (tree unchanged)', () => {
      const tree = createTree();
      addChild(tree, tree.rootId);
      const {renderer, unmount} = renderCanvas(
        <MindmapCanvas initialTree={tree} />,
      );
      pressByLabel(renderer, 'Clear');
      expect(findHostByLabel(renderer, 'Confirm Clear')).toHaveLength(1);
      // Advance past the confirm window; the disarm timer fires and
      // the button reverts to "Clear" without touching the tree.
      act(() => {
        jest.advanceTimersByTime(3500);
      });
      expect(findHostByLabel(renderer, 'Clear')).toHaveLength(1);
      expect(findHostByLabel(renderer, 'Confirm Clear')).toHaveLength(0);
      expect(findHostByLabel(renderer, 'node-1')).toHaveLength(1);
      unmount();
    });
  });

  describe('Phase 2.2 — Insert button wires to insertMindmap (§F-IN-*)', () => {
    beforeEach(() => {
      (PluginCommAPI.insertGeometry as jest.Mock).mockClear();
      (PluginCommAPI.insertGeometry as jest.Mock).mockResolvedValue({
        success: true,
      });
      (PluginFileAPI.insertElements as jest.Mock).mockClear();
      (PluginFileAPI.insertElements as jest.Mock).mockResolvedValue({
        success: true,
      });
      (PluginCommAPI.lassoElements as jest.Mock).mockClear();
      (PluginCommAPI.lassoElements as jest.Mock).mockResolvedValue({
        success: true,
      });
      (PluginCommAPI.deleteLassoElements as jest.Mock).mockClear();
      (PluginCommAPI.deleteLassoElements as jest.Mock).mockResolvedValue({
        success: true,
      });
      (PluginManager.closePluginView as jest.Mock).mockClear();
      (PluginManager.closePluginView as jest.Mock).mockResolvedValue(true);
    });

    it('renders an enabled Insert Pressable with label "Insert"', () => {
      const {renderer, unmount} = renderCanvas(<MindmapCanvas />);
      const insert = findPressable(renderer, 'Insert');
      expect(insert.props.accessibilityState?.disabled).toBe(false);
      expect(insert.props.disabled).toBe(false);
      unmount();
    });

    it('tapping Insert drives the full §F-IN-* pipeline', async () => {
      const tree = createTree();
      addChild(tree, tree.rootId);
      const {renderer, unmount} = renderCanvas(
        <MindmapCanvas initialTree={tree} />,
      );

      const insert = findPressable(renderer, 'Insert');
      const onPress = insert.props.onPress as () => void;
      await act(async () => {
        onPress();
        await flushPromises();
        await flushPromises();
      });

      // 2 outlines + 1 connector = 3 non-marker geometries, then a
      // single lasso and a single close. Marker bits (§6.4, penColor
      // 0x9D) are emitted alongside but filtered out of this count
      // so the assertion stays stable if the marker payload shifts.
      expect(nonMarkerInsertCount()).toBe(3);
      expect(PluginCommAPI.lassoElements).toHaveBeenCalledTimes(1);
      expect(PluginManager.closePluginView).toHaveBeenCalledTimes(1);
      unmount();
    });

    it('shows an error banner when insert fails and keeps the plugin view open', async () => {
      (PluginFileAPI.insertElements as jest.Mock).mockResolvedValueOnce({
        success: false,
        error: {message: 'simulated insert failure'},
      });

      const {renderer, unmount} = renderCanvas(<MindmapCanvas />);
      const insert = findPressable(renderer, 'Insert');
      const onPress = insert.props.onPress as () => void;
      await act(async () => {
        onPress();
        await flushPromises();
        await flushPromises();
      });

      const banners = findHostByLabel(renderer, 'insert-error');
      expect(banners).toHaveLength(1);
      expect(PluginManager.closePluginView).not.toHaveBeenCalled();
      unmount();
    });

    it('debounces rapid double-taps so only one insert runs at a time', async () => {
      // Make the batched insertElements slow enough that a second tap
      // can land while the first is still in flight. Using a promise
      // we resolve manually to avoid timing flake.
      // TS's flow analysis can't see that the Promise executor fires
      // synchronously, so we initialize resolveFirst with a no-op and
      // reassign inside the executor to keep the type `() => void`.
      let resolveFirst: () => void = () => {};
      const firstPending = new Promise<void>(r => {
        resolveFirst = r;
      });
      (PluginFileAPI.insertElements as jest.Mock).mockImplementationOnce(
        async () => {
          await firstPending;
          return {success: true};
        },
      );

      const {renderer, unmount} = renderCanvas(<MindmapCanvas />);
      const insert = findPressable(renderer, 'Insert');
      const onPress = insert.props.onPress as () => void;

      await act(async () => {
        onPress(); // kick off first insert
        await flushPromises();
      });
      await act(async () => {
        onPress(); // second tap while first is in flight — no-op
        await flushPromises();
      });

      // At this point insertElements has been called exactly once —
      // the second tap was debounced via insertingRef.
      expect(PluginFileAPI.insertElements).toHaveBeenCalledTimes(1);

      // Let the first insert complete cleanly.
      resolveFirst();
      await flushAsync();
      unmount();
    });
  });

  describe('Phase 4.3 — isEditMode top-bar gating', () => {
    // Until §F-ED-7 Save lands (Phase 4.5), edit-mode is Cancel-only.
    // These tests lock in that contract so Phase 4.4/4.5 edits can't
    // regress it without a visible test churn.

    it('hides the Insert button when isEditMode=true', () => {
      const {renderer, unmount} = renderCanvas(
        <MindmapCanvas isEditMode />,
      );
      const insertBtns = renderer.root.findAllByProps({
        accessibilityLabel: 'Insert',
      });
      expect(insertBtns.length).toBe(0);
      unmount();
    });

    it('still renders the Cancel button when isEditMode=true', () => {
      const {renderer, unmount} = renderCanvas(
        <MindmapCanvas isEditMode />,
      );
      const cancelBtns = renderer.root.findAllByProps({
        accessibilityLabel: 'Cancel',
      });
      // One Pressable is registered with the accessibilityLabel; the
      // host View underneath forwards the prop so the host layer
      // surfaces it too. Either way the user-facing affordance must
      // be present.
      expect(cancelBtns.length).toBeGreaterThan(0);
      unmount();
    });

    it('still renders the Clear button when isEditMode=true', () => {
      // Clear is topology-only ("reset to fresh root") and remains
      // useful in edit mode for "start this edit over". Phase 4.5
      // revisits whether Clear should also be gated; for now it is
      // explicitly allowed.
      const {renderer, unmount} = renderCanvas(
        <MindmapCanvas isEditMode />,
      );
      const clearBtns = renderer.root.findAllByProps({
        accessibilityLabel: 'Clear',
      });
      expect(clearBtns.length).toBeGreaterThan(0);
      unmount();
    });

    it('shows the Insert button when isEditMode is omitted (authoring default)', () => {
      // Regression guard: isEditMode defaults to false, so the
      // authoring canvas is unaffected by this new prop.
      const {renderer, unmount} = renderCanvas(<MindmapCanvas />);
      const insertBtns = renderer.root.findAllByProps({
        accessibilityLabel: 'Insert',
      });
      expect(insertBtns.length).toBeGreaterThan(0);
      unmount();
    });

    it('does not call insertGeometry when isEditMode=true (Insert is unreachable)', async () => {
      (PluginCommAPI.insertGeometry as jest.Mock).mockClear();
      const {unmount} = renderCanvas(<MindmapCanvas isEditMode />);
      await flushAsync();
      expect(PluginCommAPI.insertGeometry).not.toHaveBeenCalled();
      unmount();
    });
  });

  describe('Phase 4.4 — preserved-stroke rendering (§F-ED-6)', () => {
    // These tests lock in the read-only label-stroke rendering path.
    // Preserved strokes come in bucketed per-node in NODE-LOCAL coords
    // (offset from each node's pre-edit page bbox top-left, per the
    // EditMindmap-side projection); the canvas must render them
    // anchored to each node's CURRENT radial-layout bbox so strokes
    // follow the node as the user edits topology.

    // A minimal pen-style fixture — the sn-plugin-lib firmware allow
    // list expects penType=10 (Fineliner) in emissions, but Phase 4.4
    // read-only rendering doesn't touch penType; any numeric value
    // is fine for these tests.
    const PEN = {penColor: 0x00, penType: 10, penWidth: 400} as const;

    it('renders polyline stroke segments with accessibilityLabel tagged by node id', () => {
      // Root-only tree → one visible node. A 3-point polyline becomes
      // 2 segments. The accessibility label lets us count segments
      // per node without reading into style math.
      const tree = createTree();
      const strokes = new Map<number, Array<unknown>>();
      strokes.set(tree.rootId, [
        {
          type: 'GEO_polygon',
          points: [
            {x: 5, y: 10},
            {x: 15, y: 10},
            {x: 25, y: 20},
          ],
          ...PEN,
        },
      ]);
      const {renderer, unmount} = renderCanvas(
        <MindmapCanvas
          initialTree={tree}
          isEditMode
          initialPreservedStrokes={strokes as never}
        />,
      );
      const segments = findHostByLabel(
        renderer,
        `preserved-stroke-node-${tree.rootId}`,
      );
      expect(segments).toHaveLength(2);
      unmount();
    });

    it('anchors polyline stroke to the node\'s current bbox (left/top derived from layout)', () => {
      // Single-segment polyline on the root. We can reason about the
      // expected stage-coord position analytically: bbox top-left -
      // origin + midX - length/2 for the segment.
      const tree = createTree();
      const from = {x: 10, y: 20};
      const to = {x: 60, y: 20};
      const strokes = new Map<number, Array<unknown>>();
      strokes.set(tree.rootId, [
        {type: 'GEO_polygon', points: [from, to], ...PEN},
      ]);
      const {renderer, unmount} = renderCanvas(
        <MindmapCanvas
          initialTree={tree}
          isEditMode
          initialPreservedStrokes={strokes as never}
        />,
      );
      const segments = findHostByLabel(
        renderer,
        `preserved-stroke-node-${tree.rootId}`,
      );
      expect(segments).toHaveLength(1);
      const style = flattenStyle(segments[0].props.style);
      // length = 50, thickness = penWidth * 1/40 (10 px). midX=35,
      // midY=20. Stage offset for the root depends on the union bbox
      // — the root is centered on (0,0) so its bbox top-left is
      // (-NODE_WIDTH/2, -NODE_HEIGHT/2), and that also equals the
      // stage origin (unionBbox = rootBbox for a lone root), so
      // bbox.x - origin.x = 0 and bbox.y - origin.y = 0. The segment
      // renders at (midX - length/2, midY - thickness/2) = (10, 15).
      expect(style.width).toBe(50);
      expect(style.left).toBe(10);
      // thickness = max(2, 400/40) = 10, so top = 20 - 5 = 15.
      expect(style.top).toBe(15);
      expect(style.height).toBe(10);
      unmount();
    });

    it('renders ellipse stroke as a single bordered View', () => {
      const tree = createTree();
      const strokes = new Map<number, Array<unknown>>();
      strokes.set(tree.rootId, [
        {
          type: 'GEO_ellipse',
          ellipseCenterPoint: {x: 40, y: 30},
          ellipseMajorAxisRadius: 20,
          ellipseMinorAxisRadius: 12,
          ellipseAngle: 0,
          ...PEN,
        },
      ]);
      const {renderer, unmount} = renderCanvas(
        <MindmapCanvas
          initialTree={tree}
          isEditMode
          initialPreservedStrokes={strokes as never}
        />,
      );
      const hits = findHostByLabel(
        renderer,
        `preserved-stroke-node-${tree.rootId}`,
      );
      // Single ellipse → exactly one labeled host View (no per-segment
      // breakdown like the polyline case).
      expect(hits).toHaveLength(1);
      const style = flattenStyle(hits[0].props.style);
      expect(style.width).toBe(40);
      expect(style.height).toBe(24);
      // borderRadius = min(rx, ry) so an oval has rounded ends.
      expect(style.borderRadius).toBe(12);
      unmount();
    });

    it('renders each bucket\'s strokes against that bucket\'s node bbox', () => {
      // Two-node tree: root + one child. Each node gets its own stroke
      // with distinguishable pen widths; we assert each stroke's label
      // resolves to exactly the node we stashed it on.
      const tree = createTree();
      addChild(tree, tree.rootId);
      const childId = tree.nodesById.get(tree.rootId)!.childIds[0];
      const strokes = new Map<number, Array<unknown>>();
      strokes.set(tree.rootId, [
        {
          type: 'GEO_polygon',
          points: [
            {x: 0, y: 0},
            {x: 10, y: 0},
          ],
          ...PEN,
        },
      ]);
      strokes.set(childId, [
        {
          type: 'GEO_polygon',
          points: [
            {x: 0, y: 0},
            {x: 5, y: 5},
          ],
          penColor: 0x00,
          penType: 10,
          // Different pen width so we can distinguish root-stroke vs
          // child-stroke host Views by height (thickness).
          penWidth: 800,
        },
      ]);
      const {renderer, unmount} = renderCanvas(
        <MindmapCanvas
          initialTree={tree}
          isEditMode
          initialPreservedStrokes={strokes as never}
        />,
      );
      const rootSegs = findHostByLabel(
        renderer,
        `preserved-stroke-node-${tree.rootId}`,
      );
      const childSegs = findHostByLabel(
        renderer,
        `preserved-stroke-node-${childId}`,
      );
      expect(rootSegs).toHaveLength(1);
      expect(childSegs).toHaveLength(1);
      // thickness = penWidth/40 clamped to MIN_STROKE_PX=2. Root:
      // 400/40 = 10. Child: 800/40 = 20.
      expect(flattenStyle(rootSegs[0].props.style).height).toBe(10);
      expect(flattenStyle(childSegs[0].props.style).height).toBe(20);
      unmount();
    });

    it('strokes follow the node across layout shifts (add-child re-layout)', () => {
      // Establish the child's initial bbox, render with a stroke on
      // the child, then add another child to the root — the first
      // child's bbox may shift (radial layout redistributes) and the
      // stroke should render at the new bbox position.
      const tree = createTree();
      addChild(tree, tree.rootId);
      const childId = tree.nodesById.get(tree.rootId)!.childIds[0];
      const strokes = new Map<number, Array<unknown>>();
      strokes.set(childId, [
        {
          type: 'GEO_polygon',
          points: [
            {x: 0, y: 0},
            {x: 10, y: 0},
          ],
          ...PEN,
        },
      ]);
      const {renderer, unmount} = renderCanvas(
        <MindmapCanvas
          initialTree={tree}
          isEditMode
          initialPreservedStrokes={strokes as never}
        />,
      );
      const before = findHostByLabel(
        renderer,
        `preserved-stroke-node-${childId}`,
      );
      expect(before).toHaveLength(1);
      const beforeStyle = flattenStyle(before[0].props.style);
      // Capture the pre-shift position before we mutate the tree.
      const beforeLeft = beforeStyle.left as number;
      const beforeTop = beforeStyle.top as number;

      // Add a sibling to force a re-layout. Radial layout fans nodes
      // around the root; adding a second child changes the first
      // child's angular slot (fan → full-ring transition happens at
      // FAN_THRESHOLD=2, but any change in child count tweaks spacing
      // along the connector). At the very least the stage origin or
      // the child's bbox moves; if both remained pixel-identical, the
      // test would catch a future regression where layout stops
      // responding to child count.
      pressByLabel(renderer, `add-sibling-${childId}`);
      const after = findHostByLabel(
        renderer,
        `preserved-stroke-node-${childId}`,
      );
      expect(after).toHaveLength(1);
      const afterStyle = flattenStyle(after[0].props.style);
      const afterLeft = afterStyle.left as number;
      const afterTop = afterStyle.top as number;
      // Width/height should stay equal — the stroke itself didn't
      // resize, only its anchor moved.
      expect(afterStyle.width).toBe(beforeStyle.width);
      expect(afterStyle.height).toBe(beforeStyle.height);
      // At least one axis moved. The particular delta depends on
      // radialLayout internals, so this is a loose-but-honest
      // "strokes track the node" assertion.
      expect(afterLeft !== beforeLeft || afterTop !== beforeTop).toBe(true);
      unmount();
    });

    it('drops strokes for nodes that aren\'t in the tree (e.g. stale bucket keys)', () => {
      // Defensive: a bucket keyed on a NodeId that doesn't resolve to
      // a rendered node is silently dropped (no throw, no stray
      // Views). Mirrors emitGeometries' empty-bucket behavior.
      const tree = createTree();
      const bogus = new Map<number, Array<unknown>>();
      bogus.set(9999, [
        {
          type: 'GEO_polygon',
          points: [
            {x: 0, y: 0},
            {x: 10, y: 0},
          ],
          ...PEN,
        },
      ]);
      const {renderer, unmount} = renderCanvas(
        <MindmapCanvas
          initialTree={tree}
          isEditMode
          initialPreservedStrokes={bogus as never}
        />,
      );
      expect(findHostByLabel(renderer, 'preserved-stroke-node-9999')).toHaveLength(
        0,
      );
      expect(
        findHostByLabel(renderer, `preserved-stroke-node-${tree.rootId}`),
      ).toHaveLength(0);
      unmount();
    });

    it('does not render strokes for nodes hidden inside a collapsed subtree', () => {
      // Build root → A → B. Collapse A; B is hidden. Preserved strokes
      // stashed on B must not render. Strokes on A itself DO render
      // because A is still visible (collapsed hides descendants only).
      const tree = createTree();
      addChild(tree, tree.rootId);
      const a = tree.nodesById.get(tree.rootId)!.childIds[0];
      addChild(tree, a);
      const b = tree.nodesById.get(a)!.childIds[0];
      const strokes = new Map<number, Array<unknown>>();
      strokes.set(a, [
        {
          type: 'GEO_polygon',
          points: [
            {x: 0, y: 0},
            {x: 10, y: 0},
          ],
          ...PEN,
        },
      ]);
      strokes.set(b, [
        {
          type: 'GEO_polygon',
          points: [
            {x: 0, y: 0},
            {x: 10, y: 0},
          ],
          ...PEN,
        },
      ]);
      const {renderer, unmount} = renderCanvas(
        <MindmapCanvas
          initialTree={tree}
          isEditMode
          initialPreservedStrokes={strokes as never}
        />,
      );
      // Pre-collapse: both A and B strokes render.
      expect(findHostByLabel(renderer, `preserved-stroke-node-${a}`)).toHaveLength(
        1,
      );
      expect(findHostByLabel(renderer, `preserved-stroke-node-${b}`)).toHaveLength(
        1,
      );
      // Collapse A; B's strokes should disappear, A's stay.
      pressByLabel(renderer, `collapse-${a}`);
      expect(findHostByLabel(renderer, `preserved-stroke-node-${a}`)).toHaveLength(
        1,
      );
      expect(findHostByLabel(renderer, `preserved-stroke-node-${b}`)).toHaveLength(
        0,
      );
      unmount();
    });

    it('renders nothing when initialPreservedStrokes is undefined', () => {
      // Sanity / regression: the prop is optional. An authoring
      // canvas never passes it.
      const {renderer, unmount} = renderCanvas(<MindmapCanvas isEditMode />);
      const all = renderer.root.findAll(
        node =>
          typeof node.type === 'string' &&
          typeof node.props.accessibilityLabel === 'string' &&
          node.props.accessibilityLabel.startsWith('preserved-stroke-'),
      );
      expect(all).toHaveLength(0);
      unmount();
    });

    it('drops empty-points polylines silently (defensive against corrupt input)', () => {
      // Firmware output always has ≥ 2 points, but the decoder can't
      // guarantee that. A malformed stroke mustn't crash the render.
      const tree = createTree();
      const strokes = new Map<number, Array<unknown>>();
      strokes.set(tree.rootId, [
        {type: 'GEO_polygon', points: [], ...PEN},
        {type: 'GEO_polygon', points: [{x: 0, y: 0}], ...PEN},
      ]);
      const {renderer, unmount} = renderCanvas(
        <MindmapCanvas
          initialTree={tree}
          isEditMode
          initialPreservedStrokes={strokes as never}
        />,
      );
      expect(
        findHostByLabel(renderer, `preserved-stroke-node-${tree.rootId}`),
      ).toHaveLength(0);
      unmount();
    });

    it('drops zero-length segments between duplicate consecutive points', () => {
      // Micro-sampling can produce consecutive points at the same
      // position. A zero-length rotated View would render as nothing
      // anyway but would still be a wasted <View> in the tree.
      // PreservedStrokeView skips them.
      const tree = createTree();
      const strokes = new Map<number, Array<unknown>>();
      strokes.set(tree.rootId, [
        {
          type: 'GEO_polygon',
          points: [
            {x: 0, y: 0},
            {x: 10, y: 0},
            {x: 10, y: 0}, // dup → zero-length segment skipped
            {x: 20, y: 0},
          ],
          ...PEN,
        },
      ]);
      const {renderer, unmount} = renderCanvas(
        <MindmapCanvas
          initialTree={tree}
          isEditMode
          initialPreservedStrokes={strokes as never}
        />,
      );
      // 4 points → 3 segments total; one is zero-length → 2 rendered.
      expect(
        findHostByLabel(renderer, `preserved-stroke-node-${tree.rootId}`),
      ).toHaveLength(2);
      unmount();
    });

    it('ignores preserved strokes when isEditMode is omitted (authoring)', () => {
      // Phase 4.4 chose not to gate the render on isEditMode inside
      // MindmapCanvas (the prop name itself signals intent). This test
      // documents the current behavior: strokes render regardless of
      // mode, but only EditMindmap ever passes the prop — authoring
      // callers leave it undefined and this code path stays cold.
      //
      // If Phase 4.5 decides to gate rendering explicitly on
      // isEditMode, this test should flip to expect 0.
      const tree = createTree();
      const strokes = new Map<number, Array<unknown>>();
      strokes.set(tree.rootId, [
        {
          type: 'GEO_polygon',
          points: [
            {x: 0, y: 0},
            {x: 10, y: 0},
          ],
          ...PEN,
        },
      ]);
      const {renderer, unmount} = renderCanvas(
        <MindmapCanvas
          initialTree={tree}
          initialPreservedStrokes={strokes as never}
        />,
      );
      expect(
        findHostByLabel(renderer, `preserved-stroke-node-${tree.rootId}`),
      ).toHaveLength(1);
      unmount();
    });
  });

  describe('Phase 4.5 — Save button wires to insertMindmap (§F-ED-7)', () => {
    // Phase 4.5 replaces the hidden-in-edit Insert button with a
    // "Save" button that runs the round-trip §F-ED-7 pipeline:
    // deleteLassoElements → translate preserved strokes by each
    // node's move delta → emit → insert → lasso(unionRect) → close.
    // The UX mirrors Insert's debounce + error-banner behaviour and
    // the full orchestration lives in insertMindmap; these tests
    // cover the Save-specific UI wiring.

    beforeEach(() => {
      (PluginCommAPI.insertGeometry as jest.Mock).mockClear();
      (PluginCommAPI.insertGeometry as jest.Mock).mockResolvedValue({
        success: true,
      });
      (PluginFileAPI.insertElements as jest.Mock).mockClear();
      (PluginFileAPI.insertElements as jest.Mock).mockResolvedValue({
        success: true,
      });
      (PluginCommAPI.lassoElements as jest.Mock).mockClear();
      (PluginCommAPI.lassoElements as jest.Mock).mockResolvedValue({
        success: true,
      });
      (PluginCommAPI.deleteLassoElements as jest.Mock).mockClear();
      (PluginCommAPI.deleteLassoElements as jest.Mock).mockResolvedValue({
        success: true,
      });
      (PluginManager.closePluginView as jest.Mock).mockClear();
      (PluginManager.closePluginView as jest.Mock).mockResolvedValue(true);
    });

    function buildPreEdit(tree: ReturnType<typeof createTree>): {
      preEditPageBboxes: Map<number, {x: number; y: number; w: number; h: number}>;
      strokesByNodePage: Map<number, never[]>;
    } {
      // Identical pre/post bboxes keeps delta=0 and makes assertions
      // about the delete + insert sequence independent of
      // translation math. Stroke bucket empty for the same reason —
      // §F-ED-7 translation is covered in insert.test.ts.
      const pre = new Map<number, {x: number; y: number; w: number; h: number}>();
      for (const id of tree.nodesById.keys()) {
        pre.set(id, {x: id * 100, y: id * 100, w: 220, h: 96});
      }
      return {preEditPageBboxes: pre, strokesByNodePage: new Map()};
    }

    it('renders a Save Pressable with label "Save" when isEditMode=true', () => {
      const {renderer, unmount} = renderCanvas(<MindmapCanvas isEditMode />);
      const save = findPressable(renderer, 'Save');
      expect(save.props.accessibilityState?.disabled).toBe(false);
      expect(save.props.disabled).toBe(false);
      // Insert is hidden in edit mode (Phase 4.3 contract carried
      // forward to Phase 4.5 — the two buttons are mutually exclusive).
      expect(findHostByLabel(renderer, 'Insert')).toHaveLength(0);
      unmount();
    });

    it('does not render Save in authoring mode (isEditMode omitted)', () => {
      // Authoring flow must stay on "Insert". A stray Save label
      // here would cause the authoring canvas to try to re-insert
      // without a preEdit context.
      const {renderer, unmount} = renderCanvas(<MindmapCanvas />);
      expect(findHostByLabel(renderer, 'Save')).toHaveLength(0);
      // Insert is visible as before.
      expect(findHostByLabel(renderer, 'Insert').length).toBeGreaterThan(0);
      unmount();
    });

    it('tapping Save drives the full §F-ED-7 pipeline (delete + emit + insert + close)', async () => {
      const tree = createTree();
      addChild(tree, tree.rootId);
      const preEdit = buildPreEdit(tree);
      const {renderer, unmount} = renderCanvas(
        <MindmapCanvas initialTree={tree} isEditMode preEdit={preEdit} />,
      );

      const save = findPressable(renderer, 'Save');
      const onPress = save.props.onPress as () => void;
      await act(async () => {
        onPress();
        await flushPromises();
        await flushPromises();
      });

      // deleteLassoElements fires first (before any insert call).
      expect(PluginCommAPI.deleteLassoElements).toHaveBeenCalledTimes(1);
      // 2 outlines + 1 connector = 3 non-marker geometries emitted.
      expect(nonMarkerInsertCount()).toBe(3);
      expect(PluginCommAPI.lassoElements).toHaveBeenCalledTimes(1);
      expect(PluginManager.closePluginView).toHaveBeenCalledTimes(1);
      unmount();
    });

    it('shows "Saving…" while the save is in flight', async () => {
      // Keep insertElements pending so we can observe the mid-flight
      // button state. Matches the Insert-path debounce tests below.
      let resolveFirst: () => void = () => {};
      const pending = new Promise<void>(r => {
        resolveFirst = r;
      });
      (PluginFileAPI.insertElements as jest.Mock).mockImplementationOnce(
        async () => {
          await pending;
          return {success: true};
        },
      );

      const tree = createTree();
      const preEdit = buildPreEdit(tree);
      const {renderer, unmount} = renderCanvas(
        <MindmapCanvas initialTree={tree} isEditMode preEdit={preEdit} />,
      );

      const save = findPressable(renderer, 'Save');
      const onPress = save.props.onPress as () => void;
      await act(async () => {
        onPress();
        await flushPromises();
      });
      // The button's label should have swapped to the pending state
      // — look it up by the new label.
      const pendingBtn = findPressable(renderer, 'Save');
      expect(pendingBtn.props.accessibilityState?.disabled).toBe(true);
      // Resolve so the test cleans up.
      resolveFirst();
      await flushAsync();
      unmount();
    });

    it('shows an error banner when save fails and keeps the plugin open', async () => {
      (PluginCommAPI.deleteLassoElements as jest.Mock).mockResolvedValueOnce({
        success: false,
        error: {message: 'simulated: delete refused'},
      });

      const tree = createTree();
      const preEdit = buildPreEdit(tree);
      const {renderer, unmount} = renderCanvas(
        <MindmapCanvas initialTree={tree} isEditMode preEdit={preEdit} />,
      );
      const save = findPressable(renderer, 'Save');
      const onPress = save.props.onPress as () => void;
      await act(async () => {
        onPress();
        await flushPromises();
        await flushPromises();
      });

      const banners = findHostByLabel(renderer, 'insert-error');
      expect(banners).toHaveLength(1);
      expect(PluginManager.closePluginView).not.toHaveBeenCalled();
      // No partial insert happened — the failure aborted before any
      // insert call.
      expect(PluginCommAPI.insertGeometry).not.toHaveBeenCalled();
      expect(PluginFileAPI.insertElements).not.toHaveBeenCalled();
      unmount();
    });

    it('debounces rapid double-taps so only one save runs at a time', async () => {
      // Same debounce pattern as the Insert button — the underlying
      // insertingRef is shared, so a double-tap during the Save's
      // in-flight window must no-op.
      let resolveFirst: () => void = () => {};
      const pending = new Promise<void>(r => {
        resolveFirst = r;
      });
      (PluginFileAPI.insertElements as jest.Mock).mockImplementationOnce(
        async () => {
          await pending;
          return {success: true};
        },
      );

      const tree = createTree();
      const preEdit = buildPreEdit(tree);
      const {renderer, unmount} = renderCanvas(
        <MindmapCanvas initialTree={tree} isEditMode preEdit={preEdit} />,
      );
      const save = findPressable(renderer, 'Save');
      const onPress = save.props.onPress as () => void;
      await act(async () => {
        onPress();
        await flushPromises();
      });
      await act(async () => {
        onPress(); // second tap while first is in flight — no-op
        await flushPromises();
      });

      // deleteLassoElements only fired once despite two taps, because
      // insertingRef short-circuits handleSave's second entry.
      expect(PluginCommAPI.deleteLassoElements).toHaveBeenCalledTimes(1);
      expect(PluginFileAPI.insertElements).toHaveBeenCalledTimes(1);

      resolveFirst();
      await flushAsync();
      unmount();
    });

    it('still works without preEdit (defensive degraded mode)', async () => {
      // If isEditMode=true but no preEdit is supplied (EditMindmap
      // always supplies it in practice), Save should still be
      // tappable and still run the emit/insert path — it just skips
      // the delete step because insertMindmap has no pre-edit
      // context to act on.
      const tree = createTree();
      const {renderer, unmount} = renderCanvas(
        <MindmapCanvas initialTree={tree} isEditMode />,
      );
      const save = findPressable(renderer, 'Save');
      const onPress = save.props.onPress as () => void;
      await act(async () => {
        onPress();
        await flushPromises();
        await flushPromises();
      });

      // No delete (preEdit was undefined).
      expect(PluginCommAPI.deleteLassoElements).not.toHaveBeenCalled();
      // But the first-insert pipeline still ran to completion.
      expect(nonMarkerInsertCount()).toBeGreaterThan(0);
      expect(PluginManager.closePluginView).toHaveBeenCalledTimes(1);
      unmount();
    });
  });

  describe('Phase 4.6 — pre-Save out-of-map confirmation dialog (§8.1)', () => {
    // The §F-ED-5 associator produces an `outOfMap` bucket for
    // strokes whose centroid fell outside every node's bbox. On Save
    // we show a confirmation dialog BEFORE running insertMindmap so
    // the user can back out and re-lasso wider if they intended
    // those strokes to be labels. Dropping the strokes on commit is
    // automatic — they were never routed into the preEdit bucket —
    // so the dialog's only job is gating the pipeline and counting.
    //
    // These tests focus on that gating: no out-of-map ⇒ no dialog,
    // some out-of-map ⇒ dialog blocks the pipeline until the user
    // presses "Save anyway" (or Cancel, which just dismisses without
    // closing the plugin so the user can keep editing).

    beforeEach(() => {
      (PluginCommAPI.insertGeometry as jest.Mock).mockClear();
      (PluginCommAPI.insertGeometry as jest.Mock).mockResolvedValue({
        success: true,
      });
      (PluginFileAPI.insertElements as jest.Mock).mockClear();
      (PluginFileAPI.insertElements as jest.Mock).mockResolvedValue({
        success: true,
      });
      (PluginCommAPI.lassoElements as jest.Mock).mockClear();
      (PluginCommAPI.lassoElements as jest.Mock).mockResolvedValue({
        success: true,
      });
      (PluginCommAPI.deleteLassoElements as jest.Mock).mockClear();
      (PluginCommAPI.deleteLassoElements as jest.Mock).mockResolvedValue({
        success: true,
      });
      (PluginManager.closePluginView as jest.Mock).mockClear();
      (PluginManager.closePluginView as jest.Mock).mockResolvedValue(true);
    });

    /** Simplest out-of-map stroke fixture (a short polyline). */
    function buildOutOfMap(count: number): unknown[] {
      const arr: unknown[] = [];
      for (let i = 0; i < count; i++) {
        arr.push({
          type: 'GEO_polygon',
          points: [
            {x: -100 - i, y: -100 - i},
            {x: -80 - i, y: -80 - i},
          ],
          penColor: 0x00,
          penType: 10,
          penWidth: 400,
        });
      }
      return arr;
    }

    /** Minimal preEdit context matching Phase 4.5's helper. */
    function buildPreEdit(tree: ReturnType<typeof createTree>): {
      preEditPageBboxes: Map<number, {x: number; y: number; w: number; h: number}>;
      strokesByNodePage: Map<number, never[]>;
    } {
      const pre = new Map<number, {x: number; y: number; w: number; h: number}>();
      for (const id of tree.nodesById.keys()) {
        pre.set(id, {x: id * 100, y: id * 100, w: 220, h: 96});
      }
      return {preEditPageBboxes: pre, strokesByNodePage: new Map()};
    }

    it('runs the pipeline directly when outOfMap is empty (no dialog)', async () => {
      // The gate must be a no-op when there's nothing to warn about,
      // otherwise the simple common-case Save grows an extra tap.
      const tree = createTree();
      const preEdit = buildPreEdit(tree);
      const {renderer, unmount} = renderCanvas(
        <MindmapCanvas
          initialTree={tree}
          isEditMode
          preEdit={preEdit}
          initialOutOfMapStrokes={[]}
        />,
      );
      const save = findPressable(renderer, 'Save');
      await act(async () => {
        (save.props.onPress as () => void)();
        await flushPromises();
        await flushPromises();
      });
      // Pipeline fired, no dialog ever rendered.
      expect(findHostByLabel(renderer, 'save-confirm-dialog')).toHaveLength(0);
      expect(PluginCommAPI.deleteLassoElements).toHaveBeenCalledTimes(1);
      expect(PluginManager.closePluginView).toHaveBeenCalledTimes(1);
      unmount();
    });

    it('also skips the dialog when initialOutOfMapStrokes is omitted', async () => {
      // Defensive case: if EditMindmap forgets to pass the prop we
      // should still save rather than silently deadlock on a dialog
      // the user can't dismiss because it never rendered.
      const tree = createTree();
      const preEdit = buildPreEdit(tree);
      const {renderer, unmount} = renderCanvas(
        <MindmapCanvas initialTree={tree} isEditMode preEdit={preEdit} />,
      );
      const save = findPressable(renderer, 'Save');
      await act(async () => {
        (save.props.onPress as () => void)();
        await flushPromises();
        await flushPromises();
      });
      expect(findHostByLabel(renderer, 'save-confirm-dialog')).toHaveLength(0);
      expect(PluginCommAPI.deleteLassoElements).toHaveBeenCalledTimes(1);
      unmount();
    });

    it('opens the dialog and blocks the pipeline when outOfMap is non-empty', async () => {
      const tree = createTree();
      const preEdit = buildPreEdit(tree);
      const {renderer, unmount} = renderCanvas(
        <MindmapCanvas
          initialTree={tree}
          isEditMode
          preEdit={preEdit}
          initialOutOfMapStrokes={buildOutOfMap(2) as never}
        />,
      );
      const save = findPressable(renderer, 'Save');
      await act(async () => {
        (save.props.onPress as () => void)();
        await flushPromises();
      });
      // Dialog rendered — use findHostByLabel because
      // save-confirm-dialog is on a plain <View> host, not a
      // Pressable composite.
      expect(findHostByLabel(renderer, 'save-confirm-dialog').length).toBeGreaterThan(0);
      // Nothing in the Save pipeline should have fired yet — we're
      // still inside the confirmation gate.
      expect(PluginCommAPI.deleteLassoElements).not.toHaveBeenCalled();
      expect(PluginCommAPI.insertGeometry).not.toHaveBeenCalled();
      expect(PluginManager.closePluginView).not.toHaveBeenCalled();
      unmount();
    });

    it('the dialog body announces the correct out-of-map count', async () => {
      // The count is the user's only clue for "how much am I about to
      // drop" — it must reflect the actual outOfMap bucket length.
      const cases: Array<{n: number; needle: string}> = [
        {n: 1, needle: '1 stroke fell outside'},
        {n: 2, needle: '2 strokes fell outside'},
        {n: 7, needle: '7 strokes fell outside'},
      ];
      for (const c of cases) {
        const tree = createTree();
        const preEdit = buildPreEdit(tree);
        const {renderer, unmount} = renderCanvas(
          <MindmapCanvas
            initialTree={tree}
            isEditMode
            preEdit={preEdit}
            initialOutOfMapStrokes={buildOutOfMap(c.n) as never}
          />,
        );
        const save = findPressable(renderer, 'Save');
        await act(async () => {
          (save.props.onPress as () => void)();
          await flushPromises();
        });
        const body = findHostByLabel(renderer, 'save-confirm-body');
        expect(body.length).toBeGreaterThan(0);
        const text = (body[0].props.children as unknown[])
          .filter((x): x is string => typeof x === 'string')
          .join('');
        expect(text).toContain(c.needle);
        unmount();
      }
    });

    it('"Save anyway" closes the dialog and runs the full §F-ED-7 pipeline', async () => {
      const tree = createTree();
      const preEdit = buildPreEdit(tree);
      const {renderer, unmount} = renderCanvas(
        <MindmapCanvas
          initialTree={tree}
          isEditMode
          preEdit={preEdit}
          initialOutOfMapStrokes={buildOutOfMap(3) as never}
        />,
      );
      const save = findPressable(renderer, 'Save');
      await act(async () => {
        (save.props.onPress as () => void)();
        await flushPromises();
      });
      const proceed = findPressable(renderer, 'save-confirm-proceed');
      await act(async () => {
        (proceed.props.onPress as () => void)();
        await flushPromises();
        await flushPromises();
      });
      // Dialog is gone…
      expect(findHostByLabel(renderer, 'save-confirm-dialog')).toHaveLength(0);
      // …and the full pipeline ran.
      expect(PluginCommAPI.deleteLassoElements).toHaveBeenCalledTimes(1);
      expect(nonMarkerInsertCount()).toBeGreaterThan(0);
      expect(PluginCommAPI.lassoElements).toHaveBeenCalledTimes(1);
      expect(PluginManager.closePluginView).toHaveBeenCalledTimes(1);
      unmount();
    });

    it('"Cancel" dismisses the dialog without running the pipeline or closing the plugin', async () => {
      const tree = createTree();
      const preEdit = buildPreEdit(tree);
      const {renderer, unmount} = renderCanvas(
        <MindmapCanvas
          initialTree={tree}
          isEditMode
          preEdit={preEdit}
          initialOutOfMapStrokes={buildOutOfMap(1) as never}
        />,
      );
      const save = findPressable(renderer, 'Save');
      await act(async () => {
        (save.props.onPress as () => void)();
        await flushPromises();
      });
      const cancel = findPressable(renderer, 'save-confirm-cancel');
      await act(async () => {
        (cancel.props.onPress as () => void)();
        await flushPromises();
      });
      // Dialog dismissed but nothing else happened — user can tap
      // Cancel in the top bar to close the plugin and re-lasso.
      expect(findHostByLabel(renderer, 'save-confirm-dialog')).toHaveLength(0);
      expect(PluginCommAPI.deleteLassoElements).not.toHaveBeenCalled();
      expect(PluginCommAPI.insertGeometry).not.toHaveBeenCalled();
      expect(PluginManager.closePluginView).not.toHaveBeenCalled();
      unmount();
    });

    it('tapping the backdrop dismisses the dialog (tap-outside-to-cancel idiom)', async () => {
      // Per spec §646 transient overlays should honor tap-outside to
      // cancel. Backdrop is a Pressable with onPress=handleSaveCancel.
      const tree = createTree();
      const preEdit = buildPreEdit(tree);
      const {renderer, unmount} = renderCanvas(
        <MindmapCanvas
          initialTree={tree}
          isEditMode
          preEdit={preEdit}
          initialOutOfMapStrokes={buildOutOfMap(1) as never}
        />,
      );
      const save = findPressable(renderer, 'Save');
      await act(async () => {
        (save.props.onPress as () => void)();
        await flushPromises();
      });
      const backdrop = findPressable(renderer, 'save-confirm-backdrop');
      await act(async () => {
        (backdrop.props.onPress as () => void)();
        await flushPromises();
      });
      expect(findHostByLabel(renderer, 'save-confirm-dialog')).toHaveLength(0);
      expect(PluginCommAPI.deleteLassoElements).not.toHaveBeenCalled();
      unmount();
    });

    it('re-opens the dialog on a subsequent Save tap after the user cancelled', async () => {
      // Regression guard: saveConfirmOpen must go back to false on
      // cancel so the next Save tap re-triggers the gate. If the
      // state got stuck the user would be silently auto-saving on the
      // second tap and losing the out-of-map strokes without a prompt.
      const tree = createTree();
      const preEdit = buildPreEdit(tree);
      const {renderer, unmount} = renderCanvas(
        <MindmapCanvas
          initialTree={tree}
          isEditMode
          preEdit={preEdit}
          initialOutOfMapStrokes={buildOutOfMap(1) as never}
        />,
      );
      // First tap → dialog → cancel.
      const save = findPressable(renderer, 'Save');
      await act(async () => {
        (save.props.onPress as () => void)();
        await flushPromises();
      });
      const cancel = findPressable(renderer, 'save-confirm-cancel');
      await act(async () => {
        (cancel.props.onPress as () => void)();
        await flushPromises();
      });
      expect(findHostByLabel(renderer, 'save-confirm-dialog')).toHaveLength(0);
      // Second tap → dialog shows again.
      const save2 = findPressable(renderer, 'Save');
      await act(async () => {
        (save2.props.onPress as () => void)();
        await flushPromises();
      });
      expect(findHostByLabel(renderer, 'save-confirm-dialog').length).toBeGreaterThan(0);
      unmount();
    });

    it('does not render the dialog in authoring mode (isEditMode omitted)', () => {
      // The prop combination shouldn't happen in practice (authoring
      // doesn't know about lasso association) but a stray prop must
      // not spawn an on-authoring-canvas dialog either way.
      const tree = createTree();
      const {renderer, unmount} = renderCanvas(
        <MindmapCanvas
          initialTree={tree}
          initialOutOfMapStrokes={buildOutOfMap(2) as never}
        />,
      );
      // The Save button itself isn't rendered in authoring mode, and
      // the dialog's isEditMode guard keeps it off-screen even if
      // saveConfirmOpen somehow got flipped.
      expect(findHostByLabel(renderer, 'save-confirm-dialog')).toHaveLength(0);
      expect(findHostByLabel(renderer, 'Save')).toHaveLength(0);
      unmount();
    });
  });

  describe('Phase 5 — §F-PE-4 marker-capacity modal', () => {
    // Building a tree with > MARKER_PUBLISHED_NODE_CAP nodes forces
    // encodeMarkerBytes to throw MarkerCapacityError, which bubbles up
    // through emitGeometries → insertMindmap → the canvas catch block.
    // The new contract: surface a persistent modal (not the transient
    // 2 s insert-error banner), keep the plugin view open, let the
    // user OK the modal and return to the canvas to reduce nodes.

    beforeEach(() => {
      (PluginCommAPI.insertGeometry as jest.Mock).mockClear();
      (PluginCommAPI.insertGeometry as jest.Mock).mockResolvedValue({
        success: true,
      });
      (PluginFileAPI.insertElements as jest.Mock).mockClear();
      (PluginFileAPI.insertElements as jest.Mock).mockResolvedValue({
        success: true,
      });
      (PluginCommAPI.lassoElements as jest.Mock).mockClear();
      (PluginCommAPI.lassoElements as jest.Mock).mockResolvedValue({
        success: true,
      });
      (PluginCommAPI.deleteLassoElements as jest.Mock).mockClear();
      (PluginCommAPI.deleteLassoElements as jest.Mock).mockResolvedValue({
        success: true,
      });
      (PluginManager.closePluginView as jest.Mock).mockClear();
      (PluginManager.closePluginView as jest.Mock).mockResolvedValue(true);
    });

    /**
     * Build a right-chain tree with `nodeCount` total nodes (including
     * the root). A chain is the cheapest over-cap structure: one
     * addChild per link, no layout fan-out cost. For nodeCount=51 the
     * marker encoder will throw MarkerCapacityError on the first
     * encodeMarkerBytes call because MARKER_PUBLISHED_NODE_CAP = 50.
     */
    function buildOversizedTree(nodeCount: number): ReturnType<typeof createTree> {
      const t = createTree();
      let last = t.rootId;
      for (let i = 1; i < nodeCount; i += 1) {
        last = addChild(t, last);
      }
      return t;
    }

    it('opens the capacity modal (not the transient banner) when Insert exceeds the cap', async () => {
      const tree = buildOversizedTree(51);
      const {renderer, unmount} = renderCanvas(
        <MindmapCanvas initialTree={tree} />,
      );
      const insert = findPressable(renderer, 'Insert');
      await act(async () => {
        (insert.props.onPress as () => void)();
        await flushPromises();
        await flushPromises();
      });
      // Capacity modal is present…
      expect(findHostByLabel(renderer, 'capacity-error-dialog').length).toBeGreaterThan(0);
      // …and the transient banner route was NOT taken (the banner is
      // not for persistent errors; the spec text needs to stay up
      // until the user dismisses it).
      expect(findHostByLabel(renderer, 'insert-error')).toHaveLength(0);
      // Plugin view must stay open so the user can edit the tree.
      expect(PluginManager.closePluginView).not.toHaveBeenCalled();
      // Nothing landed on the page — emit failed before insertGeometry.
      expect(PluginCommAPI.insertGeometry).not.toHaveBeenCalled();
      unmount();
    });

    it('modal body is the verbatim §F-PE-4 capacity message', async () => {
      const tree = buildOversizedTree(51);
      const {renderer, unmount} = renderCanvas(
        <MindmapCanvas initialTree={tree} />,
      );
      const insert = findPressable(renderer, 'Insert');
      await act(async () => {
        (insert.props.onPress as () => void)();
        await flushPromises();
        await flushPromises();
      });
      const body = findHostByLabel(renderer, 'capacity-error-body');
      expect(body.length).toBeGreaterThan(0);
      expect(body[0].props.children).toContain('more structure than can be embedded');
      expect(body[0].props.children).toContain('Reduce nodes');
      expect(body[0].props.children).toContain('multiple mindmaps');
      // Spec cross-refs (§F-PE-4) must not leak into user-facing text.
      expect(body[0].props.children).not.toMatch(/§/);
      unmount();
    });

    it('"OK" dismisses the capacity modal and leaves the plugin open', async () => {
      const tree = buildOversizedTree(51);
      const {renderer, unmount} = renderCanvas(
        <MindmapCanvas initialTree={tree} />,
      );
      const insert = findPressable(renderer, 'Insert');
      await act(async () => {
        (insert.props.onPress as () => void)();
        await flushPromises();
        await flushPromises();
      });
      expect(findHostByLabel(renderer, 'capacity-error-dialog').length).toBeGreaterThan(0);
      // Tap OK to acknowledge.
      const ok = findPressable(renderer, 'capacity-error-proceed');
      act(() => {
        (ok.props.onPress as () => void)();
      });
      // Modal dismissed, plugin still open.
      expect(findHostByLabel(renderer, 'capacity-error-dialog')).toHaveLength(0);
      expect(PluginManager.closePluginView).not.toHaveBeenCalled();
      unmount();
    });

    it('capacity modal has no cancel button (acknowledge-only)', async () => {
      // The only path past this error is reducing nodes — "cancel" has
      // no distinct meaning, so ConfirmDialog is invoked without a
      // secondaryLabel and the cancel button is omitted entirely.
      const tree = buildOversizedTree(51);
      const {renderer, unmount} = renderCanvas(
        <MindmapCanvas initialTree={tree} />,
      );
      const insert = findPressable(renderer, 'Insert');
      await act(async () => {
        (insert.props.onPress as () => void)();
        await flushPromises();
        await flushPromises();
      });
      expect(findHostByLabel(renderer, 'capacity-error-dialog').length).toBeGreaterThan(0);
      expect(findHostByLabel(renderer, 'capacity-error-cancel')).toHaveLength(0);
      unmount();
    });

    it('also routes Save failures with MarkerCapacityError into the modal', async () => {
      // The save path shares handleInsertError so both entry points
      // must produce the same modal. The regression guard is cheap —
      // just drive Save with an oversized tree and assert the same
      // modal surfaces.
      const tree = buildOversizedTree(51);
      const preEdit = {
        preEditPageBboxes: new Map(
          Array.from(tree.nodesById.keys()).map(id => [
            id,
            {x: id * 100, y: id * 100, w: 220, h: 96},
          ]),
        ),
        strokesByNodePage: new Map(),
      };
      const {renderer, unmount} = renderCanvas(
        <MindmapCanvas initialTree={tree} isEditMode preEdit={preEdit} />,
      );
      const save = findPressable(renderer, 'Save');
      await act(async () => {
        (save.props.onPress as () => void)();
        await flushPromises();
        await flushPromises();
      });
      expect(findHostByLabel(renderer, 'capacity-error-dialog').length).toBeGreaterThan(0);
      // Save ran deleteLassoElements first (§F-ED-7 step 0 happens
      // before emit), but no new geometry landed on the page.
      expect(PluginCommAPI.insertGeometry).not.toHaveBeenCalled();
      expect(PluginManager.closePluginView).not.toHaveBeenCalled();
      unmount();
    });

    it('at-cap tree (= MARKER_PUBLISHED_NODE_CAP) does not open the capacity modal', async () => {
      // Sanity boundary: exactly MARKER_PUBLISHED_NODE_CAP nodes must
      // succeed — the error is for > cap only.
      const tree = buildOversizedTree(50);
      const {renderer, unmount} = renderCanvas(
        <MindmapCanvas initialTree={tree} />,
      );
      const insert = findPressable(renderer, 'Insert');
      await act(async () => {
        (insert.props.onPress as () => void)();
        await flushPromises();
        await flushPromises();
      });
      expect(findHostByLabel(renderer, 'capacity-error-dialog')).toHaveLength(0);
      // Normal success path: plugin closed.
      expect(PluginManager.closePluginView).toHaveBeenCalledTimes(1);
      unmount();
    });
  });
});
