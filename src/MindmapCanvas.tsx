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
 * Top bar (§F-AC-8): Cancel | Clear | Insert. Insert is always
 * enabled because the tree always has ≥ 1 node (§F-AC-8 — no
 * committed-strokes precondition since the plugin does not own
 * labels). Clear resets the tree back to a single-root fresh state
 * for "start over" authoring; because it's destructive, it uses a
 * two-tap confirm pattern (first tap arms the button, second tap
 * within CLEAR_CONFIRM_MS commits — matches the sn-shapes approach
 * of avoiding RN `Alert.alert` on e-ink firmware, where the native
 * modal's flashing animation looks poor and has never been verified
 * on Nomad/Manta).
 *
 * On Insert tap this component hands off to ./insert.ts.
 *
 * Phase 1.4b (this revision): mutation-capable canvas. A
 * useReducer-backed tree state supports Add Child, Add Sibling,
 * Delete, and Collapse toggle. Tapping a node selects it (the
 * Delete × is the only selection-gated affordance per §F-AC-5);
 * tapping the selected node again or tapping empty stage clears
 * selection. Collapsed subtrees are filtered from the render pass
 * per §4.2; the layout itself still lays every node out
 * deterministically (§F-IN-2 auto-expands before emit, so emit-time
 * code doesn't see a collapsed tree).
 *
 * Rendering approach: pure React Native Views. No react-native-svg —
 * sn-shapes avoids that dependency for the same reason (native
 * linking on the Supernote firmware is unverified). Node outlines
 * use `borderRadius`/`borderWidth`; connectors are thin black Views
 * rotated into place. Action icons are small Pressables with Text
 * glyphs inside — a chevron for Add Child/Sibling, a filled circle /
 * ring for Collapse, a × for Delete. This mirrors the sn-shapes
 * StrokePreview pattern so the two plugins stay visually consistent
 * on-device.
 */
import React, {
  useCallback,
  useEffect,
  useMemo,
  useReducer,
  useRef,
  useState,
} from 'react';
import {
  type LayoutChangeEvent,
  Pressable,
  StyleSheet,
  Text,
  TextInput,
  View,
} from 'react-native';
import {PluginManager} from 'sn-plugin-lib';
import {
  addChild,
  addSibling,
  cloneTree,
  createTree,
  deleteSubtree,
  setCollapsed,
  setLabel,
  ShapeKind,
  type MindmapNode,
  type NodeId,
  type Tree,
} from './model/tree';
import {radialLayout, type LayoutResult} from './layout/radial';
import {
  ROOT_PEN_WIDTH,
  SIBLING_CORNER_RADIUS,
  STANDARD_PEN_WIDTH,
} from './layout/constants';
import type {Point, Rect} from './geometry';
import {useInsertFlow} from './useInsertFlow';

/**
 * Firmware pen-width (μm) → on-screen pixels. Matches sn-shapes'
 * StrokePreview constant so the two plugins render outline weights
 * that match side-by-side on the same device.
 */
const STROKE_PX_PER_PENWIDTH = 1 / 40;

/**
 * Minimum visible stroke thickness. Matches sn-shapes' MIN_STROKE_PX
 * — at the firmware's smallest 100μm pen the preview would otherwise
 * render at 2.5 px which looks hairline on Nomad / Manta.
 */
const MIN_STROKE_PX = 2;

/**
 * Action-icon hit target. 28 px is small for a fingertip but large
 * enough for the Supernote pen, which is what the whole UI is tuned
 * for anyway. Scaled up to 36 once §10 tuning confirms a comfortable
 * size on-device if needed.
 */
const ICON_SIZE = 28;

/** Gap between node outline and the action icons that sit alongside it. */
const ICON_GAP = 8;

/**
 * Pill dimensions for the Add Child / Add Sibling buttons. v1.0.1
 * carries a single Unicode glyph instead of a "+ Child" / "+ Sibling"
 * word label — the glyphs convey direction more clearly than English
 * text on a small e-ink button. Width is just wide enough that the
 * glyph plus a couple of pixels of horizontal padding keeps the
 * rounded ends from clipping the character; height matches sn-shapes'
 * top-bar pill height so the canvas affordances feel consistent with
 * the host UI.
 *
 * Glyphs:
 *   Sibling (`→`, U+2192)  — "next at this level"
 *   Child   (`↳`, U+21B3)  — "step down a level then over", same
 *                            visual idiom as a git-branch icon: a
 *                            path that drops then turns rightwards.
 */
const ADD_PILL_WIDTH = 36;
const ADD_PILL_HEIGHT = 28;

/** Sibling glyph — unicode RIGHTWARDS ARROW. */
const SIBLING_GLYPH = '\u2192';

/** Child glyph — unicode DOWNWARDS ARROW WITH TIP RIGHTWARDS. */
const CHILD_GLYPH = '\u21B3';

/**
 * Pixels of viewport margin left around the mindmap when fit-scaling
 * on open (§F-AC-2 "centered on screen"). Chosen large enough that
 * the action icons — which sit OUTSIDE each node's bbox by ICON_GAP
 * + ICON_SIZE — never clip against the surface edges on e-ink, and
 * small enough to feel close to edge-to-edge on small trees.
 *
 * Applied on each side, so the effective inner viewport is
 * (surfaceW - 2 * VIEWPORT_PADDING) × (surfaceH - 2 * VIEWPORT_PADDING).
 */
const VIEWPORT_PADDING = 48;

/**
 * Two-tap confirm window for the destructive Clear button. A first
 * tap swaps the label to "Confirm Clear"; a second tap within this
 * window commits the reset. After the window elapses with no second
 * tap the button silently disarms back to "Clear".
 *
 * 3 s is long enough for an authoring user to take a breath and
 * confirm on purpose, short enough that a stale armed state never
 * sits around long enough to catch the next tap by surprise.
 */
const CLEAR_CONFIRM_MS = 3000;

export type MindmapCanvasProps = {
  /**
   * Optional preloaded tree for on-device authoring tests. Undefined
   * → the canvas creates a fresh tree with just the root Oval.
   */
  initialTree?: Tree;
};

/**
 * Reducer actions. Each action describes a single user gesture on
 * the canvas — the reducer turns that into a cloned-then-mutated
 * Tree so React's state identity comparison notices the change.
 */
type Action =
  | {type: 'ADD_CHILD'; parentId: NodeId; label: string}
  | {type: 'ADD_SIBLING'; nodeId: NodeId; label: string}
  | {type: 'SET_LABEL'; nodeId: NodeId; label: string}
  | {type: 'DELETE_SUBTREE'; nodeId: NodeId}
  | {type: 'TOGGLE_COLLAPSE'; nodeId: NodeId}
  | {type: 'CLEAR'};

/**
 * Pending label-modal context. Drives the Modal-with-TextInput that
 * captures a node's label before it lands in the tree.
 *
 * Modes:
 *   - `root`   the canvas is brand-new (or just Cleared) and the
 *              user hasn't named the central idea yet. Cancel
 *              closes the plugin entirely — there's nothing to
 *              author without a root label.
 *   - `child`  the user tapped Add Child on `parentId`. Create
 *              dispatches ADD_CHILD with the entered text; Cancel
 *              dismisses the modal without adding a node.
 *   - `sibling`the user tapped Add Sibling on `nodeId`. Create
 *              dispatches ADD_SIBLING; Cancel dismisses.
 *   - `edit`   the user tapped an existing node body. Create
 *              dispatches SET_LABEL on that node; Cancel dismisses
 *              without changing it.
 */
type PendingMode =
  | {kind: 'root'; nodeId: NodeId}
  | {kind: 'child'; parentId: NodeId}
  | {kind: 'sibling'; nodeId: NodeId}
  | {kind: 'edit'; nodeId: NodeId};

/**
 * On mount: open the central-idea modal automatically iff the tree
 * has just the unlabeled root and nothing else. This matches the
 * authored UX: the very first thing the user sees is a prompt for
 * the central idea, not an empty canvas.
 *
 * If `initialTree` was supplied with a labeled root (e.g. tests, or
 * a future "load existing mindmap" path), no modal opens.
 */
function initialPendingForTree(tree: Tree): PendingMode | null {
  const root = tree.nodesById.get(tree.rootId);
  if (!root) {
    return null;
  }
  if (tree.nodesById.size === 1 && !root.label) {
    return {kind: 'root', nodeId: tree.rootId};
  }
  return null;
}

/**
 * Pure reducer: clones the previous tree and applies the mutators
 * from ./model/tree. The mutators themselves are imperative for
 * testability but callers outside this module always see an
 * immutable-style state transition.
 */
function treeReducer(state: Tree, action: Action): Tree {
  // CLEAR discards the previous state entirely — no point cloning it
  // only to overwrite — so it short-circuits before the clone.
  if (action.type === 'CLEAR') {
    return createTree();
  }
  const next = cloneTree(state);
  switch (action.type) {
    case 'ADD_CHILD':
      addChild(next, action.parentId, action.label);
      return next;
    case 'ADD_SIBLING':
      addSibling(next, action.nodeId, action.label);
      return next;
    case 'SET_LABEL':
      setLabel(next, action.nodeId, action.label);
      return next;
    case 'DELETE_SUBTREE':
      deleteSubtree(next, action.nodeId);
      return next;
    case 'TOGGLE_COLLAPSE': {
      const node = next.nodesById.get(action.nodeId);
      if (!node) {
        return state;
      }
      setCollapsed(next, action.nodeId, !node.collapsed);
      return next;
    }
    default:
      // Exhaustiveness guard — the Action union is closed, so TS
      // flags any missing case here. Runtime throw is defense-in-
      // depth for JS callers.
      throw new Error(
        `treeReducer: unknown action ${(action as {type: string}).type}`,
      );
  }
}

export default function MindmapCanvas({
  initialTree,
}: MindmapCanvasProps = {}): React.JSX.Element {
  // The initial-state arg is called lazily by React, so cloning only
  // happens on mount. The clone is important: callers may reuse the
  // same `initialTree` reference across remounts and expect their
  // copy to be unmodified.
  const [tree, dispatch] = useReducer(treeReducer, initialTree, seed =>
    seed ? cloneTree(seed) : createTree(),
  );

  // Selection state. Only one of the per-node affordances (§F-AC-5
  // Delete) is selection-gated, but we still centralise selection
  // here so future work (label editing, highlight on hover) can
  // reuse it.
  const [selectedId, setSelectedId] = useState<NodeId | null>(null);

  // Measured surface dimensions (inner viewport below the top bar).
  // Starts at 0×0 — the first paint uses fitScale=1 which is the
  // correct default for a lone root; onLayout fires immediately after
  // mount and re-renders at the right scale for larger trees.
  const [viewport, setViewport] = useState<{w: number; h: number}>({
    w: 0,
    h: 0,
  });
  const handleSurfaceLayout = useCallback((e: LayoutChangeEvent) => {
    const {width, height} = e.nativeEvent.layout;
    // Guard against a no-op setState loop on re-layouts that report
    // identical dimensions — otherwise we'd trigger an extra render
    // every time the tree mutates and the surface re-measures itself.
    setViewport(prev =>
      prev.w === width && prev.h === height ? prev : {w: width, h: height},
    );
  }, []);

  const layout = useMemo(() => radialLayout(tree), [tree]);

  /**
   * Fit-to-view scale so the whole mindmap is visible on open per
   * §F-AC-2 ("centered on screen"). Capped at 1 so a lone root stays
   * at its designed 220×96 proportions rather than blowing up to fill
   * the viewport; action-icon hit targets would otherwise scale with
   * the canvas and the 28×28 Pressables would become awkward.
   *
   * Scale-down kicks in as soon as unionBbox (plus a VIEWPORT_PADDING
   * margin on each side) exceeds the viewport along either axis. Pan
   * and manual zoom land in §F-AC-7 (Phase 1.4c); until then this
   * auto-fit keeps the whole map on-screen for any tree that still
   * fits readably at a single scale.
   */
  const fitScale = useMemo(() => {
    if (viewport.w <= 0 || viewport.h <= 0) {
      return 1;
    }
    const stageW = Math.max(1, layout.unionBbox.w);
    const stageH = Math.max(1, layout.unionBbox.h);
    const innerW = Math.max(1, viewport.w - 2 * VIEWPORT_PADDING);
    const innerH = Math.max(1, viewport.h - 2 * VIEWPORT_PADDING);
    return Math.min(1, innerW / stageW, innerH / stageH);
  }, [layout.unionBbox, viewport]);

  // Visible set: fully-expanded layout minus nodes that live inside
  // a collapsed subtree. A node is visible iff every ancestor is
  // non-collapsed (the node itself being collapsed still shows —
  // only its children disappear).
  const visibleIds = useMemo(() => computeVisibleSet(tree), [tree]);

  // Label-edit modal state (§F-AC-2 / authoring labels). Drives a
  // <Modal> with a <TextInput> rendered below the Stage. `pending`
  // null means no modal is shown; otherwise it carries which mode
  // (root / child / sibling / edit) and the parent / sibling / target
  // node id to apply the entered label to. Initial state is the root
  // edit modal whenever the root is unlabeled — exactly the
  // "first show prompts for the central idea" UX the user asked for.
  const [pending, setPending] = useState<PendingMode | null>(() =>
    initialPendingForTree(tree),
  );

  // Tap on a labeled node body: open its edit modal. Tap on an
  // unlabeled node body: same — modal opens to set its label. The
  // modal-edit gesture also selects the node, so the existing per-
  // node Delete affordance still works after the modal closes.
  const handleSelect = useCallback((nodeId: NodeId) => {
    setSelectedId(nodeId);
    setPending({kind: 'edit', nodeId});
  }, []);

  const handleBackgroundPress = useCallback(() => {
    setSelectedId(null);
  }, []);

  const handleAddChild = useCallback((parentId: NodeId) => {
    setPending({kind: 'child', parentId});
  }, []);

  const handleAddSibling = useCallback((nodeId: NodeId) => {
    setPending({kind: 'sibling', nodeId});
  }, []);

  // Modal Create button — dispatches the right action based on the
  // current pending mode. Empty / whitespace-only labels are blocked
  // upstream by the modal's disabled-Create state, but we trim again
  // here so the reducer can't be tricked into setting an empty label
  // by a stale render.
  const handleLabelCreate = useCallback(
    (rawLabel: string) => {
      const label = rawLabel.trim();
      if (!label || pending === null) {
        return;
      }
      switch (pending.kind) {
        case 'root':
        case 'edit':
          dispatch({type: 'SET_LABEL', nodeId: pending.nodeId, label});
          break;
        case 'child':
          dispatch({type: 'ADD_CHILD', parentId: pending.parentId, label});
          break;
        case 'sibling':
          dispatch({type: 'ADD_SIBLING', nodeId: pending.nodeId, label});
          break;
      }
      setPending(null);
    },
    [pending],
  );

  // Modal Cancel button. From the initial root-label modal the only
  // sensible thing is to close the plugin — there is no labeled tree
  // to fall back to. From every other mode (child / sibling / edit
  // of an existing node), Cancel just dismisses the modal.
  const handleLabelCancel = useCallback(() => {
    if (pending?.kind === 'root') {
      // Fire-and-forget — same pattern insert.ts uses for the post-
      // insert close. We don't care about the dismissal promise; the
      // host does its own teardown when the view backgrounds.
      PluginManager.closePluginView().catch(() => {
        /* ignore — UI is gone anyway */
      });
      return;
    }
    setPending(null);
  }, [pending]);

  const handleDelete = useCallback(
    (nodeId: NodeId) => {
      dispatch({type: 'DELETE_SUBTREE', nodeId});
      // Deleted node can no longer be the selection target.
      setSelectedId(prev => (prev === nodeId ? null : prev));
    },
    [],
  );

  const handleToggleCollapse = useCallback((nodeId: NodeId) => {
    dispatch({type: 'TOGGLE_COLLAPSE', nodeId});
  }, []);

  // Insert pipeline state (§F-IN-*). Extracted into useInsertFlow so
  // the canvas renders topology + affordances + top bar, while the
  // hook owns debounce, pending state, and the transient error banner.
  const flow = useInsertFlow({tree});

  // Clear-button two-tap confirm state. `clearArmed` flips to true on
  // the first tap, re-rendering the button label as "Confirm Clear".
  // A second tap within CLEAR_CONFIRM_MS commits the reset; otherwise
  // the disarm timer silently puts the button back to "Clear".
  const [clearArmed, setClearArmed] = useState(false);
  // Increments on every Clear commit. Applied as the React `key` on
  // the canvas surface so a Clear forces React to unmount the whole
  // stage subtree and remount fresh — which dirties enough screen
  // area on the next paint that the Supernote's e-ink driver triggers
  // a full refresh of the canvas region. Without this, partial-refresh
  // mode leaves the previous tree's icon chevrons visible as ghost
  // pixels even though their Views no longer exist in the React tree.
  const [clearTick, setClearTick] = useState(0);
  const clearArmedTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => {
    return () => {
      if (clearArmedTimerRef.current) {
        clearTimeout(clearArmedTimerRef.current);
      }
    };
  }, []);

  const handleClear = useCallback(() => {
    // Refuse to clear mid-insert — the insert pipeline reads `tree`
    // from the render that kicked it off, but a confused user
    // shouldn't be able to wipe the canvas while the device is still
    // painting the previous map. flow.isInserting is state rather
    // than a ref, but Pressable onPress can't fire inside the same
    // render cycle that set it, so the race window is zero in practice.
    if (flow.isInserting) {
      return;
    }
    if (clearArmedTimerRef.current) {
      clearTimeout(clearArmedTimerRef.current);
      clearArmedTimerRef.current = null;
    }
    if (!clearArmed) {
      setClearArmed(true);
      clearArmedTimerRef.current = setTimeout(() => {
        setClearArmed(false);
        clearArmedTimerRef.current = null;
      }, CLEAR_CONFIRM_MS);
      return;
    }
    // Second tap within the confirm window — commit. Reset every
    // piece of canvas state we own so the user lands back in the
    // initial-plugin-open UI: empty tree behind the "Central idea"
    // modal. The tree dispatch resets the topology; selectedId is
    // dropped (no node to select); the pending modal is rearmed for
    // the new unlabeled root, exactly mirroring initialPendingForTree
    // on first mount. Bumping clearTick changes the surface View's
    // React key so the entire stage subtree unmounts and remounts —
    // belt-and-suspenders against e-ink partial-refresh ghosts that
    // would otherwise leave the previous tree's icon chevrons visible
    // even though their Views are gone from the React tree.
    dispatch({type: 'CLEAR'});
    setSelectedId(null);
    setClearArmed(false);
    setPending({kind: 'root', nodeId: 0 as NodeId});
    setClearTick(t => t + 1);
  }, [clearArmed, flow.isInserting]);

  return (
    <View style={styles.root}>
      <View style={styles.topBar}>
        <Pressable
          accessibilityRole="button"
          accessibilityLabel="Cancel"
          onPress={() => PluginManager.closePluginView()}
          style={({pressed}) => [
            styles.topBarBtn,
            pressed && styles.topBarBtnPressed,
          ]}>
          <Text style={styles.topBarBtnText}>Cancel</Text>
        </Pressable>
        {/*
         * Clear — two-tap destructive reset. Label swaps to
         * "Confirm Clear" after first tap; second tap within
         * CLEAR_CONFIRM_MS wipes the tree back to a single-root
         * fresh state. Disabled while an insert is in flight so the
         * canvas state doesn't change out from under the pipeline.
         */}
        <Pressable
          accessibilityRole="button"
          accessibilityLabel={clearArmed ? 'Confirm Clear' : 'Clear'}
          accessibilityState={{disabled: flow.isInserting}}
          disabled={flow.isInserting}
          onPress={handleClear}
          style={({pressed}) => [
            styles.topBarBtn,
            styles.topBarBtnAdjacent,
            pressed && !flow.isInserting && styles.topBarBtnPressed,
            clearArmed && styles.topBarBtnArmed,
            flow.isInserting && styles.topBarBtnDisabled,
          ]}>
          <Text
            style={[
              styles.topBarBtnText,
              clearArmed && styles.topBarBtnTextArmed,
              flow.isInserting && styles.topBarBtnTextDisabled,
            ]}>
            {clearArmed ? 'Confirm Clear' : 'Clear'}
          </Text>
        </Pressable>
        <View style={styles.topBarSpacer} />
        {/*
         * Insert / Save button — §F-AC-8 for first-insert, §F-ED-7
         * for re-insert. Always enabled because the tree always has
         * ≥ 1 node; the only reason it's locally disabled is while
         * an insert is already in flight, to debounce double taps
         * during the §F-NF-2 ≤ 2.0 s budget. Fires the §F-IN-*
         * pipeline (Edit/Save paths were removed with the marker).
         */}
        <InsertButton
          isPending={flow.isInserting}
          onPress={flow.triggerInsert}
        />
      </View>
      {flow.insertError !== null && (
        <View accessibilityLabel="insert-error" style={styles.errorBanner}>
          <Text style={styles.errorText}>{flow.insertError}</Text>
        </View>
      )}
      <Pressable
        accessibilityLabel="mindmap-background"
        style={styles.surface}
        onLayout={handleSurfaceLayout}
        onPress={handleBackgroundPress}>
        {/*
         * Fit-to-view wrapper. Transform scales the Stage around its
         * own layout center (RN's default origin), so flexbox
         * centering on the surface places the scaled Stage right in
         * the middle of the viewport with a VIEWPORT_PADDING margin
         * on the tight axis. Layout size of the wrapper stays equal
         * to the Stage's un-scaled size — we rely on visual transform
         * only, which matches how React Native's Animated library
         * handles the same "fit one content box inside another"
         * pattern.
         */}
        <View
          // Keying on clearTick forces a clean unmount/remount of the
          // entire stage subtree on every Clear commit — see the
          // comment on `clearTick` above for the e-ink ghost-pixel
          // rationale. clearTick is a plain integer that only ever
          // increments, so each value yields a unique key.
          key={`stage-${clearTick}`}
          accessibilityLabel="mindmap-fit-wrapper"
          style={[styles.stageWrapper, {transform: [{scale: fitScale}]}]}>
          <Stage
            tree={tree}
            layout={layout}
            visibleIds={visibleIds}
            selectedId={selectedId}
            onSelect={handleSelect}
            onAddChild={handleAddChild}
            onAddSibling={handleAddSibling}
            onDelete={handleDelete}
            onToggleCollapse={handleToggleCollapse}
          />
        </View>
      </Pressable>
      <LabelModal
        pending={pending}
        tree={tree}
        onCreate={handleLabelCreate}
        onCancel={handleLabelCancel}
      />
    </View>
  );
}

