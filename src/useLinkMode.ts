/**
 * useLinkMode — state + orchestration for DAG "Link mode" (§F-DAG-3).
 *
 * Separated from MindmapCanvas (SRP), mirroring useInsertFlow: the
 * canvas renders the tree + toolbar + overlay; this hook owns the
 * link-authoring lifecycle — arm/disarm, the two-tap source→target
 * selection, and the transient reject-banner timer (with cleanup on
 * unmount). The hook never imports React Native components — it's pure
 * state + orchestration — so it can be unit-tested without a renderer.
 *
 * Interaction (the two-tap idiom, like Clear's confirm):
 *   IDLE ──toggleArm──▶ ARMED (no source)
 *   ARMED ──selectForLink(N)──▶ ARMED (source = N)
 *   ARMED(source N) ──selectForLink(N again)──▶ ARMED (source cleared)
 *   ARMED(source N) ──selectForLink(M≠N)──▶ validateCrossEdge(N,M):
 *        ok     → onAddLink(N,M); reset to IDLE
 *        reject → showLinkError(reason); reset to IDLE (banner persists)
 *   ARMED ──toggleArm──▶ IDLE (cancel)
 *
 * Validation is delegated to the model's validateCrossEdge against the
 * CURRENT tree — single source of truth, no rule duplication. onAddLink
 * dispatches ADD_LINK, which re-runs addCrossEdge on the cloned tree in
 * the reducer (a cheap second validate over a ≤50-node graph).
 */
import {useCallback, useEffect, useRef, useState} from 'react';
import {
  validateCrossEdge,
  type CrossEdgeRejection,
  type NodeId,
  type Tree,
} from './model/tree';

/**
 * How long to leave a link-reject banner on screen before auto-
 * dismissing. Matches useInsertFlow's INSERT_ERROR_DISPLAY_MS so the
 * two transient banners feel consistent on-device.
 */
const LINK_ERROR_DISPLAY_MS = 2000;

/**
 * Human-readable banner text per typed rejection reason (§F-DAG-3-FR3).
 * Kept exhaustive over CrossEdgeRejection so a future reason forces a
 * message here (TypeScript flags a missing key via the Record type).
 */
const LINK_ERROR_MESSAGES: Record<CrossEdgeRejection, string> = {
  'self-loop': "Can't link a node to itself.",
  'tree-edge': 'That link already exists as a branch.',
  duplicate: 'That link already exists.',
  cycle: 'That link would create a cycle.',
};

export type UseLinkModeInput = {
  /** Current tree — validation runs against this (single source of truth). */
  tree: Tree;
  /** Dispatch an accepted link into the reducer (ADD_LINK). */
  onAddLink: (from: NodeId, to: NodeId) => void;
};

export type UseLinkModeResult = {
  /** True while link mode is armed — drives toolbar + overlay affordances. */
  isArmed: boolean;
  /** Selected source node while armed (awaiting target); null otherwise. */
  sourceId: NodeId | null;
  /** Current transient reject-banner text; null = no banner. */
  linkError: string | null;
  /** Link toolbar button onPress — arms / disarms (toggle). */
  toggleArm: () => void;
  /** Node tap while armed — selects source, then target. No-op when idle. */
  selectForLink: (nodeId: NodeId) => void;
  /** Force back to idle (e.g. on Clear / insert). Leaves the banner up. */
  reset: () => void;
};

export function useLinkMode({
  tree,
  onAddLink,
}: UseLinkModeInput): UseLinkModeResult {
  const [isArmed, setIsArmed] = useState(false);
  const [sourceId, setSourceId] = useState<NodeId | null>(null);
  const [linkError, setLinkError] = useState<string | null>(null);
  const errorTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Cleanup the error timer on unmount so the setTimeout closure can't
  // fire a setState against a torn-down hook (mirrors useInsertFlow).
  useEffect(() => {
    return () => {
      if (errorTimerRef.current) {
        clearTimeout(errorTimerRef.current);
      }
    };
  }, []);

  const showLinkError = useCallback((reason: CrossEdgeRejection) => {
    setLinkError(LINK_ERROR_MESSAGES[reason]);
    if (errorTimerRef.current) {
      clearTimeout(errorTimerRef.current);
    }
    errorTimerRef.current = setTimeout(
      () => setLinkError(null),
      LINK_ERROR_DISPLAY_MS,
    );
  }, []);

  // Back to idle: drop armed + source, but KEEP linkError so the user
  // still sees why a rejected link failed after the mode disarms.
  const reset = useCallback(() => {
    setIsArmed(false);
    setSourceId(null);
  }, []);

  const toggleArm = useCallback(() => {
    setIsArmed(prev => !prev);
    setSourceId(null);
  }, []);

  const selectForLink = useCallback(
    (nodeId: NodeId) => {
      if (!isArmed) {
        return; // taps while idle are not link selections
      }
      if (sourceId === null) {
        setSourceId(nodeId); // first tap — pick the source
        return;
      }
      if (sourceId === nodeId) {
        setSourceId(null); // re-tap the source — cancel the selection
        return;
      }
      // Second tap on a different node — validate the candidate link.
      const result = validateCrossEdge(tree, sourceId, nodeId);
      if (result.ok) {
        onAddLink(sourceId, nodeId);
      } else {
        showLinkError(result.reason);
      }
      reset();
    },
    [isArmed, sourceId, tree, onAddLink, showLinkError, reset],
  );

  return {isArmed, sourceId, linkError, toggleArm, selectForLink, reset};
}
