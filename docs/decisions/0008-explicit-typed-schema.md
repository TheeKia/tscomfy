# ADR-0008: The schema is an explicit typed value

Status: accepted, 2026-10-17

## Context

Generated node types could be registered globally with module augmentation, or passed as a value.

## Decision

Generated code exports a typed schema value (`export const local: TypedSchema<Nodes>`), and `workflow(local, …)` takes it explicitly. No global augmentation.

## Consequences

- Several servers in one project, each with its own types.
- Tests are isolated and there is no hidden global state.

## Evidence

docs/plan.md §6.1 and §7.
