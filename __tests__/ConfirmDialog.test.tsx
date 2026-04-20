/**
 * Tests for src/ConfirmDialog.tsx.
 *
 * ConfirmDialog is the reusable centered-card modal shared by the
 * §8.1 out-of-map dialog and the §F-PE-4 capacity modal. These tests
 * pin down its contract:
 *
 *   - renders nothing when visible=false
 *   - labels every queryable element with `${labelPrefix}-*`
 *   - wires primary / secondary / backdrop taps to the right callbacks
 *   - single-button (acknowledge-only) dialogs hide the cancel button
 *     AND make backdrop tap a no-op (the user must press primary)
 *   - body accepts string OR string[] and preserves children shape
 *     (the §F-ED-5 count assertion inspects `Text.props.children` as
 *     an array, so the array form has to round-trip unchanged)
 *   - destructive variant flips primary button styling (white-on-black)
 */
import React from 'react';
import {act, create} from 'react-test-renderer';
import ConfirmDialog from '../src/ConfirmDialog';

type Renderer = ReturnType<typeof create>;
type TestInstance = ReturnType<Renderer['root']['findAll']>[number];

function renderDialog(
  element: React.ReactElement,
): {renderer: Renderer; unmount: () => void} {
  let renderer: Renderer | undefined;
  act(() => {
    renderer = create(element);
  });
  if (!renderer) {
    throw new Error('renderDialog: react-test-renderer returned undefined');
  }
  const unmount = (): void => {
    act(() => {
      renderer?.unmount();
    });
  };
  return {renderer, unmount};
}

function findHostByLabel(
  renderer: Renderer,
  label: string,
): TestInstance[] {
  return renderer.root.findAll(
    node =>
      typeof node.type === 'string' &&
      node.props.accessibilityLabel === label,
  );
}

function findPressable(renderer: Renderer, label: string): TestInstance {
  const hits = renderer.root.findAll(
    node =>
      typeof node.type !== 'string' &&
      node.props.accessibilityLabel === label &&
      typeof node.props.onPress === 'function',
  );
  if (hits.length === 0) {
    throw new Error(`findPressable: no Pressable with label "${label}"`);
  }
  return hits[0];
}

function flattenStyle(style: unknown): Record<string, unknown> {
  if (!style) {
    return {};
  }
  if (Array.isArray(style)) {
    return Object.assign({}, ...style.map(flattenStyle));
  }
  return style as Record<string, unknown>;
}

