/**
 * Placeholder tests for src/EditMindmap.tsx.
 *
 * Phase 4 (§9) replaces these with real coverage:
 *   - getLassoGeometries called on mount (§F-ED-2)
 *   - decode failure surfaces the §F-ED-4 banner and closes the view
 *   - decode success mounts MindmapCanvas with initialTree set and
 *     preserved label strokes attached
 *   - Save path: deleteLassoElements -> emit -> insert -> lasso ->
 *     close (§F-ED-7)
 *
 * For now we only validate the placeholder renders.
 */
import React from 'react';
import {create, act} from 'react-test-renderer';
import EditMindmap from '../src/EditMindmap';

describe('EditMindmap (scaffold)', () => {
  it('renders the placeholder without crashing', () => {
    let renderer: ReturnType<typeof create> | undefined;
    act(() => {
      renderer = create(<EditMindmap />);
    });
    expect(renderer).toBeDefined();
    const json = renderer!.toJSON();
    expect(json).toBeTruthy();
    renderer!.unmount();
  });
});
