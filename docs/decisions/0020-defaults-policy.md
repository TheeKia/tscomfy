# ADR-0020: Fill the schema's defaults, never invent one

Status: accepted, 2026-10-17 (recorded 2026-10-18)

## Context

The frontend sends every widget's value. For a widget without a stated default it falls back to `0`, `""`, `false` or the first combo option, which for a checkpoint loader means whatever file sorts first.

## Decision

(Plan §7.2.) The exporter fills every explicit schema default, recursively through dynamic-combo options and DynamicGroup rows, and the generated types make exactly those inputs optional. It never invents a value: an input without a default stays required in the types, and an optional widget without one is left out of the prompt. Where the frontend overrides the schema's default (a multi-select starts as `[]`, a falsy combo default becomes the first option, a few widgets start at fixed values), the normalizer records the frontend's initial value as the default, so the exporter, the types and their JSDoc follow one rule.

## Consequences

- Exported prompts match the frontend's for every input the user or the schema gives a value, byte for byte.
- An optional widget without a default is the one documented difference: the frontend sends a fallback, tscomfy sends nothing (and the frontend's `0` can even be outside `min`).
- Inputs named after `Object` members are required, since TypeScript checks an optional property against the member every object literal inherits.

## Alternatives

- The frontend's fallbacks: silently picks a model, and can produce values the backend rejects.
- No defaults at all: prompts would differ from the frontend's, and every input would be required.

## Evidence

Frontend 1.55.17 `useComboWidget.ts` and the widget composables (plan §16, "Combo defaults"); the parity prompts in `internal/fixtures/mocks/workflows/api/`.
