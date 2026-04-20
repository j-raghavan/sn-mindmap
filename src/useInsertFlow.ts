/**
 * useInsertFlow — single source of truth for every piece of state the
 * authoring-canvas Insert button and the edit-canvas Save button
 * share.
 *
 * Splitting this out of MindmapCanvas follows SRP: the canvas renders
 * tree + action icons + the top bar; the pipeline lifecycle (debounce
 * ref, pending state, transient-error banner timer, persistent
 * capacity modal, pre-Save out-of-map confirmation) belongs with the
 * flow logic. Before this hook, MindmapCanvas held ~15 useState /
 * useRef / useCallback calls dedicated to the pipeline alongside tree
 * / selection / viewport state — two concerns tangled in one file.
 *
 * The hook intentionally exposes the dialog-visibility flags plus the
 * primary-action callbacks as a flat object; callers render the
 * dialogs themselves (via ConfirmDialog) and hand the hook the tree +
 * preEdit + outOfMap inputs. The hook never imports React Native
 * components — it's pure state + orchestration — so a future test
 * harness can drive it without spinning up react-test-renderer.
 *
 * Pipeline semantics (kept byte-identical to the pre-extraction
 * inline code so MindmapCanvas.test.tsx keeps passing without a
 * churn):
 *
 *   triggerInsert() — first-insert path (§F-IN-*). Runs immediately.
 *   triggerSave()   — re-insert path (§F-ED-7). If outOfMapCount > 0
 *                     it opens the save-confirm dialog; otherwise
 *                     runs immediately with preEdit attached.
 *   confirmSave()   — "Save anyway" from the save-confirm dialog.
 *   cancelSave()    — "Cancel" / backdrop tap from the save-confirm
 *                     dialog; does NOT close the plugin view.
 *   acknowledgeCapacity() — "OK" from the §F-PE-4 capacity modal.
 *
 * Error routing:
 *   - MarkerCapacityError → capacity modal (persistent); plugin view
 *     stays open so the user can reduce nodes.
 *   - Any other Error → transient 2 s insert-error banner (§F-IN-5).
 *
 * insertingRef debounces rapid double-taps from both Insert and Save
 * because the underlying insertMindmap pipeline isn't re-entrant —
 * two parallel runs would step on each other's partial-insert
 * cleanup. The ref is the same pattern sn-shapes/ShapePalette.tsx
 * uses.
 */
import {useCallback, useEffect, useRef, useState} from 'react';
import {insertMindmap, type PreEditContext} from './insert';
import {MarkerCapacityError} from './marker/encode';
import type {Tree} from './model/tree';
import type {OutOfMapStrokes} from './model/strokes';

/**
 * How long to leave an insert-error banner on screen before auto-
 * dismissing. Matches sn-shapes' ERROR_DISPLAY_MS so the two plugins
 * feel consistent when the user hits an intermittent device-side
 * insert failure.
 */
const INSERT_ERROR_DISPLAY_MS = 2000;

export type UseInsertFlowInput = {
  tree: Tree;
  /**
   * Only supplied by edit mode (§F-ED-7). When present, Save runs
   * deleteLassoElements + re-emit; when absent (authoring or defensive
   * edit mode), the pipeline behaves like a first-insert.
   */
  preEdit?: PreEditContext;
  /**
   * Strokes whose centroid fell outside every node's bbox during
   * §F-ED-5 association. When non-empty, Save opens the pre-commit
   * confirmation dialog first; empty or omitted → Save proceeds.
   */
  outOfMapStrokes?: OutOfMapStrokes;
};

export type UseInsertFlowResult = {
  /** True while insertMindmap is in flight — drives button disabled state. */
  isInserting: boolean;
  /** Current transient error banner text (§F-IN-5); null = no banner. */
  insertError: string | null;
  /** True while the §F-PE-4 capacity modal is open. */
  capacityModalOpen: boolean;
  /** True while the §8.1 pre-Save out-of-map dialog is open. */
  saveConfirmOpen: boolean;
  /** Count of out-of-map strokes — shown in the confirmation dialog body. */
  outOfMapCount: number;
  /** Insert button onPress — authoring flow (§F-IN-*). */
  triggerInsert: () => Promise<void>;
  /**
   * Save button onPress (§F-ED-7). Opens the save-confirm dialog when
   * outOfMapCount > 0; otherwise runs the pipeline directly.
   */
  triggerSave: () => Promise<void>;
  /** OK button in the capacity modal. Dismisses without retrying. */
  acknowledgeCapacity: () => void;
  /** "Save anyway" primary button in the save-confirm dialog. */
  confirmSave: () => Promise<void>;
  /** "Cancel" / backdrop tap in the save-confirm dialog. */
  cancelSave: () => void;
};

