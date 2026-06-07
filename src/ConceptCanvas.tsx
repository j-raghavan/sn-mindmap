/**
 * Concept-map (DAG) authoring canvas (§14.2 / §14.4). Sibling to
 * MindmapCanvas — a SEPARATE component so the mindmap path stays
 * byte-identical (architect's call). Shares only the visual idioms
 * (pure React Native Views, no SVG; pill affordances; fit-to-view
 * transform), reimplemented here over the concept Graph model rather
 * than refactoring MindmapCanvas.
 *
 * Per-node affordances (§14.4):
 *   - Add Child  (F-AC-DAG-1) — new node with this node as sole parent.
 *   - Add Parent (F-AC-DAG-2) — new node with this node as sole child
 *     (the dual gesture; tap son, Add Parent twice → Father + Mother).
 *   - Concept link (F-AC-DAG-3) — two-tap "link to existing": arm via
 *     the top-bar pill, tap source then target; useConceptLinkMode owns
 *     the state machine and the cycle/duplicate/self-loop gate.
 *   - Delete node (F-AC-DAG-4) — SINGLE node, orphan-aware (children of
 *     the deleted node keep their other parents). A two-tap confirm
 *     guards a node with ≥ 2 incoming or outgoing edges so a careless
 *     tap can't silently orphan a chunk of the graph.
 *   - NO Add Sibling (F-AC-DAG-5) — "sibling" has no meaning in a DAG.
 *
 * Shape is derived on read via conceptShape(node) (OVAL when parentless,
 * else RECTANGLE) — never stored (§14.3 deviation, see graph.ts).
 *
 * Insert hands off to insertConceptMap (§14.6): force-directed layout,
 * one connector per parent edge, no auto-expand.
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
  addNodeAsParent,
  addNodeWithParent,
  addParentEdge,
  cloneGraph,
  conceptShape,
  createGraph,
  deleteNode,
  type ConceptNode,
  type Graph,
} from './model/graph';
import {ShapeKind, type NodeId} from './model/tree';
import {forceDirectedLayout} from './layout/forceDirected';
import type {LayoutResult} from './layout/radial';
import {insertConceptMap} from './insert';
import {ROOT_PEN_WIDTH, STANDARD_PEN_WIDTH} from './layout/constants';
import type {Point, Rect} from './geometry';
import {useConceptLinkMode} from './useConceptLinkMode';

// ---------------------------------------------------------------------------
// Rendering constants (mirror MindmapCanvas so the two canvases match
// side-by-side on-device; kept local to avoid widening MindmapCanvas's
// private surface, per the lead's no-export-widening rule).
// ---------------------------------------------------------------------------

const STROKE_PX_PER_PENWIDTH = 1 / 40;
const MIN_STROKE_PX = 2;
const ICON_SIZE = 28;
const ICON_GAP = 8;
const ADD_PILL_HEIGHT = 28;
const ADD_PILL_WIDTH = 36;
const VIEWPORT_PADDING = 24;

/** Add-Child glyph (drop down a level, then over) — mirrors MindmapCanvas. */
const CHILD_GLYPH = '↳'; // ↳
/** Add-Parent glyph (up a level) — the dual of Add Child. */
const PARENT_GLYPH = '↱'; // ↱

// ---------------------------------------------------------------------------
// Reducer
// ---------------------------------------------------------------------------

type Action =
  | {type: 'ADD_CHILD_NODE'; parentId: NodeId; label: string}
  | {type: 'ADD_PARENT_NODE'; childId: NodeId; label: string}
  | {type: 'ADD_PARENT_EDGE'; childId: NodeId; parentId: NodeId}
  | {type: 'SET_LABEL'; nodeId: NodeId; label: string}
  | {type: 'DELETE_NODE'; nodeId: NodeId}
  | {type: 'CLEAR'};

/**
 * Pending label-modal context. `kind` drives the modal title and which
 * action fires on Create:
 *   'root'   — initial central idea (handled by the Canvas wrapper, but
 *              kept here so a re-seed via Clear reopens it).
 *   'child'  — Add Child target node.
 *   'parent' — Add Parent target node.
 */
type PendingMode =
  | {kind: 'root'; nodeId: NodeId}
  | {kind: 'child'; nodeId: NodeId}
  | {kind: 'parent'; nodeId: NodeId};

