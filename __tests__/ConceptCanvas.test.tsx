/**
 * Tests for src/ConceptCanvas.tsx — the concept-map (DAG) authoring
 * surface (§14.2 / §14.4). Sibling to MindmapCanvas; the mindmap canvas +
 * useLinkMode stay byte-identical (their suites are untouched).
 *
 * Coverage (concept affordances, §F-AC-DAG-*):
 *   - F-AC-DAG-1 Add Child — add-child pill creates a child via the label
 *     modal.
 *   - F-AC-DAG-2 Add Parent — add-parent pill creates a parent; the
 *     genealogy two-tap (son + Father + Mother) gives son two parents.
 *   - F-AC-DAG-3 Concept link — top-bar arm + two-tap source→target adds a
 *     parent edge; a rejected target (cycle/duplicate) raises the concept
 *     banner with NO 'tree-edge' wording; cancel via background / re-tap.
 *   - F-AC-DAG-4 Delete node — single-node delete; an orphaned child
 *     survives; a node with ≥ 2 edges needs a two-tap confirm.
 *   - F-AC-DAG-5 NO Add Sibling — the affordance is absent on concept
 *     nodes.
 *   - A11y: the concept link control wears the CONCEPT label ("Concept
 *     link"), distinct from feature-A's "Link"; feature-A's "Link" top-bar
 *     button is ABSENT in concept mode.
 */
import React from 'react';
import {act, create} from 'react-test-renderer';

// Same sn-plugin-lib mock surface MindmapCanvas.test.tsx uses — the insert
// path (insertConceptMap) dips into PluginCommAPI / PluginFileAPI; the
// authoring tests here only need closePluginView + the additive insert
// mocks to succeed.
jest.mock('sn-plugin-lib', () => {
  let uuidCounter = 0;
  const mintElement = () => ({
    uuid: `concept-uuid-${uuidCounter++}`,
    type: 700,
    pageNum: 0,
    layerNum: 0,
    thickness: 0,
    geometry: null as unknown,
  });
  return {
    Element: {TYPE_GEO: 700, TYPE_TEXT: 600},
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
      getCurrentPageNum: jest.fn().mockResolvedValue({success: true, result: 0}),
      lassoElements: jest.fn().mockResolvedValue({success: true}),
      deleteLassoElements: jest.fn().mockResolvedValue({success: true}),
      setLassoBoxState: jest.fn().mockResolvedValue({success: true}),
      reloadFile: jest.fn().mockResolvedValue({success: true}),
    },
    PluginFileAPI: {
      getPageSize: jest
        .fn()
        .mockResolvedValue({success: true, result: {width: 1404, height: 1872}}),
      getElements: jest.fn().mockResolvedValue({success: true, result: []}),
      replaceElements: jest.fn().mockResolvedValue({success: true}),
      insertElements: jest.fn().mockResolvedValue({success: true}),
    },
  };
});

import ConceptCanvas from '../src/ConceptCanvas';
import {PluginManager} from 'sn-plugin-lib';
import {
  addNodeWithParent,
  createGraph,
  type Graph,
} from '../src/model/graph';

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

function findHostByLabel(renderer: Renderer, label: string): TestInstance[] {
  return renderer.root.findAll(
    node =>
      typeof node.type === 'string' &&
      node.props.accessibilityLabel === label,
  );
}

/** True iff at least one host element carries `label`. */
function hasLabel(renderer: Renderer, label: string): boolean {
  return findHostByLabel(renderer, label).length > 0;
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
  // a Pressable handler may return a floating Promise (e.g. closePluginView /
  // the insert flow), and `act(() => onPress())` would hand that thenable to
  // act, silently entering un-awaited async-act mode and poisoning the next
  // renderer. Matches MindmapCanvas.test.tsx's pressByLabel.
  act(() => {
    onPress();
  });
}

/** Type into the (single) label-input and press label-create. */
function createWithLabel(renderer: Renderer, label: string): void {
  const input = renderer.root.findAll(
    node =>
      typeof node.type !== 'string' &&
      node.props.accessibilityLabel === 'label-input',
  )[0];
  act(() => (input.props.onChangeText as (t: string) => void)(label));
  pressByLabel(renderer, 'label-create');
}


/** Count rendered concept nodes (host Views labeled node-<id>). */
function nodeCount(renderer: Renderer): number {
  return renderer.root.findAll(
    node =>
      typeof node.type === 'string' &&
      typeof node.props.accessibilityLabel === 'string' &&
      /^node-\d+$/.test(node.props.accessibilityLabel),
  ).length;
}

