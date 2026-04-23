# sn-mindmap — Requirements

**Author:** Jayasimha (`jrlabs01@gmail.com`)

**Date:** April 18, 2026

**Status:** Draft v0.10 — node ceiling raised to N=50 (72×72 marker grid) and in-plugin handwriting capture dropped (plugin is topology-only; labels use the firmware's native pen post-insert). See §12 changelog.

**Sister project:** [`sn-shapes`](./sn-shapes) (conventions, plugin router, and insertion pipeline reused verbatim)

**Target firmware (provisional — see §10):** Supernote Chauvet on Nomad (1404×1872 confirmed) and Manta (1920 width confirmed; full resolution pending verification). The exact Chauvet minimum version has not been confirmed; `sn-shapes` logs reference 3.27.41(2274) but that is not authoritative as the earliest working build. Do not treat these values as frozen requirements until §10 verification items are closed.

**Library:** `sn-plugin-lib` ^0.1.19

---

## 1. Summary

`sn-mindmap` is a Supernote plugin that adds first-class mindmap authoring to the Notes system. A user taps the Mindmap toolbar icon, authors a mindmap's **topology** inside a dedicated plugin canvas (center node, add child, add sibling, expand/collapse, auto-center on mutation), inserts the finished mindmap into the current note page as an embedded stroke block, and writes each node's label directly on the note page using the Supernote's native pen. The user can later lasso the inserted block and tap "Edit Mindmap" to re-enter the authoring view with the structure intact and the labels preserved as the on-page strokes the user wrote. Note: expand/collapse is an authoring-time convenience only (see §4 and §F-IN-2); at Insert time all subtrees are auto-expanded so every node is emitted, and collapse state is not persisted across the insert/edit round trip.

**The plugin never captures stylus input.** Node *labels* are written by the user on the note page after insert, using the firmware's native pen surface, at full firmware fidelity. The plugin owns only the tree topology, the node shape assignment (§F-AC-3), the connector layout, and the marker (§6). On Edit the plugin reads existing label strokes from the lasso via `getLassoGeometries()`, associates them to nodes by bounding-box containment (§F-ED-5), and translates them to follow node moves when the user reorganizes the tree.

The plugin reuses the `sn-shapes` skeleton — React Native + `sn-plugin-lib`, `snplg` packaging, `PluginManager.registerButton` entry points, the single-listener `pluginRouter.ts` pattern, and the `PluginCommAPI.insertGeometry` / `modifyLassoGeometry` / `deleteLassoElements` insertion and edit APIs.

---

## 2. Goals and non-goals

### 2.1 Goals

- Let the user build a mindmap on a Supernote without leaving the note-taking context.
- Node *labels* are written with the firmware's native pen on the note page after the mindmap is inserted. The plugin does not capture, render, or own label strokes during authoring. Label fidelity = firmware native-pen fidelity, full stop.
- Inserted maps are re-editable via a lasso-toolbar "Edit Mindmap" action that round-trips the *topology* through a structured representation (no OCR, no stroke-shape heuristics). Labels are preserved across the round-trip by reading them from the lassoed strokes on Edit and re-emitting them at the new node positions on Save (see §F-ED-5 / §F-ED-7). Every visible node (root + all descendants) round-trips; collapsed branches are auto-expanded at insert, so there is no hidden state that can be lost on edit (see §8.6).
- Feel native to Supernote — e-ink friendly, monochrome, large tap targets, no keyboard required.

### 2.2 Non-goals (v0.1)

- Real-time collaboration or cloud sync.
- OCR of node labels, search across mindmaps, or cross-map linking.
- Importing/exporting to OPML, Markdown, or third-party mindmap formats. (Tracked as v0.2.)
- Horizontal-tree layout. (Tracked as v0.2.)
- Typed text input.
- **In-plugin handwriting capture.** Earlier drafts had a per-node handwriting pad inside the plugin canvas; v0.10 dropped it. Labels are written exclusively on the note page using the firmware's native pen, after insert. The plugin canvas shows tree topology only.
- Rendering the mindmap as a PDF/PNG export. The mindmap lives inside the `.note` as strokes.

---

## 3. Confirmed design decisions

These were resolved in the requirements review on April 17, 2026:

| # | Decision area | Choice | Implication |
|---|---|---|---|
| 1 | Label input on the inserted block | Labels are written with the firmware's native pen directly on the note page, after the plugin inserts the topology. The plugin never captures stylus input. | No in-plugin stroke capture surface needed; no font rasterization; no vector-text generator. Label fidelity = native-pen fidelity. Edit reads the existing on-page strokes back via `getLassoGeometries()`. |
| 2 | What the plugin canvas owns | Tree topology, shape assignment per node (§F-AC-3), connector layout, and the marker. Nodes render as empty outlines during authoring. | Authoring canvas is a pure layout editor. The only strokes the plugin ever emits are outlines, connectors, and marker cells. This eliminates the capture risk flagged in v0.9's §13.3. |
| 3 | Persistence for re-editability | Embedded marker strokes carry a compact **binary** topology payload (fixed-size records, no JSON, no compression — see §6.2 / §6.3), visible inside the inserted block — this is the **only** persistence mechanism in v0.1 | No sidecar files, no plugin storage. Portable across note rename/copy. Capacity is hard-limited (§6.2 / §8.3); trees that exceed it are rejected with a size-cap error rather than falling back. A sidecar path was considered but deferred: `sn-plugin-lib` ^0.1.19 exposes no byte-write primitive (`PluginFileAPI` has none; `NativeFileUtils` exposes `exists`, `makeDir`, `renameToFile`, `copyFile`, `listFiles`, `deleteFile`, `getExportPath`, and similar — among others — but no arbitrary write; see `node_modules/sn-plugin-lib/lib/typescript/src/module/NativeFileUtils.d.ts`). |
| 4 | Authoring layout | Radial mindmap: root centered, first-level children fanned around it, deeper levels spread outward | Matches canonical mindmap idiom; deterministic auto-layout on node add/delete; re-centers on mutation. |

---

## 4. User stories

### 4.1 Author a new map (the first-run flow)

1. **Open the canvas.** From an open note, the user taps Plugins → Mindmap. The plugin canvas opens centered on the device viewport.
2. **See the root.** The canvas renders a single node at its origin: an **Oval** (elongated rounded rectangle with extra-round edges) with a **darker border** than ordinary nodes. The oval is empty — no text, no placeholder. The user will label it on the note page after insert.
3. **Grow the tree.** Two action icons float next to the active node:
   - **Add Child** — chevron-right, drawn with a **thicker stroke** than the sibling icon.
   - **Add Sibling** — chevron-down, drawn with a **thinner stroke**.
   On the root Oval, **only Add Child is shown** — the root has no siblings by definition, so Add Sibling is suppressed (not merely disabled).
4. **Shape follows action.** When the user taps Add Child, a new **sharp rectangle** node is created and connected to the current node. When the user taps Add Sibling, a new **rounded rectangle** node is created at the same tree level. Shape is determined by *which icon created the node*, not by tree depth — so two children of the same parent can have different shapes depending on whether they were each added via Add Child from the parent, or chained via Add Sibling from an existing sibling.
5. **Re-center on mutation.** As soon as a node is added (or deleted, collapsed, expanded), the canvas re-runs the radial layout and animates so the Central Oval stays anchored at the visual center (§F-AC-6).
6. **Insert and label.** When the topology is ready, the user taps Insert. The plugin emits node outlines + connectors + marker to the note page, auto-lassos the block (§F-IN-3), and closes. The user then writes each node's label on the note page using the Supernote's native pen, inside the corresponding node outline. Because nodes are drawn with a 12 px internal padding (§8.1), there is visible room to write without crowding the outline.

### 4.2 Expand / collapse a branch (authoring-only)

Any node that has **at least one child** shows an Expand / Collapse toggle (filled circle when expanded, ring with `+N` when collapsed, where `N` is the count of hidden descendants). Tapping the toggle hides or re-shows the subtree rooted at that node inside the plugin canvas; the canvas re-centers. This is authoring convenience only — it is **not** persisted across Insert. At Insert time the plugin auto-expands every subtree so every node is emitted (§F-IN-2). On subsequent Edit the decoded tree arrives fully expanded; the user can re-collapse in that editing session. Collapse is therefore offered on any node that has children, regardless of whether those children were added via Add Child or Add Sibling (or a mix).

### 4.3 Delete a node

Long-press or tap a per-node trash icon → the subtree rooted at that node is removed. Layout recomputes, canvas re-centers. Deleting the root is disabled — the user must Cancel the whole authoring session instead.

### 4.4 Insert into the note

User taps "Insert". The plugin lays out the mindmap at the current scale, renders the strokes (node outlines in the correct shape per §F-IN-2.1–2.2 + connectors + embedded marker — **no label strokes**, since labels live on the note page), calls `insertGeometry` / `insertElements`, and closes the plugin view. The inserted block is auto-lassoed via the explicit `lassoElements(unionRect)` call (§F-IN-3). The user then writes labels on the page with the firmware's native pen.

### 4.5 Edit an existing inserted map

User lassos the inserted block (including any labels they have written inside node outlines). A "Edit Mindmap" contextual lasso-toolbar button appears. Tapping it opens the plugin canvas pre-populated with the decoded tree (fully expanded, every node's original shape preserved via the shape-kind byte in the marker — §6.3). The plugin also reads the label strokes from the lassoed selection and associates them to nodes by bbox containment (§F-ED-5); inside the authoring canvas each node's outline shows the existing label strokes as read-only reference so the user can remember what each node represents while editing topology. Saving re-emits node outlines + connectors + marker at the new positions, plus each node's preserved label strokes translated by that node's move delta so labels follow their nodes (§F-ED-7).

### 4.6 Abandon an edit

A "Cancel" button exits the plugin without touching the note.

---

## 5. Functional requirements

### 5.1 Authoring canvas

- **F-AC-1.** The plugin UI opens in a full-screen React Native view, identical entry-point pattern to `ShapePalette.tsx` in `sn-shapes`.
- **F-AC-2.** The canvas is a pannable, zoomable surface. On open with no prior state, the canvas shows a single root node at its logical origin (0, 0) and is centered on screen. The root node is an **Oval** (elongated rounded rectangle, corner radius ≥ half the node's shorter side so the short edges fully round) with a **darker border** (pen width ≥ 500) than non-root nodes.
- **F-AC-3.** Node shape is determined by the action that created the node:
  - **Root** (always node 0): Oval, darker border, empty (no text, no placeholder) during authoring.
  - **Created by Add Child:** sharp-cornered rectangle, standard border weight.
  - **Created by Add Sibling:** rounded rectangle (small corner radius, distinct from the root's Oval), standard border weight.
  Shape is stored per-node (see §6.3 shape-kind byte) and round-trips through Insert → Edit.
- **F-AC-4.** Nodes are pure outline containers during authoring. The plugin does not capture stylus input inside the canvas — there is no per-node handwriting pad. Labels are written with the firmware's native pen on the note page after the mindmap is inserted (§4.1 step 6). On Edit mode (§F-ED-5), the plugin reads existing on-page label strokes from the lasso and renders them inside each node as read-only reference so the user can see which node represents which idea while editing topology; those reference strokes are not editable inside the plugin and are preserved verbatim (translated only by node-move deltas) on Save.
- **F-AC-5.** Each node exposes the following affordances, with **stroke-intensity differentiation on the two primary icons**:
  - **Add Child** (chevron-right icon to the right of the node) — rendered with a **thicker** stroke weight (the "primary" action).
  - **Add Sibling** (chevron-down icon below the node) — rendered with a **thinner** stroke weight.
    - On the root Oval, Add Sibling is **hidden** (not merely disabled) because the root has no siblings.
  - **Collapse/Expand toggle** — visible only when the node has ≥ 1 child. Expanded = filled circle; collapsed = ring badge showing `+N` where `N` is the hidden-descendant count.
  - **Delete subtree** (small × in the top-right corner, visible only when the node is selected). Hidden on the root (the root cannot be deleted; use Cancel instead).
- **F-AC-6.** When a node is added, deleted, expanded, or collapsed, the canvas re-runs the radial layout and animates to re-center the canvas on the root. Animation budget ≤ 250 ms; no animation on e-ink if the device is in "fast refresh" mode.
- **F-AC-7.** Undo/redo is supported for: add node, delete subtree, move node (phase 2), edit label strokes.
- **F-AC-8.** The canvas shows a persistent top bar with `Cancel | Insert` buttons. The tree is never empty (it always has a root). Insert is always enabled when the tree has ≥ 1 node (always true) — there is no committed-strokes precondition because the plugin does not own labels.

### 5.2 Radial layout (v0.1)

- **F-LY-1.** Root is placed at canvas origin.
- **F-LY-2.** First-level children are placed on a circle of radius `R1` around the root. Positions are distributed evenly around the circle, skipping an angular wedge behind the root when relevant.
- **F-LY-3.** Deeper levels radiate outward; each node occupies an angular slice whose width is proportional to the number of leaves in its subtree. This keeps siblings from overlapping after a subtree expands.
- **F-LY-4.** Connector between parent P and child C is a straight line segment, rendered as a `straightLine` geometry (see `sn-shapes/src/shapes.ts` for the type). Curved connectors are phase 2.
- **F-LY-5.** Layout constants (`R1`, node width/height, inter-level radius increment) are tuned empirically for both Nomad and Manta. Values stored in `src/layout/constants.ts`.
- **F-LY-6.** If the laid-out map is wider than the note page, on **insert** the plugin scales uniformly to fit with a configurable margin (default 80 px on all sides). Scaling applies to node positions and node outline dimensions. On re-insert from Edit mode (§F-ED-7), preserved label strokes are **translated** to follow each node's move delta but are **not scaled** — if the target node resizes, its labels stay at their original pixel scale and center within the new node bbox. Re-scaling handwritten strokes on re-insert is out of scope for v0.1 because it would re-sample user handwriting and degrade fidelity.

### 5.3 Insertion into the note

- **F-IN-1.** On Insert tap, the plugin resolves the current page dimensions using the full `resolvePageSize()` helper pattern from `sn-shapes/src/ShapePalette.tsx`: first `PluginCommAPI.getCurrentFilePath()` → `PluginCommAPI.getCurrentPageNum()` → `PluginFileAPI.getPageSize(notePath, page)`, with a fall-through to `DEFAULT_PAGE_WIDTH / DEFAULT_PAGE_HEIGHT` if any step fails.
- **F-IN-2.** The plugin first auto-expands all collapsed subtrees in the in-memory tree so every node becomes emittable, then emits the following geometries per mindmap. Node outlines are selected per the node's stored **shape kind** (§6.3):
  1. For each node, emit its outline according to its shape kind:
     - **Oval (root):** a `GEO_polygon` approximating an elongated rounded rectangle with corner radius ≥ half the shorter side, rendered at the **darker** border weight (pen width ≥ 500). Reuse `roundedRectPoints()` from `sn-shapes/src/shapes.ts` with an aggressive corner-radius parameter, or a `GEO_ellipse` if the Oval proportions match an ellipse exactly. Pick whichever produces the closer visual match on-device; the choice is a §10 tuning item.
     - **Rectangle (Add-Child node):** a `GEO_polygon` with 4 points (sharp corners), standard border weight.
     - **Rounded rectangle (Add-Sibling node):** a `GEO_polygon` from `roundedRectPoints()` with a small corner radius (e.g., 15 px), standard border weight.
  2. For each connector: a `straightLine` from parent center to child center, stopping at the parent's and child's node outlines. Connector pen width follows the node border weight of its **child** so visual hierarchy stays consistent with the node shape.
  3. **Labels are NOT emitted on first insert.** The plugin does not own label strokes; the user writes them on the page after insert using the firmware's native pen. On *re-insert from Edit mode* the plugin re-emits each node's preserved label strokes (read from the lasso on Edit per §F-ED-5) translated by that node's move delta. Each preserved label stroke is emitted as a `GEO_polygon` open polyline (or its original geometry type if it was already non-polygonal); pen width and color come from the original stroke's metadata, not from any plugin setting.
  4. One marker block (see §6) encoding the tree topology in a fixed position relative to the root (top-left of the inserted bounding rectangle).
- **F-IN-3.** All geometries are inserted using `PluginCommAPI.insertGeometry` in sequence, or batched via `PluginFileAPI.insertElements(notePath, page, elements)` when stable. **Every** emitted geometry carries `showLassoAfterInsert: false` — the `sn-shapes` pattern of setting that flag on the single inserted geometry does not generalize to a multi-geometry block (the firmware has no documented behavior for "re-use the last inserted geometry's flag across a batch"). Instead, after the final insert completes, the plugin calls `PluginCommAPI.lassoElements(unionRect)` explicitly, where `unionRect` is the axis-aligned bounding rectangle of all emitted geometries, to produce a single group-selection over the whole mindmap block.
- **F-IN-4.** The plugin view closes via `PluginManager.closePluginView()` after the insert completes, matching `sn-shapes` behavior.
- **F-IN-5.** Insert is atomic from the user's POV: on any failure mid-insert, the plugin shows a banner error (same pattern as `ShapePalette.tsx`), and attempts best-effort cleanup by lassoing the partial union rect and calling `deleteLassoElements()` before re-raising. Acceptable for v0.1 to surface the error and require manual cleanup if automatic cleanup fails.

### 5.4 Edit an existing inserted map

- **F-ED-1.** Register a lasso-toolbar button (`BUTTON_TYPE_LASSO_TOOLBAR = 2`) with `editDataTypes: [5]` (geometry) so it appears only when a geometry is lassoed. Pattern: `index.js` in `sn-shapes`.
- **F-ED-2.** On tap: the plugin reads the lassoed geometries via `PluginCommAPI.getLassoGeometries()`.
- **F-ED-3.** The plugin scans the returned geometries for a marker block (§6) and decodes the tree topology.
- **F-ED-4.** If no marker is found, the plugin shows: "No mindmap structure found in this selection. Lasso the full mindmap and try again." and closes.
- **F-ED-5.** If the marker is found, the plugin associates the remaining lassoed geometries to their nodes by bounding-box membership: each node's bbox is part of the topology payload, and any stroke whose bounding box falls inside a node's bbox (after re-projecting from mindmap-local to page coordinates via the marker's lassoed position) becomes that node's *preserved label strokes*. Strokes that fall outside every node bbox are marker cells, connectors, or out-of-map drawings; the plugin ignores them for label purposes. Each preserved stroke is stored in full with its original pen color, pen width, and points, so the round-trip does not touch firmware stroke metadata.
- **F-ED-6.** The canvas re-opens in edit mode pre-populated with the decoded tree. Each node's preserved label strokes are rendered inside its outline in the authoring canvas as read-only reference (dimmed slightly so they visually differentiate from editable affordances). The user cannot modify label strokes inside the plugin — to rewrite a label, they finish editing topology, Save, and then rewrite on the page using the firmware's native pen.
- **F-ED-7.** On Insert/Save from edit mode: the plugin deletes the original lassoed elements via `deleteLassoElements()`, then re-inserts the updated block at the same union-rect origin. Re-emission order: node outlines, connectors, marker, then each node's preserved label strokes translated by that node's position delta between the pre-edit and post-edit layouts. Label strokes for a deleted node are dropped (labels of deleted nodes are not carried over). Label strokes for a newly-added node are empty (the user will write fresh labels post-save). Scaling of the map does not rescale preserved labels (§F-LY-6).

### 5.5 Persistence: marker encoding (§6 defines the format)

- **F-PE-1.** Each inserted mindmap contains exactly one marker block.
- **F-PE-2.** Marker rendering is a grid of tiny strokes in the top-left corner of the mindmap's bounding rect. Each cell is one "bit" (present = 1, absent = 0).
- **F-PE-3.** Marker is rendered at a fixed pixel scale. The v0.1 target is **72×72 cells at 4 px per cell (288×288 px footprint)**, giving a raw channel capacity of 5184 bits = 648 bytes. After header, CRC32, and Reed-Solomon parity overhead the design target is ≥ 500 bytes of usable binary payload (§6.2 sizing). Cell size and grid dimensions are explicit tuning knobs — see §6.2 and §10 — because the correct final sizing depends on on-device stroke capture fidelity and layout headroom.
- **F-PE-4.** The embedded marker is the **only** persistence path in v0.1. If an authored tree's encoded binary payload exceeds marker capacity (§6.2 / §8.3), Insert is blocked with a clear modal: *"This mindmap has more structure than can be embedded. Reduce nodes, or split across multiple mindmaps."* No sidecar fallback is implemented because `sn-plugin-lib` ^0.1.19 provides no byte-write primitive — see the deferred-sidecar note in §3 decision row 3 and the open question in §10.

### 5.6 Non-functional

- **F-NF-1.** Plugin launch (toolbar tap → canvas visible) ≤ 700 ms on Nomad.
- **F-NF-2.** Insert (Insert tap → plugin closed, map visible on page) ≤ 2.0 s for a 30-node map on Nomad. Larger maps degrade linearly; progress indicator shown over 1.0 s.
- **F-NF-3.** Authoring remains responsive (≥ 30 fps perceived) up to 100 nodes. Beyond 100 nodes, canvas may become sluggish — acceptable for v0.1, flagged in Known Limitations.
- **F-NF-4.** Plugin artifact `SnMindmap.snplg` target size ≤ 2 MB (same class as `SnShapes`).
- **F-NF-5.** Memory budget ≤ 80 MB peak during a 100-node authoring session.

---

## 6. Marker encoding — detailed spec

This section documents the on-paper format used to round-trip mindmap structure through Supernote's stroke representation. **Note: in v0.5 this section described a JSON-inside-deflate-inside-a-20×20-grid encoding. An empirical sanity check showed that encoding could not hold even a single node's data in the claimed budget (1 node's deflated JSON measured ~89 bytes; 15 nodes ~199). v0.6 pivots to a compact binary encoding on a larger grid to make the claimed capacity match reality.**

### 6.1 Format summary

A marker is a 72×72 grid of binary cells rendered as short horizontal strokes. Each cell is 4 px × 4 px, giving a total footprint of 288 px × 288 px (about 15% of Nomad page width). The marker sits in the top-left corner of the **mindmap's bounding rectangle** (i.e., it is a sibling element of the nodes, not rendered inside any one node). It is positioned at a small fixed offset from the bbox origin so it is reliably captured whenever the user lassos the whole map, without being mistaken for a node during decode.

Both the grid dimensions (72×72) and cell size (4 px) are design-target starting points, not frozen. §10 tracks on-device tuning — the correct final values depend on stroke-capture fidelity and layout headroom, and the implementation may move to 64×64 or 80×80 after measurement.

### 6.2 Byte layout

Raw channel: 72 × 72 = 5184 bits = **648 bytes**.

```
Byte 0:             format version (uint8; 0x02 for v2 — 72×72 grid)
Byte 1:             node count N (uint8; maximum 255)
Bytes 2..2+10N-1:   packed node records, 10 bytes each (see §6.3)
Bytes 2+10N..2+10N+3: CRC32 of bytes 0..2+10N-1 (big-endian, 4 bytes)
Bytes 2+10N+4..647: Reed-Solomon parity symbols (fill to 648 bytes total)
```

The header + node table + CRC32 is the RS *message*; the remaining bytes are RS *parity*. The design rule is **parity ≥ 20% of message length** so the decoder has at least ~10% worst-case error-correction headroom; implementations are free to choose a higher ratio for more robustness on device.

**Capacity sizing at v2 (72×72 grid, 10 bytes/node binary records, 648-byte channel).** v0.10 raised the grid from 48×48 to 72×72 to lift the node ceiling from 23 to 50, addressing the "23 nodes is too restrictive for first-pass mindmaps" concern raised in the v0.9 review. For each candidate node count, the table shows the fixed message length and the parity bytes that remain if all 648 channel bytes are used. "Verdict" applies the ≥ 20% parity design rule.

| Nodes (N) | Message bytes (2 + 10N + 4) | Parity bytes (648 − message) | Parity ratio | Verdict (≥ 20% parity) |
|---|---|---|---|---|
| 30 | 306 | 342 | 112% | Abundant |
| 40 | 406 | 242 | 60% | Abundant |
| 50 | 506 | 142 | 28% | Healthy |
| 53 | 536 | 112 | 21% | Healthy (at the limit) |
| 54 | 546 | 102 | 19% | Below minimum — reject |
| 60 | 606 | 42 | 7% | Below minimum — reject |
| 65 | 656 | — | — | Exceeds channel |

The hard ceiling at the ≥ 20% parity rule is **N = 53 nodes**, with **N = 50 as the published v0.1 cap** so the headroom buffer is conservative against tighter parity targets discovered during on-device calibration (§10). An implementation that chooses a stricter parity target (e.g., 30% for heavier on-device jitter) lowers the headroom but the v0.1 cap stays at 50. Stepping the ceiling above 53 requires the next grid size (80×80 = 800 bytes channel, 1024-byte footprint at 4 px cells) and is deferred to v0.2.

Trees larger than the chosen ceiling are rejected at Insert with the modal from §F-PE-4. No silent truncation.

### 6.3 Binary node record (10 bytes)

Each node is encoded as a fixed 10-byte record. Node identity is its **index in the records array** (byte offset `2 + 10k` for node `k`); there is no explicit string id.

```
Offset 0:       parent index (uint8; 0xFF = root, otherwise index of parent in this array)
Offset 1:       shape kind (uint8; see enum below)
Offset 2..3:    bbox x  (uint16 big-endian, page-pixel coords relative to marker origin)
Offset 4..5:    bbox y  (uint16 big-endian)
Offset 6..7:    bbox w  (uint16 big-endian)
Offset 8..9:    bbox h  (uint16 big-endian)
```

Shape-kind enum (matches §F-AC-3 / §F-IN-2):

```
0x00 = OVAL              (root only; darker border)
0x01 = RECTANGLE         (created by Add Child; sharp corners)
0x02 = ROUNDED_RECTANGLE (created by Add Sibling; small corner radius)
0x03..0xFF               reserved for future shape kinds
```

Constraints:

- The root node is at index 0, always has parent = `0xFF`, and always has shape kind `0x00` (OVAL).
- Non-root nodes (index ≥ 1) must have shape kind `0x01` or `0x02`.
- `bbox x, y, w, h` must fit in uint16 (0..65535). Page dimensions on Nomad/Manta are well under that, so no scaling is required.
- All coordinates are **mindmap-local** (origin = marker top-left). They are re-projected to page coordinates on decode using the marker's decoded position.

**Why binary, not JSON.** JSON overhead (field names, braces, quotes, commas) plus deflate on such a small payload inflates, not compresses: 1 node ≈ 89 deflated bytes, 15 nodes ≈ 199 deflated bytes — verified empirically during the v0.5→v0.6 review. The fixed 10-byte binary record is several times denser for tiny trees and scales linearly.

No label text is carried in the record. Labels are the handwriting strokes themselves, associated to nodes at decode time by `bbox` containment (§8.1 describes the stroke-to-node disambiguation).

No collapse state is carried. Collapse is authoring-time only (§4.2); every emitted map is fully expanded.

The shape-kind byte lets the Edit round-trip reconstruct each node's original shape without relying on post-hoc geometric analysis of the node's outline strokes.

### 6.4 Rendering

Each "1" bit is rendered as a single `straightLine` geometry of length 3 px at the bit's (col, row) position within the 4-px cell. "0" bits are omitted entirely. Pen color is `0x9D` (dark gray) to keep the marker visually unobtrusive but still captured by lasso at a reasonable pen-width threshold. Pen width is 100 (minimum allowed).

### 6.5 Decoding

On edit, the plugin performs these steps **in this order**:

1. **Collect marker-candidate strokes.** Scan all lassoed `straightLine` geometries with length ≤ 4 px and pen color `0x9D`.
2. **Infer marker origin.** Locate the top-left of the marker grid. The reference point is the top-left of the mindmap's bounding rectangle — the same anchor used at encode time (§6.1). In practice, the decoder derives this from the top-left of the user's lasso bbox, which requires the user to have lassoed the full map (see §8.5 for the partial-lasso caveat; a short-of-full lasso misaligns the grid and is treated as "marker not found" per §F-ED-4).
3. **Recover the bit matrix.** Project each candidate stroke onto the 72×72 grid.
4. **Bits → bytes.** Pack the 5184 bits into 648 bytes in row-major order, matching the encoder.
5. **Reed-Solomon decode.** Treat the full 648-byte block as a single RS codeword `[message || parity]`; correct up to `t` errors (with `t` determined by the parity length chosen in §6.2). The corrected message bytes (the `[message]` portion) are the buffer used by the following steps; in particular, read `N` (node count) from byte 1 of the corrected message — **not** from the raw pre-correction buffer.
6. **CRC32 verify.** The CRC scope is bytes `0..2+10N-1` of the corrected message (version + node count + packed node records at 10 bytes each, per §6.3). If CRC fails, abort with "marker corrupted."
7. **Deserialize node records.** Parse bytes `2..2+10N-1` into an array of `{parent, shapeKind, bbox}` tuples; reconstruct the tree by walking parent indices from the implicit node ids (array index). Each node's stored shape kind drives both the authoring-UI rendering on re-open and the outline geometry on subsequent re-insert.

§6.2 is the source of truth for the byte layout; if the decode order above conflicts with the byte layout, the byte layout wins and this section must be updated.

### 6.6 Robustness notes

- The marker is sensitive to partial lasso selections. Users must lasso the whole map. The "marker not found" error in §F-ED-4 is the UX recourse.
- Stroke jitter on e-ink should be well under the 4 px cell size; bit misreads are expected to be fully recoverable by Reed-Solomon. On-device calibration (§10) confirms the appropriate cell size and parity ratio before v0.1 ships.
- Node bboxes in the records are in **mindmap-local** coordinates (origin = marker top-left). They are re-projected to page coordinates on decode using the marker's lassoed position.
- There is no compression in the current format (binary records are already near-optimal at this tree size); no deflate or inflate implementation is required, which also eliminates the dependency risk called out in earlier §7.4 drafts.

---

## 7. Architecture

### 7.1 File layout (mirrors `sn-shapes`)

```
sn-mindmap/
├── PluginConfig.json                 # pluginKey: SnMindmap, iconPath: assets/icon.png
├── package.json                      # React 19, react-native 0.79.2, sn-plugin-lib ^0.1.19
├── index.js                          # registers toolbar button id=100 + lasso button id=200
├── App.tsx                           # routes between 'canvas' and 'edit' views via pluginRouter
├── assets/
│   ├── icon.png                      # 48x48 mindmap toolbar icon
│   └── edit_icon.png                 # 48x48 edit-mindmap lasso-toolbar icon
├── src/
│   ├── pluginRouter.ts               # copy of sn-shapes/src/pluginRouter.ts (constant names updated)
│   ├── MindmapCanvas.tsx             # authoring UI (handwriting pad, pan/zoom, add/collapse)
│   ├── EditMindmap.tsx               # entry point when launched from lasso toolbar
│   ├── layout/
│   │   ├── radial.ts                 # pure radial layout math
│   │   └── constants.ts              # R1, node dimensions, margin
│   ├── model/
│   │   ├── tree.ts                   # mindmap tree types + mutators (addChild, addSibling, delete, collapse)
│   │   └── strokes.ts                # per-node stroke storage, coordinate transforms
│   ├── rendering/
│   │   ├── emitGeometries.ts         # tree + strokes -> Geometry[] for insertGeometry
│   │   └── nodeFrame.ts              # rounded-rect geometry for node outlines (reuses shapes.ts helpers)
│   ├── marker/
│   │   ├── encode.ts                 # tree -> bit matrix -> Geometry[]
│   │   ├── decode.ts                 # Geometry[] -> bit matrix -> tree
│   │   └── rs.ts                     # tiny Reed-Solomon implementation (no new deps)
│   └── insert.ts                     # high-level insert flow (resolvePageSize, emit, lasso, close)
├── __tests__/
│   ├── radial.test.ts
│   ├── tree.test.ts
│   ├── marker.encode.test.ts
│   ├── marker.decode.test.ts         # round-trip: tree -> encode -> decode -> tree
│   ├── emitGeometries.test.ts
│   ├── MindmapCanvas.test.tsx
│   └── EditMindmap.test.tsx
└── docs/
    └── images/                       # screenshots from the device
```

### 7.2 Plugin router

Same pattern as `sn-shapes/src/pluginRouter.ts`, with constants:

```ts
export const BUTTON_ID_TOOLBAR = 100;         // Mindmap (launches authoring canvas)
export const BUTTON_ID_EDIT_MINDMAP = 200;    // Edit Mindmap (contextual lasso-toolbar button)
```

`App.tsx` routes on the last observed button event, exactly as today.

### 7.3 Button registration

In `index.js`:

```js
PluginManager.registerButton(1, ['NOTE'], {
  id: 100,
  name: 'Mindmap',
  icon: Image.resolveAssetSource(require('./assets/icon.png')).uri,
  showType: 1,
});

PluginManager.registerButton(2, ['NOTE'], {
  id: 200,
  name: 'Edit Mindmap',
  icon: Image.resolveAssetSource(require('./assets/edit_icon.png')).uri,
  enable: true,
  editDataTypes: [5],  // geometry
});
```

### 7.4 Dependencies

- No new runtime deps beyond `sn-plugin-lib`.
- Reed-Solomon is a ~150-line in-house implementation (GF(256), systematic encoding, Berlekamp-Massey decoder).
- **No compression.** The marker uses fixed 10-byte binary node records (§6.3) which are near-optimal at this tree size; there is no deflate or inflate requirement and therefore no dependency on `tiny-deflate`, `tiny-inflate`, `pako`, or any equivalent. This eliminates the bundle-size and library-verification concerns from earlier drafts.
- CRC32 is a ~30-line in-house implementation (standard IEEE 802.3 polynomial).
- Dev deps unchanged from `sn-shapes`.

---

## 8. Risks and known limitations

### 8.1 Label-to-node association on Edit

Because labels are written on the page with the firmware's native pen (not captured by the plugin), label fidelity is never degraded — every stroke the user writes is a first-class firmware stroke and is preserved verbatim through the Insert → page-labeling → Edit round trip. The only risk is *association*: on Edit, the plugin must decide which lassoed strokes belong to which node. If a stroke extends slightly outside a node's outline, the plugin could assign it to a sibling.

Mitigations and rules:

- Node outlines are drawn with a 12 px internal padding so there is visible writing room well inside the outline's bbox — the user can stay within the outline naturally.
- Stroke-to-node assignment on decode uses **stroke centroid** first; if the centroid falls inside a node's bbox, the stroke is that node's label. Ties (stroke spans two bboxes) are resolved by which bbox contains more of the stroke's point mass.
- Strokes whose centroids fall outside every node's bbox are treated as "out of map" annotations; they are not preserved into any node on Save, and the re-inserted block will not carry them. A pre-Save confirmation dialog lists any such strokes so the user can re-lasso if they intended those to be node labels.
- On preserve-and-translate (§F-ED-7), each stroke moves as a rigid unit — its point-to-point shape is unchanged, only its origin shifts by the node's move delta. Strokes are not scaled or rotated.

This is a deliberately simpler risk profile than the v0.9 spec's in-plugin-capture design: there is no clipping at emit time, no "preserved verbatim within pad bounds" caveat, and no plugin-owned stroke storage. The only time the plugin touches label strokes is on Edit (read them), during the editor session (display as read-only reference), and on Save (translate + re-emit).

### 8.2 Mid-insert failure

Partial insertion may leave half a mindmap on the page. The v0.1 behavior is best-effort cleanup + error banner (§F-IN-5). Acceptable because `insertGeometry` calls rarely fail on a working device, and the user has access to the firmware's own undo action (the "undo" chevron in Supernote's standard note toolbar) to revert the partial geometry. Future: transactional insertion via a single `PluginFileAPI.insertElements` batch so either everything or nothing is committed.

### 8.3 Marker capacity

The 72×72 marker carries 648 bytes of raw channel capacity. With 2 bytes of header, 4 bytes of CRC32, a ≥ 20% RS parity design rule, and fixed 10-byte binary node records (§6.2 / §6.3, including one shape-kind byte per node), the hard v0.1 ceiling is **N = 53 nodes**, and the published v0.1 cap is **N = 50** to leave a 28% parity ratio as buffer against stricter calibration targets. v0.9's 48×48 grid yielded only 23 nodes, which a review flagged as too restrictive for typical first-pass mindmaps; v0.10 quadrupled the usable area (288×288 px footprint vs. 192×192 px) to reach a more generous cap. Earlier ceiling history (N=26 at v0.7, N=23 at v0.8, N=15 claim at v0.5) is retained in the changelog.

Trees larger than the cap are not representable in v0.1. At Insert time the plugin computes the exact byte count; if it exceeds channel capacity, Insert is blocked with the modal described in §F-PE-4 — the user must reduce nodes or split the map. No silent truncation, no partial save. Stepping the ceiling above 53 is a v0.2 item that requires the next grid size (80×80 = 800 bytes channel) and more aggressive layout work to fit the larger marker footprint.

### 8.4 Note rename/copy

Marker-embedded maps are completely portable: the marker travels with the strokes, so renaming, copying, or moving the `.note` across folders does not break the Edit round-trip. There is no sidecar file in v0.1, so there is no file-path-coupling concern. (Once a byte-write primitive exists in `sn-plugin-lib`, re-evaluate — see §10.)

### 8.5 Lasso fragility

Users who lasso only part of a mindmap get a "not found" error. This is because the decoder in §6.5 derives the marker grid origin from the top-left of the lasso bbox, which only equals the marker's true origin when the lasso covers the full map. A partial lasso shifts the inferred origin and no valid bit matrix is produced; the plugin surfaces the "marker not found" message from §F-ED-4. v0.1 does not attempt partial decode. Future v0.2: auto-expand the lasso on Edit tap by calling `lassoElements(unionRectFromMarker)` once the marker is provisionally located.

### 8.6 Collapse state rendering

Collapse is an authoring-time convenience only. At Insert time the plugin auto-expands every subtree so that every node — visible or previously-collapsed — is emitted to the page with its outline, handwriting strokes, and connectors (§F-IN-2). This eliminates the data-loss scenario described in earlier drafts: nothing is hidden at insert, so nothing can be lost on later Edit. The tradeoff is that collapse state itself does not round-trip; when a map is re-edited, it opens fully expanded and the user re-collapses branches as needed for that editing session.

### 8.7 Lasso-toolbar button ordering and surface limit

Same constraint as noted in `sn-shapes/auto_lasso_integration_plan.md` §2.1: our "Edit Mindmap" button is additive to the default lasso toolbar. We cannot hide the firmware defaults (Keyword, Heading, etc.). Users must be taught to ignore the non-mindmap options. Acceptable.

### 8.8 Per-node editing of old maps

Editing a previously-inserted map requires lassoing the *entire* map. Lassoing a single node to edit just that node's label is not supported in v0.1 (the marker decoder is all-or-nothing).

---

## 9. Milestones

### Phase 0 — Scaffold (2 days)

- `git init`, copy `sn-shapes` layout, rename packages and config.
- `buildPlugin.sh` verified producing `SnMindmap.snplg`.
- Toolbar button opens a placeholder "Hello Mindmap" canvas.

### Phase 1 — Authoring MVP (4 days — down from 5)

- Tree model + mutators (`src/model/tree.ts`).
- Radial layout (`src/layout/radial.ts`).
- Add child / add sibling / delete / collapse buttons wired into the canvas.
- Node outlines rendered per shape kind (Oval / Rectangle / Rounded Rectangle).
- Pan + zoom gestures.
- No insert, no edit, no marker — canvas state discarded on close.
- Unit tests for tree and layout.

(Handwriting pad component removed in v0.10: the plugin no longer captures stylus input. Saves an estimated 1 day versus the v0.9 budget.)

### Phase 2 — Insert (3 days — down from 4)

- `rendering/emitGeometries.ts` producing node outlines + connectors + marker cells. No label strokes (labels are post-insert, written with firmware pen).
- Full insert flow via `PluginCommAPI.insertGeometry` → `lassoElements(unionRect)` → `closePluginView()`.
- Error handling + partial-insert cleanup.
- On-device QA on Nomad: topology inserts cleanly, lasso covers the block, user can write labels with the native pen inside each outline.

### Phase 3 — Marker encode + decode (6 days — up from 5)

- `marker/encode.ts` + `marker/rs.ts` + `marker/decode.ts`.
- 72×72 grid at 4 px cells; v2 header byte; 648-byte channel.
- Round-trip test suite with property-style fuzzing up to N=50.
- Integrate into insert flow + Edit entry point.
- Size-cap enforcement: Insert blocked with user-facing modal when encoded payload exceeds marker capacity (v0.1 cap = 50 nodes). (Sidecar fallback deferred — depends on a byte-write primitive that does not exist in `sn-plugin-lib` ^0.1.19.)
- **On-device marker calibration (1 day buffer):** confirm the 4 px cell size is readable on Nomad and Manta, and that the RS parity ratio holds under real stroke jitter.

### Phase 4 — Edit flow (4 days — up from 3)

- Lasso-toolbar button registration.
- Decode → pre-populate canvas → render preserved label strokes as read-only reference inside node outlines → save.
- **Label-stroke preservation across topology edits (new task):** on Save, translate each node's preserved label strokes by the node's move delta and re-emit them. Drop labels of deleted nodes. Leave new nodes label-free.
- Pre-Save dialog listing "out of map" strokes (§8.1) so the user can re-lasso if they intended those to be labels.
- On-device QA: author → insert → label with native pen → close note → re-open → lasso → edit topology → save → labels follow their nodes.

### Phase 5 — Polish (2 days)

- Expand/collapse visual polish.
- Tooltip/help popover (reuse `ShapePalette.tsx` tooltip pattern).
- README, demo video (via GitHub user-attachments CDN per §13.2), screenshots, version bump to 0.1.0.

Total: ~19 engineering days, single developer (down from v0.9's 21-day budget — handwriting pad removal saves 2 days net after adding buffer to Phase 3 calibration and Phase 4 label-preservation).

---

## 10. Open questions (defer; not blocking v0.1)

- **Sidecar persistence for large maps.** Depends on a byte-write primitive in `sn-plugin-lib`. Today `PluginFileAPI` offers no `writeFile`, and `NativeFileUtils` exposes file-system shape-manipulation methods (copy, rename, delete, make-dir, list, exists) but no arbitrary write. Revisit when Supernote adds a write API (or when we can justify a native sidecar module).
- **On-device verification of batch-insert auto-lasso.** F-IN-3 specifies every geometry is inserted with `showLassoAfterInsert: false` and an explicit `lassoElements(unionRect)` call produces the group-selection. Verify on hardware that (a) the union rect really captures all geometries inserted during the plugin session, and (b) batched `PluginFileAPI.insertElements` produces the same selection behavior as sequential `insertGeometry` calls.
- Should the Edit view support navigating to individual nodes from outside (future "find in mindmap")?
- Should we expose a plugin setting for node outline style (rounded vs. sharp, solid vs. dashed)?
- Should connectors optionally use a polyline Bezier approximation instead of straight lines?
- Should we support a "flatten" action that converts the mindmap's strokes into plain handwriting (breaking the marker) — useful when the user is finished editing forever?
- **Manta pixel height (provisional in header).** `sn-shapes/src/ShapePalette.tsx:11` only confirms Manta width (1920); the full resolution is not attested in the codebase. Do not freeze layout constants tuned to a 2560 height until this is verified against official Supernote documentation.
- **Chauvet minimum (provisional in header).** `sn-shapes/index.js` comments reference "Chauvet 3.27.41(2274)" as the tested build for `showLassoAfterInsert` and `editDataTypes` gating, but that is not established as the *earliest* version that supports these APIs. Either verify with Supernote, or relax the manifest target to "Chauvet (version TBD; confirmed working on 3.27.41(2274)+)" until settled.
- **Marker grid and cell size tuning.** The v0.10 72×72 / 4 px design is a starting target; on-device capture tests should confirm (a) the 4 px cell size is reliably readable on Nomad and Manta under real stroke jitter, (b) the 20% RS parity ratio holds or whether the floor should be raised to 25–30% for robustness, and (c) that the 288×288 px footprint does not collide with layout in dense maps at the N=50 cap. Grid may shift to 64×64 (if jitter is lower than expected) or 80×80 (if parity needs to grow) after measurement.

---

## 11. Appendix — key conventions inherited from `sn-shapes`

- Pen-color allow-list: `0x00` (black), `0x9D` (dark gray), `0xC9` (light gray), `0xFE` (white). All node outlines default to `0x00`; marker uses `0x9D`.
- Pen-width minimum: 100. Node outlines default to 400. Marker cells use 100.
- Geometry types are exhaustive: `GEO_polygon`, `GEO_circle`, `GEO_ellipse`, `straightLine`.
- `showLassoAfterInsert` usage: in `sn-shapes`, a single inserted geometry sets this flag to `true` and the firmware auto-lassos that one shape. For `sn-mindmap`, the inserted block is a batch of many geometries and there is no documented behavior for a batch-wide auto-lasso via this flag. Therefore every emitted geometry sets `showLassoAfterInsert: false` and the plugin calls `PluginCommAPI.lassoElements(unionRect)` explicitly after the final insert (see §F-IN-3).
- Plugin UI is dismissed via `PluginManager.closePluginView()`.
- Logcat prefix: all plugin-router logs use `[PLUGIN_ROUTER]`; insert-path logs use `[SN_MINDMAP]` (new convention).

---

## 12. Changelog

### v0.10 — April 18, 2026 (capacity lift + in-plugin capture dropped)

Two material architectural changes based on a second round of owner review of the v0.9 draft.

**1. Node ceiling raised from N=23 to N=50.** The v0.9 48×48 marker grid produced a 23-node cap at ≥ 20% RS parity, which the reviewer flagged as too restrictive for typical first-pass mindmaps. v0.10 scales the grid to 72×72 at the proven 4 px cell size:

- Raw channel grows from 288 bytes to 648 bytes.
- Footprint grows from 192×192 px to 288×288 px (about 15% of Nomad page width; still comfortably in a top-left corner).
- At N=50 the marker carries 506 bytes of message and 142 bytes of RS parity — a 28% parity ratio, comfortably above the 20% design floor.
- The theoretical cap at ≥ 20% parity is N=53; the published v0.1 cap is set to **N=50** so there is buffer against stricter parity targets identified during on-device calibration (§10).
- Stepping the ceiling above 53 requires the next grid size (80×80, 288-byte larger footprint) and is deferred to v0.2.
- §6.1, §6.2, §6.5, §F-PE-3, and §8.3 updated. Version byte in the marker header bumped from 0x01 to 0x02.

**2. In-plugin handwriting capture dropped.** The v0.9 design had a per-node handwriting pad inside the plugin canvas that captured stylus strokes for display during authoring and replay on insert. The v0.9 §13.3 learning flagged this as the project's biggest technical unknown because `sn-shapes` never exercised stylus capture in a plugin view and `sn-plugin-lib` ^0.1.19 has no documented stylus-capture API. v0.10 resolves the unknown by designing around it:

- The plugin never captures stylus input. The authoring canvas owns only tree topology, node shape assignment (§F-AC-3), connector layout, and the marker.
- Labels are written with the firmware's native pen on the note page after the mindmap is inserted (§4.1 step 6). Native-pen fidelity is always full.
- On Edit, the plugin reads existing label strokes from the lasso via `getLassoGeometries()` (a proven API), associates them to nodes by bbox containment (§F-ED-5), and renders them inside node outlines as read-only reference during the editor session.
- On Save, preserved label strokes translate by each node's move delta to follow their nodes when the user reorganizes the tree (§F-ED-7). Strokes are not scaled — if a node resizes on re-layout, the labels stay at original pixel scale and center within the new outline.
- §8.1 reframed: no in-plugin capture means no emit-time clipping, no "preserved within pad bounds" caveat. The only remaining risk is label-to-node *association* on Edit, and §8.1 documents the centroid-based rule plus a pre-Save confirmation for "out of map" strokes.
- §F-AC-4 rewritten, §F-AC-8 insert gating loosened, §F-IN-2 step 3 reframed (no label emission on first insert; preserved-label re-emission on Edit Save), §2.2 non-goals now lists in-plugin handwriting capture explicitly, §3 decision rows 1 and 2 rewritten.

**Schedule impact.** §9 rebalanced: Phase 1 drops 1 day (no handwriting pad component), Phase 2 drops 1 day (no label emission path), Phase 3 adds 1 day (marker calibration buffer), Phase 4 adds 1 day (label-preservation across topology edits). Net total: 19 engineering days, down from v0.9's 21.

**Downstream learning-section update.** §13.3 now records that in-plugin capture was designed around rather than built. The concept of "read via `getLassoGeometries()` is cheap, capture is an unbounded spike" is promoted from a risk to an architectural principle for future Supernote plugins.

### v0.9 — April 18, 2026 (learning section added)

Added §13 "Learning — distilled from the `sn-shapes` v1.0.3 cycle". The new section captures on-device plugin metadata, README/release craft, firmware insertion quirks, e-ink UX choices, data-format pitfalls, the verification gate, and sandbox/workflow notes observed while shipping the sister project. Findings cross-reference the existing spec (§F-IN-1, §F-IN-3, §6.3, §8.3, §9, §10) where they were already codified — §13 supplies the empirical "why". No behavioral change to any v0.1 requirement; several items sharpen the implementation plan for Phase 0 (add the `PluginConfig.json` sync helper from day one) and Phase 4 (reuse the user-attachments CDN for demo video hosting).

### v0.8.2 — April 17, 2026 (§6.6 stale-version wording)

§6.6 still described the current format with a version-qualified phrase ("There is no compression in v0.6"), which reads as a historical caveat rather than a current fact. Reworded to "in the current format", and replaced "v0.4 §7.4" with "earlier §7.4 drafts" so nothing in the robustness-notes section is pinned to a past draft.

### v0.8.1 — April 17, 2026 (stale-reference cleanup)

A review caught three references to the old 9-byte binary record format that did not get propagated when v0.8 bumped the record to 10 bytes (adding the shape-kind byte). One of them (the CRC scope in §6.5 step 6) was a real decoding-spec bug — implementers following that text would compute the CRC over the wrong number of bytes.

1. **§3 decision row 3:** "JSON topology payload" → "compact binary topology payload (fixed-size records, no JSON, no compression — see §6.2 / §6.3)". The doc has been binary since v0.6; this row was never updated.
2. **§6.5 step 6 CRC scope (real bug):** "bytes `0..2+9N-1`" → "bytes `0..2+10N-1`", matching the 10-byte record size from §6.3. Implementers reading the decode-order section would otherwise verify the CRC over the wrong range and fail every Edit.
3. **§6.3 "Why binary, not JSON" side note:** "fixed 9-byte binary record" → "fixed 10-byte binary record". Density comment preserved but phrased without a specific multiple (the ~4× figure was a v0.6 comparison).
4. **§7.4 dependency list:** "v0.6 uses fixed 9-byte binary node records" → "The marker uses fixed 10-byte binary node records".

Historical references to the 9-byte record in the §8.3 evolution paragraph and in the v0.6 changelog entry are intentionally left as-is because they document what prior drafts did.

### v0.8 — April 17, 2026 (user-journey revisions)

Incorporated the owner's step-by-step user journey. Four confirmed design points:

1. **Shape rule (§F-AC-3, §4.1 step 5, §F-IN-2):** Root = Oval with darker border. `Add Child` produces a sharp-cornered rectangle. `Add Sibling` produces a rounded rectangle. Shape is determined by the creation action, not by tree depth — two nodes at the same depth can have different shapes. The root-Oval action strip **hides** (not merely disables) Add Sibling.
2. **Stroke-intensity scope (§F-AC-5):** The stroke-weight difference applies only to the two action icons — Add Child thicker, Add Sibling thinner. Node outlines and connectors keep standard weight. Root's border is the only exception, deliberately darker.
3. **Collapse toggle trigger (§F-AC-5, §4.2):** Any node with ≥ 1 child, regardless of whether those children were added via Add Child or Add Sibling. Earlier drafts ambiguously said "sibling/parent"; confirmed as a typo for "sibling/child."
4. **"Central Topic" placeholder (§F-AC-4, §4.1 step 2, §F-IN-2):** The root Oval shows placeholder copy "Central Topic" until first pen-down; it is a plugin-side affordance only and is never emitted to the note page. Insert is blocked (§F-AC-8) if the root has no committed strokes.

Binary-format impact:

- §6.3 node record grew from 9 to 10 bytes to carry a **shape-kind** enum byte. The Edit round-trip can now reconstruct each node's original shape without post-hoc geometric analysis of its outline strokes.
- §6.2 capacity table recomputed for 10-byte records: ceiling drops from v0.7's **N = 26** to **N = 23** nodes at the ≥ 20% parity design rule. §8.3 updated to match.
- §4 expanded into six sub-stories (4.1 Author → 4.6 Abandon) reflecting the user's step-by-step flow.

### v0.7 — April 17, 2026 (capacity-table arithmetic fix)

A reviewer caught an off-by-one in the v0.6 §6.2 capacity table: at N=25 the total was listed as 289 bytes (231 + 58) instead of 288, and the parity column was computed inconsistently (25% in some rows, 20% claimed in the prose).

**Fix:** Reframed the table to use channel-filling math — for each N, show the fixed message length, the parity bytes that remain if all 288 channel bytes are used, and the resulting parity ratio. The design rule (parity ≥ 20% of message) is stated explicitly and used to render each row's verdict. The corrected ceiling is **N = 26 nodes** at the 20% parity target; stricter parity lowers it. §8.3 summary sentence updated to match ("N = 26 nodes" instead of "~20–25 nodes").

No behavioral or architectural change; this is arithmetic hygiene only.

### v0.6 — April 17, 2026 (substantive revision — four findings addressed)

Material changes in response to a technical review that caught real design defects, not just wording issues:

1. **(HIGH) Marker capacity math was wrong.** v0.5 claimed ~15 nodes fit in a 20×20 / 6 px-cell grid (50 bytes channel, ~30 bytes payload) using deflate-compressed JSON. An empirical check produced 1 node = 89 deflated bytes, 15 nodes = 199 — i.e., the encoding could not hold even a single node. **Fix:** all of §6 was rewritten. The grid is now 48×48 at 4 px per cell (192×192 px footprint, 288 bytes channel). JSON-plus-deflate is replaced by a fixed 9-byte binary node record (§6.3). Honest v0.1 capacity is now **~20–25 nodes** depending on RS parity ratio. §8.3 capacity text and §F-PE-3 / F-PE-4 updated to match. Compression dependencies (`tiny-deflate`, `tiny-inflate`) are removed from §7.4 since no compression is used.
2. **(HIGH) Collapsed branches contradicted the editability guarantee.** Earlier drafts said collapsed subtrees were omitted at insert and their labels lost on edit — which violated the headline promise in §1 and §2.1. **Fix:** collapse is now an authoring-time convenience only. §F-IN-2 starts by auto-expanding every subtree so that every node is emitted to the page. §4 story 2, §8.6, and §1 summary now all agree; the data-loss scenario is eliminated. The only thing that does not round-trip is the user's collapse state itself — the map re-opens fully expanded, which is documented as an intentional tradeoff.
3. **(MEDIUM) "Verbatim" handwriting language was overstated relative to §8.1 clipping.** **Fix:** §2.1 goal text, §3 decision row 1, and §8.1 mitigations all now say handwriting is preserved *within the editable node bounds*. §8.1 explicitly notes that strokes extending past the pad are clipped at emit and are not recoverable on Edit.
4. **(MEDIUM) Unverified platform facts were stated as fixed requirements.** The header claimed Chauvet 3.27.41+ and Manta 1920×2560 as targets, but §10 admitted both were pending verification. **Fix:** the header block now carries an explicit "(provisional — see §10)" and spells out what is and isn't attested against the `sn-shapes` codebase. §10 verification items are sharpened so the follow-up tasks are unambiguous.

Collateral edits: §6.6 now notes the absence of compression (with the dependency-risk implication); the §10 list gains an explicit marker-calibration item for cell size / parity ratio / footprint collision tuning on device.

### v0.5 — April 17, 2026 (micro-nit pass)

Two editorial alignments; no spec changes:

1. **§6.5 step 5 clarification.** Made explicit that `N` (payload-length byte) is read from byte 1 of the *corrected* RS message, not the raw pre-correction buffer, to prevent implementer confusion about buffer ordering.
2. **§8.3 adjective alignment.** Changed "~30 bytes of post-EC payload" to "~30 bytes of post-EC deflated payload" so §8.3 and §6.2 use the same noun phrase and cannot be misread as referring to uncompressed JSON bytes.

### v0.4 — April 17, 2026 (polish pass)

Small clarity edits from an editorial review; no material spec changes:

1. **§6.5 decode pipeline.** Expanded into an explicit numbered step list with the CRC scope stated (CRC is computed over bytes 0..N+1 of the §6.2 layout — header + length + deflated payload — *not* over the RS codeword or the inflated JSON). Added a "byte layout wins on conflict" note pointing back to §6.2 as the source of truth.
2. **§6.5 marker origin + §8.5 cross-reference.** §6.5 step 2 now explicitly notes that deriving the marker origin from the lasso bbox requires a full-map lasso; §8.5 now explains *why* a partial lasso breaks decoding (origin-inference shift), tying the two sections together.
3. **§7.4 `tiny-deflate`.** Marked as a placeholder pending name/license/size verification rather than a firm recommendation. Same caveat added to the `tiny-inflate` candidate for the decode path.
4. **§F-PE-3 wording.** "Subtract" replaced with "after reserving bytes for the header, CRC32, and Reed-Solomon parity, ~30 bytes remain for the deflated payload."

### v0.3 — April 17, 2026 (second technical review)

Small-surface fixes on compression terminology and wording hygiene:

1. **§6.5 verb.** The decode step now correctly says *inflates (decompresses)* rather than "deflates" — deflate is the compression direction.
2. **§7.4 dependency split.** Encode and decode are separate operations: deflate for encode, inflate for decode. Candidate libraries and sizing notes updated to reflect this; plain "use DEFLATE via `tiny-inflate`" replaced.
3. **§F-PE-3 wording.** Reed-Solomon adds parity symbols for error correction; it does not "reduce" data. The sentence now describes the 50-byte channel capacity and points to §6.2 for the authoritative byte layout.
4. **§3 row 3 / §10 NativeFileUtils hygiene.** Clarified that the listed `NativeFileUtils` methods are a sample (among others) and cited the typings file; the argument ("no arbitrary write primitive") is unchanged.
5. **§10 verification item.** Added the on-device check for `lassoElements(unionRect)` across many inserted geometries and equivalence with `insertElements` batching.

### v0.2 — April 17, 2026 (post-technical-review)

Applied fixes from a review that cross-checked the doc against `sn-plugin-lib` ^0.1.19 vendored in `sn-shapes/node_modules/`:

1. **Removed `PluginFileAPI.writeFile` reference (§5.5 / §F-PE-4).** Verified against `lib/typescript/src/sdk/PluginFileAPI.d.ts` and `module/NativeFileUtils.d.ts` — no byte-write primitive exists. The sidecar fallback is deferred to a future version and listed in §10 as dependent on a supported write API.
2. **Reconciled §3 decision row 3 with §5.5.** The marker is now the sole persistence path in v0.1; oversized trees are rejected at Insert with a clear modal rather than silently falling back.
3. **Clarified `showLassoAfterInsert` behavior for multi-geometry blocks (§F-IN-3 and §11).** All emitted geometries set the flag to `false`; an explicit `lassoElements(unionRect)` call produces the group-selection.
4. **Fixed §6.2 capacity wording.** Distinguishes the ~30-byte deflated post-EC payload from the 120–200 byte uncompressed JSON it corresponds to at a 3–5× deflate ratio.
5. **Revised §8.4 orphan-sidecar mitigation.** Since there is no sidecar in v0.1, the orphan-data-loss scenario does not apply. Section now just documents marker-embedded maps as fully portable.
6. **Tightened §F-AC-8** wording around the always-present root node.
7. **§F-IN-1** now spells out the full `resolvePageSize` helper pattern (three-step resolve with fall-through defaults) rather than a shorthand `getPageSize()`.
8. **§8.2** replaced "Ctrl-Z" with a device-accurate description of Supernote's undo chevron.
9. **§6.1** clarified that the marker is anchored in the mindmap's bounding rect (sibling of nodes), not inside any node outline.
10. **§10** adds two unresolved product-fact checks (Manta pixel height, Chauvet 3.27.41 minimum) as open verification items.

### v0.1 — April 17, 2026

Initial draft, informed by user decisions on text capture, input method, persistence model, and layout style.

---

## 13. Learning — distilled from the `sn-shapes` v1.0.3 cycle

This section captures the empirical findings from the sister project that shaped, corrected, or validated parts of this spec. Cross-references point to where each finding is codified elsewhere in this document; §13 supplies the concrete "why" so implementers can trust the existing prose.

### 13.1 On-device plugin metadata

- `PluginInstallManager` reads `PluginConfig.json` for `versionName` and `versionCode`. Not `package.json`, not `android/build.gradle`. Without an explicit sync step, the on-device plugin pins to its bootstrap version (e.g., `0.1.0`) forever, regardless of release tags or built artifact versions.
- `buildPlugin.sh` should regenerate `PluginConfig.json` on every build, deriving `versionName` from `package.json` and `versionCode` from a monotonic semver formula (`MAJOR × 10000 + MINOR × 100 + PATCH`). CI should commit the synced file back to master so the in-repo copy tracks each release.
- **Implication for Phase 0 (§9):** include the sync helper from day one. Retrofitting it across three prior `sn-shapes` releases took an unplanned debug session to diagnose the version mismatch.

### 13.2 README and release craft

- GitHub's README renderer strips or CSP-blocks `<video>` tags whose `src` points to `raw.githubusercontent.com` or `github.com/<owner>/<repo>/raw/...` for a committed MP4. The Demo section renders as a blank space with no error.
- The only reliable inline-playback source is GitHub's user-attachments CDN: `https://github.com/user-attachments/assets/<uuid>`. These URLs are minted when a video is drag-dropped into any issue, PR, or release comment on the repo.
- Host the demo video by drag-drop (releases, issues, or a draft comment — the page doesn't need to be published). Copy the `<video src="https://github.com/user-attachments/assets/...">` tag GitHub generates and paste into the README.
- Do not commit the MP4 to the repo. The file grows history, doesn't render inline anyway, and the user-attachments URL is stable long-term.
- Legacy JWT-signed `private-user-images.githubusercontent.com/...?jwt=...` URLs expire. Treat them as one-time tokens and re-host via user-attachments before publishing permanent docs.
- Release-note feature bullets should describe user-visible behavior ("one popup, one tap to insert", "live preview", "auto-select after insert") rather than developer-facing refactors ("merged `id=100`/`id=200`", "deferred-apply overlay", "hybrid-grid layout"). Avoid emdashes; use colons or plain sentences.
- Refresh Tests / Coverage / Version badges in the same commit as the release bump. Stale badges undermine trust in the README faster than any other single omission.

### 13.3 Firmware APIs and insertion flow

- `showLassoAfterInsert: true` auto-lassos only the single geometry that carries the flag. For multi-geometry blocks (the `sn-mindmap` insert path), every emitted geometry must set the flag to `false` and the plugin must call `PluginCommAPI.lassoElements(unionRect)` explicitly after the final insert — see §F-IN-3 and §11. This was verified on-device during the `sn-shapes` auto-lasso work.
- `MIN_PEN_WIDTH` is firmware-enforced. UI pickers that expose sub-minimum values get silently clamped, breaking the visual/behavioral promise (the user sees "XS" but the firmware writes a heavier stroke). Enforce the floor in the picker, not downstream.
- Pen *type* (ballpoint, marker, brush, etc.) is owned by the firmware's main drawing surface. Plugins should not duplicate a pen-type picker — the user's current selection applies automatically to every inserted geometry. In `sn-mindmap` this extends further: the plugin owns no label-stroke metadata at all, because labels are written with the firmware's native pen on the page (v0.10). The plugin still controls pen *width* and *color* for its own outline + connector + marker geometries.
- The `resolvePageSize()` three-step fall-through pattern cited in §F-IN-1 is load-bearing. Single-step alternatives (e.g., "just call `getPageSize` with a hardcoded path") fail on renamed-or-copied notes.
- Lasso resize tolerance must include pen-width padding. A thick stroke's actual visual bounds extend past its nominal geometry bbox by roughly half the pen width; a tight lasso resize drops edge pixels. For `sn-mindmap` this affects the marker payload's per-node `bbox w / h` (§6.3): stored values should be the outline bbox expanded by node pen-width / 2, otherwise decode-time bbox containment (§F-ED-5) misses stroke extremities and mis-assigns label strokes to siblings.
- **In-plugin stylus capture was identified as the biggest technical unknown** in the v0.9 review of this spec — `sn-shapes` never exercised it, and `sn-plugin-lib` ^0.1.19 has no documented API for collecting stylus points inside a plugin's React Native view. v0.10 resolved this by designing around it: labels are written post-insert on the firmware's native pen surface, and the plugin only *reads* strokes on Edit via `getLassoGeometries()` (a proven API). Reading is cheap; capturing would have required a PanResponder spike of unknown shape.

### 13.4 UX on e-ink

- Font-size floor is ≈ 9–10 px. Below that, labels are unreadable on the device's native DPI. Apply the floor to node labels, action-icon captions, marker-error banners, and any transient affordances.
- `tintColor` on a PNG thumbnail recolors but cannot thicken. A stroke-thickness preview needs a parallel geometric element (a scalable sample bar) alongside the icon so thickness changes are visible. Relevant to any node-preview affordance in the authoring canvas.
- Deferred-apply (tap outside = commit, ✕ in header = cancel, no dedicated Insert button) reduced tap count and simplified test assertions in `sn-shapes` v1.0.3. The `sn-mindmap` Insert button in §F-AC-8 is justified because authoring is substantial and needs an explicit commit moment — but transient overlays (per-node label edit, error banners, delete confirmation) should still follow the tap-outside idiom.
- Auto-lasso after insert (already captured at §F-IN-3) lets the user reposition/resize without an extra tap. Validated on-device for single-geometry inserts in `sn-shapes`; `sn-mindmap` extends it to multi-geometry via the explicit `lassoElements(unionRect)` call.
- Popup footprint matters. `sn-shapes` v1.0.3 shrank the shape picker to ≈ 60% of its prior footprint — preserving readable typography via the 9–10 px floor — to leave more drawing surface visible around it. `sn-mindmap` is full-screen, so this applies only to transient overlays (node action icons, banners).

### 13.5 Data-format findings

- Deflate/zlib *inflates* payloads under ~50 bytes. One node of JSON-over-deflate measured ~89 bytes in the v0.5 review (see §8.3 history). Fixed-width binary records (§6.3) are several times denser at this scale and carry no library dependency. The same principle applies to any future cross-plugin or cross-note micro-payload.
- Reed-Solomon parity ≥ 20% is a sensible *starting* design rule (§6.2) but the final ratio should be empirically tuned against on-device stroke jitter. §10 tracks this as an open verification item; do not freeze the ratio without a measurement.
- Test harnesses around binary round-trip (encode → decode → compare) should use property-style generation over random trees up to the N = 50 v0.1 cap (and up to the N = 53 theoretical ceiling for rejection-path tests). Hand-picked fixtures miss the packing edge cases where parent-index and bbox-coordinate bytes straddle boundaries.

### 13.6 Verification gate

- Tests + `tsc` + `eslint` green is the release gate. `sn-shapes` v1.0.3 ships 198 passing Jest cases covering the popup, preview, deferred-apply flow, lasso tolerance, and geometry builders. For `sn-mindmap`, aim for comparable coverage across: tree mutations (`addChild`, `addSibling`, delete, collapse/expand), radial layout determinism, marker encode/decode round-trip, `unionRect` math for the post-insert lasso call, and the Edit entry-point's "marker not found" flow.
- Run the full gate locally before CI. CI should be confirmation, not discovery.

### 13.7 Sandbox and workflow notes

- Git identity and SSH keys are typically unset in fresh agent or CI sandboxes. Prefer per-command identity overrides (`git -c user.name=... -c user.email=... commit ...`) over mutating global config. Pushes to `git@github.com:...` remotes usually need the developer's own terminal or a pre-configured CI deploy key.
- Agent sandboxes mount only the folder the developer explicitly selected. Cross-repo work — including cross-referencing this sister-project spec during `sn-shapes` development — requires a separate mount request. Plan mounts upfront to avoid mid-session context switches.

---

**End of document.**
