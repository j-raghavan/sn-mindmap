import {AppRegistry, Image} from 'react-native';
import App from './App';
import {name as appName} from './app.json';
import {PluginManager} from 'sn-plugin-lib';
// Side-effect import: installs the single PluginManager.registerButtonListener
// used by the toolbar button (id=100). Logs are prefixed [PLUGIN_ROUTER]
// for logcat searchability.
import {installPluginRouter} from './src/pluginRouter';

const BUTTON_TYPE_TOOLBAR = 1;
const TOOLBAR_BUTTON_ID = 100;
const SHOW_TYPE_WITH_UI = 1;

AppRegistry.registerComponent(appName, () => App);

PluginManager.init();
installPluginRouter();

// Single entry point (per requirements §7.3):
//
//   id=100  "Mindmap"  — toolbar; opens the authoring canvas.
//
// The lasso-toolbar "Edit Mindmap" entry (id=200) was removed along
// with the edit/decode pipeline — re-editing an inserted mindmap is
// out of scope for v0.1.
PluginManager.registerButton(BUTTON_TYPE_TOOLBAR, ['NOTE'], {
  id: TOOLBAR_BUTTON_ID,
  name: 'Mindmap',
  icon: Image.resolveAssetSource(require('./assets/icon.png')).uri,
  showType: SHOW_TYPE_WITH_UI,
});