/**
 * Modal pop-up that captures a node's label. Behavior:
 *
 *   - Visible whenever `pending !== null`.
 *   - Title text reflects the mode: "Central idea" for root, "Add
 *     child", "Add sibling", or "Edit label" for an existing node.
 *   - The TextInput auto-focuses on mount; the host's stylus +
 *     keyboard / handwriting recognition both feed it natively, no
 *     bridge work required.
 *   - The Create button is disabled until the input has at least one
 *     non-whitespace character — empty labels are explicitly
 *     rejected (the user can always Cancel out instead).
 *   - Cancel: from the root mode the only sensible action is to
 *     close the plugin (there's nothing to author yet); from every
 *     other mode it just dismisses.
 *
 * The current input value is reset on every `pending` change so that
 * opening the modal again starts with the right seed (the existing
 * label for `edit` mode, empty for everything else).
 */
function LabelModal({
  pending,
  tree,
  onCreate,
  onCancel,
}: {
  pending: PendingMode | null;
  tree: Tree;
  onCreate: (label: string) => void;
  onCancel: () => void;
}): React.JSX.Element {
  const seed = useMemo(() => {
    if (!pending) {
      return '';
    }
    if (pending.kind === 'edit' || pending.kind === 'root') {
      const node = tree.nodesById.get(pending.nodeId);
      return node?.label ?? '';
    }
    return '';
  }, [pending, tree]);

  const [draft, setDraft] = useState(seed);
  // Reset draft when the modal opens with a different seed (e.g. the
  // user opens edit on node A, cancels, then opens edit on node B).
  useEffect(() => {
    setDraft(seed);
  }, [seed]);

  const visible = pending !== null;
  const title =
    pending?.kind === 'root'
      ? 'Central idea'
      : pending?.kind === 'child'
        ? 'Add child'
        : pending?.kind === 'sibling'
          ? 'Add sibling'
          : 'Edit label';
  const trimmed = draft.trim();
  const canCreate = trimmed.length > 0;

  // Render nothing when no modal is requested. Bailing here (instead
  // of rendering with `visible={false}`) keeps the entire dialog out
  // of the React tree when it's not needed — no leftover focused
  // TextInput keeping the on-screen keyboard ghosted in place after
  // dismiss, no stray modal pixels for the e-ink driver to chase.
  if (!visible) {
    return <></>;
  }
  return (
    <View
      style={styles.modalOverlay}
      pointerEvents="box-none"
      accessibilityViewIsModal>
      <View
        style={styles.modalBackdrop}
        accessibilityLabel="label-modal-backdrop"
      />
      <View
        accessibilityLabel="label-modal"
        accessibilityRole="alert"
        style={styles.modalCard}>
        <Text style={styles.modalTitle}>{title}</Text>
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
            accessibilityLabel="label-cancel"
            onPress={onCancel}
            style={({pressed}) => [
              styles.modalBtn,
              styles.modalBtnSecondary,
              pressed && styles.modalBtnPressed,
            ]}>
            <Text style={styles.modalBtnText}>Cancel</Text>
          </Pressable>
          <Pressable
            accessibilityRole="button"
            accessibilityLabel="label-create"
            accessibilityState={{disabled: !canCreate}}
            disabled={!canCreate}
            onPress={() => onCreate(trimmed)}
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
  );
}