function graphReducer(state: Graph, action: Action): Graph {
  switch (action.type) {
    case 'CLEAR':
      return createGraph();
    case 'ADD_CHILD_NODE': {
      const next = cloneGraph(state);
      addNodeWithParent(next, action.parentId, action.label);
      return next;
    }
    case 'ADD_PARENT_NODE': {
      const next = cloneGraph(state);
      addNodeAsParent(next, action.childId, action.label);
      return next;
    }
    case 'ADD_PARENT_EDGE': {
      const next = cloneGraph(state);
      addParentEdge(next, action.childId, action.parentId);
      return next;
    }
    case 'SET_LABEL': {
      const next = cloneGraph(state);
      const node = next.nodesById.get(action.nodeId);
      if (node) {
        const trimmed = action.label.trim();
        node.label = trimmed.length > 0 ? trimmed : undefined;
      }
      return next;
    }
    case 'DELETE_NODE': {
      const next = cloneGraph(state);
      deleteNode(next, action.nodeId);
      return next;
    }
    default:
      // Exhaustiveness guard — the Action union is closed.
      throw new Error(
        `graphReducer: unknown action ${(action as {type: string}).type}`,
      );
  }
}

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

export type ConceptCanvasProps = {
  /** Seed graph (e.g. a labeled root from the central-idea modal). */
  initialGraph?: Graph;
};

