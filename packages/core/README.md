# @tscomfy/core

[![npm](https://img.shields.io/npm/v/@tscomfy/core)](https://www.npmjs.com/package/@tscomfy/core)

Type-safe ComfyUI workflows in TypeScript. Build a workflow with node functions typed by your
own server, and export the API-format prompt `POST /prompt` takes: validated the way the backend
validates it, and byte for byte what the ComfyUI frontend would send. It also reads prompts and
saved workflow files, writes files the frontend opens, and reshapes graphs. No runtime
dependencies; runs in Node, Bun, Deno and browsers.

```sh
npm install @tscomfy/core
npm install --save-dev @tscomfy/cli
npx tscomfy generate --url http://127.0.0.1:8188 --out src/comfy/local
```

`tscomfy generate` ([`@tscomfy/cli`](https://www.npmjs.com/package/@tscomfy/cli)) writes the
types: a function per node class your server has, its models and samplers as literal unions.

```ts
import { stringify, toApi, workflow } from "@tscomfy/core";
import { local } from "./comfy/local/index.js"; // generated from your server

const txt2img = workflow(local, ({ n }) => {
  const [model, clip, vae] = n.CheckpointLoaderSimple({ ckpt_name: "sd_xl_base_1.0.safetensors" });
  const latent = n.KSampler({
    model,
    positive: n.CLIPTextEncode({ clip, text: "a cat in a hat" }),
    negative: n.CLIPTextEncode({ clip, text: "" }),
    latent_image: n.EmptyLatentImage({ width: 1024, height: 1024 }),
    seed: 42n,
    sampler_name: "euler", // one of your server's samplers, or a compile error
    scheduler: "normal",
  });
  n.SaveImage({ images: n.VAEDecode({ samples: latent, vae }) });
});

const prompt = toApi(txt2img); // throws a ValidationError listing what the backend would reject
await fetch("http://127.0.0.1:8188/prompt", { method: "POST", body: stringify({ prompt }) });
```

## What's in it

**Building** ([guide](https://github.com/TheeKia/tscomfy/blob/main/docs/guides/building-workflows.md))

| Export | What |
|---|---|
| `workflow(schema, build)` | Calls `build` once with `n`, a function per node class, and `raw`, for untyped nodes; returns a frozen `Workflow` |
| `Out<T>`, `In<T>` | An output of socket type `T`, and what an input of type `T` takes: for functions that pass outputs around |
| `Workflow<Nodes>`, `NodesOf<typeof local>` | A workflow's type, with or without importing the generated `nodes.ts` |

Every node function takes options as its second argument: `title`, `id`, and `mode` (`"bypass"`
or `"mute"`).

**Exporting and validating** ([guide](https://github.com/TheeKia/tscomfy/blob/main/docs/guides/export-and-validate.md))

| Export | What |
|---|---|
| `toApi(workflow, options?)` | The prompt; throws a `ValidationError` with every error |
| `exportApi(workflow, options?)` | `{ prompt, diagnostics }`, warnings included, without throwing for bad values |
| `validate(workflow)` | The diagnostics alone |
| `validateApi(prompt, schema)` | The diagnostics of a prompt from anywhere, by the backend's rules |

The options `validate`, `meta` (`_meta.title`) and `modes` (bypass and mute) are `true` by default.

**Importing** ([guide](https://github.com/TheeKia/tscomfy/blob/main/docs/guides/import-and-transpile.md))

| Export | What |
|---|---|
| `importApi(text, schema)` | An API prompt ("Export (API)") as a workflow |
| `importUi(text, schema)` | A saved workflow file as the workflow the frontend would queue for it: Reroutes, PrimitiveNodes and subgraphs resolved |

Both take the file's text and return `{ workflow, diagnostics }`.

**The UI format** ([guide](https://github.com/TheeKia/tscomfy/blob/main/docs/guides/ui-format.md))

| Export | What |
|---|---|
| `toUi(workflow, options?)` | A workflow file the frontend opens, `{ workflow, ids, diagnostics }`; `positions` from [`@tscomfy/layout`](https://www.npmjs.com/package/@tscomfy/layout) or your own |
| `uiNodeSizes(workflow)` | The size `toUi` gives each node, for a layout of your own |

**Graph operations** ([guide](https://github.com/TheeKia/tscomfy/blob/main/docs/guides/graph-operations.md))

| Export | What |
|---|---|
| `prune(workflow)` | The output nodes that run and what they depend on, nothing else |
| `splitOutputs(workflow)` | One workflow per output node that runs |

**Schemas** ([guide](https://github.com/TheeKia/tscomfy/blob/main/docs/guides/runtime-schemas.md))

| Export | What |
|---|---|
| `normalizeObjectInfo(text, options?)` | A `/object_info` response as a `Schema`, and diagnostics for what it couldn't read; never throws |
| `typedSchema(schema)` | A schema read at runtime, as one `workflow` and the importers take, for working without codegen |
| `hashSchema(schema)` | A `sha256:` identity of the node definitions |
| `diffSchemas(before, after)` | The nodes added, removed and changed |
| `accepts(input, output)` | Whether the backend accepts a link from that output into that input |

**JSON**

| Export | What |
|---|---|
| `stringify(value)` | Deterministic JSON that writes `bigint` exactly; use it rather than `JSON.stringify`, since seeds go up to 2^64 − 1 |
| `parse(text)` | `{ value, diagnostics }`, integers beyond 2^53 as `bigint`; never throws |

**Diagnostics** ([every code](https://github.com/TheeKia/tscomfy/blob/main/docs/diagnostics.md))

Functions that read or check data report problems as `Diagnostic`s,
`{ code, severity, path, message }`, rather than throwing. Match on `code`, which is stable;
`DIAGNOSTIC_CODES` maps each to its severity. `ValidationError`, which `toApi` throws, carries
them as `diagnostics`.

The rest, such as the `Schema` types and `defineSchema` (which generated modules call), is in
[the API reference](https://github.com/TheeKia/tscomfy/blob/main/docs/api/core.md) with each
declaration's documentation.

## Requirements

- ES2024 and `JSON.parse` source-text access, which keeps seeds and bounds beyond 2^53 exact:
  Node 24 or later, Bun 1.4 or later.
- TypeScript 5.9 or later with `strict`, under `module: "nodenext"` or
  `moduleResolution: "bundler"`.

## Documentation

[The guides](https://github.com/TheeKia/tscomfy/tree/main/docs/guides), starting with
[getting started](https://github.com/TheeKia/tscomfy/blob/main/docs/guides/getting-started.md),
and [the examples](https://github.com/TheeKia/tscomfy/tree/main/examples).

## License

MIT