/**
 * InsertSaveButton — the top-bar primary-action button that toggles
 * between authoring ("Insert", §F-AC-8) and edit ("Save", §F-ED-7)
 * modes. Both modes share identical chrome: same top-bar pill
 * styling, same pressed / disabled state transitions, same pending-
 * state "…" label swap. Before the extraction MindmapCanvas rendered
 * two near-identical 20-line Pressable branches selected by
 * `isEditMode`; DRY them into a single component whose only
 * mode-dependent outputs are the accessibilityLabel and the two
 * labels displayed on the Text child.
 *
 * Kept inside MindmapCanvas.tsx rather than extracted to its own file
 * because it consumes the module-scoped `styles` object — the whole
 * point of the refactor is to share the top-bar button styling, not
 * to export a reusable primitive. A separate file would have to
 * either re-declare the styles (duplication) or export them
 * (accidental public surface).
 */
function InsertButton({
  isPending,
  onPress,
}: {
  isPending: boolean;
  onPress: () => void;
}): React.JSX.Element {
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel="Insert"
      accessibilityState={{disabled: isPending}}
      disabled={isPending}
      onPress={onPress}
      style={({pressed}) => [
        styles.topBarBtn,
        pressed && !isPending && styles.topBarBtnPressed,
        isPending && styles.topBarBtnDisabled,
      ]}>
      <Text
        style={[
          styles.topBarBtnText,
          isPending && styles.topBarBtnTextDisabled,
        ]}>
        {isPending ? 'Inserting…' : 'Insert'}
      </Text>
    </Pressable>
  );
}

