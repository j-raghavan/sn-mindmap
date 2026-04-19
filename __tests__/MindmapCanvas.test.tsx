/**
 * Placeholder tests for src/MindmapCanvas.tsx.
 *
 * Phase 1+ (§9) replaces these with real coverage of the authoring
 * canvas: tree mutation flows, action-icon rendering (Add Child
 * thicker, Add Sibling thinner, hidden on root, §F-AC-5), collapse
 * toggle visibility (§4.2), insert handoff to ./insert.ts.
 *
 * For now we only validate the placeholder renders without
 * throwing. No sn-plugin-lib mock required since this component
 * does not yet touch any platform API.
 */
import React from 'react';
import {create, act} from 'react-test-renderer';

// sn-plugin-lib ships as untransformed ESM that jest can't parse out
// of the box — sn-shapes handles this the same way per test file.
// We only need PluginManager.closePluginView because MindmapCanvas
// calls it from the placeholder Close button.
jest.mock('sn-plugin-lib', () => ({
  PluginManager: {
    closePluginView: jest.fn(),
  },
}));

import MindmapCanvas from '../src/MindmapCanvas';
import {PluginManager} from 'sn-plugin-lib';

describe('MindmapCanvas (scaffold)', () => {
  beforeEach(() => {
    (PluginManager.closePluginView as jest.Mock).mockClear();
  });

  it('renders the placeholder without crashing', () => {
    let renderer: ReturnType<typeof create> | undefined;
    act(() => {
      renderer = create(<MindmapCanvas />);
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
      renderer = create(<MindmapCanvas />);
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
