# Mindmap Plugin for Supernote

![Tests](https://img.shields.io/badge/tests-160%20passed-brightgreen)
![Lint](https://img.shields.io/badge/lint-passing-brightgreen)
![Platform](https://img.shields.io/badge/platform-Supernote-blue)
![License](https://img.shields.io/badge/license-MIT-blue)
![Version](https://img.shields.io/badge/version-1.0.1-blue)

A Supernote plugin that brings first-class mindmap authoring into the Notes system. Open a note, tap **Mindmap**, build a tree of labelled, connected nodes, and tap **Insert** — the plugin drops the whole map onto your current page as native ink and text elements, ready for you to annotate, lasso, move, and write around with your Supernote pen.

## Features

- **Label-first authoring.** A modal pops up the moment you open the plugin asking for the central idea. Type it in or hand-write it with the pen — the host's recognition feeds the same `TextInput`. Add Child / Add Sibling open the same modal; tap any existing node to edit its label.
- **Shape-by-depth hierarchy.** Root is an **Oval**, depth-1 is a **Rounded Rectangle**, depth-2 is a **sharp Rectangle**, depth-3 and deeper are **Parallelograms**. Visual hierarchy reads at a glance, no legend required.
- **Auto radial layout.** Nodes fan out from the root automatically. Subtree leaf counts drive the angular slices, so a heavy branch gets more arc than a single-leaf one. The layout switches between fan mode (≤ 2 children) and full-ring mode (≥ 3 children) based on branching factor.
- **Auto-fit and auto-center.** The whole map is uniformly scaled to fit the current page (with a 200 px breathing-room margin on every side) and centered on the page. Doesn't matter how many nodes you add — the result always lands inside the page bounds with room to lasso.
- **Persistent authoring canvas.** The mindmap you authored stays in the canvas across plugin opens and Insert cycles. The only way to wipe it is the explicit two-tap **Confirm Clear** in the top bar (a single tap arms it; a second tap within three seconds commits).
- **Single-button affordances.** Per-node controls are kept to the essentials: a `↳` pill for **Add Child**, a `→` pill for **Add Sibling**, a collapse dot/ring for any node with children, and a `×` for **Delete** on the selected non-root node. Add Sibling is hidden on the root (siblings of the root would mean a forest, not a tree).
- **Fast insert.** One batched `replaceElements` call — about **1–2 seconds end-to-end** for ~300 geometry primitives — instead of the per-element fsync loop that used to take ~80 s. The plugin view dismisses cleanly when the page is repainted.
- **Native ink output.** Outlines and connectors land as `TYPE_GEO` elements; labels land as `TYPE_TEXT` elements with auto-sized fonts and centred alignment, padded inside each node's bbox so the text never kisses the outline. Once on the page it's just ink — annotate it, lasso it, move it, or write inside the node outlines with your pen.

## How it works

The plugin owns **topology and labels only**. When you tap Insert:

1. The tree is auto-expanded (so collapsed subtrees still emit) and laid out radially in mindmap-local coordinates.
2. The union bounding box is uniformly scaled to fit the current page minus a 200 px margin on each side, then translated so the box's centroid sits exactly on the page centroid.
3. For every node, the plugin emits an outline geometry — Oval, Rounded Rectangle, Rectangle, or Parallelogram — and for every parent → child edge, a connector segment.
4. Each emitted geometry is wrapped in a freshly-minted `Element` (via `PluginCommAPI.createElement(TYPE_GEO)` so the host's native validator gets the `uuid` / `angles` / `contoursSrc` plumbing it expects), and each labelled node gets a `TYPE_TEXT` element with the node's bbox shrunk by 8 px as `textRect`.
5. A single `PluginFileAPI.replaceElements(notePath, page, [existing..., newElements])` call writes the whole batch atomically — one host-side fsync regardless of element count.
6. `PluginCommAPI.reloadFile()` repaints the page; `PluginManager.closePluginView()` (fire-and-forget) dismisses the plugin.

By design, **once a mindmap is on the page it is just ink and text** — the plugin does not round-trip it back into the editor. Re-authoring means clearing and starting over (or building a new one alongside).

## Usage

1. Open a note on your Supernote.
2. Tap the **Plugins** icon in the left toolbar (the puzzle piece) and select **Mindmap**.
3. The plugin opens with a "Central idea" prompt. Type or hand-write your root label and tap **Create**.
4. Tap `↳` next to any node to add a child; tap `→` below any non-root node to add a sibling. The same modal pops up for the new node's label.
5. Tap any existing node to edit its label. Tap the collapse dot on a node with children to hide its subtree (collapse is authoring-only — every node is re-emitted on Insert regardless).
6. Tap the `×` on a selected non-root node to delete that subtree. Tap **Clear** twice to wipe the whole tree back to a fresh Central idea prompt.
7. Tap **Insert** when the topology is ready. The plugin draws node outlines, connectors, and labels onto the page in one batched write and dismisses itself.

## Limits

There is no hard node-count cap — the only ceiling is what fits readably on the page after the auto-fit scaler shrinks the layout. In practice trees up to ~50 nodes lay out comfortably on a Nomad portrait page; beyond that the auto-fit scale gets aggressive enough that the labels start to look small.

Performance targets on Nomad: plugin launch ≤ 700 ms, Insert ≤ 2.0 s for any tree the canvas can lay out, authoring stays responsive across mutations.

## Building

Make sure you have Node.js 18+ installed, then:

```sh
npm install
./buildPlugin.sh
```

This produces `build/outputs/SnMindmap.snplg`.

## Installing on the Device

Use the Supernote Partner App to copy `build/outputs/SnMindmap.snplg` to the `MyStyles` folder on your device. Then on the Supernote, navigate to `Settings -> Apps -> Plugins -> Add Plugin` to add the plugin to your Supernote.

## Running Tests

```sh
npm test
```

Covers 160 unit tests across 7 suites: tree mutators and shape-by-depth assignment, radial layout, node-frame geometry (including parallelogram polygon emission), connector + outline emit ordering, the insert pipeline (page-context resolution, fit-to-page scaler, `createElement` + `replaceElements` happy path and error surfaces), and the canvas component (label modal, action pills, top-bar buttons, two-tap clear, key-based remount on Clear).

## Linting

```sh
npm run lint
```

## Project Structure

```
src/
  MindmapCanvas.tsx       Authoring canvas (topology + label modal + action pills + top bar)
  useInsertFlow.ts        Insert pipeline state hook (debounce, pending, error banner)
  insert.ts               §F-IN-* pipeline: layout → emit → createElement → replaceElements → close
  geometry.ts             Point/Rect primitives and bbox helpers
  pluginApi.ts            Thin wrapper over sn-plugin-lib surface
  pluginRouter.ts         Single-listener button → view router
  model/
    tree.ts               Tree model + mutators (add/remove/collapse) + shape-by-depth
  layout/
    radial.ts             Radial auto-layout (leaf-count weighted slices, fan vs ring mode)
    constants.ts          Pen widths, corner radius, shape constants, parallelogram skew
  rendering/
    emitGeometries.ts     Outlines (oval/rect/rounded-rect/parallelogram) + connectors
    nodeFrame.ts          Shape-aware bbox helpers + parallelogram polygon emission
assets/
  icon.png                Toolbar icon
__tests__/                Jest test suites (one per src module)
index.js                  Plugin entry — toolbar button registration
App.tsx                   React Native root component
PluginConfig.json         Plugin metadata (id, version, icon)
buildPlugin.sh            Builds SnMindmap.snplg under build/outputs/
```

## Architecture Notes

The insert pipeline is built around a single batched `replaceElements` call. Earlier iterations called `insertGeometry` per element, which the firmware fsyncs individually — at ~260 ms per fsync, a 300-primitive map took 80 seconds. The current pipeline mints native-backed `Element` objects via `createElement(TYPE_GEO|TYPE_TEXT)` (so the host validator gets the internal accessors a hand-built `{type:700,…}` object would lack) and hands the whole batch — existing page elements plus the new mindmap — to `replaceElements` in one go. One fsync, ~1–2 seconds total.

`MindmapCanvas` owns rendering and per-node mutation; `useInsertFlow` owns insert lifecycle (debounce, pending state, transient error banner). The label modal is an absolute-positioned `<View>` overlay rather than RN's `<Modal>` because the latter's Android Dialog wrapper has rendering quirks on the Supernote firmware (intermittent failure to mount after a Clear). The canvas surface is keyed on a `clearTick` integer that increments on every Clear, forcing React to unmount/remount the whole stage subtree — belt-and-suspenders against e-ink partial-refresh ghosts that would otherwise leave the previous tree's icon glyphs visible after a Clear.

The radial layout switches between **fan mode** (`< 3` children, 120° span centred on the parent angle) and **full-ring mode** (`≥ 3` children, 360°). Children's angular slices are proportional to their subtree leaf count, so a heavy branch gets proportionally more arc than a single-leaf sibling — keeps the visual weight balanced regardless of tree shape.

---

Hope you enjoy using this plugin as much as I enjoyed developing it. If you find any issues, please feel free to raise an [Issue](https://github.com/j-raghavan/sn-mindmap/issues).
