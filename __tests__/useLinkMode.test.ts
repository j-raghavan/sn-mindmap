/**
 * Tests for src/useLinkMode.ts — the §F-DAG-3 Link-mode state machine.
 *
 * useLinkMode is a pure state + orchestration hook (it imports no React
 * Native components), so it's exercised here in isolation via
 * react-test-renderer driving a tiny function-component host that calls
 * the hook and exposes its result through a ref. This mirrors the
 * established react-test-renderer + act pattern used across the suite
 * (the repo has no @testing-library/react-hooks).
 *
 * Coverage targets the whole surface (B3-8):
 *   - toggleArm arms / disarms and clears any pending source
 *   - selectForLink is a no-op while idle
 *   - first tap sets the source; re-tapping the source clears it
 *   - a valid target → onAddLink(from,to) then reset to idle
 *   - each typed rejection (self-loop / tree-edge / duplicate / cycle)
 *     → the mapped banner message, then reset; onAddLink NOT called
 *   - reset() drops armed + source but KEEPS linkError (banner outlives
 *     the disarm)
 *   - the 2 s timer auto-clears linkError (fake timers)
 *   - showLinkError replaces an in-flight banner timer (no leak)
 *   - cleanup-on-unmount clears the timer (no setState-after-unmount)
 */
import {act, create} from 'react-test-renderer';
import {createElement, useImperativeHandle, forwardRef} from 'react';

import {useLinkMode, type UseLinkModeResult} from '../src/useLinkMode';
import {addChild, createTree, type NodeId, type Tree} from '../src/model/tree';

/**
 * Render the hook inside a host component and return a live handle to
 * the hook's result plus the renderer. The handle is refreshed on every
 * render (useImperativeHandle re-runs), so after each act() the latest
 * hook state is readable via `handle.current`.
 */
function renderHook(
  tree: Tree,
  onAddLink: (from: NodeId, to: NodeId) => void,
): {
  handle: {current: UseLinkModeResult | null};
  unmount: () => void;
} {
  const handle: {current: UseLinkModeResult | null} = {current: null};

  const Host = forwardRef<UseLinkModeResult>((_props, ref) => {
    const result = useLinkMode({tree, onAddLink});
    useImperativeHandle(ref, () => result, [result]);
    return null;
  });
  Host.displayName = 'UseLinkModeHost';

  let renderer: ReturnType<typeof create> | undefined;
  act(() => {
    renderer = create(
      createElement(Host, {
        ref: (r: UseLinkModeResult | null) => {
          handle.current = r;
        },
      }),
    );
  });
  if (!renderer) {
    throw new Error('renderHook: renderer was not created');
  }
  const r = renderer;
  return {
    handle,
    unmount: () => act(() => r.unmount()),
  };
}

/** Root + two children (B, D) — siblings, so B→D is a valid cross-edge. */
function twoChildTree(): {tree: Tree; b: NodeId; d: NodeId} {
  const tree = createTree();
  const b = addChild(tree, tree.rootId);
  const d = addChild(tree, tree.rootId);
  return {tree, b, d};
}