/** Seed graph: root + two children (so Concept link is enabled). */
function seededGraph(): Graph {
  const graph = createGraph('root');
  addNodeWithParent(graph, 0, 'a');
  addNodeWithParent(graph, 0, 'b');
  return graph;
}

beforeEach(() => {
  (PluginManager.closePluginView as jest.Mock).mockClear();
});

describe('ConceptCanvas — render + top bar', () => {
  it('renders a seeded graph with one node frame per node', () => {
    const {renderer, unmount} = renderCanvas(
      <ConceptCanvas initialGraph={seededGraph()} />,
    );
    expect(nodeCount(renderer)).toBe(3); // root + a + b
    unmount();
  });

  it('Cancel dismisses via PluginManager.closePluginView', () => {
    const {renderer, unmount} = renderCanvas(
      <ConceptCanvas initialGraph={createGraph('only')} />,
    );
    pressByLabel(renderer, 'Cancel');
    expect(PluginManager.closePluginView).toHaveBeenCalledTimes(1);
    unmount();
  });
});

describe('ConceptCanvas — F-AC-DAG-1 Add Child', () => {
  it('add-child pill + label modal creates a child node', () => {
    const {renderer, unmount} = renderCanvas(
      <ConceptCanvas initialGraph={createGraph('root')} />,
    );
    expect(nodeCount(renderer)).toBe(1);
    pressByLabel(renderer, 'add-child-0');
    createWithLabel(renderer, 'child A');
    expect(nodeCount(renderer)).toBe(2);
    unmount();
  });
});

describe('ConceptCanvas — F-AC-DAG-2 Add Parent (genealogy)', () => {
  it('add-parent twice on the son gives the son two parents', () => {
    // son is the seeded root (0). Add Parent twice → Father + Mother, each
    // a new root pointing at son. Result: 3 nodes, son has 2 parents.
    const {renderer, unmount} = renderCanvas(
      <ConceptCanvas initialGraph={createGraph('son')} />,
    );
    pressByLabel(renderer, 'add-parent-0');
    createWithLabel(renderer, 'Father');
    pressByLabel(renderer, 'add-parent-0');
    createWithLabel(renderer, 'Mother');
    expect(nodeCount(renderer)).toBe(3);
    // Two connectors now point INTO son (one per parent edge).
    const connectors = findHostByLabel(renderer, 'concept-connector');
    expect(connectors.length).toBe(2);
    unmount();
  });
});

describe('ConceptCanvas — F-AC-DAG-3 Concept link (two-tap)', () => {
  it('arms via the top-bar "Concept link" pill, then links source→target', () => {
    const {renderer, unmount} = renderCanvas(
      <ConceptCanvas initialGraph={seededGraph()} />,
    );
    // Before linking: 2 connectors (root→a, root→b).
    expect(findHostByLabel(renderer, 'concept-connector').length).toBe(2);
    pressByLabel(renderer, 'Concept link'); // arm
    pressByLabel(renderer, 'node-1'); // source = a
    pressByLabel(renderer, 'node-2'); // target = b → a becomes parent of b
    // b now has two parents (root + a) → 3 connectors total.
    expect(findHostByLabel(renderer, 'concept-connector').length).toBe(3);
    // No reject banner on a valid link.
    expect(hasLabel(renderer, 'link-error')).toBe(false);
    unmount();
  });

  it('a cycle-creating target raises the concept banner (no tree-edge wording)', () => {
    // root 0 → a. Arm, source = a, target = root: a→root would cycle.
    const graph = createGraph('root');
    addNodeWithParent(graph, 0, 'a');
    const {renderer, unmount} = renderCanvas(
      <ConceptCanvas initialGraph={graph} />,
    );
    pressByLabel(renderer, 'Concept link');
    pressByLabel(renderer, 'node-1'); // source = a
    pressByLabel(renderer, 'node-0'); // target = root → cycle
    expect(hasLabel(renderer, 'link-error')).toBe(true);
    const banner = findHostByLabel(renderer, 'link-error')[0];
    expect(banner).toBeDefined();
    // Concatenate every string child under the banner subtree; assert it
    // says "cycle" and NOT feature-A's 'tree-edge'/'branch' wording.
    const message = [banner, ...banner.findAll(() => true)]
      .flatMap(n =>
        Array.isArray(n.props.children) ? n.props.children : [n.props.children],
      )
      .filter((c): c is string => typeof c === 'string')
      .join(' ')
      .toLowerCase();
    expect(message).toContain('cycle');
    expect(message).not.toContain('tree');
    expect(message).not.toContain('branch');
    unmount();
  });

  it('the armed pill flips to "Cancel Concept link" and disarms on re-press', () => {
    const {renderer, unmount} = renderCanvas(
      <ConceptCanvas initialGraph={seededGraph()} />,
    );
    pressByLabel(renderer, 'Concept link'); // arm
    expect(hasLabel(renderer, 'Cancel Concept link')).toBe(true);
    pressByLabel(renderer, 'Cancel Concept link'); // disarm
    expect(hasLabel(renderer, 'Concept link')).toBe(true);
    unmount();
  });

  it('tapping the background while armed cancels the pending link', () => {
    const {renderer, unmount} = renderCanvas(
      <ConceptCanvas initialGraph={seededGraph()} />,
    );
    pressByLabel(renderer, 'Concept link'); // arm
    pressByLabel(renderer, 'node-1'); // source picked
    pressByLabel(renderer, 'concept-background'); // cancel (still armed, source cleared)
    // No link added: still the original 2 connectors.
    expect(findHostByLabel(renderer, 'concept-connector').length).toBe(2);
    unmount();
  });
});

