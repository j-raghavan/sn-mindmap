/**
 * Edit-mode entry point (§5.4, §F-ED-1..F-ED-7).
 *
 * Mounted when the lasso-toolbar "Edit Mindmap" button (id=200, see
 * index.js + ./pluginRouter.ts) fires. Responsibilities:
 *
 *   1. Call PluginCommAPI.getLassoGeometries() (§F-ED-2).
 *   2. Pass the geometries to ./marker/decode.ts (§F-ED-3).
 *   3. If decode fails: surface the §F-ED-4 banner with the decoder's
 *      reason message and offer a Close button to dismiss the plugin.
 *   4. If decode succeeds: mount MindmapCanvas with the decoded tree
 *      pre-populated (§F-ED-6).
 *   5. On Save (Phase 4.5 / §F-ED-7): translate preserved label
 *      strokes by each node's move delta, then deleteLassoElements →
 *      emit → insert → lasso(unionRect) → closePluginView.
 *
 * Phase 4.3 scope (this revision): steps 1-4 minus preserved-stroke
 * rendering (§F-ED-6 wiring is Phase 4.4) and minus the Save button
 * (§F-ED-7 is Phase 4.5). MindmapCanvas is mounted with
 * isEditMode=true, which hides the Insert button — edit mode is
 * Cancel-only until Save ships. Edits made on this canvas currently
 * discard on Cancel; that's the correct WIP behavior for the gap
 * between Phase 4.3 and Phase 4.5, and matches how the plugin would
 * behave if a user opened edit mode before the save pipeline is
 * wired.
 *
 * Decoder-to-associator data flow (used by Phase 4.4+):
 *   - decodeMarker returns nodeBboxesById in MINDMAP-LOCAL coords
 *     (origin = marker top-left) plus markerOriginPage (page coords).
 *   - The raw lasso strokes are in PAGE coords. Before Phase 4.4 calls
 *     associateStrokes we translate each node bbox into page coords
 *     (add markerOriginPage) so the association happens in a single
 *     shared coordinate system. We stash markerOriginPage here for
 *     that later use.
 */
import React, {useEffect, useState} from 'react';
import {Pressable, StyleSheet, Text, View} from 'react-native';
import {PluginCommAPI, PluginManager} from 'sn-plugin-lib';
import type {Geometry, Point, Rect} from './geometry';
import {decodeMarker} from './marker/decode';
import MindmapCanvas from './MindmapCanvas';
import type {NodeId, Tree} from './model/tree';

/**
 * Local narrow type for sn-plugin-lib's `{success, result}` envelope.
 * The SDK declares return values as the generic `Object` — same
 * shape as ./insert.ts's ApiRes, duplicated here so the two call
 * sites stay self-contained.
 */
type ApiRes<T> =
  | {success: boolean; result?: T; error?: {message?: string}}
  | null
  | undefined;

/**
 * Outer view phases — purely a UI concern, not tied to the decoder's
 * error reasons. The `message` in 'error' is either the API envelope's
 * error string or a §F-ED-4 hint, both already user-suitable.
 */
type Phase =
  | {kind: 'loading'}
  | {kind: 'error'; message: string}
  | {
      kind: 'ready';
      tree: Tree;
      nodeBboxesById: Map<NodeId, Rect>;
      markerOriginPage: Point;
    };

/**
 * §F-ED-4 banner wording for decoder failures. A bare error string
 * from the decoder is enough for devs reading logcat, but on-device
 * we want a hint that tells the user what to do. The decoder's
 * `reason` is exported via its error type so we could pivot on it
 * here, but for Phase 4.3 a single recovery instruction covers every
 * reason — the user's next move is the same regardless of whether
 * the marker was missing, corrupted, or version-mismatched.
 */
const NO_MINDMAP_HINT =
  'No mindmap structure found in this selection. Lasso the full ' +
  'mindmap and try again.';

/**
 * Upstream API failure wording. Distinct from NO_MINDMAP_HINT because
 * the user's action differs: a firmware-level failure is usually
 * transient (retry), whereas decoder failures are a selection error
 * (re-lasso). We surface the envelope's error message alongside the
 * hint so logcat-style diagnosis is still possible on-device.
 */
