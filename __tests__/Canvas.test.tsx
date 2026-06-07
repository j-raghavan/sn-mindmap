/**
 * Tests for src/Canvas.tsx — the §14.2 top-level mode-selecting wrapper.
 *
 * Canvas owns the document-mode choice (Mindmap | Concept map) in the
 * central-idea modal, then renders MindmapCanvas (seeded createTree) or
 * ConceptCanvas (seeded createGraph). Mode is fixed for the document's
 * life — the toggle only appears in this initial modal.
 *
 * The mode-selector tests live HERE (not MindmapCanvas.test.tsx) so the
 * mindmap canvas suite stays byte-identical: MindmapCanvas renders bare in
 * its own tests and must keep auto-opening its own label modal only when
 * the root is unlabeled. Canvas always hands it a LABELED root, so its
 * modal does not re-open.
 *
 * Coverage:
 *   - on mount the mode modal shows with a Mindmap|Concept-map toggle
 *   - Create is disabled until the label is non-empty
 *   - picking Mindmap + Create renders MindmapCanvas (mindmap chrome), and
 *     MindmapCanvas's own central-idea modal does NOT re-open (labeled root)
 *   - picking Concept-map + Create renders ConceptCanvas (concept chrome)
 *   - initialDocument skips the modal and renders the chosen canvas
 *   - the mode toggle exists ONLY in the modal (gone once a canvas mounts)
 */
import React from 'react';
import {act, create} from 'react-test-renderer';

jest.mock('sn-plugin-lib', () => ({
  Element: {TYPE_GEO: 700, TYPE_TEXT: 600},
  PluginManager: {closePluginView: jest.fn().mockResolvedValue(true)},
  PluginCommAPI: {
    createElement: jest
      .fn()
      .mockResolvedValue({success: true, result: {uuid: 'u', geometry: null}}),
    getCurrentFilePath: jest
      .fn()
      .mockResolvedValue({success: true, result: '/note/test.note'}),
    getCurrentPageNum: jest.fn().mockResolvedValue({success: true, result: 0}),
    lassoElements: jest.fn().mockResolvedValue({success: true}),
    setLassoBoxState: jest.fn().mockResolvedValue({success: true}),
    reloadFile: jest.fn().mockResolvedValue({success: true}),
  },
  PluginFileAPI: {
    getPageSize: jest
      .fn()
      .mockResolvedValue({success: true, result: {width: 1404, height: 1872}}),
    getElements: jest.fn().mockResolvedValue({success: true, result: []}),
    insertElements: jest.fn().mockResolvedValue({success: true}),
  },
}));

import Canvas from '../src/Canvas';
import {PluginManager} from 'sn-plugin-lib';

type Renderer = ReturnType<typeof create>;
type TestInstance = ReturnType<Renderer['root']['findAll']>[number];

function renderCanvas(element: React.ReactElement): {
  renderer: Renderer;
  unmount: () => void;
} {
  let renderer: Renderer | undefined;
  act(() => {
    renderer = create(element);
  });
  if (!renderer) {
    throw new Error('renderCanvas: react-test-renderer returned undefined');
  }
  const r = renderer;
  return {renderer: r, unmount: () => act(() => r.unmount())};
}

function hasLabel(renderer: Renderer, label: string): boolean {
  return (
    renderer.root.findAll(
      node =>
        typeof node.type === 'string' &&
        node.props.accessibilityLabel === label,
    ).length > 0
  );
}

