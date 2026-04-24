/**
 * Plugin button router — central dispatch for PluginManager button events.
 *
 * Design (Pattern 5 from sn-plugin-lib skill §patterns.md):
 *   installPluginRouter() registers a single PluginManager.registerButtonListener
 *   at module-load time (idempotent: safe to call from both index.js and App.tsx).
 *   Every press updates `lastButtonEvent` and fans out to all active React
 *   subscribers via subscribeToButtonEvents().
 *
 * Usage in index.js:
 *   import {installPluginRouter} from './src/pluginRouter';
 *   PluginManager.init();
 *   installPluginRouter();           // registers the listener
 *
 * Usage in App.tsx (React side):
 *   const initial = getLastButtonEvent();   // synchronous; avoids first-render flicker
 *   useEffect(() => subscribeToButtonEvents(handler), []);
 *
 * References: §7.2, §7.3, Pattern 5.
 */

import {PluginManager} from 'sn-plugin-lib';

// ---------------------------------------------------------------------------
// Button ID constants (§7.3)
// ---------------------------------------------------------------------------

/** Toolbar "Mindmap" button — opens the authoring canvas. */
export const BUTTON_ID_TOOLBAR = 100;

// ---------------------------------------------------------------------------
// Internal state
// ---------------------------------------------------------------------------

export interface ButtonEvent {
  id: number;
  name: string;
  icon: string;
  pressEvent?: number;
}

/** The most recent button event, or undefined if none has fired yet. */
let lastButtonEvent: ButtonEvent | undefined;

/** Active React subscribers. */
const subscribers = new Set<(event: ButtonEvent) => void>();

/** Guard preventing double-registration across index.js / App.tsx calls. */
let installed = false;

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Register the single PluginManager button listener.  Idempotent — a second
 * call after the first is a no-op (important because both index.js and
 * App.tsx call this for test-harness compatibility).
 */
export function installPluginRouter(): void {
  if (installed) {
    return;
  }
  installed = true;

  PluginManager.registerButtonListener({
    onButtonPress(event: ButtonEvent): void {
      lastButtonEvent = event;
      for (const cb of subscribers) {
        cb(event);
      }
    },
  });
}

/**
 * Subscribe to future button-press events.  Returns an unsubscribe function
 * suitable for React's useEffect cleanup.
 *
 * @example
 *   useEffect(() => subscribeToButtonEvents(e => setView(viewFor(e.id))), []);
 */
export function subscribeToButtonEvents(
  callback: (event: ButtonEvent) => void,
): () => void {
  subscribers.add(callback);
  return () => {
    subscribers.delete(callback);
  };
}

/**
 * Synchronously return the last button event received (or undefined if the
 * listener has not fired yet).  Used as the lazy initial-state seed in
 * App.tsx to avoid a first-render flicker to the wrong view.
 */
export function getLastButtonEvent(): ButtonEvent | undefined {
  return lastButtonEvent;
}

/**
 * Reset all module-level state.  Only for use in tests — not exported in
 * production builds (tree-shaken away because it is only referenced from
 * test files that are excluded from the bundle).
 *
 * @internal
 */
export function _resetForTests(): void {
  lastButtonEvent = undefined;
  subscribers.clear();
  installed = false;
}