const LASSO_API_HINT_PREFIX = 'Could not read the lasso selection: ';

export default function EditMindmap(): React.JSX.Element {
  const [phase, setPhase] = useState<Phase>({kind: 'loading'});

  useEffect(() => {
    // React StrictMode double-invokes effects in dev, but on-device
    // the plugin host instantiates the view once and tears it down.
    // A double-fire of getLassoGeometries is harmless (idempotent
    // read), so we don't bother with a ref guard. The `cancelled`
    // flag exists so a StrictMode double-mount doesn't stomp the
    // first effect's setState after the component unmounts.
    let cancelled = false;
    (async () => {
      let res: ApiRes<Geometry[]>;
      try {
        res = (await PluginCommAPI.getLassoGeometries()) as ApiRes<Geometry[]>;
      } catch (err) {
        if (cancelled) {
          return;
        }
        const message = err instanceof Error ? err.message : String(err);
        console.error('[EDIT_MINDMAP] getLassoGeometries threw', err);
        setPhase({kind: 'error', message: LASSO_API_HINT_PREFIX + message});
        return;
      }
      if (cancelled) {
        return;
      }
      if (!res?.success || !Array.isArray(res.result)) {
        const apiMsg = res?.error?.message ?? 'getLassoGeometries failed';
        console.error('[EDIT_MINDMAP] getLassoGeometries not successful', res);
        setPhase({kind: 'error', message: LASSO_API_HINT_PREFIX + apiMsg});
        return;
      }

      const decoded = decodeMarker(res.result);
      if (!decoded.ok) {
        console.warn(
          '[EDIT_MINDMAP] decodeMarker failed',
          decoded.reason,
          decoded.message,
        );
        setPhase({kind: 'error', message: NO_MINDMAP_HINT});
        return;
      }

      setPhase({
        kind: 'ready',
        tree: decoded.tree,
        nodeBboxesById: decoded.nodeBboxesById,
        markerOriginPage: decoded.markerOriginPage,
      });
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  if (phase.kind === 'loading') {
    return (
      <View style={styles.root} accessibilityLabel="edit-mindmap-loading">
        <Text style={styles.title}>Edit Mindmap</Text>
        <Text style={styles.body}>Reading lasso selection…</Text>
      </View>
    );
  }

  if (phase.kind === 'error') {
    return (
      <View style={styles.root} accessibilityLabel="edit-mindmap-error">
        <Text style={styles.title}>Edit Mindmap</Text>
        <Text
          accessibilityLabel="edit-mindmap-error-message"
          style={styles.errorBody}>
          {phase.message}
        </Text>
        <Pressable
          accessibilityRole="button"
          accessibilityLabel="edit-mindmap-close"
          onPress={() => PluginManager.closePluginView()}
          style={({pressed}) => [
            styles.closeBtn,
            pressed && styles.closeBtnPressed,
          ]}>
          <Text style={styles.closeBtnText}>Close</Text>
        </Pressable>
      </View>
    );
  }

  // phase.kind === 'ready'. MindmapCanvas in edit mode hides Insert
  // until the Save path lands in Phase 4.5. Until then, Cancel is
  // the only exit and any edits are discarded — acceptable WIP
  // behavior while §F-ED-7 is under construction.
  return <MindmapCanvas initialTree={phase.tree} isEditMode />;
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
    marginBottom: 32,
    textAlign: 'center',
  },
  errorBody: {
    fontSize: 14,
    color: '#000',
    marginBottom: 32,
    textAlign: 'center',
    maxWidth: 360,
  },
  closeBtn: {
    paddingVertical: 12,
    paddingHorizontal: 32,
    borderRadius: 8,
    borderWidth: 2,
    borderColor: '#000',
  },
  closeBtnPressed: {
    backgroundColor: '#000',
  },
  closeBtnText: {
    fontSize: 16,
    fontWeight: '500',
    color: '#000',
  },
});
