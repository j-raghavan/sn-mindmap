/**
 * Placeholder tests for src/model/tree.ts.
 *
 * Phase 1 (§9) replaces these with real coverage of the mutators
 * (addChild / addSibling / delete / setCollapsed) and of the
 * pre-order flattening that drives §6.2 record emission. For now we
 * only validate that the module imports cleanly and that the
 * starting shape — a fresh tree with just the root Oval — is what
 * §F-AC-2 / §F-AC-3 describe.
 */
import {createTree, ShapeKind} from '../src/model/tree';

describe('tree (scaffold)', () => {
  it('creates a tree with only the root Oval (§F-AC-2, §F-AC-3)', () => {
    const tree = createTree();
    expect(tree.rootId).toBe(0);
    expect(tree.nodesById.size).toBe(1);
    const root = tree.nodesById.get(0);
    expect(root).toBeDefined();
    expect(root?.parentId).toBeNull();
    expect(root?.shape).toBe(ShapeKind.OVAL);
    expect(root?.childIds).toEqual([]);
    expect(root?.collapsed).toBe(false);
  });

  it('ShapeKind wire bytes match §6.3', () => {
    // These numeric values ARE the marker-record bytes. If they ever
    // change, the marker encoder/decoder change with them. Do not
    // renumber casually.
    expect(ShapeKind.OVAL).toBe(0x00);
    expect(ShapeKind.RECTANGLE).toBe(0x01);
    expect(ShapeKind.ROUNDED_RECTANGLE).toBe(0x02);
  });
});
