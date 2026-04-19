import {AppRegistry, Image} from 'react-native';
import App from './App';
import {name as appName} from './app.json';
import {PluginManager} from 'sn-plugin-lib';
// Side-effect import: installs the single PluginManager.registerButtonListener
// used by both buttons (id=100 toolbar, id=200 lasso) and prefixes dispatch
// logs with [PLUGIN_ROUTER] for logcat searchability.
import {installPluginRouter} from './src/pluginRouter';

const BUTTON_TYPE_TOOLBAR = 1;
const BUTTON_TYPE_LASSO_TOOLBAR = 2;
const TOOLBAR_BUTTON_ID = 100;
const EDIT_MINDMAP_BUTTON_ID = 200;
const SHOW_TYPE_WITH_UI = 1;
// editDataTypes: [5] = geometry. Per requirements §F-ED-1 and the
// auto_lasso_integration_plan.md §2.1 in sn-shapes, this gates the
// "Edit Mindmap" lasso-toolbar button so it only appears when the user
// has a geometry selection — i.e. our previously-inserted mindmap block.
const EDIT_DATA_TYPE_GEOMETRY = 5;

AppRegistry.registerComponent(appName, () => App);

PluginManager.init();
installPluginRouter();

// Two entry points (per requirements §7.3):
//
//   id=100  "Mindmap"       — toolbar; opens the authoring canvas.
//   id=200  "Edit Mindmap"  — lasso toolbar; appears when a geometry is
//                             lassoed; opens the canvas pre-populated
//                             with the decoded tree (see §5.4 / §F-ED-*).
//
// The sister project sn-shapes removed its id=200 button on 2026-04-18
// because every option it offered was redundant with its main popup.
// sn-mindmap's id=200 is fundamentally different — it's the round-trip
// entry point for editing existing maps, not a re-style panel — so the
// pattern recovered from sn-shapes/auto_lasso_integration_plan.md §2.2
// is reinstated here with id=200 (per §7.3, not the plan's original id=2).
PluginManager.registerButton(BUTTON_TYPE_TOOLBAR, ['NOTE'], {
  id: TOOLBAR_BUTTON_ID,
  name: 'Mindmap',
  icon: Image.resolveAssetSource(require('./assets/icon.png')).uri,
  showType: SHOW_TYPE_WITH_UI,
});

PluginManager.registerButton(BUTTON_TYPE_LASSO_TOOLBAR, ['NOTE'], {
  id: EDIT_MINDMAP_BUTTON_ID,
  name: 'Edit Mindmap',
  icon: Image.resolveAssetSource(require('./assets/edit_icon.png')).uri,
  enable: true,
  editDataTypes: [EDIT_DATA_TYPE_GEOMETRY],
});
