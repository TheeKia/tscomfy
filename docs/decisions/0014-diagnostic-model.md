# ADR-0014: One diagnostic model, from Phase 1

Status: accepted, 2026-10-17

## Context

Errors are data, but the plan only described diagnostics with validation (Phase 5). The normalizer (Phase 1) and the parser emit them first, so the shape has to exist before either is written. Paths must identify input names with dots in them (851 in a real dump) and class names that aren't identifiers (328).

## Decision

Every module returns the same `Diagnostic`: `{ code, severity, path, message }` (plan §5.4).

- `path` is an array of segments: strings for keys, numbers for array indexes. Normalizer paths point into the raw `/object_info` document; export and validation paths point into the structured workflow.
- Each code has exactly one severity, named by its prefix: `E_` for errors (dropped, or rejected by the backend), `W_` for warnings (kept but degraded, or unverifiable). A check that can end either way gets two codes.
- Codes form a literal union backed by one registry in `core/src/diagnostic/`. Each code has one negative test and an entry in `docs/diagnostics.md`, and a test keeps the two in sync.

## Consequences

- No escaping rules: a dotted name is one segment. Display formatting is a separate concern.
- Callers can filter by code or severity without parsing messages; message wording may change.
- The registry grows phase by phase; codes are never reused for a different meaning.

## Alternatives

- Dotted path strings (`KSampler.input.required.seed`): ambiguous with dotted input names.
- JSON Pointer strings: unambiguous, but need `~0`/`~1` escaping and string parsing for every consumer.
- Severity chosen per occurrence: makes a code's meaning depend on context, and filters by code unreliable.
