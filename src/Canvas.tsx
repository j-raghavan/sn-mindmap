/**
 * Top-level authoring entry point. Owns the §14.2 document-mode choice
 * and routes to the right canvas:
 *
 *   - The central-idea modal opens on a fresh session (it always has,
 *     §F-AC-2) and now carries a two-option mode toggle:
 *       Mindmap      → <MindmapCanvas> seeded with createTree(label)
 *       Concept map  → <ConceptCanvas> seeded with createGraph(label)
 *   - Mode is FIXED for the life of the document (§14.2): the toggle
 *     only appears in this initial modal, before either canvas mounts.
 *
 * Why a wrapper rather than a toggle inside MindmapCanvas's own modal:
 * MindmapCanvas owns its central-idea modal and must stay byte-identical
 * (its existing tests render <MindmapCanvas/> bare). Putting the mode
 * choice in a thin wrapper keeps MindmapCanvas (and useLinkMode, and the
 * mindmap render path) completely untouched, while ConceptCanvas is its
 * own sibling component. Both canvases receive an ALREADY-labeled root,
 * so neither re-opens its own label modal (MindmapCanvas only
 * auto-prompts when the root is unlabeled).
 *
 * Deferred per §14.2: the runtime "Mindmap | Concept" segmented control
 * in the top bar (mid-session switching). This wrapper ships the modal
 * toggle only.
 */
import React, {useEffect, useMemo, useState} from 'react';
import {Pressable, StyleSheet, Text, TextInput, View} from 'react-native';
import {PluginManager} from 'sn-plugin-lib';
import MindmapCanvas from './MindmapCanvas';
import ConceptCanvas from './ConceptCanvas';
import {createTree} from './model/tree';
import {createGraph} from './model/graph';

/** The two document modes selectable in the central-idea modal (§14.2). */
type DocMode = 'mindmap' | 'concept';

/** Chosen document — drives which canvas renders once the modal commits. */
type Document =
  | {mode: 'mindmap'; label: string}
  | {mode: 'concept'; label: string};

export type CanvasProps = {
  /**
   * Skip the mode modal and render a specific mode directly. Used by
   * tests (and a future "open existing document" path). When omitted the
   * mode-selecting central-idea modal opens on mount.
   */
  initialDocument?: Document;
};

export default function Canvas({
  initialDocument,
}: CanvasProps = {}): React.JSX.Element {
  const [doc, setDoc] = useState<Document | null>(initialDocument ?? null);

  if (doc === null) {
    return <ModeModal onCreate={setDoc} />;
  }
  if (doc.mode === 'concept') {
    return <ConceptCanvas initialGraph={createGraph(doc.label)} />;
  }
  return <MindmapCanvas initialTree={createTree(doc.label)} />;
}

/**
 * The mode-selecting central-idea modal (§14.2). A label input plus a
 * two-option segmented toggle (Mindmap | Concept map). Create is disabled
 * until the label is non-empty, mirroring MindmapCanvas's own modal.
 */
