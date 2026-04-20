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
 * Phase 4.4 scope (this revision): steps 1-4 plus in-map
 * preserved-stroke routing (§F-ED-5) and rendering (§F-ED-6). The
 * Save button is still gated — §F-ED-7 lands in Phase 4.5. Until
 * then, MindmapCanvas is mounted with isEditMode=true, which hides
 * Insert; edit mode is Cancel-only and any topology edits are
 * discarded on Cancel. That's the correct WIP behavior for the gap
 * between Phase 4.4 and Phase 4.5, and matches how the plugin would
 * behave if a user opened edit mode before the save pipeline is
 * wired.
 *
 * Decoder-to-associator data flow (Phase 4.4):
 *   1. decodeMarker returns nodeBboxesById in MINDMAP-LOCAL coords
 *      (origin = marker top-left) plus markerOriginPage (page coords).
 *   2. The raw lasso strokes are in PAGE coords. Before we call
 *      associateStrokes we translate each node bbox into page coords
 *      (add markerOriginPage) so the association happens in a single
 *      shared coordinate system (§8.1).
 *   3. associateStrokes returns {byNode, outOfMap}. Each stroke in a
 *      bucket is still in PAGE coords at this point.
 *   4. For rendering in MindmapCanvas we convert each bucket to
 *      NODE-LOCAL coords by translating by -nodeBboxPage.topLeft.
 *      That way the canvas can anchor strokes to the node's current
 *      radial-layout bbox, so strokes visually follow the node as
 *      the user edits topology (§F-ED-6 "follow node position").
 *   5. outOfMap is forwarded through to MindmapCanvas unchanged —
 *      Phase 4.6 surfaces those in a pre-Save confirmation dialog.
 *
 * The pre-edit page-coord bboxes (markerOriginPage-shifted) and the
 * original byNode strokes (pre-to-node-local) both live in state
 * because Phase 4.5 Save needs them to compute per-node move delta
 * and translate strokes back into post-edit page coords. Keeping them
 * here rather than fanning them back out of MindmapCanvas on Save is
 * simpler: EditMindmap already owns the cross-coord-system knowledge.
 */
