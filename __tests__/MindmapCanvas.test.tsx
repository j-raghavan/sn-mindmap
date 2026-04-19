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
// We only need PluginManager.closePluginView because MindmapCanvas
// calls it from the Cancel button.
jest.mock('sn-plugin-lib', () => ({
  PluginManager: {
    closePluginView: jest.fn(),
  },
}));

import MindmapCanvas from '../src/MindmapCanvas';
import {PluginManager} from 'sn-plugin-lib';
import {addChild, addSibling, createTree} from '../src/model/tree';

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
});
