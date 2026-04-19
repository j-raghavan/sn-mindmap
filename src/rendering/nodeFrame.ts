/**
 * Node outline geometry builders per §F-IN-2 step 1.
 *
 * Three shape kinds, selected by ShapeKind (the per-node stored byte
 * from §6.3). All three return GEO_polygon or GEO_ellipse per the
 * spec's tuning note — the Oval in particular may be implemented as
 * either an aggressive-radius rounded-rect polygon or as a true
 * ellipse, whichever produces the closer visual match on-device
 * (tracked as a §10 tuning item).
 *
 *   OVAL              — elongated rounded rectangle, darker border
 *                       (uses ROOT_PEN_WIDTH, §F-AC-2)
 *   RECTANGLE         — 4 sharp corners, standard border
 *                       (uses PEN_DEFAULTS.penWidth)
 *   ROUNDED_RECTANGLE — small corner radius (SIBLING_CORNER_RADIUS),
 *                       standard border
 *
 * Reuses sn-shapes/src/shapes.ts's roundedRectPoints helper per
 * §7.1's comment — Phase 2 will decide the import path (vendor
 * vs. local mirror); stubs today contain no implementation body.
 *
 * The concrete Phase 2 implementation will import PEN_DEFAULTS from
 * ../geometry and ROOT_PEN_WIDTH / SIBLING_CORNER_RADIUS from
 * ../layout/constants; those imports are intentionally omitted from
 * this stub until the body exists, to keep the lint surface clean.
 */
import type {Geometry, Rect} from '../geometry';
import type {ShapeKind} from '../model/tree';

export type NodeFrameOptions = {
  /**
   * Border weight. Defaults to PEN_DEFAULTS.penWidth for RECTANGLE
   * and ROUNDED_RECTANGLE. The OVAL uses ROOT_PEN_WIDTH (≥ 500)
   * per §F-AC-2 when omitted.
   */
  penWidth?: number;
};

/**
 * Build the outline geometry for a node at the given bbox with the
 * given shape kind. Output is ready to pass to
 * PluginCommAPI.insertGeometry with `showLassoAfterInsert: false`
 * (§F-IN-3) — the caller batches and then lassos the union-rect.
 *
 * TODO(Phase 2, §F-IN-2 step 1): implement all three shape kinds.
 */
export function nodeFrame(
  _bbox: Rect,
  _shape: ShapeKind,
  _opts: NodeFrameOptions = {},
): Geometry {
  throw new Error('TODO(Phase 2, §F-IN-2): nodeFrame not implemented');
}