import React, {useEffect, useState} from 'react';
import {Pressable, StyleSheet, Text, View} from 'react-native';
import {PluginCommAPI, PluginManager} from 'sn-plugin-lib';
import type {Geometry, Point, Rect} from './geometry';
import {decodeMarker} from './marker/decode';
import MindmapCanvas from './MindmapCanvas';
import type {NodeId, Tree} from './model/tree';
import {
  associateStrokes,
  translateStrokes,
  type OutOfMapStrokes,
  type StrokeBucket,
} from './model/strokes';

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
      /**
       * Decoder-reported bboxes per node, MINDMAP-LOCAL coords
       * (origin = marker top-left). Kept here alongside the
       * page-projected copy so Phase 4.5 Save can read either frame
       * without recomputing.
       */
      nodeBboxesById: Map<NodeId, Rect>;
      markerOriginPage: Point;
      /**
       * Page-coord projection of nodeBboxesById (each bbox shifted by
       * markerOriginPage). Used for §8.1 association above; held for
       * Phase 4.5 Save, which computes per-node move delta as
       * `postEditBboxPage.topLeft − preEditBboxPage.topLeft` and
       * translateStrokes with that delta before re-emitting.
       */
      pageBboxesById: Map<NodeId, Rect>;
      /**
       * Preserved label strokes bucketed by node, in PAGE COORDS —
       * the raw output of associateStrokes. Phase 4.5 reads these
       * for translate-then-emit; we keep the page-coord form in state
       * so Save doesn't have to un-do the to-node-local render
       * conversion.
       */
      preservedStrokesByNodePage: StrokeBucket;
      /**
       * The same stroke bucket, but each stroke translated into
       * NODE-LOCAL coords (offset from its node's pre-edit page-coord
       * bbox top-left). This is what MindmapCanvas expects for
       * §F-ED-6 render anchoring.
       */
      preservedStrokesByNodeLocal: StrokeBucket;
      /**
       * §8.1 out-of-map bucket. Phase 4.6 surfaces these in a
       * pre-Save confirmation dialog; we forward them to MindmapCanvas
       * now so the later dialog has the data on hand.
       */
      outOfMapStrokes: OutOfMapStrokes;
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

      // Project decoder-reported bboxes from mindmap-local (origin =
      // marker top-left) into page coords so association and raw
      // lasso strokes live in the same frame (§8.1 / §F-ED-5).
      const pageBboxesById = projectBboxesToPage(
        decoded.nodeBboxesById,
        decoded.markerOriginPage,
      );
      // Associate every lasso stroke to at most one node; strokes
      // whose centroid fell outside every bbox land in outOfMap.
      // associateStrokes preserves stroke order within each bucket
      // (stable, deterministic — important for re-emit on Save).
      const association = associateStrokes(res.result, pageBboxesById);
      // Convert the in-map buckets to node-local coords (strokes
      // offset from their node's pre-edit bbox top-left). This is the
      // coord frame MindmapCanvas expects — its §F-ED-6 render path
      // anchors each stroke to the node's CURRENT radial-layout bbox
      // so strokes follow the node when the user adds/removes
      // children.
      const preservedStrokesByNodeLocal = toNodeLocalBucket(
        association.byNode,
        pageBboxesById,
      );

      setPhase({
        kind: 'ready',
        tree: decoded.tree,
        nodeBboxesById: decoded.nodeBboxesById,
        markerOriginPage: decoded.markerOriginPage,
        pageBboxesById,
        preservedStrokesByNodePage: association.byNode,
        preservedStrokesByNodeLocal,
        outOfMapStrokes: association.outOfMap,
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
  //
  // Phase 4.4: we also pass preserved label strokes (node-local for
  // the canvas's render path) and the out-of-map bucket (held for
  // Phase 4.6's pre-Save confirmation dialog).
  return (
    <MindmapCanvas
      initialTree={phase.tree}
      isEditMode
      initialPreservedStrokes={phase.preservedStrokesByNodeLocal}
      initialOutOfMapStrokes={phase.outOfMapStrokes}
    />
  );
}

/**
 * Shift every bbox in `bboxes` from mindmap-local (origin = marker
 * top-left) into page coords by adding `markerOrigin`. Width and
 * height are invariant. Returns a new Map in insertion order — the
 * decoder builds nodeBboxesById in BFS order, and associateStrokes
 * relies on that order for its §8.1 point-mass tie-break, so we
 * preserve it here.
 */
function projectBboxesToPage(
  bboxes: Map<NodeId, Rect>,
  markerOrigin: Point,
): Map<NodeId, Rect> {
  const m = new Map<NodeId, Rect>();
  for (const [id, b] of bboxes) {
    m.set(id, {
      x: b.x + markerOrigin.x,
      y: b.y + markerOrigin.y,
      w: b.w,
      h: b.h,
    });
  }
  return m;
}

/**
 * Translate each stroke in every bucket so its coordinates are
 * relative to its owning node's page-coord bbox top-left (i.e.
 * "node-local" offsets). MindmapCanvas composes these offsets with
 * its current radial-layout bbox top-left at render time, so strokes
 * track the node through topology edits.
 *
 * If a bucket key isn't in `pageBboxesById` (shouldn't happen with
 * current associateStrokes, but defensive against future mismatches)
 * that bucket is skipped silently — the strokes are lost to the
 * render, but Phase 4.5 still has the page-coord copy in state and
 * can recover them for Save.
 */
function toNodeLocalBucket(
  byNodePage: StrokeBucket,
  pageBboxesById: Map<NodeId, Rect>,
): StrokeBucket {
  const m: StrokeBucket = new Map();
  for (const [id, strokes] of byNodePage) {
    const bbox = pageBboxesById.get(id);
    if (!bbox) {
      continue;
    }
    m.set(id, translateStrokes(strokes, {x: -bbox.x, y: -bbox.y}));
  }
  return m;
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
