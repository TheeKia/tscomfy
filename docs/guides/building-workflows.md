# Building workflows

Everything here is checked against the types generated from your server (see
[getting started](getting-started.md)), so the node names and options below are those of a
stock ComfyUI install; yours may differ.

## The builder

```ts
import { type Workflow, workflow } from "@tscomfy/core";
import { local } from "./comfy/local/index.js";
import type { Nodes } from "./comfy/local/nodes.js";

export function txt2img(prompt: string, seed: bigint): Workflow<Nodes> {
  return workflow(local, ({ n }) => {
    const [model, clip, vae] = n.CheckpointLoaderSimple({ ckpt_name: "sd_xl_base_1.0.safetensors" });
    // …
  });
}
```

`workflow(schema, build)` runs `build` once, synchronously, and returns a frozen `Workflow`: the
schema and a graph of nodes. There is no global state, so builds can nest or run side by side, and
one project can target several servers through several generated schemas. `Workflow<Nodes>` (or
`Workflow<NodesOf<typeof local>>`, without importing `nodes.ts`) names the type.

`build` receives:
- `n`: one function per node class, keyed by its exact `class_type`. Classes whose names aren't
  identifiers use brackets: `n["Image Resize (rgthree)"]({ … })`.
- `raw`: untyped nodes, [below](#raw-nodes).

### Outputs

A node function returns what the node outputs:

| Outputs | Returns | Use |
|---|---|---|
| none | `{ id }` | `const save = n.SaveImage({ … })` |
| one | that output, `Out<"LATENT">` | `latent_image: n.EmptyLatentImage({ … })` |
| several | a tuple, also with members by output name | `const [model, clip, vae] = n.CheckpointLoaderSimple({ … })`, or `ckpt.CLIP` |

An output name is left off the result when two outputs share it, or when it would clash with
`id`, `length` or another array member; the tuple always has every output. `Out<T>` carries the
socket type, and an input of type `T` takes `Out<T>` or an any-typed `Out<"*">`. Outputs are
values: pass them around, store them, feed one into many inputs.

### Inputs

| Input | Takes |
|---|---|
| a socket (`MODEL`, `IMAGE`, …) | an output of that type |
| INT | `number`, `bigint` (seeds up to 2^64 − 1 stay exact), or a link |
| FLOAT, STRING, BOOLEAN | the value, or a link |
| combo | one of the server's options, or a link; a multi-select combo takes a list |
| upload combo (`LoadImage`'s `image`) | any string: the options are files on the server, which change at runtime, but they still autocomplete |
| widget with an object value (COLOR, CURVE, BOUNDING_BOX, …) | JSON |

Every widget input also takes a link, as in the frontend's "convert to input". An input with a
default in the schema is optional, and the exporter fills the default in, as the frontend sends
every widget's value. An input without one is required, even where the frontend would pick
something (`0`, `""`, the first checkpoint): tscomfy never chooses a value for you.

### Node options

The second argument of every node function:

```ts
n.SaveImage({ images }, { title: "Final", id: "save" });
```

- `title`: sent as `_meta.title` (otherwise the display name) and shown in the UI.
- `id`: a node id of your choosing, instead of the next free one of `"1"`, `"2"`, … Ids are
  strings.
- `mode`: `"bypass"` or `"mute"`, see [graph operations](graph-operations.md).

## Dynamic inputs

ComfyUI's V3 nodes have inputs whose shape depends on other inputs. Each has a structured value
here; the exporter turns it into the dotted wire keys the backend expects.

**Dynamic combos** (`COMFY_DYNAMICCOMBO_V3`) choose an option that adds inputs. Give
`{ option, inputs }`, nested as deep as the options go, or just the key for an option whose
inputs all have defaults:

```ts
n.SaveVideo({ video, format: { option: "mp4", inputs: { codec: "auto" } } });
n.SaveAudioAdvanced({ audio, format: "flac" });
```

Option inputs never mix with the node's own, which matters: `SaveVideo` has both a `codec` and a
`format.codec`.

**Autogrow** inputs (`COMFY_AUTOGROW_V3`) are a growing list of sockets: a list, or for the
named form a record of the slot names. The types require the minimum number of slots and allow
no more than the node has:

```ts
n.BatchImagesNode({ images: [first, second, third] });
```

**Dynamic groups** (`COMFY_DYNAMICGROUP_V3`) are rows of widgets, a list of row objects, bounded
by the group's minimum and maximum.

**MatchType** inputs (`COMFY_MATCHTYPE_V3`) share one type across a node: the first input of a
template fixes it, the others must agree, and the outputs carry it on.

```ts
const image = n.ComfySwitchNode({ switch: useRefiner, on_true: refined, on_false: base });
// image is Out<"IMAGE"> when refined and base are images; mixing IMAGE and LATENT is an error.
```

## Lists and JSON values

Values are JSON (`string`, `number`, `bigint`, `boolean`, `null`, arrays and objects), plus
output references: as a whole input, a DynamicGroup row's field, or an element of an Autogrow's
slot list (the only lists that hold links). A list-valued widget is sent
wrapped as `{"__value__": [...]}`, since the backend reads a bare list as a link; you write the
plain list. An output reference nested inside a JSON value throws: no input can carry one.

## Reusable pieces

Templates are plain functions. Pass `n` and outputs in, return outputs:

```ts
import type { Out } from "@tscomfy/core";
import type { Nodes } from "./comfy/local/nodes.js";

function withLoras(
  n: Nodes,
  model: Out<"MODEL">,
  clip: Out<"CLIP">,
  loras: readonly { readonly name: LoraName; readonly strength: number }[],
): readonly [Out<"MODEL">, Out<"CLIP">] {
  return loras.reduce<readonly [Out<"MODEL">, Out<"CLIP">]>(
    ([model, clip], lora) =>
      n.LoraLoader({ model, clip, lora_name: lora.name, strength_model: lora.strength, strength_clip: lora.strength }),
    [model, clip],
  );
}
```

`LoraName` stands for the combo's generated alias: `nodes.ts` names it after the input and shares
one alias between identical option lists. `Extract<Parameters<Nodes["LoraLoader"]>[0]["lora_name"],
string>` reaches it without knowing the name. A whole workflow is just such a function that calls
`workflow`, as in [`examples/txt2img`](../../examples/txt2img/src/txt2img.ts). Re-running a
builder is cheap, so parameters are plain TypeScript arguments, not a template language.

## Raw nodes

For a node the schema doesn't have (a pack installed on another server), or a shape the types
can't express, `raw` adds a node without types:

```ts
workflow(local, ({ n, raw }) => {
  const resized = raw("Image Resize+", { image: decoded, width: 512, height: 512, method: "lanczos" });
  n.SaveImage({ images: resized.output(0) });
});
```

Its inputs are wire keys, sent as given: no defaults, no flattening (one exception: a widget whose
link a bypass or mute resolves to nothing sends its default, as on any node). Only an output reference
(`.output(slot)`, or a node's result) makes a link, as everywhere; a list is a value, sent
wrapped as `{"__value__": [...]}` (so `["1", 0]` is not a link). `output(slot)` is an `Out<"*">`,
which fits any input. Validation still checks raw nodes against the schema, so an
unknown class is an error at export; use `exportApi` (see
[exporting and validating](export-and-validate.md)) when you mean to send one anyway.

## Mistakes the types can't catch

`workflow` throws a `TypeError` for misuse: a duplicate or empty id, a node added after `build`
returned (or from an `async` build), an output reference from another workflow, a value that
isn't JSON, a sparse array. Problems with the values themselves, such as a number out of range,
are diagnostics, reported when you export.

## What the exporter does not do

Two frontend behaviors are deliberately left out, so a prompt is exactly what you wrote:
- The frontend expands `{a|b}` dynamic prompts and strips comments in some text inputs before
  sending them. tscomfy sends the text verbatim.
- The frontend replaces `%date:…%` and `%Node.widget%` in save nodes' `filename_prefix` when it
  queues. The builder sends the text as written. (`importUi`, which reproduces what the frontend
  would queue for a saved file, does replace `%Node.widget%`; see [the UI format](ui-format.md).)
