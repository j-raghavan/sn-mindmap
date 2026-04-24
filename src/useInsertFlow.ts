/**
 * useInsertFlow — state + orchestration around the Insert button.
 *
 * Separated from MindmapCanvas (SRP): the canvas renders tree +
 * action icons + top bar; this hook owns the pipeline lifecycle
 * (debounce ref, pending state, transient error-banner timer). The
 * hook never imports React Native components — it's pure state +
 * orchestration — so future tests can drive it without spinning up
 * react-test-renderer.
 *
 * Pipeline semantics:
 *   triggerInsert() — runs insertMindmap. Debounced by insertingRef
 *                     so double-taps during the in-flight window are
 *                     no-ops.
 *
 * Error routing: any insertMindmap rejection shows the transient
 * 2 s error banner. insertMindmap handles its own cleanup internally
 * (replaceElements is atomic), so there is nothing to undo here.
 *
 * v0.1 is insert-only. The Save / re-insert / capacity modal / out-
 * of-map dialog paths were removed along with the edit/decode
 * pipeline.
 */
import {useCallback, useEffect, useRef, useState} from 'react';
import {insertMindmap} from './insert';
import type {Tree} from './model/tree';

/**
 * How long to leave an insert-error banner on screen before auto-
 * dismissing. Matches sn-shapes' ERROR_DISPLAY_MS so the two plugins
 * feel consistent when the user hits an intermittent device-side
 * insert failure.
 */
const INSERT_ERROR_DISPLAY_MS = 2000;

export type UseInsertFlowInput = {
  tree: Tree;
};

export type UseInsertFlowResult = {
  /** True while insertMindmap is in flight — drives button disabled state. */
  isInserting: boolean;
  /** Current transient error banner text; null = no banner. */
  insertError: string | null;
  /** Insert button onPress. */
  triggerInsert: () => Promise<void>;
};

export function useInsertFlow({tree}: UseInsertFlowInput): UseInsertFlowResult {
  const [isInserting, setIsInserting] = useState(false);
  const insertingRef = useRef(false);
  const [insertError, setInsertError] = useState<string | null>(null);
  const errorTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Cleanup the error timer on unmount so the setTimeout closure
  // can't fire a setState against a torn-down hook.
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

  const triggerInsert = useCallback(async () => {
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
      await insertMindmap({tree});
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Insert failed';
      showInsertError(message);
    } finally {
      insertingRef.current = false;
      setIsInserting(false);
    }
  }, [tree, showInsertError]);

  return {isInserting, insertError, triggerInsert};
}
