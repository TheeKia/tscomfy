# AGENTS.md

Instructions for AI agents (and humans) working in this repo. Read this first, then
`docs/plan.md`, which is the source of truth for design and scope.

## The project

tscomfy is a TypeScript library for **generating** ComfyUI workflows as code. Node types are
generated from a ComfyUI server's `/object_info`, so wiring and value mistakes fail at compile
time, and runtime validation catches the rest. Output is API-format JSON.

**Out of scope:** executing workflows (queueing, websockets, progress), running nodes in-process,
GUIs, MCP servers. Don't add these.

**Status:** Phase 0 (foundation) is done. Next is Phase 1: lossless `parse`/`stringify`, the
diagnostic model, the `core` schema model, `accepts()` and the `/object_info` normalizer. Phases
and exit criteria are in `docs/plan.md` §14.

## Where things are

| Path | What |
|---|---|
| `docs/plan.md` | The plan: decisions (§3), architecture (§4), type encoding (§6), frontend parity rules (§7.4), phases (§14), verification log (§16) |
| `docs/decisions/` | One ADR per decision in plan §3 |
| `docs/research/` | Ground-truth notes on ComfyUI's serialization and the prior-art review, with source citations |
| `packages/{core,codegen,cli}` | The publishable packages, `@tscomfy/<folder>` |
| `internal/fixtures` | `@tscomfy/fixtures` (private): mocks and the local corpus |

## Working agreements

These come from the project owner. Follow them unless told otherwise.

- **Quality bar is very high.** Clean architecture, strict types, no shortcuts. A phase is not
  done while it has known `TODO`s.
- **Research before deciding; don't assume.** Verify claims hands-on (run it, read the source,
  measure it) before they go into the plan or code. Record evidence in plan §16 or the relevant
  ADR. When a decision changes, update the plan and the ADR in the same change.
- **Modern tooling:** Bun 1.4 and TypeScript 7 (fall back to TS 6 only if TS 7 truly blocks
  something). oxfmt formats, oxlint lints. Prefer the newest stable tools, verified to work.
- **No CI for now.** Don't add or propose CI pipelines. `bun run check` is the gate; a phase
  also needs `bun run test:corpus` to pass before it closes.
- **Publishing is not a priority.** Packages live under the owner's npm org `@tscomfy`.
- **Never commit real ComfyUI data.** `/object_info` dumps and workflows from a real server go in
  `internal/fixtures/corpus/` (gitignored). Committed tests use hand-written mocks. When a corpus
  run finds something no mock covers, distill it into a new mock first (see
  `internal/fixtures/README.md`).
- **License hygiene:** the project is MIT. ComfyUI's frontend and backend are GPL-3.0: read them as
  a specification only. Never copy their code or text (tooltips, descriptions) into this repo.
- **Combos are strict by default** (literal unions of the server's options), with the documented
  exceptions in plan §6.5.

## Architecture rules

Enforced by package boundaries, lint, or review:

- Dependencies point downward: `cli` → `codegen` → `core`. No package has runtime dependencies.
- `core` and `codegen` are runtime-agnostic: no `node:*`, `bun`, `bun:*` or DOM APIs. oxlint
  enforces this for `packages/{core,codegen}/src/**`. `types: []` alone is not a guard, because
  Bun's types pull in `@types/node`.
- Only `cli` does I/O. `codegen` returns `{ path, contents }[]`.
- Only `packages/core/src/object-info/` knows the raw `/object_info` format. Everything else uses
  the normalized `Schema`.
- Public API: free functions over immutable data, named exports only, explicit types (enforced by
  `isolatedDeclarations`), JSDoc on every public symbol.
- Errors are data: one `Diagnostic` model (plan §5.4) with a stable code, a fixed severity, a
  segment-array path and a message. Throw only for programmer misuse.
- Pure and deterministic: the same input gives byte-identical output.
- Soundness ordering: what compiles passes runtime validation; what passes validation is accepted
  by the ComfyUI backend. Types may be stricter than the backend, never looser.

## Commands

```sh
bun install
bun run check     # tsc -b, lint, format check, tests: run before declaring work done
bun run test      # tests against source, no build needed (skips corpus tests)
bun run test:corpus  # corpus tests against your local real data
bun run format    # oxfmt: format and sort imports
bun run clean     # tsc never deletes stale outputs; clean when files are removed or renamed
```

## Conventions

- ESM only. Relative imports use `.ts` extensions (rewritten on emit). `import type` for types.
- Package layout: `src/` (built), `test/` (not built, own `tsconfig.json`, Bun types).
- Unit tests: `test/*.test.ts` with `bun:test`. Type tests: `test/*.test-d.ts` using
  `expect-type` and `@ts-expect-error -- reason`, checked by `tsc -b` (Bun ignores them).
  Corpus tests: `test/*.corpus.test.ts`, run only by `test:corpus`; an empty section reports a
  skipped test.
- Tests load data only through `@tscomfy/fixtures` (`readMockObjectInfo`, `listCorpus`), never by
  relative path. Loaders return raw text because parsing is under test.
- Adding a package: add it to the root `tsconfig.json` references (both the package and its
  `test/` config) and declare workspace dependencies with `workspace:*`.
- Generated files are excluded from lint.

## Gotchas (all verified)

- Bun has no bunfig setting for export conditions; scripts pass `--conditions=@tscomfy/source`.
  Without it, imports resolve to `dist/` and the package tests fail on purpose.
- Don't add `references` to the noEmit test configs: that causes TS2878.
- `tsBuildInfoFile` lives in `dist/`, so deleting `dist` forces a rebuild.
- oxlint needs `.gitignore` present, or it walks `node_modules` symlinks.
- `JSON.parse` rounds integers beyond 2^53. Seeds reach 2^64−1; use source-text access when
  parsing and our own serializer when writing (plan D10). APIs that read outside JSON take raw
  text, never a parsed value.
- Sort strings by code unit (`toSorted()` with no comparator), never with `localeCompare`: its
  order depends on the process locale (Node under `LANG=sv_SE` puts `z` before `ä`; Bun doesn't).
- 851 real inputs have dots in their names: never split input keys on `.` without the schema.
- In API JSON a bare list is a link; list-valued widget values are sent as `{"__value__": [...]}`.

## Local environment

A ComfyUI server usually runs at `http://127.0.0.1:8188` (0.41.0 at the time of the
verification round). Use it to fill the corpus (`internal/fixtures/corpus/README.md`). Never POST
to `/prompt`: this project doesn't execute workflows. Read-only GETs (`/object_info`,
`/system_stats`, `/api/userdata?dir=workflows`) are fine.
