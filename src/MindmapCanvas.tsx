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
 * Per-node affordances (§F-AC-5, Phase 1.4b):
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
 * Phase 1.4a (this revision): READ-ONLY render of a tree. No
 * mutations, no action icons, no pan/zoom — just a canvas that
 * paints the passed-in tree so Phase 1.1-1.3 can be validated
 * on-device. The Cancel button is the only interactive affordance,
 * matching §F-AC-8 minus the Insert hand-off (deferred to Phase 2).
 *
 * Rendering approach: pure React Native Views. No react-native-svg —
 * sn-shapes avoids that dependency for the same reason (native
 * linking on the Supernote firmware is unverified). Node outlines
 * use `borderRadius`/`borderWidth`; connectors are thin black Views
 * rotated into place. This mirrors the sn-shapes StrokePreview
 * pattern so the two plugins stay visually consistent on-device.
 */
import React, {useMemo} from 'react';
import {Pressable, StyleSheet, Text, View} from 'react-native';
import {PluginManager} from 'sn-plugin-lib';
import {
  createTree,
  ShapeKind,
  type MindmapNode,
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

export type MindmapCanvasProps = {
  /**
   * Optional preloaded tree for the edit round-trip (§F-ED-6) or for
   * on-device authoring tests before Phase 1.4b wires up mutations.
   * Undefined → the canvas creates a fresh tree with just the root
   * Oval.
   */
  initialTree?: Tree;
};

export default function MindmapCanvas({
  initialTree,
}: MindmapCanvasProps = {}): React.JSX.Element {
  // useMemo so repeated renders don't re-run layout; layout is pure
  // and deterministic but the maps it allocates are not cheap on
  // larger trees. The Phase 1.4b mutation reducer will replace
  // `initialTree` with state + cloneTree, at which point the memo
  // dep list becomes the state identity.
  const tree = useMemo(() => initialTree ?? createTree(), [initialTree]);
  const layout = useMemo(() => radialLayout(tree), [tree]);

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
         * Insert button is a disabled stub in Phase 1.4a — the insert
         * pipeline lands in Phase 2 (§F-IN-*). Kept visible so the
         * on-device layout matches the final §F-AC-8 top bar, which
         * makes it immediately obvious if the bar is clipped or
         * misaligned.
         */}
        <View
          accessibilityLabel="Insert (disabled)"
          style={[styles.topBarBtn, styles.topBarBtnDisabled]}>
          <Text style={[styles.topBarBtnText, styles.topBarBtnTextDisabled]}>
            Insert
          </Text>
        </View>
      </View>
      <View style={styles.surface}>
        <Stage tree={tree} layout={layout} />
      </View>
    </View>
  );
}

/**
 * Stage: centred plane sized to the layout's union bbox. Children
 * are absolutely positioned inside, coordinates translated from
 * mindmap-local (root at origin, may extend in any direction) to
 * stage-local (top-left = 0,0).
 *
 * The stage is sized to the union bbox, NOT to the surface, so it
 * can overflow on small screens without being clipped by the
 * intrinsic pan/zoom of Phase 1.4c (§F-AC-7). Phase 1.4a leaves the
 * stage unclipped; any overflow is fine for demo trees.
 */
function Stage({
  tree,
  layout,
}: {
  tree: Tree;
  layout: LayoutResult;
}): React.JSX.Element {
  const {unionBbox} = layout;
  const origin: Point = {x: unionBbox.x, y: unionBbox.y};

  // Enumerate directed edges parent → child. Iterate the node map
  // once rather than walking the tree recursively — child linkage is
  // already denormalised on each MindmapNode.
  const edges: Array<{parent: MindmapNode; child: MindmapNode}> = [];
  for (const node of tree.nodesById.values()) {
    for (const childId of node.childIds) {
      const child = tree.nodesById.get(childId);
      if (!child) {
        continue;
      }
      edges.push({parent: node, child});
    }
  }

  return (
    <View
      accessibilityLabel="mindmap-stage"
      style={{width: unionBbox.w, height: unionBbox.h}}>
      {/*
       * Connectors render first so nodes paint on top. Each node has
       * `backgroundColor: '#fff'`, which masks the portion of a
       * connector that would otherwise show inside the node outline
       * (the line math goes center→center, not edge→edge).
       */}
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
      {Array.from(tree.nodesById.values()).map(node => {
        const bbox = layout.bboxes.get(node.id);
        if (!bbox) {
          return null;
        }
        return (
          <NodeFrame key={`node-${node.id}`} node={node} bbox={bbox} origin={origin} />
        );
      })}
    </View>
  );
}

/**
 * Visual outline for a single node. Shape drives `borderRadius`:
 *   OVAL              → height/2 (stadium / fully-rounded ends)
 *   RECTANGLE         → 0 (sharp corners)
 *   ROUNDED_RECTANGLE → SIBLING_CORNER_RADIUS (§F-AC-3)
 *
 * Outline weight comes from the shape's canonical pen width and is
 * converted to pixels via STROKE_PX_PER_PENWIDTH, matching sn-shapes'
 * StrokePreview so side-by-side rendering stays consistent.
 */
function NodeFrame({
  node,
  bbox,
  origin,
}: {
  node: MindmapNode;
  bbox: Rect;
  origin: Point;
}): React.JSX.Element {
  const penWidth = penWidthForShape(node.shape);
  const borderWidth = penWidthToPx(penWidth);
  return (
    <View
      accessibilityLabel={`node-${node.id}`}
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
  nodeFrame: {
    position: 'absolute',
    borderColor: '#000',
    backgroundColor: '#fff',
  },
  connector: {
    position: 'absolute',
    backgroundColor: '#000',
  },
});
