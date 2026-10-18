# ADR-0002: TypeScript 7 (native compiler)

Status: accepted, 2026-10-17

## Context

TypeScript 7.0, the Go port, became the stable `typescript@latest` in July 2026. It lacks a stable programmatic API until 7.1.

## Decision

Use `typescript@7.0.x` for type-checking and emit. Fall back to TypeScript 6 only if a blocker appears.

## Consequences

- About 10x faster checks; the full 1,758-node generated schema type-checks in 0.11 s.
- No compiler-API tooling (API Extractor and similar). Codegen writes strings, so it needs no compiler API; API-surface checks snapshot `.d.ts` output instead (ADR-0022).
- oxlint's type-aware mode (tsgolint) is built on the same compiler, so lint and tsc agree.

## Evidence

Verified in docs/plan.md §16: strict library build, `tsc -b` references, `.d.ts` consumption under nodenext and bundler, type tests.
