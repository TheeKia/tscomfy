# ADR-0005: Zero runtime dependencies

Status: accepted, 2026-10-17

## Context

The first plan used zod to parse `/object_info`. Real dumps showed that parsing must be lenient per field (one odd spec should produce a diagnostic, not reject the node), and that the raw format has many loosely related shapes.

## Decision

No package has runtime dependencies. The object_info normalizer is a hand-written tree walk over `unknown` values that collects diagnostics.

## Consequences

- No second representation of the data (schema types plus normalized types).
- The normalizer needs careful tests; the mock fixtures (`internal/fixtures/mocks/object-info/malformed.json` and others) exist for that.

## Evidence

Decided after the verification round; see docs/plan.md D5.
