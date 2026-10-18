# ADR-0021: `toApi` validates by default and throws

Status: accepted, 2026-10-17 (recorded 2026-10-18)

## Context

The types catch most mistakes, but not bounds, unknown classes in `raw` nodes, cycles or a prompt with no output node. A prompt the backend rejects is only discovered when it is queued, far from the code that built it. A pure library also has nowhere to print a warning.

## Decision

(Plan §8.) `toApi(workflow)` validates the prompt against the schema, the way the backend's `validate_prompt` does, and throws one `ValidationError` carrying every diagnostic when there is an error. `{ validate: false }` skips validation; problems building the prompt itself still throw. Warnings never throw: `exportApi` returns the prompt with every diagnostic, `validate` the diagnostics alone, and `validateApi` checks any prompt.

## Consequences

- The default path can't produce a prompt the backend would reject for a reason the schema states.
- Severity follows the soundness ordering: a check is an error when the types reject the same thing or the backend rejects it; where the types accept a value the backend takes, it is a warning.
- Each export validates, which costs under a millisecond for typical workflows (0.8 ms for a 13-node corpus export).

## Alternatives

- A `"error" | "warn" | "off"` level: a library has no channel for warnings, so they would be lost or logged.
- Validation only on request: the common path would ship prompts the backend rejects.

## Evidence

Plan §16 "Backend validation"; `packages/codegen/test/soundness.test.ts` (what compiles validates) and the corpus API workflows (what the frontend exports validates without an error).
