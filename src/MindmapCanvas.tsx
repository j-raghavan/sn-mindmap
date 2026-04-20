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
import React, {useCallback, useMemo, useReducer, useState} from 'react';
import {
  type LayoutChangeEvent,
  Pressable,
  StyleSheet,
  Text,
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

export type MindmapCanvasProps = {
  /**
   * Optional preloaded tree for the edit round-trip (§F-ED-6) or for
   * on-device authoring tests. Undefined → the canvas creates a
   * fresh tree with just the root Oval.
   */
  initialTree?: Tree;
};

/**
 * Reducer actions. Each action describes a single user gesture on
 * the canvas — the reducer turns that into a cloned-then-mutated
 * Tree so React's state identity comparison notices the change.
 */
type Action =
  | {type: 'ADD_CHILD'; parentId: NodeId}
  | {type: 'ADD_SIBLING'; nodeId: NodeId}
  | {type: 'DELETE_SUBTREE'; nodeId: NodeId}
  | {type: 'TOGGLE_COLLAPSE'; nodeId: NodeId};

/**
 * Pure reducer: clones the previous tree and applies the mutators
 * from ./model/tree. The mutators themselves are imperative for
 * testability but callers outside this module always see an
 * immutable-style state transition.
 */
function treeReducer(state: Tree, action: Action): Tree {
  const next = cloneTree(state);
  switch (action.type) {
    case 'ADD_CHILD':
      addChild(next, action.parentId);
      return next;
    case 'ADD_SIBLING':
      addSibling(next, action.nodeId);
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

  const handleSelect = useCallback((nodeId: NodeId) => {
    setSelectedId(prev => (prev === nodeId ? null : nodeId));
  }, []);

  const handleBackgroundPress = useCallback(() => {
    setSelectedId(null);
  }, []);

  const handleAddChild = useCallback((parentId: NodeId) => {
    dispatch({type: 'ADD_CHILD', parentId});
  }, []);

  const handleAddSibling = useCallback((nodeId: NodeId) => {
    dispatch({type: 'ADD_SIBLING', nodeId});
  }, []);

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
        <View style={styles.topBarSpacer} />
        {/*
         * Insert button is a disabled stub — the insert pipeline
         * lands in Phase 2 (§F-IN-*). Kept visible so the on-device
         * layout matches the final §F-AC-8 top bar, which makes it
         * immediately obvious if the bar is clipped or misaligned.
         */}
        <View
          accessibilityLabel="Insert (disabled)"
          style={[styles.topBarBtn, styles.topBarBtnDisabled]}>
          <Text style={[styles.topBarBtnText, styles.topBarBtnTextDisabled]}>
            Insert
          </Text>
        </View>
      </View>
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
    </View>
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
      ]}
    />
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
       * Add Child — chevron "›" to the right, thicker stroke (the
       * "primary" action per §F-AC-5).
       */}
      <Pressable
        accessibilityLabel={`add-child-${node.id}`}
        onPress={() => onAddChild(node.id)}
        style={[
          styles.iconButton,
          styles.iconButtonPrimary,
          {
            left: stageLeft + bbox.w + ICON_GAP,
            top: stageTop + bbox.h / 2 - ICON_SIZE / 2,
          },
        ]}>
        <Text style={[styles.iconGlyph, styles.iconGlyphPrimary]}>{'\u203A'}</Text>
      </Pressable>

      {/* Add Sibling — chevron "⌄" below, thinner stroke. Hidden on the root. */}
      {!isRoot && (
        <Pressable
          accessibilityLabel={`add-sibling-${node.id}`}
          onPress={() => onAddSibling(node.id)}
          style={[
            styles.iconButton,
            {
              left: stageLeft + bbox.w / 2 - ICON_SIZE / 2,
              top: stageTop + bbox.h + ICON_GAP,
            },
          ]}>
          <Text style={styles.iconGlyph}>{'\u02C5'}</Text>
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
 * render as stadiums), the others are constants.
 */
function borderRadiusForShape(shape: ShapeKind, bbox: Rect): number {
  switch (shape) {
    case ShapeKind.OVAL:
      return bbox.h / 2;
    case ShapeKind.RECTANGLE:
      return 0;
    case ShapeKind.ROUNDED_RECTANGLE:
      return SIBLING_CORNER_RADIUS;
    default:
      throw new Error(
        `MindmapCanvas.borderRadiusForShape: unknown shape kind ${shape as number}`,
      );
  }
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
  topBarBtnPressed: {
    backgroundColor: '#eee',
  },
  topBarBtnDisabled: {
    borderColor: '#999',
  },
  topBarBtnText: {
    fontSize: 14,
    fontWeight: '500',
    color: '#000',
  },
  topBarBtnTextDisabled: {
    color: '#999',
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
