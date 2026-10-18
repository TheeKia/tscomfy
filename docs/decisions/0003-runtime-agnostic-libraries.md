# ADR-0003: Runtime-agnostic library packages

Status: accepted, 2026-10-17; updated 2026-10-18 (layout, globals)

## Context

Workflow generation should work wherever JavaScript runs: Node, Bun, Deno, browsers, edge runtimes.

## Decision

`@tscomfy/core`, `@tscomfy/codegen` and `@tscomfy/layout` use no `node:*`, `bun`, `bun:*` or DOM APIs. `@tscomfy/cli` is the only package with I/O. Imports are banned by oxlint `no-restricted-imports`, scoped to `packages/{core,codegen,layout}/src/**`; runtime and DOM globals by the build config (`lib: ["es2024"]`, `types: []`), so using one fails `tsc -b`.

## Consequences

- Codegen returns files as data; the CLI writes them.
- `types: []` alone is not a sufficient guard for imports, because Bun's types pull in `@types/node` transitively wherever they are loaded; the lint rule is the guard. Test configs load Bun's types, so tests may use Bun and Node APIs.

## Evidence

Verified: the rule fires on a `node:fs` import in core and does not apply to cli or tests.
