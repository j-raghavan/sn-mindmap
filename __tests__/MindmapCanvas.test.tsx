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
  },
}));

import MindmapCanvas from '../src/MindmapCanvas';
import {PluginCommAPI, PluginManager} from 'sn-plugin-lib';
import {MARKER_PEN_COLOR} from '../src/marker/encode';
import {addChild, addSibling, createTree} from '../src/model/tree';

/**
 * Filter insertGeometry mock calls down to the "primary" emit mix
 * (outlines + connectors + preserved strokes). Marker strokes share
 * the straightLine type but carry pen color 0x9D (§6.4); every insert
 * produces several hundred of them, so assertions that care about the
 * structural geometry count filter them out.
 */
function nonMarkerInsertCount(mock: jest.Mock): number {
  return mock.mock.calls.filter(
    ([geometry]) =>
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
      expect(
        nonMarkerInsertCount(PluginCommAPI.insertGeometry as jest.Mock),
      ).toBe(3);
      expect(PluginCommAPI.lassoElements).toHaveBeenCalledTimes(1);
      expect(PluginManager.closePluginView).toHaveBeenCalledTimes(1);
      unmount();
    });

    it('shows an error banner when insert fails and keeps the plugin view open', async () => {
      (PluginCommAPI.insertGeometry as jest.Mock).mockResolvedValueOnce({
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
      // Make insertGeometry slow enough that a second tap can land
      // while the first is still in flight. Using a promise we resolve
      // manually to avoid timing flake.
      // TS's flow analysis can't see that the Promise executor fires
      // synchronously, so we initialize resolveFirst with a no-op and
      // reassign inside the executor to keep the type `() => void`.
      let resolveFirst: () => void = () => {};
      const firstPending = new Promise<void>(r => {
        resolveFirst = r;
      });
      (PluginCommAPI.insertGeometry as jest.Mock).mockImplementationOnce(
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

      // At this point insertGeometry has been called exactly once —
      // the second tap was debounced via insertingRef.
      expect(PluginCommAPI.insertGeometry).toHaveBeenCalledTimes(1);

      // Let the first insert complete cleanly.
      resolveFirst();
      await flushAsync();
      unmount();
    });
  });
});
