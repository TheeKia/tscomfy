# Getting started

This guide takes you from a running ComfyUI server to a typed workflow and the JSON that queues
it. It assumes you know ComfyUI itself; no knowledge of tscomfy's internals is needed.

## Requirements

- **Node 24 or later, or Bun 1.4 or later,** runs the `tscomfy` command.
- **The libraries** (`@tscomfy/core`, `@tscomfy/codegen`, `@tscomfy/layout`) have no runtime
  dependencies and use no runtime-specific API, so they work in Bun, Node, Deno, browsers and
  edge runtimes. They need ES2024 and `JSON.parse` source-text access, which keeps seeds and
  bounds beyond 2^53 exact (tested with Bun 1.4 and Node 24 and 26). On a runtime without it,
  loading a generated schema that holds such integers (every real one does: seed bounds) throws
  a clear error instead of loading rounded numbers.
- **TypeScript 5.9 or later** with `strict` on (tested with 5.9, 6.0 and 7.0), under
  `module: "nodenext"` or `moduleResolution: "bundler"`.

A project needs `@tscomfy/core` as a dependency and `@tscomfy/cli` as a dev dependency:

```sh
npm install @tscomfy/core
npm install --save-dev @tscomfy/cli
```

[`examples/`](../../examples) has complete projects to start from.

## 1. Generate types from your server

```sh
tscomfy generate --url http://127.0.0.1:8188 --out src/comfy/local
```

In this repository, run it as `bun run tscomfy …`. It only sends `GET /object_info` and
`GET /system_stats`, and writes four files:

| File | What it is |
|---|---|
| `nodes.ts` | The types: one `Nodes` interface with a function per node class, input interfaces, and literal unions for combo options (your checkpoint names, samplers, …) |
| `index.ts` | `export const local: TypedSchema<Nodes>`: the normalized node definitions as a runtime value, typed by `Nodes` |
| `object_info.json` | The server's response as it came, for regenerating offline (`--from`) and for `tscomfy check` |
| `tscomfy.json` | What was generated, so `tscomfy check` can tell an edited or stale file |

The constant is named after the directory (`local` here; `--name` picks another). The files hold
your model names and depend on what your server has installed, so most projects gitignore them
and regenerate; commit them if your builds must work without the server. `--out` can be any
directory; several servers can live side by side (`src/comfy/laptop`, `src/comfy/render-box`).

The command prints a short report. Warnings are normal: a loader with no model files installed
gets `W_EMPTY_COMBO` and takes any string. See [the CLI reference](cli.md) for every option.

## 2. Build a workflow

```ts
import { stringify, toApi, workflow } from "@tscomfy/core";
import { local } from "./comfy/local/index.js";

const txt2img = workflow(local, ({ n }) => {
  const [model, clip, vae] = n.CheckpointLoaderSimple({ ckpt_name: "sd_xl_base_1.0.safetensors" });
  const latent = n.KSampler({
    model,
    positive: n.CLIPTextEncode({ clip, text: "a cat in a hat" }),
    negative: n.CLIPTextEncode({ clip, text: "" }),
    latent_image: n.EmptyLatentImage({ width: 1024, height: 1024 }),
    seed: 42n,
    sampler_name: "euler",
    scheduler: "normal",
  });
  n.SaveImage({ images: n.VAEDecode({ samples: latent, vae }) });
});
```

`workflow(schema, build)` calls `build` once with `n`, which has a function per node class.
Each call adds a node and returns its outputs: one output is returned as is, several as a tuple
you can destructure (or read by name: `ckpt.CLIP`). Inputs with a default in the schema
(`seed`, `steps`, `cfg`, `denoise`, `batch_size`, `filename_prefix`) are optional and filled in
on export.

Every one of these is a compile error:

```ts
n.KSampler({ model: latent /* Out<"LATENT"> is not In<"MODEL"> */, … });
n.KSampler({ …, sampler_name: "eular" /* not one of your server's samplers */ });
n.KSampler({ model, positive, negative, latent_image /* missing: sampler_name, scheduler */ });
n.CLIPTextEncode({ clip, text: "…", strength: 1 /* no such input */ });
```

[Building workflows](building-workflows.md) covers the rest: dynamic inputs, titles and ids,
reusable pieces, bypass and mute, and the untyped escape hatch.

## 3. Export it

```ts
const prompt = toApi(txt2img);
const body = stringify({ prompt }); // the body of POST /prompt
```

`toApi` returns the prompt the ComfyUI frontend would send for the same graph: every widget
value, links as `["id", slot]`, `_meta.title`, keys in the frontend's order. It validates the
prompt against the schema first and throws a `ValidationError` listing every problem the backend
would reject (a value out of range, a combo option that isn't there, a cycle).

Use `stringify` rather than `JSON.stringify`: seeds can be `bigint`, and `stringify` writes them
as exact JSON numbers. Queueing is up to you; tscomfy doesn't talk to the server beyond
`tscomfy generate`. With `fetch`:

```ts
await fetch("http://127.0.0.1:8188/prompt", { method: "POST", body: stringify({ prompt }) });
```

[Exporting and validating](export-and-validate.md) explains the output and the diagnostics.

## 4. Keep the types in sync

When you install a model or a node pack, regenerate. To find out whether you need to, `check`
compares the server with the snapshot and exits 1 on drift:

```sh
tscomfy check --url http://127.0.0.1:8188 --out src/comfy/local
```

It also fails when a generated file was edited or comes from another tscomfy version. New files
in upload combos (`LoadImage`'s images) are runtime state and don't count.

## Where next

- Already have workflows? `tscomfy transpile --workflow my-workflow.json --schema src/comfy/local`
  turns a saved UI workflow (or `--prompt`, an "Export (API)" file) into code like the above:
  [importing and transpiling](import-and-transpile.md).
- Want to open a generated workflow in ComfyUI? [The UI format](ui-format.md).
- Working without codegen, say in a browser app against a live server?
  [Schemas at runtime](runtime-schemas.md).