function ModeModal({
  onCreate,
}: {
  onCreate: (doc: Document) => void;
}): React.JSX.Element {
  const [draft, setDraft] = useState('');
  const [mode, setMode] = useState<DocMode>('mindmap');

  // Defensive: reset to the default mode whenever the modal remounts so a
  // stale selection can't leak across sessions.
  useEffect(() => {
    setMode('mindmap');
  }, []);

  const trimmed = draft.trim();
  const canCreate = useMemo(() => trimmed.length > 0, [trimmed]);

  return (
    <View style={styles.root}>
      <View
        style={styles.modalOverlay}
        pointerEvents="box-none"
        accessibilityViewIsModal>
        <View
          style={styles.modalBackdrop}
          accessibilityLabel="mode-modal-backdrop"
        />
        <View
          accessibilityLabel="mode-modal"
          accessibilityRole="alert"
          style={styles.modalCard}>
          <Text style={styles.modalTitle}>Central idea</Text>

          {/* Mode toggle — two Pressables acting as a segmented control. */}
          <View style={styles.segmented}>
            <Pressable
              accessibilityRole="button"
              accessibilityLabel="mode-mindmap"
              accessibilityState={{selected: mode === 'mindmap'}}
              onPress={() => setMode('mindmap')}
              style={[
                styles.segment,
                styles.segmentLeft,
                mode === 'mindmap' && styles.segmentSelected,
              ]}>
              <Text
                style={[
                  styles.segmentText,
                  mode === 'mindmap' && styles.segmentTextSelected,
                ]}>
                Mindmap
              </Text>
            </Pressable>
            <Pressable
              accessibilityRole="button"
              accessibilityLabel="mode-concept"
              accessibilityState={{selected: mode === 'concept'}}
              onPress={() => setMode('concept')}
              style={[
                styles.segment,
                styles.segmentRight,
                mode === 'concept' && styles.segmentSelected,
              ]}>
              <Text
                style={[
                  styles.segmentText,
                  mode === 'concept' && styles.segmentTextSelected,
                ]}>
                Concept map
              </Text>
            </Pressable>
          </View>

          <TextInput
            accessibilityLabel="label-input"
            style={styles.modalInput}
            value={draft}
            onChangeText={setDraft}
            autoFocus
            placeholder="Type or write a label"
            multiline
            textAlignVertical="top"
          />
          <View style={styles.modalRow}>
            <Pressable
              accessibilityRole="button"
              accessibilityLabel="mode-cancel"
              onPress={() => PluginManager.closePluginView()}
              style={({pressed}) => [
                styles.modalBtn,
                styles.modalBtnSecondary,
                pressed && styles.modalBtnPressed,
              ]}>
              <Text style={styles.modalBtnText}>Cancel</Text>
            </Pressable>
            <Pressable
              accessibilityRole="button"
              accessibilityLabel="mode-create"
              accessibilityState={{disabled: !canCreate}}
              disabled={!canCreate}
              onPress={() => onCreate({mode, label: trimmed})}
              style={({pressed}) => [
                styles.modalBtn,
                styles.modalBtnPrimary,
                pressed && canCreate && styles.modalBtnPressed,
                !canCreate && styles.modalBtnDisabled,
              ]}>
              <Text
                style={[
                  styles.modalBtnText,
                  styles.modalBtnTextOnPrimary,
                  !canCreate && styles.modalBtnTextDisabled,
                ]}>
                Create
              </Text>
            </Pressable>
          </View>
        </View>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  root: {flex: 1, backgroundColor: '#fff'},
  modalOverlay: {
    ...StyleSheet.absoluteFillObject,
    alignItems: 'center',
    justifyContent: 'center',
  },
  modalBackdrop: {
    ...StyleSheet.absoluteFillObject,
    backgroundColor: 'rgba(0,0,0,0.3)',
  },
  modalCard: {
    width: '80%',
    backgroundColor: '#fff',
    borderRadius: 10,
    padding: 20,
    borderWidth: 1,
    borderColor: '#ccc',
  },
  modalTitle: {
    fontSize: 18,
    fontWeight: '700',
    color: '#111',
    marginBottom: 12,
  },
  segmented: {
    flexDirection: 'row',
    marginBottom: 12,
  },
  segment: {
    flex: 1,
    paddingVertical: 10,
    alignItems: 'center',
    borderWidth: 1,
    borderColor: '#333',
  },
  segmentLeft: {borderTopLeftRadius: 6, borderBottomLeftRadius: 6},
  segmentRight: {
    borderTopRightRadius: 6,
    borderBottomRightRadius: 6,
    borderLeftWidth: 0,
  },
  segmentSelected: {backgroundColor: '#111'},
  segmentText: {fontSize: 16, color: '#111'},
  segmentTextSelected: {color: '#fff'},
  modalInput: {
    borderWidth: 1,
    borderColor: '#999',
    borderRadius: 6,
    padding: 10,
    fontSize: 16,
    color: '#111',
    minHeight: 44,
  },
  modalRow: {
    flexDirection: 'row',
    justifyContent: 'flex-end',
    marginTop: 16,
  },
  modalBtn: {
    paddingHorizontal: 18,
    paddingVertical: 10,
    borderRadius: 6,
    marginLeft: 10,
    borderWidth: 1,
    borderColor: '#333',
  },
  modalBtnSecondary: {backgroundColor: '#fff'},
  modalBtnPrimary: {backgroundColor: '#111', borderColor: '#111'},
  modalBtnPressed: {opacity: 0.7},
  modalBtnDisabled: {backgroundColor: '#eee', borderColor: '#ccc'},
  modalBtnText: {fontSize: 16, color: '#111'},
  modalBtnTextOnPrimary: {color: '#fff'},
  modalBtnTextDisabled: {color: '#999'},
});
