import React, {useEffect, useMemo, useState} from 'react';
import EditMindmap from './src/EditMindmap';
import MindmapCanvas from './src/MindmapCanvas';
import {addChild, addSibling, createTree, type Tree} from './src/model/tree';
import {
  BUTTON_ID_EDIT_MINDMAP,
  BUTTON_ID_TOOLBAR,
  getLastButtonEvent,
  installPluginRouter,
  subscribeToButtonEvents,
} from './src/pluginRouter';

// Install the router listener eagerly — idempotent, so safe to call from
// both here and index.js. We do it here as well because some test
// harnesses render App.tsx without executing index.js; production order
// is: index.js → PluginManager.init → installPluginRouter → button
// registration → AppRegistry.registerComponent → App is instantiated →
// useEffect fires → listener confirmed installed.
installPluginRouter();

// §7.2 defines two entry points, each mapped to its own top-level view:
//
//   id=100 "Mindmap"       → MindmapCanvas (authoring canvas, §5.1)
//   id=200 "Edit Mindmap"  → EditMindmap   (edit round-trip,   §5.4)
//
// The pattern mirrors the previous two-view sn-shapes App.tsx that was
// removed on 2026-04-18 (see sn-shapes git history, commit 1af6110).
type ActiveView = 'authoring' | 'edit';

function viewForButtonId(id: number | undefined): ActiveView {
  // Explicit switch (rather than a ternary that only checks one id) so
  // both §7.2 constants appear at the decision site — keeps the
  // route table greppable and makes it a compile-time error if the
  // ids ever drift out of the pluginRouter source of truth.
  switch (id) {
    case BUTTON_ID_EDIT_MINDMAP:
      return 'edit';
    case BUTTON_ID_TOOLBAR:
    default:
      return 'authoring';
  }
}

/**
 * Build a small hand-coded demo tree for on-device testing of
 * Phase 1.4a. Shape assignment follows §F-AC-3:
 *   - root is OVAL (from createTree)
 *   - addChild(parent) → RECTANGLE child
 *   - addSibling(pivot) → ROUNDED_RECTANGLE sibling
 *
 * Topology (unbalanced so §F-LY-3's leaf-count slice math is
 * visible on-device):
 *
 *              root (Oval)
 *              /    |    \
 *         ideas  tasks   notes
 *          / \     |       |
 *      A  B-sib   T1     (leaf)
 *                 |
 *                T2
 *
 * Replaced by the real tree reducer in Phase 1.4b; until then this
 * fixture exists solely so the on-device APK renders something
 * non-trivial when the toolbar Mindmap button is tapped.
 */
function buildDemoTree(): Tree {
  const tree = createTree();
  const ideas = addChild(tree, tree.rootId);
  const tasks = addChild(tree, tree.rootId);
  addChild(tree, tree.rootId); // "notes" — leaf
  addChild(tree, ideas); // "A"
  addSibling(tree, ideas); // "B-sib" — sibling of "ideas" under root.
  const t1 = addChild(tree, tasks);
  addChild(tree, t1); // "T2"
  return tree;
}

export default function App(): React.JSX.Element {
  // Lazy initial state reads the router's cached "last event" synchronously
  // so the first render picks the right view. This matters because
  // sn-plugin-lib replays the button event to newly-registered listeners
  // inside its 1-second cache window, but that replay fires asynchronously
  // — without this lazy read we'd flicker the authoring canvas before
  // switching to edit.
  const [view, setView] = useState<ActiveView>(() =>
    viewForButtonId(getLastButtonEvent()?.id),
  );

  // Build the demo tree once per App mount. Phase 1.4b will replace
  // this with a real reducer state.
  const demoTree = useMemo(() => buildDemoTree(), []);

  useEffect(() => {
    return subscribeToButtonEvents(event => {
      setView(viewForButtonId(event.id));
    });
  }, []);

  if (view === 'edit') {
    return <EditMindmap />;
  }

  // Default: toolbar "Mindmap" (id=100) or unknown — show the authoring
  // canvas.
  return <MindmapCanvas initialTree={demoTree} />;
}