export default function ConceptCanvas({
  initialGraph,
}: ConceptCanvasProps = {}): React.JSX.Element {
  const [graph, dispatch] = useReducer(graphReducer, initialGraph, seed =>
    seed ? cloneGraph(seed) : createGraph(),
  );

  const [selectedId, setSelectedId] = useState<NodeId | null>(null);
  const [pending, setPending] = useState<PendingMode | null>(null);
  const [deleteArmId, setDeleteArmId] = useState<NodeId | null>(null);
  const [isInserting, setIsInserting] = useState(false);
  const [insertError, setInsertError] = useState<string | null>(null);
  const insertingRef = useRef(false);
  const errorTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const [viewport, setViewport] = useState<{w: number; h: number}>({w: 0, h: 0});
  const handleSurfaceLayout = useCallback((e: LayoutChangeEvent) => {
    const {width, height} = e.nativeEvent.layout;
    setViewport(prev =>
      prev.w === width && prev.h === height ? prev : {w: width, h: height},
    );
  }, []);

  const layout = useMemo(() => forceDirectedLayout(graph), [graph]);

  const linkMode = useConceptLinkMode({
    graph,
    onAddLink: useCallback(
      (source: NodeId, target: NodeId) =>
        dispatch({type: 'ADD_PARENT_EDGE', childId: target, parentId: source}),
      [],
    ),
  });

  useEffect(() => {
    return () => {
      if (errorTimerRef.current) {
        clearTimeout(errorTimerRef.current);
      }
    };
  }, []);

  // Fit-to-view scale so the whole graph stays visible (mirrors
  // MindmapCanvas's auto-fit; capped at 1 for small graphs).
  const fitScale = useMemo(() => {
    const {w, h} = viewport;
    const {unionBbox} = layout;
    if (w === 0 || h === 0 || unionBbox.w === 0 || unionBbox.h === 0) {
      return 1;
    }
    const availW = Math.max(1, w - 2 * VIEWPORT_PADDING);
    const availH = Math.max(1, h - 2 * VIEWPORT_PADDING);
    return Math.min(1, availW / unionBbox.w, availH / unionBbox.h);
  }, [viewport, layout]);

  const handleSelect = useCallback(
    (nodeId: NodeId) => {
      if (linkMode.isArmed) {
        linkMode.selectForLink(nodeId);
        return;
      }
      setDeleteArmId(null);
      setSelectedId(prev => (prev === nodeId ? null : nodeId));
    },
    [linkMode],
  );

  const handleBackgroundPress = useCallback(() => {
    if (linkMode.isArmed) {
      linkMode.reset();
      return;
    }
    setSelectedId(null);
    setDeleteArmId(null);
  }, [linkMode]);

  const handleAddChild = useCallback((nodeId: NodeId) => {
    setPending({kind: 'child', nodeId});
  }, []);

  const handleAddParent = useCallback((nodeId: NodeId) => {
    setPending({kind: 'parent', nodeId});
  }, []);

  // Single-node delete (F-AC-DAG-4). A two-tap confirm guards nodes with
  // ≥ 2 incoming OR outgoing edges (the orphan-risk threshold from §14.4).
  const handleDelete = useCallback(
    (nodeId: NodeId) => {
      const node = graph.nodesById.get(nodeId);
      const heavy =
        !!node && (node.parentIds.length >= 2 || node.childIds.length >= 2);
      if (heavy && deleteArmId !== nodeId) {
        setDeleteArmId(nodeId);
        return;
      }
      dispatch({type: 'DELETE_NODE', nodeId});
      setSelectedId(null);
      setDeleteArmId(null);
    },
    [graph, deleteArmId],
  );

  const handleLabelCreate = useCallback(
    (label: string) => {
      if (!pending) {
        return;
      }
      if (pending.kind === 'child') {
        dispatch({type: 'ADD_CHILD_NODE', parentId: pending.nodeId, label});
      } else if (pending.kind === 'parent') {
        dispatch({type: 'ADD_PARENT_NODE', childId: pending.nodeId, label});
      } else {
        dispatch({type: 'SET_LABEL', nodeId: pending.nodeId, label});
      }
      setPending(null);
    },
    [pending],
  );

  const handleLabelCancel = useCallback(() => setPending(null), []);

  const handleClear = useCallback(() => {
    dispatch({type: 'CLEAR'});
    setSelectedId(null);
    setDeleteArmId(null);
    linkMode.reset();
  }, [linkMode]);

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
      await insertConceptMap({graph});
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Insert failed';
      setInsertError(message);
      errorTimerRef.current = setTimeout(() => setInsertError(null), 2000);
    } finally {
      insertingRef.current = false;
      setIsInserting(false);
    }
  }, [graph]);

  const canLink = graph.nodesById.size >= 2;

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
        <Pressable
          accessibilityRole="button"
          accessibilityLabel="Clear"
          accessibilityState={{disabled: isInserting}}
          disabled={isInserting}
          onPress={handleClear}
          style={({pressed}) => [
            styles.topBarBtn,
            styles.topBarBtnAdjacent,
            pressed && !isInserting && styles.topBarBtnPressed,
          ]}>
          <Text style={styles.topBarBtnText}>Clear</Text>
        </Pressable>
        <Pressable
          accessibilityRole="button"
          accessibilityLabel={
            linkMode.isArmed ? 'Cancel Concept link' : 'Concept link'
          }
          accessibilityState={{disabled: isInserting || !canLink}}
          disabled={isInserting || !canLink}
          onPress={linkMode.toggleArm}
          style={({pressed}) => [
            styles.topBarBtn,
            styles.topBarBtnAdjacent,
            pressed && !isInserting && canLink && styles.topBarBtnPressed,
            linkMode.isArmed && styles.topBarBtnArmed,
          ]}>
          <Text
            style={[
              styles.topBarBtnText,
              linkMode.isArmed && styles.topBarBtnTextArmed,
            ]}>
            {linkMode.isArmed ? 'Cancel Concept link' : 'Concept link'}
          </Text>
        </Pressable>
        <View style={styles.topBarSpacer} />
        <Pressable
          accessibilityRole="button"
          accessibilityLabel="Insert"
          accessibilityState={{disabled: isInserting}}
          disabled={isInserting}
          onPress={triggerInsert}
          style={({pressed}) => [
            styles.topBarBtn,
            styles.insertBtn,
            pressed && !isInserting && styles.topBarBtnPressed,
          ]}>
          <Text style={[styles.topBarBtnText, styles.insertBtnText]}>
            {isInserting ? 'Inserting…' : 'Insert'}
          </Text>
        </Pressable>
      </View>
      {insertError !== null && (
        <View accessibilityLabel="insert-error" style={styles.errorBanner}>
          <Text style={styles.errorText}>{insertError}</Text>
        </View>
      )}
      {linkMode.linkError !== null && (
        <View accessibilityLabel="link-error" style={styles.errorBanner}>
          <Text style={styles.errorText}>{linkMode.linkError}</Text>
        </View>
      )}
      <Pressable
        accessibilityLabel="concept-background"
        style={styles.surface}
        onLayout={handleSurfaceLayout}
        onPress={handleBackgroundPress}>
        <View
          accessibilityLabel="concept-fit-wrapper"
          style={[styles.stageWrapper, {transform: [{scale: fitScale}]}]}>
          <ConceptStage
            graph={graph}
            layout={layout}
            selectedId={selectedId}
            armed={linkMode.isArmed}
            sourceId={linkMode.sourceId}
            deleteArmId={deleteArmId}
            onSelect={handleSelect}
            onAddChild={handleAddChild}
            onAddParent={handleAddParent}
            onDelete={handleDelete}
          />
        </View>
      </Pressable>
      <ConceptLabelModal
        pending={pending}
        graph={graph}
        onCreate={handleLabelCreate}
        onCancel={handleLabelCancel}
      />
    </View>
  );
}

