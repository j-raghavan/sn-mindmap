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
jest.mock('sn-plugin-lib', () => {
  let uuidCounter = 0;
  const mintElement = () => ({
    uuid: `canvas-uuid-${uuidCounter++}`,
    type: 700,
    pageNum: 0,
    layerNum: 0,
    thickness: 0,
    geometry: null as unknown,
  });
  return {
    Element: {TYPE_GEO: 700},
    PluginManager: {
      closePluginView: jest.fn().mockResolvedValue(true),
    },
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
      getPageSize: jest
        .fn()
        .mockResolvedValue({success: true, result: {width: 1404, height: 1872}}),
      // Phase 2.2's insert now flows through the additive insertElements
      // (the old getElements read + replaceElements whole-page rewrite
      // are gone). getElements/replaceElements stay mocked so tests can
      // assert they are never called (F-NDI-1-AC3).
      getElements: jest.fn().mockResolvedValue({success: true, result: []}),
      replaceElements: jest.fn().mockResolvedValue({success: true}),
      insertElements: jest.fn().mockResolvedValue({success: true}),
    },
  };
});

import MindmapCanvas from '../src/MindmapCanvas';
import {PluginCommAPI, PluginFileAPI, PluginManager} from 'sn-plugin-lib';
import {addChild, addSibling, createTree} from '../src/model/tree';

/**
 * Collect the geometries that insertMindmap emitted. The additive
 * insert path bundles every geometry into a single insertElements call
 * (one Element per geometry, with the geometry hanging off the
 * `.geometry` field) and sends ONLY the plugin's new elements — the
 * page's pre-existing content is never read or sent. Walk the most
 * recent insertElements call's payload and yield the geometry list the
 * rest of this file was already written against.
 */
function collectInsertedGeometries(): Array<{
  type?: string;
  penColor?: number;
}> {
  const calls = (PluginFileAPI.insertElements as jest.Mock).mock.calls;
  if (calls.length === 0) {
    return [];
  }
  const latest = calls[calls.length - 1];
  const payload = latest[2] as Array<{
    geometry?: {type?: string; penColor?: number} | null;
  }>;
  // mintElement() initialises `.geometry` to null and insertMindmap
  // overwrites it with the emitted Geometry, so every geometry Element
  // has a truthy `.geometry` (TYPE_TEXT label elements keep it null).
  const out: Array<{type?: string; penColor?: number}> = [];
  for (const el of payload) {
    if (el?.geometry) {
      out.push(el.geometry);
    }
  }
  return out;
}

/**
 * Count every inserted geometry. Marker strokes were removed along
 * with the edit/decode pipeline, so there's no pen-color filter to
 * apply — the emit today is just outlines + connectors.
 */
