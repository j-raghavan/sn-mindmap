/**
 * Placeholder tests for src/rendering/emitGeometries.ts.
 *
 * Phase 2 (§9) replaces these with real coverage:
 *   - emit order: outlines, then connectors, then marker, then
 *     (re-insert only) preserved label strokes (§F-IN-2)
 *   - every emitted geometry sets showLassoAfterInsert: false
 *     (§F-IN-3)
 *   - returned unionRect bounds every emitted point exactly
 *   - per-shape outline selection follows the node's stored shape
 *     kind (§6.3 -> §F-IN-2 step 1)
 *
 * For now we only validate the module exports the expected symbols.
 */
import {emitGeometries} from '../src/rendering/emitGeometries';

describe('emitGeometries (scaffold)', () => {
  it('exposes emitGeometries', () => {
    expect(typeof emitGeometries).toBe('function');
  });
});
