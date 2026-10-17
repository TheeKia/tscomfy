# tscomfy

Type-safe ComfyUI workflow generation in TypeScript. Node types are generated on demand from a
ComfyUI server's `/object_info`, so wiring a `LATENT` into a `MODEL` input, a misspelled
sampler or a missing required input fails at compile time. The output is API-format JSON that
any ComfyUI client can queue. Executing workflows is out of scope.

Status: early development (Phases 0–2 of [the plan](docs/plan.md) are complete). Nothing is
published yet.

## Layout

| Path | What |
|---|---|
| `packages/core` | `@tscomfy/core`: schema model, `/object_info` normalizer, graph builder, API export/import, validation. Zero dependencies, runs anywhere. |
| `packages/codegen` | `@tscomfy/codegen`: generates node types and the runtime schema module; transpiles workflows to code. Pure. |
| `packages/cli` | `@tscomfy/cli`: the `tscomfy` command (generate, check, transpile). The only package with I/O. |
| `internal/fixtures` | `@tscomfy/fixtures` (private): committed mock data and the local real-data corpus. |
| `internal/bench` | `@tscomfy/bench` (private): the type-checking speed harness. |
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
| `bun run lint` | oxlint with type-aware rules |
| `bun run format` | Format and sort imports (oxfmt) |
| `bun run clean` | Remove build output |

## License

MIT
