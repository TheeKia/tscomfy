# tscomfy

[![npm](https://img.shields.io/npm/v/@tscomfy/core)](https://www.npmjs.com/package/@tscomfy/core)
[![Check](https://github.com/TheeKia/tscomfy/actions/workflows/check.yml/badge.svg)](https://github.com/TheeKia/tscomfy/actions/workflows/check.yml)
[![License: MIT](https://img.shields.io/npm/l/@tscomfy/core)](LICENSE)

Type-safe ComfyUI workflows in TypeScript. tscomfy generates types from your ComfyUI server's
`/object_info`, so wiring a `LATENT` into a `MODEL` input, a misspelled sampler or a missing
required input fails at compile time, and validates what the types can't express (bounds, unknown
classes, cycles) before you send anything. The output is the API-format JSON the ComfyUI frontend
would send for the same graph, byte for byte.

```ts
import { stringify, toApi, workflow } from "@tscomfy/core";
import { comfy } from "./comfy/index.ts"; // generated from your server

const txt2img = workflow(comfy, ({ n }) => {
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

const body = stringify({ prompt: toApi(txt2img) });
await fetch("http://127.0.0.1:8188/prompt", { method: "POST", body });
```

## Quick start

You need Node 24 or later (or Bun 1.4) and a ComfyUI server at `http://127.0.0.1:8188`.

```sh
npm init -y && npm pkg set type=module
npm install @tscomfy/core
npm install --save-dev @tscomfy/cli typescript
npx tscomfy generate --url http://127.0.0.1:8188 --out comfy --import-extension .ts
```

`comfy/` now holds the types of every node, model and sampler your server has. Add a
`tsconfig.json` so your editor and `tsc` check against them:

```json
{ "compilerOptions": { "module": "nodenext", "strict": true, "noEmit": true, "allowImportingTsExtensions": true } }
```

Save the code above as `txt2img.ts`, with a checkpoint your server lists (your editor completes
it), then:

```sh
npx tsc            # wrong wiring, a misspelled sampler, a missing input: all errors here
node txt2img.ts    # queues it; the image lands in ComfyUI's output/
```

Node and Bun run TypeScript as is, which is what `--import-extension .ts` is for. After installing
models or node packs, run `generate` again; `npx tscomfy check --url … --out comfy` tells you
when you need to.

## Recipes

Short versions of everyday tasks; [the guides](docs/guides/README.md) cover each in full.

**Render a batch.** A workflow is a function, so its parameters are plain arguments. With
`txt2img` written as one, as in [`examples/txt2img`](examples/txt2img/src/txt2img.ts):

```ts
for (const prompt of ["a lighthouse at dusk", "a fox in the snow"]) {
  for (const seed of [1n, 2n, 3n]) {
    const body = stringify({ prompt: toApi(txt2img({ checkpoint, prompt, seed })) });
    await fetch("http://127.0.0.1:8188/prompt", { method: "POST", body });
  }
}
```

**Start from a workflow you already have.** Save it from ComfyUI, then turn it into typed code
that builds the same prompt, and replace the values you want to vary with parameters:

```sh
npx tscomfy transpile --workflow portrait.json --schema comfy --out portrait.ts
```

**Check values from outside.** Types can't see a width typed into a form. `exportApi` reports
what the backend would reject instead of throwing:

```ts
const { prompt, diagnostics } = exportApi(txt2img({ checkpoint, prompt: text, seed, width }));
if (diagnostics.some((d) => d.severity === "error")) return Response.json(diagnostics, { status: 400 });
```

**Look at it in ComfyUI.** Write a laid-out workflow file and drag it into the frontend:

```ts
const built = txt2img({ checkpoint, prompt: "a cat in a hat", seed: 42n });
await Bun.write("txt2img.json", stringify(toUi(built, { positions: layout(built) }).workflow));
```

[`examples/hires-fix`](examples/hires-fix) puts these together: reusable pieces, a LoRA stack with
one LoRA bypassed, two outputs, diagnostics and a UI file.

## What it does

- **Types per server.** `tscomfy generate` writes a `Nodes` interface with a function per node
  class, literal unions of your models and samplers, and every V3 dynamic input (dynamic combos,
  Autogrow, dynamic groups, MatchType) typed. 1,758 node types type-check in about 0.1 s.
- **Frontend parity.** Defaults, wire keys, key order and `_meta` match the frontend's
  "Export (API)", checked against the frontend's own exports; bypass and mute behave as in the
  frontend.
- **Validation.** `toApi` checks the prompt the way the backend does and throws one error listing
  every problem. Whatever compiles passes validation, and whatever passes validation the backend
  accepts.
- **Existing workflows.** `tscomfy transpile` turns a saved workflow or an API export into typed
  code. `importUi` reads saved workflows (Reroutes, PrimitiveNodes, subgraphs) into the prompt the
  frontend would queue; `toUi` writes files the frontend opens.
- **No dependencies, any runtime.** The libraries run in Bun, Node, Deno and browsers. Seeds and
  bounds beyond 2^53 stay exact. Problems are reported as diagnostics with stable codes.

Out of scope: running workflows (queueing, websockets, progress), executing nodes, a GUI.
tscomfy produces JSON; any ComfyUI client can queue it.

## Status

Feature-complete for its scope (the phases in [the design](docs/plan.md#14-phases) are done) and
tested against the frontend and backend of ComfyUI 0.41. Published on npm; before 1.0, a minor
version may change the API.

## Documentation

- [Guides](docs/guides/README.md): [getting started](docs/guides/getting-started.md),
  [building workflows](docs/guides/building-workflows.md),
  [exporting and validating](docs/guides/export-and-validate.md),
  [graph operations](docs/guides/graph-operations.md),
  [importing and transpiling](docs/guides/import-and-transpile.md),
  [the UI format](docs/guides/ui-format.md), [schemas at runtime](docs/guides/runtime-schemas.md),
  [the CLI](docs/guides/cli.md).
- [Diagnostics](docs/diagnostics.md): every code.
- [API surface](docs/api/): every public declaration, per package.
- [Design](docs/plan.md), [decision records](docs/decisions/README.md) and
  [research notes](docs/research/) on how ComfyUI serializes workflows.

## Packages

| Package | What |
|---|---|
| [`@tscomfy/core`](packages/core) | The schema model and `/object_info` normalizer, the workflow builder, API and UI export and import, validation, graph operations, lossless JSON |
| [`@tscomfy/codegen`](packages/codegen) | Generates node types and the runtime schema module; transpiles workflows to code |
| [`@tscomfy/cli`](packages/cli) | The `tscomfy` command: `generate`, `check`, `transpile` |
| [`@tscomfy/layout`](packages/layout) | Positions for workflows written in the UI format |

## Repository layout

| Path | What |
|---|---|
| `packages/` | The published packages |
| `examples/` | Example projects, typed by your own server |
| `internal/fixtures` | Test data: hand-written mocks, and the local real-data corpus (never committed) |
| `internal/bench`, `internal/api-report`, `internal/pack-test` | The type-checking budget, the API-surface reports in `docs/api/`, and the packages tested as a user installs them |
| `docs/` | Guides, diagnostics, API reports, the design, decisions and research |
| `AGENTS.md` | Working agreements, architecture rules and conventions, for people and AI agents |

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md). In short: Bun 1.4, `bun install`, and `bun run check`
must pass.

## License

[MIT](LICENSE)
