import React from 'react';
import MindmapCanvas from './src/MindmapCanvas';
import {installPluginRouter} from './src/pluginRouter';

// Install the router listener eagerly — idempotent, so safe to call from
// both here and index.js. We do it here as well because some test
// harnesses render App.tsx without executing index.js.
installPluginRouter();

// Single entry point (per requirements §7.3):
//
//   id=100 "Mindmap" → MindmapCanvas (authoring canvas, §5.1)
//
// The lasso-toolbar id=200 "Edit Mindmap" entry was removed along
// with the edit/decode pipeline.
export default function App(): React.JSX.Element {
  // Open the authoring canvas on a bare tree per §F-AC-2 (single
  // root Oval at logical origin, empty, no placeholder label). The
  // user drives the rest of the topology via Add Child / Add Sibling
  // (§F-AC-5); MindmapCanvas's reducer seed calls createTree() when
  // no initialTree prop is passed.
  return <MindmapCanvas />;
}
