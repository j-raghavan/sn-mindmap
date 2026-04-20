# Mindmap Plugin for Supernote

![Tests](https://img.shields.io/badge/tests-314%20passed-brightgreen)
![Lint](https://img.shields.io/badge/lint-passing-brightgreen)
![Platform](https://img.shields.io/badge/platform-Supernote-blue)
![License](https://img.shields.io/badge/license-MIT-blue)
![Version](https://img.shields.io/badge/version-0.1.0-blue)

A Supernote plugin that brings first-class mindmap authoring into the Notes system. Open a note, tap **Mindmap**, build a tree of connected nodes, insert it into the page, and label each node with your native Supernote pen. Later, lasso the block and tap **Edit Mindmap** to re-enter the authoring canvas with the structure intact and your handwritten labels preserved — the plugin translates them with each node as you reorganize the tree.

## Why this plugin

Mindmapping on a Supernote has always meant either sketching boxes and arrows by hand (which quickly becomes unreadable after a few edits) or bouncing out to a companion app on your phone. This plugin keeps everything on the device and in the note, round-trips through a binary marker embedded in the stroke data, and — crucially — never captures your stylus input. Your handwriting stays at full firmware fidelity because the plugin only draws the scaffolding; you write the labels yourself on the page, with your real pen, the same way you write anything else on the Supernote.

## How it works

The plugin owns **topology only**: node outlines, connectors, and an invisible marker block that lets the map round-trip through Edit. Labels are written on the page, with the Supernote's native pen, after the mindmap is inserted. On Edit the plugin reads your label strokes back from the lassoed selection, associates each one to a node by bounding-box containment, and renders them inside each node as read-only reference while you restructure the tree. When you Save, the plugin deletes the pre-edit block and re-emits node outlines + connectors + marker + your preserved labels translated by each node's move delta, so labels follow the nodes they belong to.

The tree renders radially: the root sits at the center as an elongated **Oval** with a thicker border, first-level children fan around it, and deeper levels radiate outward. Node shapes signal how the node was created — children of **Add Child** are sharp rectangles, children of **Add Sibling** are rounded rectangles, and those shapes round-trip verbatim through the marker so your visual distinctions survive an Edit pass.

## Usage

### Author a new mindmap

1. Open a note on your Supernote.
2. Tap the **Plugins** icon in the left toolbar (the puzzle piece).
3. Tap **Mindmap** to open the authoring canvas. You'll see a single empty Oval — the root — centered on screen.
4. Tap **Add Child** (chevron-right, thicker stroke) to append a sharp-rectangle child to any node. Tap **Add Sibling** (chevron-down, thinner stroke) to append a rounded-rectangle sibling at the same level. The canvas re-centers on every mutation so the root stays anchored in view.
5. Tap the collapse badge on any node with children to hide or re-show its subtree. Collapse is authoring-time convenience only — every node is re-emitted on Insert, regardless of collapsed state.
6. Tap the **×** on a selected non-root node to delete that subtree. Tap **Clear** twice to reset the whole tree back to a lone root (a single tap arms the button; a second tap within three seconds commits).
7. Tap **Insert** when the topology is ready. The plugin draws node outlines, connectors, and the marker to the page, auto-lassoes the whole block, and closes the plugin view.
8. With the block still selected, write each node's label inside its outline using your Supernote pen. There's 12 px of internal padding on every shape so there's room to write without crowding the outline.

### Edit an existing mindmap

1. Lasso the previously inserted mindmap block, including any label strokes you wrote inside the node outlines.
2. Tap **Edit Mindmap** in the contextual lasso toolbar (the button appears only when you have a geometry selection).
3. The authoring canvas re-opens with the decoded tree fully expanded, every node's original shape preserved, and your label strokes rendered inside each node outline as read-only reference. The labels are dimmed slightly so they visually differentiate from editable affordances.
4. Add, remove, or rearrange nodes as you like. Labels follow the nodes they belong to — when you Save, each preserved stroke is translated by its node's move delta so the handwriting stays anchored.
5. If any strokes in your lasso fell outside every node's bbox, Save first asks you to confirm. Cancel and re-lasso with a wider selection if you want to keep those strokes; Save anyway drops them and proceeds.
6. Tap **Save**. The plugin deletes the pre-edit block, re-emits the new topology at the same origin with preserved labels translated to their new positions, auto-lassoes the new block, and closes.

## Limits

A single mindmap can contain up to **50 nodes** (root + 49 descendants). Trees that exceed this cap surface a **"Mindmap too large"** modal on Insert or Save — reduce the node count on the canvas and try again. The cap is the hard ceiling of the on-page marker: the 72×72 binary grid has a fixed 648-byte channel, and the design requires ≥ 20% of that as Reed-Solomon parity so decode is tolerant to on-device stroke jitter. Splitting into multiple mindmaps is the intended escape hatch for larger structures.

Performance targets on Nomad: plugin launch ≤ 700 ms, Insert ≤ 2.0 s for a 30-node map, authoring remains responsive up to ~100 nodes (beyond that the canvas may feel sluggish, though insert is still gated at the 50-node cap). Artifact size is ≤ 2 MB.

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

Covers 314 unit tests across 12 suites: tree mutators, radial layout, node-frame geometry, stroke association and translation, the Reed-Solomon + CRC32 marker codec, bit-matrix render and parse round-trips, the insert pipeline, the canvas component (action icons, top-bar buttons, dialogs), and the reusable `ConfirmDialog`.

## Linting

```sh
npm run lint
```

## Project Structure

```
src/
  MindmapCanvas.tsx       Authoring canvas (topology + action icons + top bar)
  useInsertFlow.ts        Insert/Save pipeline state hook (debounce, errors, dialogs)
  ConfirmDialog.tsx       Reusable centered-card modal (§8.1, §F-PE-4)
  EditMindmap.tsx         Edit-round-trip orchestration (decode + mount)
  insert.ts               §F-IN-* pipeline: emit + insertGeometry + lasso + close
  geometry.ts             Point/Rect primitives and bbox helpers
  pluginApi.ts            Thin wrapper over sn-plugin-lib surface
  pluginRouter.ts         Single-listener button → view router
  model/
    tree.ts               Tree model + mutators (add/remove/collapse)
    strokes.ts            Preserved-stroke bucket + translation types
  layout/
    radial.ts             Radial auto-layout
    constants.ts          Pen widths, corner radius, shape constants
  rendering/
    emitGeometries.ts     Node outlines + connectors + marker emit
    nodeFrame.ts          Shape-aware bbox helpers
  marker/
    encode.ts             encodeMarker + MarkerCapacityError (§F-PE-4)
    decode.ts             decodeMarker + bit-matrix parse
    rs.ts                 Reed-Solomon (GF256) + CRC32
assets/
  icon.png                Toolbar icon
  edit_icon.png           Lasso-toolbar icon
__tests__/                Jest test suites (one per src module)
index.js                  Plugin entry — toolbar + lasso-toolbar button registration
App.tsx                   React Native root component
PluginConfig.json         Plugin metadata (id, version, icon)
buildPlugin.sh            Builds SnMindmap.snplg under build/outputs/
```

## Architecture Notes

Insert and Save share a single state-machine hook, `useInsertFlow`, which owns debounce, pending state, the transient error banner, the §F-PE-4 capacity modal, and the §8.1 out-of-map confirmation dialog. `MindmapCanvas` renders the tree and top bar and hands topology to the hook; `ConfirmDialog` is a reusable centered-card modal used by both the capacity and out-of-map surfaces. This keeps `MindmapCanvas` focused on rendering, the hook focused on lifecycle, and the dialog focused on presentation — no concern leaks into the others.

The marker pipeline is deliberately tiny and self-contained: fixed 10-byte node records → a CRC32-guarded message → a full-channel Reed-Solomon codeword → a 72×72 bit matrix rendered as dark-gray 3-px line segments in the top-left of the mindmap's bounding rectangle. Decode reverses every step and validates the CRC against the RS-corrected message (not the raw bits), so a few misread cells are recoverable without the user noticing.

---

Hope you enjoy using this plugin as much as I enjoyed developing it. If you find any issues, please feel free to raise an [Issue](https://github.com/j-raghavan/sn-mindmap/issues).
