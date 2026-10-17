# ADR-0004: ESM-only, unbundled build with source-first development

Status: accepted, 2026-10-17

## Context

A library needs JS, declarations and source maps. Bundlers add configuration and a second view of the code. During development, tests and editors should run against source without a build.

## Decision

- ESM only. `tsc -b` emits per-file JS, `.d.ts` and maps; source uses `.ts` import specifiers with `rewriteRelativeImportExtensions`.
- Package exports put a custom `@tscomfy/source` condition first, pointing at `src/index.ts`. TypeScript picks it up through `customConditions`, and Bun through `--conditions`.
- Each package has a composite build config (`rootDir: src`, `tsBuildInfoFile: dist/.tsbuildinfo`) and a non-composite noEmit test config with no references. The root `tsconfig.json` is a solution file over all six.

## Consequences

- No bundler to maintain.
- `tsBuildInfoFile` inside `dist` means deleting `dist` forces a rebuild; tsc never deletes stale outputs, hence `bun run clean`.
- References in a noEmit config cause TS2878, so test configs have none.
- There is no separate fast check config: `tsc -b` is fast enough under TS 7, and a second config with Bun types would let library code use Bun APIs undetected.

## Evidence

Verified in docs/plan.md §16; the package tests assert that each entry resolves to `src/index.ts` under the condition and fail without it.
