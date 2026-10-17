# ADR-0013: Generated runtime schema is a JSON.parse module

Status: accepted, 2026-10-17

## Context

Generated code needs the normalized schema at runtime. Importing it as JSON makes TypeScript infer a type for the whole file on every check.

## Decision

Codegen emits the schema inside a `.ts` module as `JSON.parse("…")`, typed by an annotation, rather than a `.json` import.

## Consequences

- For a 3.4 MB schema: 20 MB and 0.02 s per check, versus 142 MB and 0.2 s for a JSON import.
- No `resolveJsonModule`, no copy step, no import attributes needed in consumers.
- `.d.json.ts` declarations were rejected: the default import is undefined at runtime.

## Evidence

Verified in docs/plan.md §16.
