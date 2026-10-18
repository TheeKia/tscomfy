# The UI format

The frontend saves workflows in its own format: nodes with positions, sizes and widget values by
position, a links array, groups, subgraph definitions. tscomfy reads that format into the
workflow the frontend would queue, and writes workflows built in code as files the frontend opens.

## Writing a file the frontend opens

```ts
import { stringify, toUi } from "@tscomfy/core";
import { layout } from "@tscomfy/layout";

const { workflow: file, diagnostics } = toUi(built, { positions: layout(built) });
await Bun.write("txt2img.json", stringify(file));
```

Drag the file onto the frontend, or put it in the server's `user/default/workflows/` directory.
Queueing it there sends the same prompt `toApi(built)` builds, apart from what the format can't
carry, each reported:

| Code | What |
|---|---|
| `W_UI_VALUE_LOST` | A value with no widget to hold it, or one the frontend wouldn't send: DynamicGroup rows (the frontend has no widgets for them), widgets the frontend doesn't save or send |
| `W_UNKNOWN_UI_CLASS` | A node of a class the schema lacks: written with its links and values by name; the frontend shows it as missing |
| `W_UNSAFE_INTEGER` | An integer beyond 2^53, which the frontend's JSON parser rounds |
| `W_QUEUE_TIME_VALUE` | A value the frontend computes when it queues: a file name it rewrites (`%date:…%`, `%Node.widget%`), a 3D scene, webcam frame or recording its extensions capture |
| `W_EXTENSION_WIDGETS` | A node whose widgets frontend JavaScript builds from nothing its definition describes (CustomCombo's options): those values can't be written |

Optional widgets you left out get the frontend's initial values in the file, as for a node added
by hand, so the frontend may send a value for an input `toApi` leaves out. Seeds and other
controlled values are saved with their control set to `fixed`, so the frontend doesn't change
them after queueing.

The file is flat: functions that compose a workflow are not turned into subgraphs. Its `id` is
derived from its content, so the same workflow always gives the same bytes. Node ids that are
integers stay; others (`"ckpt"`, `"40:31"`) get the next free numbers, and the result's `ids`
maps each to its number.

### Layout

`positions` is optional; without it nodes are stacked in one column. `@tscomfy/layout` places
nodes left to right in columns by their longest path from a source, ordered within a column by
their sources, sized as `toUi` sizes them (`uiNodeSizes`). `layout(built, { column, row })`
changes the gaps between columns and rows. `layered` lays out any boxes, for a layout of your own.

## Reading a saved file

```ts
import { importUi, toApi } from "@tscomfy/core";

const { workflow: imported, diagnostics } = importUi(text, local);
const prompt = toApi(imported); // what the frontend would queue for this file
```

The rules are the frontend's own, read in its source (version 1.55.17, the one ComfyUI 0.41
installs) and checked by loading files into the frontend itself:

- **Links** come from the `links` array, placed on the slots of each node as the frontend creates
  it, including the inputs a dynamic combo's chosen option adds.
- **Widget values** are read by position, as the frontend reads them; by name only when the
  positions don't fit (a pack's own widgets) and the file saves names.
- **Reroutes** are followed; **PrimitiveNodes** write their value into every widget they feed;
  **Notes** are dropped.
- **Subgraphs** are expanded; inner nodes get ids like `"40:31"`, as in the frontend's prompts.
- **Bypassed and muted** nodes keep their mode, and links through them resolve as the exporter
  resolves them ([graph operations](graph-operations.md)).
- **`%Node.widget%`** in save nodes' `filename_prefix` is replaced, as the frontend replaces it.

Where the frontend does something odd, `importUi` does it too and reports `W_FRONTEND_QUIRK`, so
the prompt is still the one the frontend would send. What it can't reproduce is reported:
`%date:…%` (the queue time) stays as written, a node of a class your server lacks stays raw, and
legacy group nodes (`extra.groupNodes`, from frontends before subgraphs) are refused with
`E_LEGACY_GROUP_NODE`. JavaScript of node packs that changes the prompt at queue time is not
reproduced, since no schema describes it.

`docs/research/ui-format.md` has every rule with its source and the experiment that checked it.