/**
 * Walk the tree from the root, stopping descent at every collapsed
 * node. The collapsed node itself is visible; its descendants are
 * not. Returns the set of visible NodeIds.
 */
function computeVisibleSet(tree: Tree): Set<NodeId> {
  const visible = new Set<NodeId>();
  const stack: NodeId[] = [tree.rootId];
  while (stack.length > 0) {
    const id = stack.pop() as NodeId;
    visible.add(id);
    const node = tree.nodesById.get(id);
    if (!node || node.collapsed) {
      continue;
    }
    for (const childId of node.childIds) {
      stack.push(childId);
    }
  }
  return visible;
}

/**
 * Count descendants below a node. Used by the collapse badge to
 * render `+N`. Iterative so deep trees can't blow the stack.
 */
function countDescendants(tree: Tree, nodeId: NodeId): number {
  const node = tree.nodesById.get(nodeId);
  if (!node) {
    return 0;
  }
  let count = 0;
  const stack: NodeId[] = [...node.childIds];
  while (stack.length > 0) {
    const id = stack.pop() as NodeId;
    count += 1;
    const child = tree.nodesById.get(id);
    if (!child) {
      continue;
    }
    for (const grandchildId of child.childIds) {
      stack.push(grandchildId);
    }
  }
  return count;
}

