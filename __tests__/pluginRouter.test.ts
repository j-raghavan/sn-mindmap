/**
 * Tests for src/pluginRouter.ts.
 *
 * Coverage targets:
 *   - Both exported button-ID constants (§7.3).
 *   - installPluginRouter: registers exactly one listener; idempotent on
 *     repeated calls.
 *   - Button-press event: updates lastButtonEvent; fans out to all
 *     subscribers.
 *   - subscribeToButtonEvents: callback fires on press; unsubscribe removes
 *     it; multiple subscribers all fire independently.
 *   - getLastButtonEvent: returns undefined before any press; returns the
 *     most recent event after a press; returns the same object across calls.
 *   - _resetForTests: cleans up between test groups.
 */

// ---- Mock sn-plugin-lib BEFORE any import of the module under test --------
// Capture the registered listener so tests can trigger it directly.
let capturedListener: {onButtonPress: (e: unknown) => void} | null = null;

jest.mock('sn-plugin-lib', () => ({
  PluginManager: {
    registerButtonListener: jest
      .fn()
      .mockImplementation(
        (listener: {onButtonPress: (e: unknown) => void}) => {
          capturedListener = listener;
          return {remove: jest.fn()};
        },
      ),
  },
}));

import {PluginManager} from 'sn-plugin-lib';
import {
  _resetForTests,
  BUTTON_ID_EDIT_MINDMAP,
  BUTTON_ID_TOOLBAR,
  getLastButtonEvent,
  installPluginRouter,
  subscribeToButtonEvents,
  type ButtonEvent,
} from '../src/pluginRouter';

// Helper: fire a synthetic button press through the captured listener.
function fireEvent(event: ButtonEvent): void {
  if (!capturedListener) {
    throw new Error('installPluginRouter has not been called yet');
  }
  capturedListener.onButtonPress(event);
}

const TOOLBAR_EVENT: ButtonEvent = {id: 100, name: 'Mindmap', icon: 'icon.png'};
const EDIT_EVENT: ButtonEvent = {
  id: 200,
  name: 'Edit Mindmap',
  icon: 'edit.png',
  pressEvent: 3,
};

// ---------------------------------------------------------------------------
// Reset state before every test so tests are independent.
// ---------------------------------------------------------------------------
beforeEach(() => {
  _resetForTests();
  capturedListener = null;
  (PluginManager.registerButtonListener as jest.Mock).mockClear();
});

// ---------------------------------------------------------------------------

describe('button ID constants', () => {
  it('BUTTON_ID_TOOLBAR is 100 (§7.3)', () => {
    expect(BUTTON_ID_TOOLBAR).toBe(100);
  });

  it('BUTTON_ID_EDIT_MINDMAP is 200 (§7.3)', () => {
    expect(BUTTON_ID_EDIT_MINDMAP).toBe(200);
  });
});

// ---------------------------------------------------------------------------

describe('installPluginRouter', () => {
  it('registers exactly one button listener on first call', () => {
    installPluginRouter();
    expect(PluginManager.registerButtonListener).toHaveBeenCalledTimes(1);
    expect(capturedListener).not.toBeNull();
  });

  it('is idempotent — second call does not register a second listener', () => {
    installPluginRouter();
    installPluginRouter();
    installPluginRouter();
    expect(PluginManager.registerButtonListener).toHaveBeenCalledTimes(1);
  });

  it('does not register a listener before being called', () => {
    // No installPluginRouter() call here.
    expect(PluginManager.registerButtonListener).not.toHaveBeenCalled();
    expect(capturedListener).toBeNull();
  });
});

// ---------------------------------------------------------------------------

describe('getLastButtonEvent', () => {
  it('returns undefined before any button has been pressed', () => {
    installPluginRouter();
    expect(getLastButtonEvent()).toBeUndefined();
  });

  it('returns the event after the first press', () => {
    installPluginRouter();
    fireEvent(TOOLBAR_EVENT);
    expect(getLastButtonEvent()).toEqual(TOOLBAR_EVENT);
  });

  it('returns the MOST RECENT event when multiple presses occur', () => {
    installPluginRouter();
    fireEvent(TOOLBAR_EVENT);
    fireEvent(EDIT_EVENT);
    expect(getLastButtonEvent()).toEqual(EDIT_EVENT);
  });

  it('returns the same object reference across repeated calls', () => {
    installPluginRouter();
    fireEvent(TOOLBAR_EVENT);
    expect(getLastButtonEvent()).toBe(getLastButtonEvent());
  });

  it('preserves pressEvent field on the event object', () => {
    installPluginRouter();
    fireEvent(EDIT_EVENT);
    expect(getLastButtonEvent()?.pressEvent).toBe(3);
  });
});

