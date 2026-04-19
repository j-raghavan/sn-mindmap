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

// sn-plugin-lib ships as untransformed ESM that jest can't parse out
// of the box — sn-shapes handles this the same way per test file.
// We only need PluginManager.closePluginView because EditMindmap
// calls it from the placeholder Close button.
jest.mock('sn-plugin-lib', () => ({
  PluginManager: {
    closePluginView: jest.fn(),
  },
}));

import EditMindmap from '../src/EditMindmap';
import {PluginManager} from 'sn-plugin-lib';

describe('EditMindmap (scaffold)', () => {
  beforeEach(() => {
    (PluginManager.closePluginView as jest.Mock).mockClear();
  });

  it('renders the placeholder without crashing', () => {
    let renderer: ReturnType<typeof create> | undefined;
    act(() => {
      renderer = create(<EditMindmap />);
    });
    expect(renderer).toBeDefined();
    const json = renderer!.toJSON();
    expect(json).toBeTruthy();
    act(() => {
      renderer!.unmount();
    });
  });

  it('Close button calls PluginManager.closePluginView', () => {
    // Regression test for the Phase 0 "Notes hangs when Mindmap
    // plugin is tapped" bug (see logcat.txt 04-18 22:19:25+). The
    // placeholder must offer an explicit affordance to dismiss the
    // plugin view — sn-plugin-lib has no implicit back gesture.
    let renderer: ReturnType<typeof create> | undefined;
    act(() => {
      renderer = create(<EditMindmap />);
    });
    const closeBtn = renderer!.root.findByProps({accessibilityRole: 'button'});
    act(() => {
      closeBtn.props.onPress();
    });
    expect(PluginManager.closePluginView).toHaveBeenCalledTimes(1);
    act(() => {
      renderer!.unmount();
    });
  });
});
