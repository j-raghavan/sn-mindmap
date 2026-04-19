/**
 * Authoring canvas (§5.1, §F-AC-1..F-AC-8).
 *
 * Full-screen React Native view. Owns only tree topology, node shape
 * assignment (§F-AC-3), connector layout, and the marker. v0.10
 * dropped in-plugin handwriting capture entirely — the canvas does
 * NOT have a per-node handwriting pad; labels are written with the
 * firmware's native pen on the note page AFTER the mindmap is
 * inserted (§4.1 step 6).
 *
 * Per-node affordances (§F-AC-5):
 *   - Add Child (chevron-right, thicker stroke) — "primary"
 *   - Add Sibling (chevron-down, thinner stroke) — hidden on the root
 *   - Collapse/Expand toggle (filled circle / ring with +N) — any
 *     node with ≥ 1 child (§4.2)
 *   - Delete subtree (small × top-right, only on selected node) —
 *     hidden on the root (use Cancel)
 *
 * Top bar (§F-AC-8): Cancel | Insert. Insert is always enabled
 * because the tree always has ≥ 1 node (§F-AC-8 — no committed-
 * strokes precondition since the plugin does not own labels).
 *
 * On Insert tap this component hands off to ./insert.ts.
 *
 * Phase 1 (§9) builds this component incrementally: tree + layout
 * first, then mutation UI, then pan/zoom. No insert, no marker, no
 * edit round-trip until Phase 2/3/4.
 */
import React from 'react';
import {StyleSheet, Text, View} from 'react-native';

export type MindmapCanvasProps = {
  /**
   * Optional preloaded tree for the edit round-trip (§F-ED-6). On
   * first-open this is undefined and the component creates a fresh
   * tree with just the root Oval.
   */
  initialTree?: import('./model/tree').Tree;
};

export default function MindmapCanvas(
  _props: MindmapCanvasProps = {},
): React.JSX.Element {
  // Phase 0 placeholder. Phase 1 replaces this with the real
  // authoring canvas per §5.1 / §F-AC-*.
  return (
    <View style={styles.root}>
      <Text style={styles.title}>Mindmap</Text>
      <Text style={styles.body}>
        Authoring canvas will appear here (Phase 1).
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