type StageProps = {
  tree: Tree;
  layout: LayoutResult;
  visibleIds: Set<NodeId>;
  selectedId: NodeId | null;
  onSelect: (nodeId: NodeId) => void;
  onAddChild: (parentId: NodeId) => void;
  onAddSibling: (nodeId: NodeId) => void;
  onDelete: (nodeId: NodeId) => void;
  onToggleCollapse: (nodeId: NodeId) => void;
};

/**
 * Stage: centred plane sized to the layout's union bbox. Children
 * are absolutely positioned inside, coordinates translated from
 * mindmap-local (root at origin, may extend in any direction) to
 * stage-local (top-left = 0,0).
 *
 * Render order (back to front):
 *   1. connectors (so nodes paint on top and mask the center→center
 *      overshoot)
 *   2. node outlines (interactive — tap selects)
 *   3. action icons (interactive — Add Child / Sibling / Collapse /
 *      Delete)
 */
function Stage({
  tree,
  layout,
  visibleIds,
  selectedId,
  onSelect,
  onAddChild,
  onAddSibling,
  onDelete,
  onToggleCollapse,
}: StageProps): React.JSX.Element {
  const {unionBbox} = layout;
  const origin: Point = {x: unionBbox.x, y: unionBbox.y};

  // Enumerate directed edges parent → child, skipping any edge that
  // crosses the collapsed boundary (parent visible, child not).
  const edges: Array<{parent: MindmapNode; child: MindmapNode}> = [];
  for (const node of tree.nodesById.values()) {
    if (!visibleIds.has(node.id)) {
      continue;
    }
    for (const childId of node.childIds) {
      if (!visibleIds.has(childId)) {
        continue;
      }
      const child = tree.nodesById.get(childId);
      if (!child) {
        continue;
      }
      edges.push({parent: node, child});
    }
  }

  const visibleNodes: MindmapNode[] = [];
  for (const node of tree.nodesById.values()) {
    if (visibleIds.has(node.id)) {
      visibleNodes.push(node);
    }
  }

  return (
    <View
      accessibilityLabel="mindmap-stage"
      style={{width: unionBbox.w, height: unionBbox.h}}>
      {edges.map(({parent, child}) => {
        const parentCenter = layout.centers.get(parent.id);
        const childCenter = layout.centers.get(child.id);
        if (!parentCenter || !childCenter) {
          return null;
        }
        return (
          <Connector
            key={`edge-${parent.id}-${child.id}`}
            from={parentCenter}
            to={childCenter}
            origin={origin}
            penWidth={penWidthForShape(child.shape)}
          />
        );
      })}
      {visibleNodes.map(node => {
        const bbox = layout.bboxes.get(node.id);
        if (!bbox) {
          return null;
        }
        return (
          <NodeFrame
            key={`node-${node.id}`}
            node={node}
            bbox={bbox}
            origin={origin}
            isSelected={selectedId === node.id}
            onPress={onSelect}
          />
        );
      })}
      {visibleNodes.map(node => {
        const bbox = layout.bboxes.get(node.id);
        if (!bbox) {
          return null;
        }
        return (
          <NodeActions
            key={`actions-${node.id}`}
            node={node}
            tree={tree}
            bbox={bbox}
            origin={origin}
            isSelected={selectedId === node.id}
            onAddChild={onAddChild}
            onAddSibling={onAddSibling}
            onDelete={onDelete}
            onToggleCollapse={onToggleCollapse}
          />
        );
      })}
    </View>
  );
}