function findPressable(renderer: Renderer, label: string): TestInstance {
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

function pressByLabel(renderer: Renderer, label: string): void {
  const onPress = findPressable(renderer, label).props.onPress as () => void;
  // Block body (not expression body) so the act callback returns undefined —
  // a Pressable handler may return a floating Promise (e.g. closePluginView),
  // and `act(() => onPress())` would hand that thenable to act, silently
  // entering un-awaited async-act mode and poisoning the next renderer.
  // Matches MindmapCanvas.test.tsx's pressByLabel.
  act(() => {
    onPress();
  });
}

function typeLabel(renderer: Renderer, text: string): void {
  const input = renderer.root.findAll(
    node =>
      typeof node.type !== 'string' &&
      node.props.accessibilityLabel === 'label-input',
  )[0];
  act(() => (input.props.onChangeText as (t: string) => void)(text));
}

beforeEach(() => {
  (PluginManager.closePluginView as jest.Mock).mockClear();
});

describe('Canvas — mode-selecting central-idea modal (§14.2)', () => {
  it('opens the mode modal with a Mindmap|Concept-map toggle on mount', () => {
    const {renderer, unmount} = renderCanvas(<Canvas />);
    expect(hasLabel(renderer, 'mode-modal')).toBe(true);
    expect(hasLabel(renderer, 'mode-mindmap')).toBe(true);
    expect(hasLabel(renderer, 'mode-concept')).toBe(true);
    expect(hasLabel(renderer, 'mode-create')).toBe(true);
    unmount();
  });

  it('disables Create until the label is non-empty', () => {
    const {renderer, unmount} = renderCanvas(<Canvas />);
    expect(
      findPressable(renderer, 'mode-create').props.accessibilityState?.disabled,
    ).toBe(true);
    typeLabel(renderer, 'My idea');
    expect(
      findPressable(renderer, 'mode-create').props.accessibilityState?.disabled,
    ).toBe(false);
    unmount();
  });

  it('Cancel dismisses via PluginManager.closePluginView', () => {
    const {renderer, unmount} = renderCanvas(<Canvas />);
    pressByLabel(renderer, 'mode-cancel');
    expect(PluginManager.closePluginView).toHaveBeenCalledTimes(1);
    unmount();
  });
});

describe('Canvas — picking Mindmap', () => {
  it('renders MindmapCanvas with a labeled root; its own modal does NOT re-open', () => {
    const {renderer, unmount} = renderCanvas(<Canvas />);
    typeLabel(renderer, 'Central');
    pressByLabel(renderer, 'mode-mindmap');
    pressByLabel(renderer, 'mode-create');
    // Mindmap chrome is up (its background), and the mode modal is gone.
    expect(hasLabel(renderer, 'mindmap-background')).toBe(true);
    expect(hasLabel(renderer, 'mode-modal')).toBe(false);
    // MindmapCanvas auto-opens its central-idea modal ONLY for an unlabeled
    // root; Canvas seeds a labeled root, so no label-modal re-prompt.
    expect(hasLabel(renderer, 'label-modal')).toBe(false);
    unmount();
  });
});

describe('Canvas — picking Concept map', () => {
  it('renders ConceptCanvas (concept chrome) with the labeled root', () => {
    const {renderer, unmount} = renderCanvas(<Canvas />);
    typeLabel(renderer, 'Central');
    pressByLabel(renderer, 'mode-concept');
    pressByLabel(renderer, 'mode-create');
    // Concept chrome is up and the mode modal is gone.
    expect(hasLabel(renderer, 'concept-background')).toBe(true);
    expect(hasLabel(renderer, 'mode-modal')).toBe(false);
    // The labeled root rendered as a node frame.
    expect(hasLabel(renderer, 'node-0')).toBe(true);
    unmount();
  });
});

describe('Canvas — initialDocument shortcut + mode fixity', () => {
  it('initialDocument:mindmap skips the modal and renders MindmapCanvas', () => {
    const {renderer, unmount} = renderCanvas(
      <Canvas initialDocument={{mode: 'mindmap', label: 'Seeded'}} />,
    );
    expect(hasLabel(renderer, 'mode-modal')).toBe(false);
    expect(hasLabel(renderer, 'mindmap-background')).toBe(true);
    unmount();
  });

  it('initialDocument:concept skips the modal and renders ConceptCanvas', () => {
    const {renderer, unmount} = renderCanvas(
      <Canvas initialDocument={{mode: 'concept', label: 'Seeded'}} />,
    );
    expect(hasLabel(renderer, 'mode-modal')).toBe(false);
    expect(hasLabel(renderer, 'concept-background')).toBe(true);
    unmount();
  });

  it('the mode toggle exists ONLY in the modal — gone once a canvas mounts', () => {
    const {renderer, unmount} = renderCanvas(<Canvas />);
    expect(hasLabel(renderer, 'mode-concept')).toBe(true); // in modal
    typeLabel(renderer, 'Central');
    pressByLabel(renderer, 'mode-concept');
    pressByLabel(renderer, 'mode-create');
    // After commit the segmented toggle is no longer in the tree (mode is
    // fixed for the document's life — no runtime switch in v1).
    expect(hasLabel(renderer, 'mode-mindmap')).toBe(false);
    expect(hasLabel(renderer, 'mode-concept')).toBe(false);
    unmount();
  });
});