export function useInsertFlow({
  tree,
  preEdit,
  outOfMapStrokes,
}: UseInsertFlowInput): UseInsertFlowResult {
  const [isInserting, setIsInserting] = useState(false);
  const insertingRef = useRef(false);
  const [insertError, setInsertError] = useState<string | null>(null);
  const errorTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Cleanup the error timer on unmount so the setTimeout closure
  // can't fire a setState against a torn-down hook. Matches
  // ShapePalette.tsx's discipline and is the right shape for React
  // 19's strict unmount semantics.
  useEffect(() => {
    return () => {
      if (errorTimerRef.current) {
        clearTimeout(errorTimerRef.current);
      }
    };
  }, []);

  const showInsertError = useCallback((msg: string) => {
    setInsertError(msg);
    if (errorTimerRef.current) {
      clearTimeout(errorTimerRef.current);
    }
    errorTimerRef.current = setTimeout(
      () => setInsertError(null),
      INSERT_ERROR_DISPLAY_MS,
    );
  }, []);

  const [capacityModalOpen, setCapacityModalOpen] = useState(false);
  const acknowledgeCapacity = useCallback(() => {
    setCapacityModalOpen(false);
  }, []);

  /**
   * Route a caught error from insertMindmap to the correct UI
   * surface. MarkerCapacityError → persistent capacity modal
   * (§F-PE-4); everything else → the transient 2 s error banner
   * (§F-IN-5). Centralised so the Insert and Save paths can't drift
   * apart — both must show the same modal for the same capacity
   * failure, and both must keep the plugin view open so the user can
   * reduce nodes.
   */
  const handleInsertError = useCallback(
    (err: unknown) => {
      if (err instanceof MarkerCapacityError) {
        setCapacityModalOpen(true);
        return;
      }
      const message = err instanceof Error ? err.message : 'Insert failed';
      showInsertError(message);
    },
    [showInsertError],
  );

  /**
   * Core pipeline runner shared by Insert and Save. `attachPreEdit`
   * controls whether insertMindmap sees a preEdit context (Save) or
   * not (Insert). The insertingRef short-circuit covers double-taps
   * from either button; the pending isInserting state is what drives
   * the visible "Inserting…" / "Saving…" label on the button.
   */
  const runPipeline = useCallback(
    async (attachPreEdit: boolean) => {
      if (insertingRef.current) {
        return;
      }
      insertingRef.current = true;
      setIsInserting(true);
      setInsertError(null);
      if (errorTimerRef.current) {
        clearTimeout(errorTimerRef.current);
        errorTimerRef.current = null;
      }
      try {
        await insertMindmap({
          tree,
          preEdit: attachPreEdit ? preEdit : undefined,
        });
      } catch (err) {
        handleInsertError(err);
      } finally {
        insertingRef.current = false;
        setIsInserting(false);
      }
    },
    [tree, preEdit, handleInsertError],
  );

  const triggerInsert = useCallback(() => runPipeline(false), [runPipeline]);

  const [saveConfirmOpen, setSaveConfirmOpen] = useState(false);
  const outOfMapCount = outOfMapStrokes?.length ?? 0;

  /**
   * Save tap handler. If any out-of-map strokes were carried through
   * from the associator (§8.1), open the confirmation dialog instead
   * of running the pipeline; the user's subsequent "Save anyway" tap
   * calls confirmSave. Otherwise run the pipeline directly for the
   * common no-out-of-map case.
   */
  const triggerSave = useCallback(async () => {
    if (insertingRef.current) {
      return;
    }
    if (outOfMapCount > 0) {
      setSaveConfirmOpen(true);
      return;
    }
    await runPipeline(true);
  }, [outOfMapCount, runPipeline]);

  /**
   * "Save anyway" from the out-of-map dialog — closes the dialog,
   * drops the out-of-map strokes implicitly (they were never routed
   * into the preEdit bucket to begin with) and runs the pipeline.
   */
  const confirmSave = useCallback(async () => {
    setSaveConfirmOpen(false);
    await runPipeline(true);
  }, [runPipeline]);

  /**
   * "Cancel" from the out-of-map dialog — or tap-outside on the
   * backdrop. Just closes the dialog; the plugin view stays open so
   * the user can tap the top-bar Cancel to close the plugin entirely
   * and re-lasso including the missed strokes. Intentional: we do
   * NOT closePluginView from here because the user might simply want
   * to make more topology edits first, then Save again.
   */
  const cancelSave = useCallback(() => {
    setSaveConfirmOpen(false);
  }, []);

  return {
    isInserting,
    insertError,
    capacityModalOpen,
    saveConfirmOpen,
    outOfMapCount,
    triggerInsert,
    triggerSave,
    acknowledgeCapacity,
    confirmSave,
    cancelSave,
  };
}