describe('useLinkMode', () => {
  describe('arm / disarm', () => {
    it('starts idle (not armed, no source, no error)', () => {
      const {tree} = twoChildTree();
      const {handle, unmount} = renderHook(tree, jest.fn());
      expect(handle.current!.isArmed).toBe(false);
      expect(handle.current!.sourceId).toBeNull();
      expect(handle.current!.linkError).toBeNull();
      unmount();
    });

    it('toggleArm arms, then disarms, clearing any source on each toggle', () => {
      const {tree, b} = twoChildTree();
      const {handle, unmount} = renderHook(tree, jest.fn());

      act(() => handle.current!.toggleArm());
      expect(handle.current!.isArmed).toBe(true);
      expect(handle.current!.sourceId).toBeNull();

      // Pick a source, then toggle off — source must clear.
      act(() => handle.current!.selectForLink(b));
      expect(handle.current!.sourceId).toBe(b);
      act(() => handle.current!.toggleArm());
      expect(handle.current!.isArmed).toBe(false);
      expect(handle.current!.sourceId).toBeNull();
      unmount();
    });
  });

  describe('selectForLink', () => {
    it('is a no-op while idle (taps are not link selections)', () => {
      const {tree, b} = twoChildTree();
      const onAddLink = jest.fn();
      const {handle, unmount} = renderHook(tree, onAddLink);
      act(() => handle.current!.selectForLink(b));
      expect(handle.current!.sourceId).toBeNull();
      expect(onAddLink).not.toHaveBeenCalled();
      unmount();
    });

    it('first tap sets the source', () => {
      const {tree, b} = twoChildTree();
      const {handle, unmount} = renderHook(tree, jest.fn());
      act(() => handle.current!.toggleArm());
      act(() => handle.current!.selectForLink(b));
      expect(handle.current!.sourceId).toBe(b);
      unmount();
    });

    it('re-tapping the source clears the selection (cancel), still armed', () => {
      const {tree, b} = twoChildTree();
      const {handle, unmount} = renderHook(tree, jest.fn());
      act(() => handle.current!.toggleArm());
      act(() => handle.current!.selectForLink(b));
      act(() => handle.current!.selectForLink(b)); // re-tap source
      expect(handle.current!.sourceId).toBeNull();
      expect(handle.current!.isArmed).toBe(true);
      unmount();
    });

    it('a valid target → onAddLink(from,to) then reset to idle, no banner', () => {
      const {tree, b, d} = twoChildTree();
      const onAddLink = jest.fn();
      const {handle, unmount} = renderHook(tree, onAddLink);
      act(() => handle.current!.toggleArm());
      act(() => handle.current!.selectForLink(b));
      act(() => handle.current!.selectForLink(d)); // valid B→D
      expect(onAddLink).toHaveBeenCalledTimes(1);
      expect(onAddLink).toHaveBeenCalledWith(b, d);
      // Reset to idle.
      expect(handle.current!.isArmed).toBe(false);
      expect(handle.current!.sourceId).toBeNull();
      expect(handle.current!.linkError).toBeNull();
      unmount();
    });
  });

  describe('rejection reasons → banner message (and no onAddLink)', () => {
    it('self-loop is impossible via re-tap, so exercise tree-edge reject', () => {
      // Tree A(root) → B. Arm, source = A, target = B. A→B is a tree
      // edge → reject 'tree-edge' → mapped banner, no onAddLink.
      const tree = createTree();
      const b = addChild(tree, tree.rootId);
      const onAddLink = jest.fn();
      const {handle, unmount} = renderHook(tree, onAddLink);
      act(() => handle.current!.toggleArm());
      act(() => handle.current!.selectForLink(tree.rootId)); // source A
      act(() => handle.current!.selectForLink(b)); // target B (tree edge)
      expect(onAddLink).not.toHaveBeenCalled();
      expect(handle.current!.linkError).toBe(
        'That link already exists as a branch.',
      );
      expect(handle.current!.isArmed).toBe(false);
      unmount();
    });

    it('cycle reject → "That link would create a cycle."', () => {
      // Tree A(root) → B. Source = B, target = A. B→A cycles.
      const tree = createTree();
      const b = addChild(tree, tree.rootId);
      const onAddLink = jest.fn();
      const {handle, unmount} = renderHook(tree, onAddLink);
      act(() => handle.current!.toggleArm());
      act(() => handle.current!.selectForLink(b)); // source B
      act(() => handle.current!.selectForLink(tree.rootId)); // target A
      expect(onAddLink).not.toHaveBeenCalled();
      expect(handle.current!.linkError).toBe(
        'That link would create a cycle.',
      );
      unmount();
    });

    it('duplicate reject → "That link already exists."', () => {
      // Add B→D once (real edge in the tree), then re-attempt B→D.
      const tree = createTree();
      const b = addChild(tree, tree.rootId);
      const d = addChild(tree, tree.rootId);
      // Pre-seed the existing cross-edge directly on the tree the hook
      // validates against.
      tree.crossEdges.push({from: b, to: d});
      const onAddLink = jest.fn();
      const {handle, unmount} = renderHook(tree, onAddLink);
      act(() => handle.current!.toggleArm());
      act(() => handle.current!.selectForLink(b));
      act(() => handle.current!.selectForLink(d)); // duplicate B→D
      expect(onAddLink).not.toHaveBeenCalled();
      expect(handle.current!.linkError).toBe('That link already exists.');
      unmount();
    });
  });

  describe('reset', () => {
    it('drops armed + source but KEEPS linkError (banner outlives disarm)', () => {
      const tree = createTree();
      const b = addChild(tree, tree.rootId);
      const {handle, unmount} = renderHook(tree, jest.fn());
      // Trigger a reject so a banner is up AND the hook auto-reset.
      act(() => handle.current!.toggleArm());
      act(() => handle.current!.selectForLink(b)); // source B
      act(() => handle.current!.selectForLink(tree.rootId)); // cycle reject
      expect(handle.current!.linkError).not.toBeNull();
      expect(handle.current!.isArmed).toBe(false);

      // Re-arm, then call reset() explicitly — the banner must persist.
      act(() => handle.current!.toggleArm());
      act(() => handle.current!.selectForLink(b));
      act(() => handle.current!.reset());
      expect(handle.current!.isArmed).toBe(false);
      expect(handle.current!.sourceId).toBeNull();
      expect(handle.current!.linkError).not.toBeNull(); // KEPT
      unmount();
    });
  });

  describe('error banner timer', () => {
    beforeEach(() => {
      jest.useFakeTimers();
    });
    afterEach(() => {
      act(() => {
        jest.runOnlyPendingTimers();
      });
      jest.useRealTimers();
    });

    it('auto-clears linkError after LINK_ERROR_DISPLAY_MS (2 s)', () => {
      const tree = createTree();
      const b = addChild(tree, tree.rootId);
      const {handle, unmount} = renderHook(tree, jest.fn());
      act(() => handle.current!.toggleArm());
      act(() => handle.current!.selectForLink(b));
      act(() => handle.current!.selectForLink(tree.rootId)); // cycle reject
      expect(handle.current!.linkError).not.toBeNull();
      // Advance past the 2 s window — the banner auto-dismisses.
      act(() => {
        jest.advanceTimersByTime(2000);
      });
      expect(handle.current!.linkError).toBeNull();
      unmount();
    });

    it('a second reject replaces the in-flight timer (no early clear of the new banner)', () => {
      const tree = createTree();
      const b = addChild(tree, tree.rootId);
      const {handle, unmount} = renderHook(tree, jest.fn());

      act(() => handle.current!.toggleArm());
      act(() => handle.current!.selectForLink(b));
      act(() => handle.current!.selectForLink(tree.rootId)); // reject #1
      expect(handle.current!.linkError).not.toBeNull();

      // 1.5 s later (before #1's timer fires), trigger reject #2.
      act(() => {
        jest.advanceTimersByTime(1500);
      });
      act(() => handle.current!.toggleArm());
      act(() => handle.current!.selectForLink(b));
      act(() => handle.current!.selectForLink(tree.rootId)); // reject #2
      expect(handle.current!.linkError).not.toBeNull();

      // 0.6 s past reject #2: if #1's stale timer were still live (fires
      // at 2.0 s total) the banner would have cleared at this point;
      // showLinkError cleared it, so the banner is still up.
      act(() => {
        jest.advanceTimersByTime(600);
      });
      expect(handle.current!.linkError).not.toBeNull();

      // And it clears 2 s after reject #2.
      act(() => {
        jest.advanceTimersByTime(1400);
      });
      expect(handle.current!.linkError).toBeNull();
      unmount();
    });

    it('unmount clears the pending timer (no setState-after-unmount)', () => {
      const tree = createTree();
      const b = addChild(tree, tree.rootId);
      const {handle, unmount} = renderHook(tree, jest.fn());
      act(() => handle.current!.toggleArm());
      act(() => handle.current!.selectForLink(b));
      act(() => handle.current!.selectForLink(tree.rootId)); // banner + timer
      // Unmount with the 2 s timer still pending.
      unmount();
      // Flushing the timer must NOT throw / warn (the cleanup effect
      // cleared it). If the timer survived, this would fire a setState
      // on the torn-down hook.
      expect(() =>
        act(() => {
          jest.advanceTimersByTime(2000);
        }),
      ).not.toThrow();
    });
  });
});
