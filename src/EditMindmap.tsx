/**
 * Edit-mode entry point (§5.4, §F-ED-1..F-ED-7).
 *
 * Mounted when the lasso-toolbar "Edit Mindmap" button (id=200, see
 * index.js + ./pluginRouter.ts) fires. Responsibilities:
 *
 *   1. Call PluginCommAPI.getLassoGeometries() (§F-ED-2).
 *   2. Pass the geometries to ../marker/decode.ts (§F-ED-3).
 *   3. If decode fails: surface "No mindmap structure found in this
 *      selection. Lasso the full mindmap and try again." and close
 *      (§F-ED-4).
 *   4. If decode succeeds: associate label strokes to nodes by bbox
 *      via ./model/strokes.ts associateStrokes (§F-ED-5), then mount
 *      MindmapCanvas with the decoded tree pre-populated and the
 *      preserved label strokes shown read-only inside each node
 *      outline (§F-ED-6).
 *   5. On Save: deleteLassoElements -> emitGeometries (with
 *      preserved-stroke translation per §F-ED-7) -> insertGeometry
 *      -> lassoElements(unionRect) -> closePluginView.
 *
 * Phase 4 (§9) builds this in earnest. Phase 0 just stubs the entry
 * point so App.tsx can route to it.
 */
import React from 'react';
import {StyleSheet, Text, View} from 'react-native';

export default function EditMindmap(): React.JSX.Element {
  // Phase 0 placeholder. Phase 4 replaces this with the real
  // edit-mode flow per §5.4 / §F-ED-*.
  return (
    <View style={styles.root}>
      <Text style={styles.title}>Edit Mindmap</Text>
      <Text style={styles.body}>
        Edit flow will appear here (Phase 4).
      </Text>
    </View>
  );
}

const styles = StyleSheet.create({
  root: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    padding: 24,
  },
  title: {
    fontSize: 24,
    fontWeight: '600',
    marginBottom: 12,
  },
  body: {
    fontSize: 14,
    opacity: 0.7,
  },
});