describe('ConceptCanvas — F-AC-DAG-4 Delete node (single, orphan-aware)', () => {
  it('deletes only the tapped node; an orphaned child survives', () => {
    // root → mid → leaf. Delete mid (1 parent + 1 child = not "heavy",
    // so single-tap delete). leaf loses its only parent but remains.
    const graph = createGraph('root');
    const mid = addNodeWithParent(graph, 0, 'mid');
    addNodeWithParent(graph, mid, 'leaf');
    const {renderer, unmount} = renderCanvas(
      <ConceptCanvas initialGraph={graph} />,
    );
    expect(nodeCount(renderer)).toBe(3);
    pressByLabel(renderer, 'node-1'); // select mid
    pressByLabel(renderer, 'delete-1'); // single-tap delete (mid has 1+1 edges)
    // mid gone, root + leaf survive (leaf orphaned, NOT cascade-deleted).
    expect(nodeCount(renderer)).toBe(2);
    expect(hasLabel(renderer, 'node-2')).toBe(true); // leaf still rendered
    unmount();
  });

  it('a node with >= 2 edges requires a two-tap confirm', () => {
    // root with two children → root has 2 outgoing edges ("heavy").
    // First delete tap arms (confirm-delete), second deletes.
    const {renderer, unmount} = renderCanvas(
      <ConceptCanvas initialGraph={seededGraph()} />,
    );
    pressByLabel(renderer, 'node-0'); // select root (2 children = heavy)
    pressByLabel(renderer, 'delete-0'); // first tap → arms confirm
    expect(hasLabel(renderer, 'confirm-delete-0')).toBe(true);
    expect(nodeCount(renderer)).toBe(3); // not deleted yet
    pressByLabel(renderer, 'confirm-delete-0'); // second tap → delete
    // root gone; its two children orphaned but surviving.
    expect(nodeCount(renderer)).toBe(2);
    unmount();
  });
});

describe('ConceptCanvas — F-AC-DAG-5 + a11y distinctness', () => {
  it('has NO Add Sibling affordance on any node', () => {
    const {renderer, unmount} = renderCanvas(
      <ConceptCanvas initialGraph={seededGraph()} />,
    );
    // No add-sibling-* label exists anywhere (concept mode drops it).
    const siblingPills = renderer.root.findAll(
      node =>
        typeof node.type === 'string' &&
        typeof node.props.accessibilityLabel === 'string' &&
        node.props.accessibilityLabel.startsWith('add-sibling'),
    );
    expect(siblingPills.length).toBe(0);
    unmount();
  });

  it('exposes the CONCEPT link control, NOT feature-A\'s "Link" button', () => {
    const {renderer, unmount} = renderCanvas(
      <ConceptCanvas initialGraph={seededGraph()} />,
    );
    // Concept link control present with the concept-specific label.
    expect(hasLabel(renderer, 'Concept link')).toBe(true);
    // Feature-A's bare "Link" top-bar button is ABSENT in concept mode.
    const featureALink = renderer.root.findAll(
      node =>
        typeof node.type === 'string' &&
        node.props.accessibilityLabel === 'Link',
    );
    expect(featureALink.length).toBe(0);
    unmount();
  });

  it('disables Concept link until there are >= 2 nodes', () => {
    // A lone root: linking is impossible (no second node), so the control
    // is disabled.
    const {renderer, unmount} = renderCanvas(
      <ConceptCanvas initialGraph={createGraph('only')} />,
    );
    const pill = findPressable(renderer, 'Concept link');
    expect(pill.props.accessibilityState?.disabled).toBe(true);
    unmount();
  });
});
