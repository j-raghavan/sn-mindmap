/**
 * useConceptLinkMode — state + orchestration for the concept-map
 * "Link to existing" gesture (§14.4 F-AC-DAG-3).
 *
 * This is a SEPARATE hook from useLinkMode (the mindmap-overlay link
 * hook), deliberately NOT a generalisation of it: the lead's rule is that
 * the overlay path — including useLinkMode.ts — stays byte-identical, so
 * concept mode gets its own parallel hook rather than a shared refactor
 * that could perturb the overlay. The two share only the two-tap state-
 * machine SHAPE; this one is typed over Graph and validates via
 * graph.validateParentEdge.
 *
 * Interaction (two-tap, mirrors the overlay link idiom):
 *   IDLE ──toggleArm──▶ ARMED (no source)
 *   ARMED ──selectForLink(N)──▶ ARMED (source = N)
 *   ARMED(source N) ──selectForLink(N again)──▶ ARMED (source cleared)
 *   ARMED(source N) ──selectForLink(M≠N)──▶ validateParentEdge(M, N):
 *        ok     → onAddLink(N, M); reset to IDLE
 *        reject → showLinkError(reason); reset to IDLE (banner persists)
 *   ARMED ──toggleArm──▶ IDLE (cancel)
 *
 * Edge semantics: the source node (the one whose "Concept link" pill was
 * tapped) becomes the PARENT of the target node (the second tap). So a
 * tap-source-then-target gesture reads "source → target" = source is a
 * parent of target. We therefore validate validateParentEdge(graph,
 * target-as-child, source-as-parent) and, on success, onAddLink(source,
 * target) — the canvas reducer maps that to addParentEdge(target, source).
 *
 * Validation is delegated to the model's validateParentEdge against the
 * CURRENT graph — single source of truth, no rule duplication. The
 * concept rejection set drops the overlay's 'tree-edge' reason (a concept
 * graph has a single edge set, so a duplicate is just 'duplicate').
 */
import {useCallback, useEffect, useRef, useState} from 'react';
import {
  validateParentEdge,
  type Graph,
  type ParentEdgeRejection,
} from './model/graph';
import type {NodeId} from './model/tree';

/**
 * How long to leave a link-reject banner on screen before auto-
 * dismissing. Matches useLinkMode's LINK_ERROR_DISPLAY_MS so the two
 * transient banners feel consistent on-device.
 */
const CONCEPT_LINK_ERROR_DISPLAY_MS = 2000;

/**
 * Human-readable banner text per typed rejection reason (§F-AC-DAG-3).
 * Exhaustive over ParentEdgeRejection so a future reason forces a message
 * here (TypeScript flags a missing key via the Record type). Note there
 * is no 'tree-edge' key — that reason belongs to the mindmap overlay, not
 * the concept graph (§14.3).
 */
const CONCEPT_LINK_ERROR_MESSAGES: Record<ParentEdgeRejection, string> = {
  'self-loop': "Can't link a node to itself.",
  duplicate: 'That link already exists.',
  cycle: 'That link would create a cycle.',
};

export type UseConceptLinkModeInput = {
  /** Current graph — validation runs against this (single source of truth). */
  graph: Graph;
  /**
   * Dispatch an accepted concept link into the reducer. Called with
   * (source, target): source is the parent, target the child, so the
   * reducer applies addParentEdge(target, source).
   */
  onAddLink: (source: NodeId, target: NodeId) => void;
};

export type UseConceptLinkModeResult = {
  /** True while link mode is armed — drives toolbar + node affordances. */
  isArmed: boolean;
  /** Selected source node while armed (awaiting target); null otherwise. */
  sourceId: NodeId | null;
  /** Current transient reject-banner text; null = no banner. */
  linkError: string | null;
  /** "Concept link" toolbar/pill onPress — arms / disarms (toggle). */
  toggleArm: () => void;
  /** Node tap while armed — selects source, then target. No-op when idle. */
  selectForLink: (nodeId: NodeId) => void;
  /** Force back to idle (e.g. on Clear / insert). Leaves the banner up. */
  reset: () => void;
};

export function useConceptLinkMode({
  graph,
  onAddLink,
}: UseConceptLinkModeInput): UseConceptLinkModeResult {
  const [isArmed, setIsArmed] = useState(false);
  const [sourceId, setSourceId] = useState<NodeId | null>(null);
  const [linkError, setLinkError] = useState<string | null>(null);
  const errorTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Cleanup the error timer on unmount so the setTimeout closure can't
  // fire a setState against a torn-down hook (mirrors useLinkMode).
  useEffect(() => {
    return () => {
      if (errorTimerRef.current) {
        clearTimeout(errorTimerRef.current);
      }
    };
  }, []);

  const showLinkError = useCallback((reason: ParentEdgeRejection) => {
    setLinkError(CONCEPT_LINK_ERROR_MESSAGES[reason]);
    if (errorTimerRef.current) {
      clearTimeout(errorTimerRef.current);
    }
    errorTimerRef.current = setTimeout(
      () => setLinkError(null),
      CONCEPT_LINK_ERROR_DISPLAY_MS,
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
      // source is the parent, nodeId (target) the child, so check
      // validateParentEdge(child=nodeId, parent=sourceId).
      const result = validateParentEdge(graph, nodeId, sourceId);
      if (result.ok) {
        onAddLink(sourceId, nodeId);
      } else {
        showLinkError(result.reason);
      }
      reset();
    },
    [isArmed, sourceId, graph, onAddLink, showLinkError, reset],
  );

  return {isArmed, sourceId, linkError, toggleArm, selectForLink, reset};
}
