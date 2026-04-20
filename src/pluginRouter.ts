/**
 * pluginRouter — single source of truth for plugin button press events.
 *
 * Ported from sn-shapes/src/pluginRouter.ts with the constant names
 * updated per requirements §7.2. Two buttons are registered in
 * index.js and their events land here:
 *
 *   id=100  BUTTON_ID_TOOLBAR       — toolbar "Mindmap" (opens authoring)
 *   id=200  BUTTON_ID_EDIT_MINDMAP  — lasso "Edit Mindmap" (opens edit)
 *
 * A single PluginManager.registerButtonListener is installed here and
 * fans out to subscribers. Components read getLastButtonEvent() on
 * first render to pick the initial view (authoring vs edit), and use
 * subscribeToButtonEvents for anything that arrives during the
 * session.
 *
 * Why "last event" instead of an event stream? The plugin UI is
 * started by the button press itself; by the time App.tsx mounts the
 * corresponding event has typically already fired. sn-plugin-lib
 * replays the cached lastButtonEventMsg when a listener registers
 * inside its 1-second window, which is enough for us to capture the
 * initial trigger into module state before components mount.
 *
 * Log prefix is [PLUGIN_ROUTER] per §11 so logcat stays searchable
 * and consistent with sn-shapes.
 */
import {PluginManager} from 'sn-plugin-lib';

export const BUTTON_ID_TOOLBAR = 100;
export const BUTTON_ID_EDIT_MINDMAP = 200;

// Mirror sn-plugin-lib's ButtonEvent shape locally so we don't depend
// on the library's internal sub-path (which isn't exported in its
// package exports map). Kept in sync with
// node_modules/sn-plugin-lib/src/listener/ButtonListener.ts.
export type ButtonEvent = {
  pressEvent: number;
  id: number;
  name: string;
  color: number;
  icon: string;
  bgColor: number;
};

export type ButtonSubscriber = (event: ButtonEvent) => void;

let lastEvent: ButtonEvent | null = null;
const subscribers = new Set<ButtonSubscriber>();
let installed = false;

export function installPluginRouter(): void {
  if (installed) {
    return;
  }
  installed = true;
  PluginManager.registerButtonListener({
    onButtonPress(event: ButtonEvent) {
      console.log('[PLUGIN_ROUTER] onButtonPress', JSON.stringify(event));
      lastEvent = event;
      for (const fn of subscribers) {
        try {
          fn(event);
        } catch (e) {
          console.error('[PLUGIN_ROUTER] subscriber threw', e);
        }
      }
    },
  });
}

export function getLastButtonEvent(): ButtonEvent | null {
  return lastEvent;
}

export function subscribeToButtonEvents(fn: ButtonSubscriber): () => void {
  subscribers.add(fn);
  return () => {
    subscribers.delete(fn);
  };
}
