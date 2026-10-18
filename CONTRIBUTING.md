# Contributing

[AGENTS.md](AGENTS.md) holds the rules: working agreements, architecture rules, conventions and
the gotchas that cost time. This file is the how-to. [The design](docs/plan.md) explains what was
decided and why; read the parts you touch.

## Setup

Requires [Bun](https://bun.com) 1.4.

```sh
bun install
bun run check    # build, lint, format check, API reports, tests: the gate
```

Everything runs from source: tests and the CLI resolve the packages to `src/` through the
`@tscomfy/source` export condition, so no build is needed except for `tsc -b` itself.

| Script | Does |
|---|---|
| `bun run check` | `tsc -b`, lint, format check, `api:check`, tests. Must pass before any change is done |
| `bun run test` | The tests, against source; skips corpus tests |
| `bun run test:corpus` | The corpus tests, over your local real data (below) |
| `bun run build` | Type-check and emit every package (`tsc -b`) |
| `bun run format` | Format and sort imports (oxfmt) |
| `bun run lint` | oxlint with type-aware rules |
| `bun run generate:fixtures` | Regenerate `packages/codegen/test/generated/` (types and transpiled mock workflows) after changing codegen |
| `bun run generate:widths` | Remeasure the text widths codegen breaks lines by from oxfmt, after updating oxfmt (`text-width.test.ts` fails until then) |
| `bun run api:update` | Rewrite the API reports in `docs/api/` after an intended API change |
| `bun run bench:types` | Check the type-checking budget of generated types |
| `bun run test:pack` | Pack every package, install the tarballs offline into a scratch project, run the CLI under Node and Bun and type-check a consumer. CI runs it on every push, under Node 24 and 26 |
| `bun run tscomfy …` | The CLI, from source |
| `bun run clean` | Remove build output; `tsc` never deletes stale files |

## Tests and data

- Unit tests are `test/*.test.ts` (`bun:test`); type tests are `test/*.test-d.ts`, checked by
  `tsc -b` with `expect-type` and `@ts-expect-error -- reason`.
- Committed tests use **hand-written mocks** in `internal/fixtures/mocks/`, loaded through
  `@tscomfy/fixtures`. See [its README](internal/fixtures/README.md) for what each mock covers.
- **Real data never gets committed.** `internal/fixtures/corpus/` is gitignored; fill it from
  your own server as [its README](internal/fixtures/corpus/README.md) describes, then run
  `bun run test:corpus`. A phase or a larger change isn't done until the corpus tests pass.
- When the corpus shows something no mock covers, **distill it into a new mock first**, then fix
  it: the mock is the regression test.
- Questions about what the frontend does are settled by the frontend itself:
  `internal/fixtures/scripts/frontend.ts` loads UI files into your server's frontend in headless
  Chromium and saves the prompt it builds, without queueing anything.

## Common changes

**A new diagnostic code.** Add it to the registry in `packages/core/src/diagnostic/diagnostic.ts`
(the prefix names its severity), document it in `docs/diagnostics.md` (a test keeps the two in
sync) and add a negative test that checks its path.

**A new mock.** Add the file to `internal/fixtures/mocks/…` and its name to the matching
`MOCK_*_NAMES` list in `internal/fixtures/src/index.ts` (a test enforces it), add a row to the
fixtures README, and run `bun run generate:fixtures` if it is an `/object_info` mock.

**A codegen change.** Run `bun run generate:fixtures`; the committed output must stay
oxfmt-formatted and type-check. Run `bun run bench:types` when the encoding changes.

**A change to the public API.** `bun run check` fails in `api:check` until you run
`bun run api:update`; the diff in `docs/api/` is the API change to review. Every public symbol
needs JSDoc and an explicit type.

**A new package.** Put it under `packages/` (published) or `internal/` (private), add it and its
`test/` config to the root `tsconfig.json` references, and declare workspace dependencies as
`workspace:*` (or `workspace:^` for a peer).

**A decision.** When a decision changes, update `docs/plan.md` and its ADR in
`docs/decisions/` in the same change, with the evidence in plan §16.

## Releasing

The four packages share one version and are released together, from CI only:

1. Set the new version in each `packages/*/package.json` and in `CODEGEN_VERSION`
   (`packages/codegen/src/generate.ts`) and `CLI_VERSION` (`packages/cli/src/run.ts`); tests
   check that these agree. Then `bun install`, `bun run generate:fixtures` (generated headers name
   the version) and `bun run api:update`.
2. `bun run check`, `bun run test:corpus` and `bun run test:pack`; commit.
3. `git tag v<version> && git push origin main v<version>`.

`.github/workflows/release.yml` checks that the tag matches every package, runs `check` and
`test:pack` and packs each package with `bun pm pack` (which rewrites `workspace:` ranges; npm
doesn't), all with read-only permissions; a second job, the only one allowed to mint the token,
publishes the tarballs with npm trusted publishing: no token is stored, and npm adds
provenance. Versions already on npm are skipped, so a failed release can be re-run. Each
package's trusted publisher on npmjs.com names `TheeKia/tscomfy` and `release.yml`; a new
package needs one, which npm only allows once the package exists, so its first version is
published by hand.

## Reviews

Each phase closed with an independent review: someone (or an agent) who didn't write the code
tries to break it, every finding is reproduced before it is fixed, and the result is recorded in
plan §16. Do the same for larger changes.

## License

Contributions are MIT. ComfyUI's frontend and backend are GPL-3.0: read them as a specification,
never copy their code or text (tooltips and descriptions included) into this repository.