function nonMarkerInsertCount(): number {
  return collectInsertedGeometries().length;
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

    it('depth-2 grandchild (RECTANGLE) renders with borderRadius = 0', () => {
      // v1.0 shape-by-depth: depth-1 children are ROUNDED_RECTANGLE,
      // depth-2 grandchildren are RECTANGLE. The borderRadius=0 case
      // therefore lives one level deeper than it used to.
      const tree = createTree();
      const a = addChild(tree, tree.rootId);
      const aa = addChild(tree, a);
      const {renderer, unmount} = renderCanvas(
        <MindmapCanvas initialTree={tree} />,
      );
      const node = findHostSingle(renderer, `node-${aa}`);
      const style = flattenStyle(node.props.style);
      expect(style.borderRadius).toBe(0);
      unmount();
    });

    it('depth-1 child (ROUNDED_RECTANGLE) renders with SIBLING_CORNER_RADIUS', () => {
      const tree = createTree();
      const a = addChild(tree, tree.rootId);
      const {renderer, unmount} = renderCanvas(
        <MindmapCanvas initialTree={tree} />,
      );
      const node = findHostSingle(renderer, `node-${a}`);
      const style = flattenStyle(node.props.style);
      // SIBLING_CORNER_RADIUS = 15 per layout/constants.ts.
      expect(style.borderRadius).toBe(15);
      unmount();
    });

    it('depth-3+ descendants render as PARALLELOGRAM with skewX transform', () => {
      // PARALLELOGRAM nodes inherit borderRadius=0 (sharp corners);
      // the slant comes from a transform: [{skewX: '-12deg'}] on the
      // outline View. The label nests its own counter-skew so it
      // reads upright — that detail isn't asserted here, just the
      // outline-level skew.
      const tree = createTree();
      const a = addChild(tree, tree.rootId);
      const aa = addChild(tree, a);
      const aaa = addChild(tree, aa);
      const {renderer, unmount} = renderCanvas(
        <MindmapCanvas initialTree={tree} />,
      );
      const node = findHostSingle(renderer, `node-${aaa}`);
      const style = flattenStyle(node.props.style);
      expect(style.borderRadius).toBe(0);
      const transforms = style.transform as Array<Record<string, string>>;
      expect(transforms?.some(t => t.skewX === '-12deg')).toBe(true);
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
    it('tapping a node selects it AND opens the edit-label modal', () => {
      // Tap = select + edit (per the v0.2 label-first UX). Tapping
      // an already-selected node still re-opens the modal so the
      // user can iterate on the label without first deselecting.
      const tree = createTree('root label');
      const a = addChild(tree, tree.rootId, 'a label');
      const {renderer, unmount} = renderCanvas(
        <MindmapCanvas initialTree={tree} />,
      );
      pressByLabel(renderer, `node-${a}`);
      expect(findHostByLabel(renderer, `delete-${a}`)).toHaveLength(1);
      // Modal opened — its label-input field is visible.
      expect(findHostByLabel(renderer, 'label-input')).toHaveLength(1);
      unmount();
    });

    it('tapping the background clears selection', () => {
      const tree = createTree('root label');
      const a = addChild(tree, tree.rootId, 'a label');
      const {renderer, unmount} = renderCanvas(
        <MindmapCanvas initialTree={tree} />,
      );
      pressByLabel(renderer, `node-${a}`);
      // The tap above also opened the edit-label modal — close it
      // by tapping its Cancel button so the background-press test
      // reflects the actual user gesture for clearing selection.
      pressByLabel(renderer, 'label-cancel');
      expect(findHostByLabel(renderer, `delete-${a}`)).toHaveLength(1);
      pressByLabel(renderer, 'mindmap-background');
      expect(findHostByLabel(renderer, `delete-${a}`)).toHaveLength(0);
      unmount();
    });
  });

  describe('Phase 1.4b — mutations re-render the tree', () => {
    /**
     * Type a label into the modal's TextInput and tap Create. Used by
     * every Add Child / Add Sibling / Edit assertion below — the modal
     * is now mandatory between gesture and tree mutation.
     */
    function fillModalAndCreate(
      renderer: Renderer,
      label: string,
    ): void {
      const input = renderer.root.findAllByProps({
        accessibilityLabel: 'label-input',
      })[0];
      act(() => {
        (input.props.onChangeText as (s: string) => void)(label);
      });
      pressByLabel(renderer, 'label-create');
    }

    it('Add Child opens the modal, then adds the new child + connector on Create', () => {
      const tree = createTree('root');
      const {renderer, unmount} = renderCanvas(
        <MindmapCanvas initialTree={tree} />,
      );
      // Start: single root, no connectors, no modal.
      expect(findHostByLabel(renderer, 'connector')).toHaveLength(0);
      expect(findHostByLabel(renderer, 'label-modal')).toHaveLength(0);
      pressByLabel(renderer, 'add-child-0');
      // Add Child opens the modal — node-1 is NOT created yet.
      expect(findHostByLabel(renderer, 'label-modal')).toHaveLength(1);
      expect(findHostByLabel(renderer, 'node-1')).toHaveLength(0);
      // Type a label and tap Create. node-1 + connector now appear.
      fillModalAndCreate(renderer, 'first child');
      expect(findHostByLabel(renderer, 'node-1')).toHaveLength(1);
      expect(findHostByLabel(renderer, 'connector')).toHaveLength(1);
      unmount();
    });

    it('Add Sibling opens the modal, then inserts a peer on Create', () => {
      const tree = createTree('root');
      const a = addChild(tree, tree.rootId, 'a');
      const {renderer, unmount} = renderCanvas(
        <MindmapCanvas initialTree={tree} />,
      );
      pressByLabel(renderer, `add-sibling-${a}`);
      expect(findHostByLabel(renderer, 'label-modal')).toHaveLength(1);
      // Sibling not in the tree yet.
      expect(findHostByLabel(renderer, 'node-2')).toHaveLength(0);
      fillModalAndCreate(renderer, 'sibling label');
      // Root now has 2 children: `a` and a new sibling (id=2).
      expect(findHostByLabel(renderer, 'node-0')).toHaveLength(1);
      expect(findHostByLabel(renderer, `node-${a}`)).toHaveLength(1);
      expect(findHostByLabel(renderer, 'node-2')).toHaveLength(1);
      unmount();
    });

    it('Cancel from the Add Child modal does NOT add a node', () => {
      const tree = createTree('root');
      const {renderer, unmount} = renderCanvas(
        <MindmapCanvas initialTree={tree} />,
      );
      pressByLabel(renderer, 'add-child-0');
      pressByLabel(renderer, 'label-cancel');
      // No new node, no connector.
      expect(findHostByLabel(renderer, 'node-1')).toHaveLength(0);
      expect(findHostByLabel(renderer, 'connector')).toHaveLength(0);
      // Modal closed.
      expect(findHostByLabel(renderer, 'label-modal')).toHaveLength(0);
      unmount();
    });

    it('Delete removes the subtree and clears selection', () => {
      const tree = createTree('root');
      const a = addChild(tree, tree.rootId, 'a');
      const aa = addChild(tree, a, 'aa');
      const {renderer, unmount} = renderCanvas(
        <MindmapCanvas initialTree={tree} />,
      );
      // Tap selects + opens the edit-label modal — dismiss it so the
      // assertions below interact with the canvas directly.
      pressByLabel(renderer, `node-${a}`);
      pressByLabel(renderer, 'label-cancel');
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
      const tree = createTree('root');
      const snapshotBefore = tree.nodesById.size;
      const {renderer, unmount} = renderCanvas(
        <MindmapCanvas initialTree={tree} />,
      );
      pressByLabel(renderer, 'add-child-0');
      // Add Child opens the modal — type a label and Create.
      const input = renderer.root.findAllByProps({
        accessibilityLabel: 'label-input',
      })[0];
      act(() => {
        (input.props.onChangeText as (s: string) => void)('first child');
      });
      pressByLabel(renderer, 'label-create');
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

    it('reopens the central-idea modal after Clear (full reset to initial-open state)', () => {
      // Per the v0.2 label-first UX: tapping Clear → confirm should
      // leave the user in the same state as their first plugin open —
      // an empty tree with the "Central idea" modal already on screen.
      // Without re-arming `pending` in handleClear, the user would
      // see an unlabeled root + chevron icons floating with no modal,
      // which is the bug that prompted this test.
      const tree = createTree('original idea');
      addChild(tree, tree.rootId, 'a');
      const {renderer, unmount} = renderCanvas(
        <MindmapCanvas initialTree={tree} />,
      );
      // Mount with a labeled root + child → no modal initially.
      expect(findHostByLabel(renderer, 'label-modal')).toHaveLength(0);
      pressByLabel(renderer, 'Clear');
      pressByLabel(renderer, 'Confirm Clear');
      // Tree is reset AND the central-idea modal is open.
      expect(findHostByLabel(renderer, 'node-1')).toHaveLength(0);
      expect(findHostByLabel(renderer, 'label-modal')).toHaveLength(1);
      // The modal's input is empty — the previous root label does
      // not leak into the new prompt.
      const inputs = renderer.root.findAllByProps({
        accessibilityLabel: 'label-input',
      });
      expect(inputs[0]?.props.value ?? '').toBe('');
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
      (PluginFileAPI.insertElements as jest.Mock).mockClear();
      (PluginFileAPI.insertElements as jest.Mock).mockResolvedValue({
        success: true,
      });
      (PluginFileAPI.replaceElements as jest.Mock).mockClear();
      (PluginFileAPI.replaceElements as jest.Mock).mockResolvedValue({
        success: true,
      });
      (PluginFileAPI.getElements as jest.Mock).mockClear();
      (PluginCommAPI.createElement as jest.Mock).mockClear();
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

      // 2 outlines + 1 connector = 3 geometries, one additive
      // insertElements, then reloadFile + close. The additive path
      // never whole-page-rewrites the page (replaceElements); getElements
      // is read-only for placement. (Marker strokes were removed with the
      // edit/decode pipeline.)
      expect(nonMarkerInsertCount()).toBe(3);
      expect(PluginFileAPI.insertElements).toHaveBeenCalledTimes(1);
      expect(PluginFileAPI.replaceElements).not.toHaveBeenCalled();
      expect(PluginManager.closePluginView).toHaveBeenCalledTimes(1);
      unmount();
    });

    it('shows an error banner when insert fails and keeps the plugin view open', async () => {
      // insertElements rejecting causes insertMindmap to throw
      // before closePluginView fires.
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
      // Gate insertElements on a promise we resolve manually so a
      // second tap can land while the first insert is still in flight.
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

      // insertElements was called exactly once — the second tap was
      // debounced via insertingRef.
      expect(PluginFileAPI.insertElements).toHaveBeenCalledTimes(1);

      // Let the first insert complete cleanly.
      resolveFirst();
      await flushAsync();
      unmount();
    });
  });

  describe('Phase B3 — Link mode (DAG cross-edges, §F-DAG-3)', () => {
    /**
     * A two-child tree (root → b, root → d). b and d are siblings, so a
     * b→d link is a genuine, valid cross-edge (no cycle, not a tree
     * edge). Both nodes carry labels so a node tap that DID open the
     * label modal would surface a label-input we can assert against.
     */
    function linkableTree() {
      const tree = createTree('root');
      const b = addChild(tree, tree.rootId, 'b');
      const d = addChild(tree, tree.rootId, 'd');
      return {tree, b, d};
    }

    it('Link button is disabled on a lone-root tree (< 2 nodes, F-DAG-3-FR5)', () => {
      const {renderer, unmount} = renderCanvas(<MindmapCanvas />);
      const link = findPressable(renderer, 'Link');
      expect(link.props.accessibilityState?.disabled).toBe(true);
      expect(link.props.disabled).toBe(true);
      unmount();
    });

    it('Link button becomes enabled once the tree has ≥ 2 nodes', () => {
      const {tree} = linkableTree();
      const {renderer, unmount} = renderCanvas(
        <MindmapCanvas initialTree={tree} />,
      );
      const link = findPressable(renderer, 'Link');
      expect(link.props.accessibilityState?.disabled).toBe(false);
      expect(link.props.disabled).toBe(false);
      unmount();
    });

    it('arm → tap source → tap target → cross-edge appears and link mode disarms (F-DAG-3-AC1)', () => {
      const {tree, b, d} = linkableTree();
      const {renderer, unmount} = renderCanvas(
        <MindmapCanvas initialTree={tree} />,
      );
      // Arm: label flips to 'Cancel Link'.
      pressByLabel(renderer, 'Link');
      expect(findHostByLabel(renderer, 'Cancel Link')).toHaveLength(1);
      // No cross-edge yet.
      expect(findHostByLabel(renderer, `cross-edge-${b}-${d}`)).toHaveLength(0);

      // Tap source (b) then target (d).
      pressByLabel(renderer, `node-${b}`);
      pressByLabel(renderer, `node-${d}`);

      // Cross-edge overlay appears, and link mode disarmed back to 'Link'.
      expect(findHostByLabel(renderer, `cross-edge-${b}-${d}`)).toHaveLength(1);
      expect(findHostByLabel(renderer, 'Link')).toHaveLength(1);
      expect(findHostByLabel(renderer, 'Cancel Link')).toHaveLength(0);
      // No reject banner on the happy path.
      expect(findHostByLabel(renderer, 'link-error')).toHaveLength(0);
      unmount();
    });

    it('reject path: a cycling pair shows the reason banner, disarms, adds NO edge (F-DAG-3-AC2)', () => {
      // Tree root → b. Arm, tap b (source) then root (target): b→root
      // cycles → reject 'cycle'.
      const tree = createTree('root');
      const b = addChild(tree, tree.rootId, 'b');
      const {renderer, unmount} = renderCanvas(
        <MindmapCanvas initialTree={tree} />,
      );
      pressByLabel(renderer, 'Link');
      pressByLabel(renderer, `node-${b}`); // source
      pressByLabel(renderer, 'node-0'); // target (root) → cycle

      // Reason banner shown with the cycle message.
      const banner = findHostByLabel(renderer, 'link-error');
      expect(banner).toHaveLength(1);
      // Link mode disarmed.
      expect(findHostByLabel(renderer, 'Link')).toHaveLength(1);
      expect(findHostByLabel(renderer, 'Cancel Link')).toHaveLength(0);
      // No cross-edge was added (neither direction).
      expect(findHostByLabel(renderer, `cross-edge-${b}-0`)).toHaveLength(0);
      expect(findHostByLabel(renderer, `cross-edge-0-${b}`)).toHaveLength(0);
      unmount();
    });

    it('re-tapping the source cancels selection (no edge, no banner, still armed)', () => {
      const {tree, b} = linkableTree();
      const {renderer, unmount} = renderCanvas(
        <MindmapCanvas initialTree={tree} />,
      );
      pressByLabel(renderer, 'Link');
      pressByLabel(renderer, `node-${b}`); // pick source
      pressByLabel(renderer, `node-${b}`); // re-tap same node → cancel
      // Still armed, no banner, no edge.
      expect(findHostByLabel(renderer, 'Cancel Link')).toHaveLength(1);
      expect(findHostByLabel(renderer, 'link-error')).toHaveLength(0);
      unmount();
    });

    it('tapping a cross-edge while armed deletes it (F-DAG-3-FR4)', () => {
      const {tree, b, d} = linkableTree();
      const {renderer, unmount} = renderCanvas(
        <MindmapCanvas initialTree={tree} />,
      );
      // Create the edge: arm, source b, target d.
      pressByLabel(renderer, 'Link');
      pressByLabel(renderer, `node-${b}`);
      pressByLabel(renderer, `node-${d}`);
      expect(findHostByLabel(renderer, `cross-edge-${b}-${d}`)).toHaveLength(1);

      // Re-arm (adding the edge disarmed link mode), then tap the
      // cross-edge to delete it.
      pressByLabel(renderer, 'Link');
      pressByLabel(renderer, `cross-edge-${b}-${d}`);
      expect(findHostByLabel(renderer, `cross-edge-${b}-${d}`)).toHaveLength(0);
      unmount();
    });

    it('a node tap while armed routes to link selection, NOT the label modal', () => {
      const {tree, b} = linkableTree();
      const {renderer, unmount} = renderCanvas(
        <MindmapCanvas initialTree={tree} />,
      );
      pressByLabel(renderer, 'Link'); // arm
      pressByLabel(renderer, `node-${b}`); // armed tap = pick source
      // The edit-label modal must NOT open.
      expect(findHostByLabel(renderer, 'label-modal')).toHaveLength(0);
      expect(findHostByLabel(renderer, 'label-input')).toHaveLength(0);
      unmount();
    });

    it('a node tap while IDLE still opens the label modal (existing behavior preserved)', () => {
      const {tree, b} = linkableTree();
      const {renderer, unmount} = renderCanvas(
        <MindmapCanvas initialTree={tree} />,
      );
      // No arming — tap routes to select + edit as before.
      pressByLabel(renderer, `node-${b}`);
      expect(findHostByLabel(renderer, 'label-input')).toHaveLength(1);
      unmount();
    });

    it('per-node action icons are hidden while armed', () => {
      const {tree, b} = linkableTree();
      const {renderer, unmount} = renderCanvas(
        <MindmapCanvas initialTree={tree} />,
      );
      // Idle: node b shows its Add Child affordance.
      expect(findHostByLabel(renderer, `add-child-${b}`)).toHaveLength(1);
      // Armed: action icons are suppressed so taps are link selections.
      pressByLabel(renderer, 'Link');
      expect(findHostByLabel(renderer, `add-child-${b}`)).toHaveLength(0);
      unmount();
    });

    it('a pre-existing cross-edge renders while IDLE as a NON-deletable overlay (onPress undefined)', () => {
      // Seed a cross-edge on the initial tree so it renders without ever
      // arming. While idle, CrossConnector gets onPress=undefined and is
      // disabled — the overlay is a passive visual, not a tap target.
      // This covers the idle arm of `onPress={armed ? ... : undefined}`.
      const tree = createTree('root');
      const b = addChild(tree, tree.rootId, 'b');
      const d = addChild(tree, tree.rootId, 'd');
      tree.crossEdges.push({from: b, to: d});

      const {renderer, unmount} = renderCanvas(
        <MindmapCanvas initialTree={tree} />,
      );
      // The overlay View exists (host match) even though we never armed.
      expect(findHostByLabel(renderer, `cross-edge-${b}-${d}`)).toHaveLength(1);
      // ...but it is NOT an interactive Pressable (no onPress handler) —
      // findPressable requires a function onPress, so it finds none.
      expect(() => findPressable(renderer, `cross-edge-${b}-${d}`)).toThrow(
        /no Pressable/,
      );
      unmount();
    });

    it('a cross-edge to a deep node still renders (overlay keys off the full-tree layout)', () => {
      // root → a → g (grandchild); root → b. Cross-edge b→g. The Stage
      // computes radialLayout over the FULL tree, so layout.centers
      // always has g's center and the overlay renders the cross-edge
      // regardless of g's depth. (The `if (!fromCenter || !toCenter)`
      // guard in CrossConnector is defensive against a dangling edge,
      // which I-DAG-2 prevents — it is not reachable via normal authoring.)
      const tree = createTree('root');
      const a = addChild(tree, tree.rootId, 'a');
      const g = addChild(tree, a, 'g');
      const b = addChild(tree, tree.rootId, 'b');
      tree.crossEdges.push({from: b, to: g});

      const {renderer, unmount} = renderCanvas(
        <MindmapCanvas initialTree={tree} />,
      );
      expect(findHostByLabel(renderer, `cross-edge-${b}-${g}`)).toHaveLength(1);
      unmount();
    });

    it('the selected source node is highlighted while armed (isLinkSource doubles its border)', () => {
      // Arm, tap source b. NodeFrame receives isLinkSource=true for b,
      // which doubles its border width vs an un-sourced sibling. Compare
      // b's borderWidth (source) to d's (not source) to assert the
      // highlight branch fired.
      const {tree, b, d} = linkableTree();
      const {renderer, unmount} = renderCanvas(
        <MindmapCanvas initialTree={tree} />,
      );
      pressByLabel(renderer, 'Link');
      pressByLabel(renderer, `node-${b}`); // b becomes the link source

      const sourceStyle = flattenStyle(
        findHostSingle(renderer, `node-${b}`).props.style,
      );
      const peerStyle = flattenStyle(
        findHostSingle(renderer, `node-${d}`).props.style,
      );
      // Source node's border is thicker than a non-source sibling's.
      expect(sourceStyle.borderWidth as number).toBeGreaterThan(
        peerStyle.borderWidth as number,
      );
      unmount();
    });
  });
});
