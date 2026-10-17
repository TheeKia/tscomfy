# ADR-0003: Runtime-agnostic library packages

Status: accepted, 2026-10-17

## Context

Workflow generation should work wherever JavaScript runs: Node, Bun, Deno, browsers, edge runtimes.

## Decision

`@tscomfy/core` and `@tscomfy/codegen` use no `node:*`, `bun`, `bun:*` or DOM APIs. `@tscomfy/cli` is the only package with I/O. The ban is enforced by oxlint `no-restricted-imports`, scoped to `packages/{core,codegen}/src/**`.

## Consequences

- Codegen returns files as data; the CLI writes them.
- `types: []` alone is not a sufficient guard, because Bun's types pull in `@types/node` transitively; the lint rule is the guard.

## Evidence

Verified: the rule fires on a `node:fs` import in core and does not apply to cli or tests.
