import React from 'react';
import Canvas from './src/Canvas';
import {installPluginRouter} from './src/pluginRouter';

// Install the router listener eagerly — idempotent, so safe to call from
// both here and index.js. We do it here as well because some test
// harnesses render App.tsx without executing index.js.
installPluginRouter();

// Single entry point (per requirements §7.3 / §14.2):
//
//   id=100 "Mindmap" → Canvas (mode-selecting authoring entry)
//
// Canvas opens the central-idea modal with the Mindmap | Concept map
// toggle (§14.2), then renders MindmapCanvas (§5.1) or ConceptCanvas
// (§14.4) for the chosen document mode. The lasso-toolbar id=200 "Edit
// Mindmap" entry was removed along with the edit/decode pipeline.
export default function App(): React.JSX.Element {
  // Open the mode-selecting central-idea modal per §14.2 (Mindmap |
  // Concept map). The chosen mode is fixed for the document's life and
  // seeds the matching canvas with a labeled root.
  return <Canvas />;
}
