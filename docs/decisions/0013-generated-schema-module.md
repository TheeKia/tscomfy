# ADR-0013: Generated runtime schema is a string-literal module

Status: accepted, 2026-10-17

## Context

Generated code needs the normalized schema at runtime. Importing it as JSON makes TypeScript infer a type for the whole file on every check.

## Decision

Codegen emits the schema inside a `.ts` module as one string literal passed to `defineSchema<Nodes>(…)`, typed by an annotation, rather than a `.json` import. `defineSchema` parses it with tscomfy's lossless `parse` (big integers stay exact; a plain `JSON.parse` would round them) and freezes the result.

## Consequences

- For a 3.4 MB schema: 20 MB and 0.02 s per check, versus 142 MB and 0.2 s for a JSON import.
- Loading costs one lossless parse at import time (about 26 ms for 3.4 MB in Bun 1.4.3).
- No `resolveJsonModule`, no copy step, no import attributes needed in consumers.
- `.d.json.ts` declarations were rejected: the default import is undefined at runtime.

## Evidence

Verified in docs/plan.md §16.
