# ADR-0003: Runtime-agnostic library packages

Status: accepted, 2026-10-17; updated 2026-10-18 (layout, globals; the client, ADR-0023)

## Context

Workflow generation should work wherever JavaScript runs: Node, Bun, Deno, browsers, edge runtimes.

## Decision

`@tscomfy/core`, `@tscomfy/codegen` and `@tscomfy/layout` use no `node:*`, `bun`, `bun:*` or DOM APIs, and do no I/O. `@tscomfy/cli` does I/O through Node's APIs; `@tscomfy/client` (ADR-0023) does network I/O through the WHATWG globals only (`fetch`, `WebSocket` and their companions), builds with `lib: ["es2024", "webworker"]` and is under the same import ban. Imports are banned by oxlint `no-restricted-imports`, scoped to `packages/{core,codegen,layout,client}/src/**`; runtime and DOM globals by the build config (`lib: ["es2024"]`, `types: []`), so using one fails `tsc -b`.

## Consequences

- Codegen returns files as data; the CLI writes them.
- `types: []` alone is not a sufficient guard for imports, because Bun's types pull in `@types/node` transitively wherever they are loaded; the lint rule is the guard. Test configs load Bun's types, so tests may use Bun and Node APIs.

## Evidence

Verified: the rule fires on a `node:fs` import in core and does not apply to cli or tests.
