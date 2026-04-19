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
 * Phase 1.4b replaces these with mutation-flow coverage (addChild,
 * addSibling, collapse toggle, delete). Phase 2 adds Insert.
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
 * the underlying host instance when RN internals forward props
 * through — this dedupes to the host layer so counts match user
 * intent ("how many rendered <View>s have this label").
 */
function findHostByLabel(
  renderer: Renderer,
  label: string,
): ReturnType<Renderer['root']['findAll']> {
  return renderer.root.findAll(
    node => typeof node.type === 'string' && node.props.accessibilityLabel === label,
  );
}

describe('MindmapCanvas', () => {
  beforeEach(() => {
    (PluginManager.closePluginView as jest.Mock).mockClear();
  });

  describe('Cancel button (regression for Phase 0 "Notes hangs" bug)', () => {
    it('renders a Cancel button with accessibilityLabel', () => {
      const {renderer, unmount} = renderCanvas(<MindmapCanvas />);
      const cancel = renderer.root.findByProps({accessibilityLabel: 'Cancel'});
      expect(cancel).toBeTruthy();
      unmount();
    });

    it('Cancel button invokes PluginManager.closePluginView', () => {
      const {renderer, unmount} = renderCanvas(<MindmapCanvas />);
      const cancel = renderer.root.findByProps({accessibilityLabel: 'Cancel'});
      act(() => {
        cancel.props.onPress();
      });
      expect(PluginManager.closePluginView).toHaveBeenCalledTimes(1);
      unmount();
    });
  });

  describe('default (no initialTree) → single-node tree', () => {
    it('renders exactly one node frame', () => {
      const {renderer, unmount} = renderCanvas(<MindmapCanvas />);
      // Only node-0 exists (the auto-created root Oval).
      const root = renderer.root.findByProps({accessibilityLabel: 'node-0'});
      expect(root).toBeTruthy();
      // No connectors on a single-node tree.
      const connectors = renderer.root.findAllByProps({
        accessibilityLabel: 'connector',
      });
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
        const node = renderer.root.findByProps({
          accessibilityLabel: `node-${id}`,
        });
        expect(node).toBeTruthy();
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
      // Filter to host instances — react-test-renderer can expose
      // both the composite forwardRef View and its underlying host
      // View when transform props are present, which would otherwise
      // double the count.
      const connectors = findHostByLabel(renderer, 'connector');
      expect(connectors).toHaveLength(3);
      unmount();
    });

    it('OVAL root renders with fully-rounded borderRadius (= bbox.h / 2)', () => {
      // Root is OVAL by construction (createTree). Its bbox is
      // NODE_WIDTH × NODE_HEIGHT = 220 × 96 centered on origin, so
      // borderRadius should be 48.
      const {renderer, unmount} = renderCanvas(<MindmapCanvas />);
      const root = renderer.root.findByProps({accessibilityLabel: 'node-0'});
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
      const node = renderer.root.findByProps({accessibilityLabel: `node-${a}`});
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
      const node = renderer.root.findByProps({accessibilityLabel: `node-${s}`});
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
      const stage = renderer.root.findByProps({
        accessibilityLabel: 'mindmap-stage',
      });
      const style = stage.props.style as {width: number; height: number};
      expect(style.width).toBeGreaterThan(0);
      expect(style.height).toBeGreaterThan(0);
      unmount();
    });
  });
});
