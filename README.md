# tscomfy

Type-safe ComfyUI workflow generation in TypeScript. Node types are generated on demand from a
ComfyUI server's `/object_info`, so wiring a `LATENT` into a `MODEL` input, a misspelled
sampler or a missing required input fails at compile time. The output is API-format JSON that
any ComfyUI client can queue. Executing workflows is out of scope.

Status: early development (Phases 0–7 of [the plan](docs/plan.md) are complete). Nothing is
published yet.

## Quick start

```sh
bun run tscomfy generate --url http://127.0.0.1:8188 --out src/comfy/local
```

That writes typed node definitions for every node your server has, and a snapshot of its
`/object_info`. Build a workflow with them and export it:

```ts
import { stringify, toApi, workflow } from "@tscomfy/core";
import { local } from "./comfy/local/index.js";

const prompt = toApi(
  workflow(local, ({ n }) => {
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
  }),
);
console.log(stringify({ prompt })); // the body of POST /prompt
```

`tscomfy check --url … --out src/comfy/local` exits 1 when the server's nodes no longer match
the generated types. `tscomfy transpile --prompt workflow.json --schema src/comfy/local` turns a
prompt saved with the frontend's "Export (API)" into code like the above, and `--workflow` does
the same for a workflow the frontend saved, Reroutes, PrimitiveNodes and subgraphs included.
For a workflow built in code (the argument of `toApi` above), `toUi(built, { positions:
layout(built) })` writes the JSON the frontend opens (`layout` is from `@tscomfy/layout`). [`examples/txt2img`](examples/txt2img) is a complete project.

## Layout

| Path | What |
|---|---|
| `packages/core` | `@tscomfy/core`: schema model, `/object_info` normalizer, graph builder, API and UI export/import, validation. Zero dependencies, runs anywhere. |
| `packages/codegen` | `@tscomfy/codegen`: generates node types and the runtime schema module, and transpiles workflows to code. Pure. |
| `packages/cli` | `@tscomfy/cli`: the `tscomfy` command (`generate`, `check`, `transpile`). The only package with I/O. |
| `packages/layout` | `@tscomfy/layout`: positions for workflows exported to the frontend's UI format. Pure. |
| `internal/fixtures` | `@tscomfy/fixtures` (private): committed mock data and the local real-data corpus. |
| `internal/bench` | `@tscomfy/bench` (private): the type-checking speed harness. |
| `examples/` | Example projects, typed by your own server. |
| `docs/plan.md` | The implementation plan: design, scope, phases. |
| `docs/decisions/` | Architecture decision records. |
| `docs/research/` | Notes on ComfyUI's serialization and on prior art, with source citations. |
| `AGENTS.md` | Working agreements, architecture rules and conventions for contributors and AI agents. |

## Development

Requires [Bun](https://bun.com) 1.4. Read [AGENTS.md](AGENTS.md) before contributing.

```sh
bun install
bun run check    # build, lint, format check, tests: the single gate
```

| Script | Does |
|---|---|
| `bun run build` | Type-check and emit all packages (`tsc -b`) |
| `bun run test` | Run tests against source (no build needed) |
| `bun run test:corpus` | Run the corpus tests against your local real data (`internal/fixtures/corpus/`) |
| `bun run generate:fixtures` | Regenerate the committed codegen fixtures from the mocks |
| `bun run bench:types` | Check the type-checking budget of generated types |
| `bun run tscomfy` | Run the CLI from source |
| `bun run lint` | oxlint with type-aware rules |
| `bun run format` | Format and sort imports (oxfmt) |
| `bun run clean` | Remove build output |

## License

MIT