// ---------------------------------------------------------------------------
// Stage + node rendering
// ---------------------------------------------------------------------------

type ConceptStageProps = {
  graph: Graph;
  layout: LayoutResult;
  selectedId: NodeId | null;
  armed: boolean;
  sourceId: NodeId | null;
  deleteArmId: NodeId | null;
  onSelect: (id: NodeId) => void;
  onAddChild: (id: NodeId) => void;
  onAddParent: (id: NodeId) => void;
  onDelete: (id: NodeId) => void;
};

function ConceptStage({
  graph,
  layout,
  selectedId,
  armed,
  sourceId,
  deleteArmId,
  onSelect,
  onAddChild,
  onAddParent,
  onDelete,
}: ConceptStageProps): React.JSX.Element {
  const {unionBbox} = layout;
  const origin: Point = {x: unionBbox.x, y: unionBbox.y};

  const nodes = [...graph.nodesById.keys()]
    .sort((a, b) => a - b)
    .map(id => graph.nodesById.get(id)!);

  return (
    <View
      accessibilityLabel="concept-stage"
      style={{width: unionBbox.w, height: unionBbox.h}}>
      {/* One connector per parent edge (child → parent). */}
      {nodes.flatMap(node => {
        const childCenter = layout.centers.get(node.id);
        if (!childCenter) {
          return [];
        }
        return [...node.parentIds].sort((a, b) => a - b).flatMap(parentId => {
          const parentCenter = layout.centers.get(parentId);
          if (!parentCenter) {
            return [];
          }
          return [
            <Connector
              key={`edge-${node.id}-${parentId}`}
              from={parentCenter}
              to={childCenter}
              origin={origin}
            />,
          ];
        });
      })}
      {nodes.map(node => {
        const bbox = layout.bboxes.get(node.id);
        if (!bbox) {
          return null;
        }
        return (
          <ConceptNodeFrame
            key={`node-${node.id}`}
            node={node}
            bbox={bbox}
            origin={origin}
            isSelected={selectedId === node.id}
            isLinkSource={armed && sourceId === node.id}
            onPress={onSelect}
          />
        );
      })}
      {!armed &&
        nodes.map(node => {
          const bbox = layout.bboxes.get(node.id);
          if (!bbox) {
            return null;
          }
          return (
            <ConceptNodeActions
              key={`actions-${node.id}`}
              node={node}
              bbox={bbox}
              origin={origin}
              isSelected={selectedId === node.id}
              isDeleteArmed={deleteArmId === node.id}
              onAddChild={onAddChild}
              onAddParent={onAddParent}
              onDelete={onDelete}
            />
          );
        })}
    </View>
  );
}

function ConceptNodeFrame({
  node,
  bbox,
  origin,
  isSelected,
  isLinkSource,
  onPress,
}: {
  node: ConceptNode;
  bbox: Rect;
  origin: Point;
  isSelected: boolean;
  isLinkSource: boolean;
  onPress: (id: NodeId) => void;
}): React.JSX.Element {
  const shape = conceptShape(node);
  const penWidth = shape === ShapeKind.OVAL ? ROOT_PEN_WIDTH : STANDARD_PEN_WIDTH;
  const borderWidth =
    penWidthToPx(penWidth) * (isSelected || isLinkSource ? 2 : 1);
  const borderRadius = shape === ShapeKind.OVAL ? bbox.h / 2 : 0;
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
          borderRadius,
        },
      ]}>
      {node.label !== undefined && node.label.length > 0 && (
        <Text
          accessibilityLabel={`node-${node.id}-label`}
          numberOfLines={2}
          ellipsizeMode="tail"
          style={styles.nodeLabel}>
          {node.label}
        </Text>
      )}
    </Pressable>
  );
}

