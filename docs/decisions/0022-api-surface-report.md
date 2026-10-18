# ADR-0022: The public API is pinned by declaration reports

Status: accepted, 2026-10-18

## Context

The packages' public API is what their `.d.ts` files declare. Without a record of it, an export added by accident, a renamed option or a changed signature only shows up in review if someone thinks to look. TypeScript 7 has no stable compiler API yet, which rules out tools such as API Extractor (plan §15).

## Decision

`docs/api/<package>.md` holds, per published package, every declaration file a consumer's type checker reads, starting at the package's `types` entry, in the order they are first reached. `bun run api:update` writes them after `tsc -b`; `bun run check` runs `api:check`, which fails while a report differs from the declarations. A runtime test pins the names `@tscomfy/core` exports.

## Consequences

- Every change to the public API, its JSDoc included, appears as a diff in `docs/api/` and is reviewed as such.
- The reports double as an API reference that lives next to the guides.
- Declaration files reachable from the entry also show internal exports used across modules (they aren't importable, since `exports` only exposes `.`); changing them changes the report.

## Alternatives

- API Extractor: needs the TypeScript compiler API, which TS 7.0 doesn't have.
- A test that snapshots `Object.keys` of each package: covers runtime names only, not types or signatures; kept as a complement for core.

## Evidence

`internal/api-report/src/api-report.ts`; the first run caught the intended API changes of Phase 9 (`ApiExportResult`, `ApiImportResult`, `typedSchema`, `ComboUpload`).
