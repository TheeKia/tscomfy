# ADR-0005: Zero runtime dependencies

Status: accepted, 2026-10-17; updated 2026-10-18 (core as a peer)

## Context

The first plan used zod to parse `/object_info`. Real dumps showed that parsing must be lenient per field (one odd spec should produce a diagnostic, not reject the node), and that the raw format has many loosely related shapes.

## Decision

No package has runtime dependencies outside the project. The packages depend on each other: `@tscomfy/core` is a peer dependency of codegen, layout and cli, so a project has exactly one copy of it (output references are recognized by `instanceof`, and a second copy would break layout and transpile silently); cli depends on codegen directly. The object_info normalizer is a hand-written tree walk over `unknown` values that collects diagnostics.

## Consequences

- No second representation of the data (schema types plus normalized types).
- Releases pack with `bun pm pack`, which rewrites the `workspace:` ranges (`workspace:^` becomes `^<version>`), and publish the tarballs with npm (ADR-0012); npm's own packing would leave the ranges as they are. `bun run test:pack` installs the packed tarballs into a scratch project to check this.
- The normalizer needs careful tests; the mock fixtures (`internal/fixtures/mocks/object-info/malformed.json` and others) exist for that.

## Evidence

Decided after the verification round; see docs/plan.md D5.
