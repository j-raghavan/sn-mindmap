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
 *   RECTANGLE         — 4 sharp corners, standard border
 *   ROUNDED_RECTANGLE — small corner radius, standard border
 *
 * Reuses sn-shapes/src/shapes.ts's roundedRectPoints helper per
 * §7.1's comment — Phase 2 will decide the import path (vendor
 * vs. local mirror); stubs today use a local placeholder.
 */
import type {Geometry, Rect} from '../geometry';
import {ShapeKind} from '../model/tree';
import {PEN_DEFAULTS} from '../geometry';
import {ROOT_PEN_WIDTH, SIBLING_CORNER_RADIUS} from '../layout/constants';

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
  // Reference the imports so tsc+eslint are satisfied until
  // the real implementation lands.
  void PEN_DEFAULTS;
  void ROOT_PEN_WIDTH;
  void SIBLING_CORNER_RADIUS;
  throw new Error('TODO(Phase 2, §F-IN-2): nodeFrame not implemented');
}