// ---------------------------------------------------------------------------

describe('subscribeToButtonEvents', () => {
  it('subscriber callback is called with the event on button press', () => {
    installPluginRouter();
    const cb = jest.fn();
    subscribeToButtonEvents(cb);
    fireEvent(TOOLBAR_EVENT);
    expect(cb).toHaveBeenCalledTimes(1);
    expect(cb).toHaveBeenCalledWith(TOOLBAR_EVENT);
  });

  it('returns an unsubscribe function that stops future calls', () => {
    installPluginRouter();
    const cb = jest.fn();
    const unsub = subscribeToButtonEvents(cb);
    fireEvent(TOOLBAR_EVENT);
    expect(cb).toHaveBeenCalledTimes(1);
    unsub();
    fireEvent(EDIT_EVENT);
    expect(cb).toHaveBeenCalledTimes(1); // no additional call
  });

  it('calling unsubscribe twice is a no-op (safe teardown)', () => {
    installPluginRouter();
    const cb = jest.fn();
    const unsub = subscribeToButtonEvents(cb);
    unsub();
    expect(() => unsub()).not.toThrow();
    fireEvent(TOOLBAR_EVENT);
    expect(cb).not.toHaveBeenCalled();
  });

  it('multiple subscribers all receive the same event', () => {
    installPluginRouter();
    const cb1 = jest.fn();
    const cb2 = jest.fn();
    const cb3 = jest.fn();
    subscribeToButtonEvents(cb1);
    subscribeToButtonEvents(cb2);
    subscribeToButtonEvents(cb3);
    fireEvent(TOOLBAR_EVENT);
    expect(cb1).toHaveBeenCalledWith(TOOLBAR_EVENT);
    expect(cb2).toHaveBeenCalledWith(TOOLBAR_EVENT);
    expect(cb3).toHaveBeenCalledWith(TOOLBAR_EVENT);
  });

  it('unsubscribing one does not affect the others', () => {
    installPluginRouter();
    const cb1 = jest.fn();
    const cb2 = jest.fn();
    const unsub1 = subscribeToButtonEvents(cb1);
    subscribeToButtonEvents(cb2);
    unsub1();
    fireEvent(TOOLBAR_EVENT);
    expect(cb1).not.toHaveBeenCalled();
    expect(cb2).toHaveBeenCalledWith(TOOLBAR_EVENT);
  });

  it('subscriber added after a press does NOT receive past events', () => {
    installPluginRouter();
    fireEvent(TOOLBAR_EVENT);
    const cb = jest.fn();
    subscribeToButtonEvents(cb);
    // No new events fired — cb should not be called.
    expect(cb).not.toHaveBeenCalled();
  });

  it('subscriber receives multiple successive events in order', () => {
    installPluginRouter();
    const received: ButtonEvent[] = [];
    subscribeToButtonEvents(e => received.push(e));
    fireEvent(TOOLBAR_EVENT);
    fireEvent(EDIT_EVENT);
    fireEvent(TOOLBAR_EVENT);
    expect(received).toEqual([TOOLBAR_EVENT, EDIT_EVENT, TOOLBAR_EVENT]);
  });
});

// ---------------------------------------------------------------------------

describe('_resetForTests (test utility)', () => {
  it('clears lastButtonEvent', () => {
    installPluginRouter();
    fireEvent(TOOLBAR_EVENT);
    expect(getLastButtonEvent()).toBeDefined();
    _resetForTests();
    expect(getLastButtonEvent()).toBeUndefined();
  });

  it('clears installed flag so installPluginRouter registers again', () => {
    installPluginRouter();
    expect(PluginManager.registerButtonListener).toHaveBeenCalledTimes(1);
    _resetForTests();
    (PluginManager.registerButtonListener as jest.Mock).mockClear();
    installPluginRouter();
    expect(PluginManager.registerButtonListener).toHaveBeenCalledTimes(1);
  });

  it('clears all subscribers', () => {
    installPluginRouter();
    const cb = jest.fn();
    subscribeToButtonEvents(cb);
    _resetForTests();
    // After reset, install fresh and fire — the old cb should not be called.
    capturedListener = null;
    (PluginManager.registerButtonListener as jest.Mock).mockClear();
    installPluginRouter();
    fireEvent(TOOLBAR_EVENT);
    expect(cb).not.toHaveBeenCalled();
  });
});
