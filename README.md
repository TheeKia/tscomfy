# tscomfy

Type-safe ComfyUI workflows in TypeScript. tscomfy generates types from your ComfyUI server's
`/object_info`, so wiring a `LATENT` into a `MODEL` input, a misspelled sampler or a missing
required input fails at compile time, and validates what the types can't express (bounds, unknown
classes, cycles) before you send anything. The output is the API-format JSON the ComfyUI frontend
would send for the same graph, byte for byte.

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

const body = stringify({ prompt: toApi(txt2img) }); // POST it to /prompt
```

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
tested against the frontend and backend of ComfyUI 0.41. Not on npm yet: to try it, clone this
repository and start from [`examples/txt2img`](examples/txt2img).

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
| `internal/bench`, `internal/api-report` | The type-checking budget, and the API-surface reports in `docs/api/` |
| `docs/` | Guides, diagnostics, API reports, the design, decisions and research |
| `AGENTS.md` | Working agreements, architecture rules and conventions, for people and AI agents |

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md). In short: Bun 1.4, `bun install`, and `bun run check`
must pass.

## License

[MIT](LICENSE)