function ConceptNodeActions({
  node,
  bbox,
  origin,
  isSelected,
  isDeleteArmed,
  onAddChild,
  onAddParent,
  onDelete,
}: {
  node: ConceptNode;
  bbox: Rect;
  origin: Point;
  isSelected: boolean;
  isDeleteArmed: boolean;
  onAddChild: (id: NodeId) => void;
  onAddParent: (id: NodeId) => void;
  onDelete: (id: NodeId) => void;
}): React.JSX.Element {
  const stageLeft = bbox.x - origin.x;
  const stageTop = bbox.y - origin.y;
  return (
    <React.Fragment>
      {/* Add Child — filled pill, right of the node (F-AC-DAG-1). */}
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

      {/* Add Parent — outlined pill, above the node (F-AC-DAG-2, the dual). */}
      <Pressable
        accessibilityLabel={`add-parent-${node.id}`}
        onPress={() => onAddParent(node.id)}
        style={[
          styles.addPill,
          {
            left: stageLeft + bbox.w / 2 - ADD_PILL_WIDTH / 2,
            top: stageTop - ADD_PILL_HEIGHT - ICON_GAP,
          },
        ]}>
        <Text style={styles.addPillGlyph}>{PARENT_GLYPH}</Text>
      </Pressable>

      {/* Delete — × top-right, selection-gated. Two-tap confirm for a
          node with ≥ 2 edges (label flips to "×!" while armed). */}
      {isSelected && (
        <Pressable
          accessibilityLabel={
            isDeleteArmed ? `confirm-delete-${node.id}` : `delete-${node.id}`
          }
          onPress={() => onDelete(node.id)}
          style={[
            styles.iconButton,
            styles.deleteButton,
            isDeleteArmed && styles.deleteButtonArmed,
            {
              left: stageLeft + bbox.w - ICON_SIZE / 2,
              top: stageTop - ICON_SIZE / 2,
            },
          ]}>
          <Text style={styles.iconGlyph}>{isDeleteArmed ? '×!' : '×'}</Text>
        </Pressable>
      )}
    </React.Fragment>
  );
}

/**
 * Thin rotated View standing in for a straight-line connector between two
 * node centres (mirrors MindmapCanvas's Connector — pure View, no SVG).
 */
function Connector({
  from,
  to,
  origin,
}: {
  from: Point;
  to: Point;
  origin: Point;
}): React.JSX.Element {
  const x1 = from.x - origin.x;
  const y1 = from.y - origin.y;
  const x2 = to.x - origin.x;
  const y2 = to.y - origin.y;
  const dx = x2 - x1;
  const dy = y2 - y1;
  const length = Math.hypot(dx, dy);
  const angleDeg = (Math.atan2(dy, dx) * 180) / Math.PI;
  const midX = (x1 + x2) / 2;
  const midY = (y1 + y2) / 2;
  const thickness = penWidthToPx(STANDARD_PEN_WIDTH);
  return (
    <View
      accessibilityLabel="concept-connector"
      style={[
        styles.connector,
        {
          width: length,
          height: thickness,
          left: midX - length / 2,
          top: midY - thickness / 2,
          transform: [{rotate: `${angleDeg}deg`}],
        },
      ]}
    />
  );
}

// ---------------------------------------------------------------------------
// Label modal
// ---------------------------------------------------------------------------