/**
 * Visual outline + tap target for a single node. Shape drives
 * `borderRadius`:
 *   OVAL              → height/2 (stadium / fully-rounded ends)
 *   RECTANGLE         → 0 (sharp corners)
 *   ROUNDED_RECTANGLE → SIBLING_CORNER_RADIUS (§F-AC-3)
 *
 * Selection highlight doubles the border width so the selected node
 * reads clearly against the paper-white canvas; keeping the same
 * black color preserves e-ink contrast (grey would anti-alias
 * poorly).
 */
function NodeFrame({
  node,
  bbox,
  origin,
  isSelected,
  onPress,
}: {
  node: MindmapNode;
  bbox: Rect;
  origin: Point;
  isSelected: boolean;
  onPress: (nodeId: NodeId) => void;
}): React.JSX.Element {
  const penWidth = penWidthForShape(node.shape);
  const borderWidth = penWidthToPx(penWidth) * (isSelected ? 2 : 1);
  const skewTransform = transformForShape(node.shape);
  // PARALLELOGRAM nodes need their CONTENTS un-skewed so the label
  // text reads upright while the outline is slanted. Composing
  // `skewX(-12deg)` (parent) with `skewX(12deg)` (child) cancels the
  // shear on the Text View — same trick CSS skew layouts use.
  const labelTransform =
    node.shape === ShapeKind.PARALLELOGRAM
      ? [{skewX: '12deg'}]
      : undefined;
  return (
    <Pressable
      accessibilityLabel={`node-${node.id}`}
      onPress={() => onPress(node.id)}
      style={[
        styles.nodeFrame,
        {
          left: bbox.x - origin.x,
          top: bbox.y - origin.y,
          width: bbox.w,
          height: bbox.h,
          borderWidth,
          borderRadius: borderRadiusForShape(node.shape, bbox),
        },
        skewTransform ? {transform: skewTransform} : null,
      ]}>
      {node.label !== undefined && node.label.length > 0 && (
        <Text
          accessibilityLabel={`node-${node.id}-label`}
          numberOfLines={2}
          ellipsizeMode="tail"
          style={[
            styles.nodeLabel,
            labelTransform ? {transform: labelTransform} : null,
          ]}>
          {node.label}
        </Text>
      )}
    </Pressable>
  );
}

/**
 * Thin rotated View that stands in for a straight-line connector.
 * Positioned with its geometric center at the midpoint of the
 * (from, to) segment, then rotated by atan2(dy, dx) around that
 * same center (RN's default transform origin).
 */
function Connector({
  from,
  to,
  origin,
  penWidth,
}: {
  from: Point;
  to: Point;
  origin: Point;
  penWidth: number;
}): React.JSX.Element {
  const dx = to.x - from.x;
  const dy = to.y - from.y;
  const length = Math.hypot(dx, dy);
  const angle = Math.atan2(dy, dx);
  const thickness = penWidthToPx(penWidth);
  const midX = (from.x + to.x) / 2;
  const midY = (from.y + to.y) / 2;
  return (
    <View
      accessibilityLabel="connector"
      style={[
        styles.connector,
        {
          left: midX - length / 2 - origin.x,
          top: midY - thickness / 2 - origin.y,
          width: length,
          height: thickness,
          transform: [{rotate: `${angle}rad`}],
        },
      ]}
    />
  );
}

/**
 * Per-node action icon cluster (§F-AC-5). Rendered as absolutely-
 * positioned Pressables around the node bbox. Visibility rules:
 *   - Add Child       : always visible
 *   - Add Sibling     : hidden on root (nodeId === rootId)
 *   - Collapse toggle : visible only when node has ≥ 1 child
 *   - Delete          : visible only when the node is selected AND
 *                       is not the root (root can't be deleted)
 */
