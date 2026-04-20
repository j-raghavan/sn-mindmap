# Mindmap Plugin for Supernote

![Tests](https://img.shields.io/badge/tests-314%20passed-brightgreen)
![Lint](https://img.shields.io/badge/lint-passing-brightgreen)
![Platform](https://img.shields.io/badge/platform-Supernote-blue)
![License](https://img.shields.io/badge/license-MIT-blue)
![Version](https://img.shields.io/badge/version-0.1.0-blue)

A Supernote plugin that lets you author mindmaps directly inside a note. Tap to add and connect nodes, insert the topology into your page, then label each node with your native Supernote pen. Re-edit later by lassoing the block and tapping **Edit Mindmap** — the tree structure and your handwritten labels round-trip intact.

## What the plugin owns (and what it doesn't)

The plugin owns **topology only** — nodes, shapes, connectors, and an embedded marker that lets the map round-trip through Edit. It never captures stylus input. Node labels are written on the page with the Supernote's native pen, at full firmware fidelity, after the mindmap is inserted. On Edit the plugin reads your label strokes back from the lassoed selection and associates them to nodes by bounding-box containment, so labels follow their nodes when you reorganize the tree.

## How to Use

### Author a new mindmap

1. Open a note on your Supernote.
2. Tap the **Plugins** icon in the left toolbar (the puzzle piece).
3. Tap **Mindmap** to open the authoring canvas. You'll see a single empty **Oval** — the root — centered on screen.
4. Tap **Add Child** (chevron-right, thicker stroke) next to any node to append a sharp-rectangle child; tap **Add Sibling** (chevron-down, thinner stroke) to append a rounded-rectangle sibling at the same level. The canvas re-centers on each mutation.
5. Tap the collapse toggle on any node with children to hide or re-show the subtree (authoring convenience only — every node is re-emitted on Insert).
6. Tap the **×** on a selected non-root node to delete that subtree. Tap **Clear** twice to reset the whole tree back to a lone root.
7. Tap **Insert** when the topology is ready. The plugin draws node outlines + connectors + the embedded marker to the page, auto-lassoes the block, and closes.
8. With the block still selected, write each node's label inside its outline using your Supernote pen.

### Edit an existing mindmap

1. Lasso the previously inserted mindmap block, including any label strokes you wrote inside the node outlines.
2. Tap **Edit Mindmap** in the contextual lasso toolbar. The authoring canvas re-opens with the decoded tree fully expanded, every node's original shape preserved, and your label strokes rendered inside each node as read-only reference.
3. Add, remove, or rearrange nodes as you like. Labels follow their nodes — when you Save, each preserved stroke is translated by its node's move delta so the handwriting stays anchored to the node it belongs to.
4. If any strokes in your lasso fell outside every node's bbox, Save first asks you to confirm — cancel and re-lasso with a wider selection if you want to keep them.
5. Tap **Save**. The plugin deletes the pre-edit block, re-emits the new topology + preserved labels at their translated positions, auto-lassoes the new block, and closes.

## Limits

A single mindmap may contain up to **50 nodes** (root + 49 descendants). Trees that exceed this cap surface a **"Mindmap too large"** modal on Insert/Save — reduce nodes on the canvas and try again. The cap is a hard ceiling of the on-page marker (§F-PE-4); it is not a soft quota.

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
    encode.ts             encodeMarker + MarkerCapacityError
    decode.ts             decodeMarker + bit-matrix parse
    rs.ts                 Reed-Solomon (GF256) + CRC32
assets/
  icon.png                Toolbar icon
index.js                  Plugin entry point (toolbar button registration)
App.tsx                   React Native root component
```

---

Hope you enjoy using this plugin as much as I enjoyed developing it. If you find any issues, please feel free to raise an [Issue](https://github.com/j-raghavan/sn-mindmap/issues).
