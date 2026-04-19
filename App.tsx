import React, {useEffect, useState} from 'react';
import EditMindmap from './src/EditMindmap';
import MindmapCanvas from './src/MindmapCanvas';
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

  useEffect(() => {
    return subscribeToButtonEvents(event => {
      setView(viewForButtonId(event.id));
    });
  }, []);

  if (view === 'edit') {
    return <EditMindmap />;
  }

  // Default: toolbar "Mindmap" (id=100) or unknown — open the
  // authoring canvas on a bare tree per §F-AC-2 (single root Oval at
  // logical origin, empty, no placeholder label). The user drives
  // the rest of the topology via Add Child / Add Sibling (§F-AC-5);
  // MindmapCanvas's reducer seed calls createTree() when no
  // initialTree prop is passed.
  return <MindmapCanvas />;
}