function NodeActions({
  node,
  tree,
  bbox,
  origin,
  isSelected,
  onAddChild,
  onAddSibling,
  onDelete,
  onToggleCollapse,
}: {
  node: MindmapNode;
  tree: Tree;
  bbox: Rect;
  origin: Point;
  isSelected: boolean;
  onAddChild: (id: NodeId) => void;
  onAddSibling: (id: NodeId) => void;
  onDelete: (id: NodeId) => void;
  onToggleCollapse: (id: NodeId) => void;
}): React.JSX.Element {
  const isRoot = node.id === tree.rootId;
  const hasChildren = node.childIds.length > 0;
  const stageLeft = bbox.x - origin.x;
  const stageTop = bbox.y - origin.y;

  return (
    <React.Fragment>
      {/*
       * Add Child — filled pill carrying the `↳` glyph (git-branch
       * idiom: drop down one level, then over). Filled (primary)
       * variant signals this as the dominant authoring gesture. The
       * pill's vertical centre lines up with the node's vertical
       * centre and sits a fixed ICON_GAP to the right of the bbox.
       */}
      <Pressable
        accessibilityLabel={`add-child-${node.id}`}
        onPress={() => onAddChild(node.id)}
        style={[
          styles.addPill,
          styles.addPillPrimary,
          {
            left: stageLeft + bbox.w + ICON_GAP,
            top: stageTop + bbox.h / 2 - ADD_PILL_HEIGHT / 2,
          },
        ]}>
        <Text style={[styles.addPillGlyph, styles.addPillGlyphPrimary]}>
          {CHILD_GLYPH}
        </Text>
      </Pressable>

      {/*
       * Add Sibling — outlined pill carrying the `→` glyph ("next at
       * this level"). Hidden on the root (siblings of the root would
       * mean a forest, not a tree). The pill is horizontally centred
       * on the node's centreline and sits a fixed ICON_GAP below the
       * bbox.
       */}
      {!isRoot && (
        <Pressable
          accessibilityLabel={`add-sibling-${node.id}`}
          onPress={() => onAddSibling(node.id)}
          style={[
            styles.addPill,
            {
              left: stageLeft + bbox.w / 2 - ADD_PILL_WIDTH / 2,
              top: stageTop + bbox.h + ICON_GAP,
            },
          ]}>
          <Text style={styles.addPillGlyph}>{SIBLING_GLYPH}</Text>
        </Pressable>
      )}

      {/*
       * Collapse/Expand toggle — bottom-right corner, inside the
       * node outline. Filled dot when expanded, ring with "+N" when
       * collapsed (§F-AC-5).
       */}
      {hasChildren && (
        <Pressable
          accessibilityLabel={`collapse-${node.id}`}
          onPress={() => onToggleCollapse(node.id)}
          style={[
            styles.collapseButton,
            {
              left: stageLeft + bbox.w - ICON_SIZE - 4,
              top: stageTop + bbox.h - ICON_SIZE - 4,
            },
          ]}>
          {node.collapsed ? (
            <View style={styles.collapseRing}>
              <Text style={styles.collapseBadgeText}>
                {`+${countDescendants(tree, node.id)}`}
              </Text>
            </View>
          ) : (
            <View style={styles.collapseDot} />
          )}
        </Pressable>
      )}

      {/*
       * Delete — "×" at the top-right. Visible only when the node
       * is selected, hidden on the root (use Cancel instead, per
       * §F-AC-5).
       */}
      {isSelected && !isRoot && (
        <Pressable
          accessibilityLabel={`delete-${node.id}`}
          onPress={() => onDelete(node.id)}
          style={[
            styles.iconButton,
            styles.deleteButton,
            {
              left: stageLeft + bbox.w - ICON_SIZE / 2,
              top: stageTop - ICON_SIZE / 2,
            },
          ]}>
          <Text style={styles.iconGlyph}>{'\u00D7'}</Text>
        </Pressable>
      )}
    </React.Fragment>
  );
}

/**
 * Convert a firmware pen width (μm) to on-screen pixels, clamped at
 * MIN_STROKE_PX so hairline strokes stay visible. Small helper kept
 * private because the ratio is a rendering concern, not a geometry
 * concern — the insert pipeline (Phase 2) uses the raw μm values.
 */
function penWidthToPx(penWidth: number): number {
  return Math.max(MIN_STROKE_PX, penWidth * STROKE_PX_PER_PENWIDTH);
}

/**
 * Pen-width default for a given shape kind. Root Oval uses
 * ROOT_PEN_WIDTH (§F-AC-2); all other shapes use STANDARD_PEN_WIDTH
 * (§11). Connectors reuse this via the child's shape per §F-IN-2
 * step 2.
 */
function penWidthForShape(shape: ShapeKind): number {
  switch (shape) {
    case ShapeKind.OVAL:
      return ROOT_PEN_WIDTH;
    case ShapeKind.RECTANGLE:
    case ShapeKind.ROUNDED_RECTANGLE:
    case ShapeKind.PARALLELOGRAM:
      return STANDARD_PEN_WIDTH;
    default:
      // Exhaustiveness guard — the ShapeKind union is closed, so
      // TypeScript flags any missing case here.
      throw new Error(
        `MindmapCanvas.penWidthForShape: unknown shape kind ${shape as number}`,
      );
  }
}

/**
 * Border-radius value for an RN `<View>` outlining the given shape.
 * OVAL reads its radius from the bbox (so non-square bboxes still
 * render as stadiums), the others are constants. PARALLELOGRAM is
 * drawn as a sharp-cornered rectangle and its slant is composed in
 * via a transform skewX at the call site (see `transformForShape`).
 */
function borderRadiusForShape(shape: ShapeKind, bbox: Rect): number {
  switch (shape) {
    case ShapeKind.OVAL:
      return bbox.h / 2;
    case ShapeKind.RECTANGLE:
    case ShapeKind.PARALLELOGRAM:
      return 0;
    case ShapeKind.ROUNDED_RECTANGLE:
      return SIBLING_CORNER_RADIUS;
    default:
      throw new Error(
        `MindmapCanvas.borderRadiusForShape: unknown shape kind ${shape as number}`,
      );
  }
}

/**
 * Per-shape transform array applied to the NodeFrame's outline View.
 * Only PARALLELOGRAM uses a non-identity transform — skewX shears the
 * rectangle horizontally so its top edge sits to the right of its
 * bottom edge, matching the inscribed-skew polygon emitted by
 * parallelogramPoints. The skew angle (12°) is tuned so a 220×96
 * bbox produces a ~20 px horizontal offset, the same value as
 * PARALLELOGRAM_SKEW_PX in nodeFrame.ts (atan(20/96) ≈ 11.8°).
 */
function transformForShape(shape: ShapeKind): {skewX: string}[] | undefined {
  if (shape === ShapeKind.PARALLELOGRAM) {
    return [{skewX: '-12deg'}];
  }
  return undefined;
}

