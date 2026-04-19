/**
 * High-level insert flow (§5.3, §F-IN-1..F-IN-5).
 *
 * Sequence:
 *   1. resolvePageSize() — the three-step fall-through from
 *      sn-shapes/src/ShapePalette.tsx via PluginCommAPI
 *      getCurrentFilePath -> getCurrentPageNum -> PluginFileAPI
 *      getPageSize, with defaults if any step fails (§F-IN-1).
 *   2. Auto-expand every subtree in the tree so no node is hidden
 *      at emit time (§F-IN-2 / §8.6).
 *   3. Run radial layout (./layout/radial.ts).
 *   4. Fit-to-page scale if wider than the page (§F-LY-6). Applies
 *      to node positions and outline dimensions; preserved label
 *      strokes on re-insert are TRANSLATED, not scaled.
 *   5. Emit geometries via ./rendering/emitGeometries.ts — outlines,
 *      connectors, marker, (on re-insert) preserved label strokes.
 *      Every emission sets showLassoAfterInsert: false (§F-IN-3).
 *   6. Insert via PluginCommAPI.insertGeometry one-at-a-time, or
 *      PluginFileAPI.insertElements batched when stable.
 *   7. Call PluginCommAPI.lassoElements(unionRect) explicitly to
 *      auto-select the whole block (§F-IN-3 / §11).
 *   8. PluginManager.closePluginView() to dismiss (§F-IN-4).
 *
 * Error handling (§F-IN-5): on any failure mid-insert, best-effort
 * cleanup by lassoing the partial union rect and calling
 * deleteLassoElements before re-raising to the UI. Acceptable for
 * v0.1 to surface the error and require manual cleanup if automatic
 * cleanup fails.
 */
import type {Tree} from './model/tree';
import type {StrokeBucket} from './model/strokes';

export type InsertInput = {
  tree: Tree;
  /**
   * Only supplied on re-insert from edit mode (§F-ED-7). On
   * first-insert this is undefined — the plugin never owns labels
   * at initial authoring (§F-IN-2 step 3).
   */
  preservedStrokesByNode?: StrokeBucket;
};

/**
 * Run the full insert flow. Resolves when the plugin view has been
 * dismissed by closePluginView(). Rejects on any unrecoverable
 * error, after best-effort cleanup (§F-IN-5).
 *
 * TODO(Phase 2, §F-IN-*): implement.
 */
export async function insertMindmap(_input: InsertInput): Promise<void> {
  throw new Error('TODO(Phase 2, §F-IN-*): insertMindmap not implemented');
}