function ConceptLabelModal({
  pending,
  graph,
  onCreate,
  onCancel,
}: {
  pending: PendingMode | null;
  graph: Graph;
  onCreate: (label: string) => void;
  onCancel: () => void;
}): React.JSX.Element {
  const seed = useMemo(() => {
    if (!pending) {
      return '';
    }
    if (pending.kind === 'root') {
      return graph.nodesById.get(pending.nodeId)?.label ?? '';
    }
    return '';
  }, [pending, graph]);

  const [draft, setDraft] = useState(seed);
  useEffect(() => {
    setDraft(seed);
  }, [seed]);

  if (pending === null) {
    return <></>;
  }
  const title =
    pending.kind === 'child'
      ? 'Add child'
      : pending.kind === 'parent'
        ? 'Add parent'
        : 'Central idea';
  const trimmed = draft.trim();
  const canCreate = trimmed.length > 0;
  return (
    <View
      style={styles.modalOverlay}
      pointerEvents="box-none"
      accessibilityViewIsModal>
      <View style={styles.modalBackdrop} accessibilityLabel="label-modal-backdrop" />
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

// ---------------------------------------------------------------------------
// Shared helpers
// ---------------------------------------------------------------------------

function penWidthToPx(penWidth: number): number {
  return Math.max(MIN_STROKE_PX, penWidth * STROKE_PX_PER_PENWIDTH);
}

const styles = StyleSheet.create({
  root: {flex: 1, backgroundColor: '#fff'},
  topBar: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: 16,
    paddingVertical: 12,
    borderBottomWidth: 1,
    borderBottomColor: '#ccc',
  },
  topBarBtn: {
    paddingHorizontal: 14,
    paddingVertical: 8,
    borderRadius: 6,
    borderWidth: 1,
    borderColor: '#333',
  },
  topBarBtnAdjacent: {marginLeft: 8},
  topBarBtnPressed: {backgroundColor: '#eee'},
  topBarBtnArmed: {backgroundColor: '#333'},
  topBarBtnText: {fontSize: 16, color: '#111'},
  topBarBtnTextArmed: {color: '#fff'},
  topBarSpacer: {flex: 1},
  insertBtn: {backgroundColor: '#111', borderColor: '#111'},
  insertBtnText: {color: '#fff'},
  errorBanner: {
    backgroundColor: '#fde8e8',
    paddingHorizontal: 16,
    paddingVertical: 8,
    borderBottomWidth: 1,
    borderBottomColor: '#f0b4b4',
  },
  errorText: {color: '#a11', fontSize: 14},
  surface: {flex: 1, alignItems: 'center', justifyContent: 'center'},
  stageWrapper: {alignItems: 'flex-start', justifyContent: 'flex-start'},
  nodeFrame: {
    position: 'absolute',
    borderColor: '#000',
    backgroundColor: '#fff',
    alignItems: 'center',
    justifyContent: 'center',
    paddingHorizontal: 6,
  },
  nodeLabel: {fontSize: 16, color: '#111', textAlign: 'center'},
  connector: {position: 'absolute', backgroundColor: '#000'},
  addPill: {
    position: 'absolute',
    width: ADD_PILL_WIDTH,
    height: ADD_PILL_HEIGHT,
    borderRadius: ADD_PILL_HEIGHT / 2,
    borderWidth: 1,
    borderColor: '#333',
    backgroundColor: '#fff',
    alignItems: 'center',
    justifyContent: 'center',
  },
  addPillPrimary: {backgroundColor: '#111', borderColor: '#111'},
  addPillGlyph: {fontSize: 16, color: '#111'},
  addPillGlyphPrimary: {color: '#fff'},
  iconButton: {
    position: 'absolute',
    width: ICON_SIZE,
    height: ICON_SIZE,
    borderRadius: ICON_SIZE / 2,
    alignItems: 'center',
    justifyContent: 'center',
  },
  deleteButton: {backgroundColor: '#a11'},
  deleteButtonArmed: {backgroundColor: '#600'},
  iconGlyph: {color: '#fff', fontSize: 16, fontWeight: '700'},
  modalOverlay: {...StyleSheet.absoluteFillObject, alignItems: 'center', justifyContent: 'center'},
  modalBackdrop: {...StyleSheet.absoluteFillObject, backgroundColor: 'rgba(0,0,0,0.3)'},
  modalCard: {
    width: '80%',
    backgroundColor: '#fff',
    borderRadius: 10,
    padding: 20,
    borderWidth: 1,
    borderColor: '#ccc',
  },
  modalTitle: {fontSize: 18, fontWeight: '700', color: '#111', marginBottom: 12},
  modalInput: {
    borderWidth: 1,
    borderColor: '#999',
    borderRadius: 6,
    padding: 10,
    fontSize: 16,
    color: '#111',
    minHeight: 44,
  },
  modalRow: {flexDirection: 'row', justifyContent: 'flex-end', marginTop: 16},
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