const styles = StyleSheet.create({
  root: {
    flex: 1,
    backgroundColor: '#fff',
  },
  topBar: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: 16,
    paddingVertical: 12,
    borderBottomWidth: 1,
    borderBottomColor: '#ccc',
  },
  topBarSpacer: {
    flex: 1,
  },
  topBarBtn: {
    paddingVertical: 8,
    paddingHorizontal: 16,
    borderWidth: 1,
    borderColor: '#000',
    borderRadius: 4,
  },
  topBarBtnAdjacent: {
    marginLeft: 8,
  },
  topBarBtnPressed: {
    backgroundColor: '#eee',
  },
  topBarBtnDisabled: {
    borderColor: '#999',
  },
  // Armed state for the Clear button: inverted black-on-white → white-
  // on-black so the "this is about to destroy your work" signal is
  // impossible to miss even on e-ink.
  topBarBtnArmed: {
    backgroundColor: '#000',
    borderColor: '#000',
  },
  topBarBtnText: {
    fontSize: 14,
    fontWeight: '500',
    color: '#000',
  },
  topBarBtnTextArmed: {
    color: '#fff',
  },
  topBarBtnTextDisabled: {
    color: '#999',
  },
  errorBanner: {
    paddingVertical: 8,
    paddingHorizontal: 16,
    backgroundColor: '#000',
    borderBottomWidth: 1,
    borderBottomColor: '#000',
  },
  errorText: {
    color: '#fff',
    fontSize: 13,
    fontWeight: '500',
  },
  surface: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    overflow: 'hidden',
  },
  stageWrapper: {
    // Layout-only wrapper; the dynamic `transform: [{scale: fitScale}]`
    // is composed into a style array so the no-inline-styles lint
    // rule stays happy without having to disable it per-line.
  },
  nodeFrame: {
    position: 'absolute',
    borderColor: '#000',
    backgroundColor: '#fff',
    alignItems: 'center',
    justifyContent: 'center',
    paddingHorizontal: 8,
  },
  nodeLabel: {
    color: '#000',
    fontSize: 14,
    textAlign: 'center',
  },
  // Label-edit modal — overlay wrapper, dimmed backdrop, centred
  // card. modalOverlay is a fullscreen positioned layer that holds
  // both the backdrop (blocks interaction with the canvas behind)
  // and the card. The wrapper's pointerEvents="box-none" lets the
  // backdrop catch every tap that misses the card, but the wrapper
  // itself doesn't intercept anything outside its child views.
  modalOverlay: {
    position: 'absolute',
    left: 0,
    top: 0,
    right: 0,
    bottom: 0,
    alignItems: 'center',
    justifyContent: 'center',
    paddingHorizontal: 24,
  },
  modalBackdrop: {
    position: 'absolute',
    left: 0,
    top: 0,
    right: 0,
    bottom: 0,
    backgroundColor: 'rgba(0, 0, 0, 0.35)',
  },
  modalCard: {
    width: '100%',
    maxWidth: 480,
    backgroundColor: '#fff',
    borderRadius: 12,
    paddingVertical: 20,
    paddingHorizontal: 20,
    borderWidth: 1,
    borderColor: '#000',
  },
  modalTitle: {
    fontSize: 18,
    fontWeight: 'bold',
    color: '#000',
    marginBottom: 12,
  },
  modalInput: {
    minHeight: 96,
    borderWidth: 1,
    borderColor: '#000',
    borderRadius: 6,
    paddingHorizontal: 10,
    paddingVertical: 8,
    fontSize: 16,
    color: '#000',
    marginBottom: 16,
  },
  modalRow: {
    flexDirection: 'row',
    justifyContent: 'flex-end',
  },
  modalBtn: {
    paddingVertical: 10,
    paddingHorizontal: 18,
    borderRadius: 8,
    borderWidth: 1,
    borderColor: '#000',
    marginLeft: 12,
  },
  modalBtnPrimary: {
    backgroundColor: '#000',
  },
  modalBtnSecondary: {
    backgroundColor: '#fff',
  },
  modalBtnPressed: {
    opacity: 0.7,
  },
  modalBtnDisabled: {
    backgroundColor: '#ddd',
    borderColor: '#888',
  },
  modalBtnText: {
    fontSize: 16,
    color: '#000',
  },
  modalBtnTextOnPrimary: {
    color: '#fff',
  },
  modalBtnTextDisabled: {
    color: '#888',
  },
  connector: {
    position: 'absolute',
    backgroundColor: '#000',
  },
  iconButton: {
    position: 'absolute',
    width: ICON_SIZE,
    height: ICON_SIZE,
    borderWidth: 1,
    borderColor: '#000',
    borderRadius: ICON_SIZE / 2,
    backgroundColor: '#fff',
    alignItems: 'center',
    justifyContent: 'center',
  },
  iconButtonPrimary: {
    borderWidth: 2,
  },
  iconGlyph: {
    fontSize: 16,
    fontWeight: '500',
    color: '#000',
    // Keeps the chevron vertically centred on Android where the
    // default Text baseline drifts toward the descender.
    lineHeight: 18,
  },
  iconGlyphPrimary: {
    fontWeight: '700',
  },
  // Add Child / Add Sibling pill buttons — small pills carrying a
  // single directional glyph (`↳` for child, `→` for sibling). Same
  // absolute positioning convention as iconButton (caller composes
  // left/top). The glyph approach replaces the v1.0 "+ Child" /
  // "+ Sibling" word labels: shorter, language-agnostic, and easier
  // to read at small sizes on e-ink.
  addPill: {
    position: 'absolute',
    width: ADD_PILL_WIDTH,
    height: ADD_PILL_HEIGHT,
    borderWidth: 1,
    borderColor: '#000',
    borderRadius: ADD_PILL_HEIGHT / 2,
    backgroundColor: '#fff',
    alignItems: 'center',
    justifyContent: 'center',
  },
  addPillPrimary: {
    backgroundColor: '#000',
    borderWidth: 2,
  },
  addPillGlyph: {
    // Glyph slightly larger than the topBarBtn body text so the
    // single-character label still reads clearly at the pill's modest
    // 36×28 footprint. Bumped lineHeight keeps `→` and `↳` vertically
    // centred on Android, where Text baselines drift toward the
    // descender by default.
    fontSize: 18,
    fontWeight: '600',
    color: '#000',
    lineHeight: 22,
    textAlign: 'center',
  },
  addPillGlyphPrimary: {
    color: '#fff',
    fontWeight: '700',
  },
  collapseButton: {
    position: 'absolute',
    width: ICON_SIZE,
    height: ICON_SIZE,
    alignItems: 'center',
    justifyContent: 'center',
  },
  collapseDot: {
    width: 14,
    height: 14,
    borderRadius: 7,
    backgroundColor: '#000',
  },
  collapseRing: {
    width: ICON_SIZE,
    height: ICON_SIZE,
    borderRadius: ICON_SIZE / 2,
    borderWidth: 2,
    borderColor: '#000',
    backgroundColor: '#fff',
    alignItems: 'center',
    justifyContent: 'center',
  },
  collapseBadgeText: {
    fontSize: 11,
    fontWeight: '600',
    color: '#000',
  },
  deleteButton: {
    backgroundColor: '#fff',
  },
});