describe('ConfirmDialog', () => {
  describe('visibility', () => {
    it('renders nothing when visible=false', () => {
      const {renderer, unmount} = renderDialog(
        <ConfirmDialog
          labelPrefix="test"
          visible={false}
          title="Title"
          body="Body"
          primaryLabel="OK"
          onPrimary={() => {}}
        />,
      );
      expect(renderer.toJSON()).toBeNull();
      expect(findHostByLabel(renderer, 'test-dialog')).toHaveLength(0);
      unmount();
    });

    it('renders the overlay, backdrop, body, and primary button when visible=true', () => {
      const {renderer, unmount} = renderDialog(
        <ConfirmDialog
          labelPrefix="test"
          visible={true}
          title="Title"
          body="Body"
          primaryLabel="OK"
          onPrimary={() => {}}
        />,
      );
      expect(findHostByLabel(renderer, 'test-dialog').length).toBeGreaterThan(0);
      expect(findHostByLabel(renderer, 'test-backdrop').length).toBeGreaterThan(0);
      expect(findHostByLabel(renderer, 'test-body').length).toBeGreaterThan(0);
      // Primary button always renders.
      expect(findPressable(renderer, 'test-proceed')).toBeTruthy();
      unmount();
    });
  });

  describe('label prefix scheme', () => {
    it('labels every queryable element with `${labelPrefix}-*` so tests can target per-prefix', () => {
      const {renderer, unmount} = renderDialog(
        <ConfirmDialog
          labelPrefix="capacity-error"
          visible={true}
          title="Too big"
          body="Reduce nodes."
          primaryLabel="OK"
          onPrimary={() => {}}
          secondaryLabel="Cancel"
          onSecondary={() => {}}
        />,
      );
      expect(findHostByLabel(renderer, 'capacity-error-dialog').length).toBeGreaterThan(0);
      expect(findHostByLabel(renderer, 'capacity-error-backdrop').length).toBeGreaterThan(0);
      expect(findHostByLabel(renderer, 'capacity-error-body').length).toBeGreaterThan(0);
      expect(findPressable(renderer, 'capacity-error-cancel')).toBeTruthy();
      expect(findPressable(renderer, 'capacity-error-proceed')).toBeTruthy();
      // A different prefix (the out-of-map dialog) would not collide.
      expect(findHostByLabel(renderer, 'save-confirm-dialog')).toHaveLength(0);
      unmount();
    });
  });

  describe('secondary / cancel button', () => {
    it('renders the cancel button only when secondaryLabel is provided', () => {
      const {renderer: withSec, unmount: u1} = renderDialog(
        <ConfirmDialog
          labelPrefix="test"
          visible={true}
          title="Title"
          body="Body"
          primaryLabel="OK"
          onPrimary={() => {}}
          secondaryLabel="Cancel"
          onSecondary={() => {}}
        />,
      );
      expect(findHostByLabel(withSec, 'test-cancel').length).toBeGreaterThan(0);
      u1();

      const {renderer: noSec, unmount: u2} = renderDialog(
        <ConfirmDialog
          labelPrefix="test"
          visible={true}
          title="Title"
          body="Body"
          primaryLabel="OK"
          onPrimary={() => {}}
        />,
      );
      // Acknowledge-only dialog has no cancel button at all.
      expect(findHostByLabel(noSec, 'test-cancel')).toHaveLength(0);
      u2();
    });
  });

  describe('press handlers', () => {
    it('invokes onPrimary when the primary button is tapped', () => {
      const onPrimary = jest.fn();
      const onSecondary = jest.fn();
      const {renderer, unmount} = renderDialog(
        <ConfirmDialog
          labelPrefix="test"
          visible={true}
          title="Title"
          body="Body"
          primaryLabel="OK"
          onPrimary={onPrimary}
          secondaryLabel="Cancel"
          onSecondary={onSecondary}
        />,
      );
      act(() => {
        (findPressable(renderer, 'test-proceed').props.onPress as () => void)();
      });
      expect(onPrimary).toHaveBeenCalledTimes(1);
      expect(onSecondary).not.toHaveBeenCalled();
      unmount();
    });

    it('invokes onSecondary when the cancel button is tapped', () => {
      const onPrimary = jest.fn();
      const onSecondary = jest.fn();
      const {renderer, unmount} = renderDialog(
        <ConfirmDialog
          labelPrefix="test"
          visible={true}
          title="Title"
          body="Body"
          primaryLabel="OK"
          onPrimary={onPrimary}
          secondaryLabel="Cancel"
          onSecondary={onSecondary}
        />,
      );
      act(() => {
        (findPressable(renderer, 'test-cancel').props.onPress as () => void)();
      });
      expect(onSecondary).toHaveBeenCalledTimes(1);
      expect(onPrimary).not.toHaveBeenCalled();
      unmount();
    });

    it('invokes onSecondary on backdrop tap when provided', () => {
      const onPrimary = jest.fn();
      const onSecondary = jest.fn();
      const {renderer, unmount} = renderDialog(
        <ConfirmDialog
          labelPrefix="test"
          visible={true}
          title="Title"
          body="Body"
          primaryLabel="OK"
          onPrimary={onPrimary}
          secondaryLabel="Cancel"
          onSecondary={onSecondary}
        />,
      );
      act(() => {
        (findPressable(renderer, 'test-backdrop').props.onPress as () => void)();
      });
      expect(onSecondary).toHaveBeenCalledTimes(1);
      expect(onPrimary).not.toHaveBeenCalled();
      unmount();
    });

    it('backdrop tap is a no-op when onSecondary is omitted (acknowledge-only dialog)', () => {
      // Acknowledge-only dialogs (§F-PE-4 capacity) must NOT dismiss on
      // backdrop tap — the user has to press OK explicitly so the
      // message stays read. The Pressable still exists so the
      // underlying <Text> isn't tappable through to the canvas below,
      // but its onPress does nothing.
      const onPrimary = jest.fn();
      const {renderer, unmount} = renderDialog(
        <ConfirmDialog
          labelPrefix="test"
          visible={true}
          title="Title"
          body="Body"
          primaryLabel="OK"
          onPrimary={onPrimary}
        />,
      );
      act(() => {
        (findPressable(renderer, 'test-backdrop').props.onPress as () => void)();
      });
      expect(onPrimary).not.toHaveBeenCalled();
      unmount();
    });
  });

  describe('body rendering', () => {
    it('renders a string body as a single child of the body Text', () => {
      const {renderer, unmount} = renderDialog(
        <ConfirmDialog
          labelPrefix="test"
          visible={true}
          title="Title"
          body="Just one sentence."
          primaryLabel="OK"
          onPrimary={() => {}}
        />,
      );
      const bodyHost = findHostByLabel(renderer, 'test-body');
      expect(bodyHost.length).toBeGreaterThan(0);
      expect(bodyHost[0].props.children).toBe('Just one sentence.');
      unmount();
    });

    it('renders an array body so each segment remains a separate child (preserves count-split for §F-ED-5)', () => {
      const {renderer, unmount} = renderDialog(
        <ConfirmDialog
          labelPrefix="test"
          visible={true}
          title="Title"
          body={['First segment. ', 'Second segment.']}
          primaryLabel="OK"
          onPrimary={() => {}}
        />,
      );
      const bodyHost = findHostByLabel(renderer, 'test-body');
      expect(bodyHost.length).toBeGreaterThan(0);
      const children = bodyHost[0].props.children as unknown[];
      expect(Array.isArray(children)).toBe(true);
      const joined = children
        .filter((x): x is string => typeof x === 'string')
        .join('');
      expect(joined).toBe('First segment. Second segment.');
      unmount();
    });
  });

  describe('primaryVariant styling', () => {
    it('default variant keeps primary button styled like secondary (no black background)', () => {
      const {renderer, unmount} = renderDialog(
        <ConfirmDialog
          labelPrefix="test"
          visible={true}
          title="Title"
          body="Body"
          primaryLabel="OK"
          onPrimary={() => {}}
        />,
      );
      const proceed = findPressable(renderer, 'test-proceed');
      const style = flattenStyle(
        typeof proceed.props.style === 'function'
          ? proceed.props.style({pressed: false})
          : proceed.props.style,
      );
      // Default variant: no black background on the button itself.
      expect(style.backgroundColor).not.toBe('#000');
      unmount();
    });

    it('destructive variant sets the primary button to inverted black-on-white → white-on-black', () => {
      const {renderer, unmount} = renderDialog(
        <ConfirmDialog
          labelPrefix="test"
          visible={true}
          title="Title"
          body="Body"
          primaryLabel="Save anyway"
          onPrimary={() => {}}
          secondaryLabel="Cancel"
          onSecondary={() => {}}
          primaryVariant="destructive"
        />,
      );
      const proceed = findPressable(renderer, 'test-proceed');
      const style = flattenStyle(
        typeof proceed.props.style === 'function'
          ? proceed.props.style({pressed: false})
          : proceed.props.style,
      );
      expect(style.backgroundColor).toBe('#000');
      expect(style.borderColor).toBe('#000');
      unmount();
    });
  });
});
