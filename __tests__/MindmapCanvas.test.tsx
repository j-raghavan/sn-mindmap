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
import MindmapCanvas from '../src/MindmapCanvas';

describe('MindmapCanvas (scaffold)', () => {
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
});
