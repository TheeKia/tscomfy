# Architecture decision records

One short record per decision in docs/plan.md §3. All accepted 2026-10-17.

| ADR | Decision |
|---|---|
| [0001](0001-bun.md) | Bun as package manager, workspace tool, test runner and CLI runtime |
| [0002](0002-typescript-7.md) | TypeScript 7 (native compiler) |
| [0003](0003-runtime-agnostic-libraries.md) | Runtime-agnostic library packages |
| [0004](0004-esm-unbundled-build.md) | ESM-only, unbundled build with source-first development |
| [0005](0005-zero-runtime-dependencies.md) | Zero runtime dependencies |
| [0006](0006-normalizer-in-core.md) | The object_info normalizer lives in core |
| [0007](0007-api-format-first.md) | API format first, UI format later |
| [0008](0008-explicit-typed-schema.md) | The schema is an explicit typed value |
| [0009](0009-branded-output-refs.md) | Output references are branded, covariant, frozen objects |
| [0010](0010-lossless-integers.md) | Lossless integers |
| [0011](0011-oxfmt-format-oxlint-lint.md) | oxfmt formats, oxlint lints |
| [0012](0012-no-ci.md) | No CI for now |
| [0013](0013-generated-schema-module.md) | Generated runtime schema is a string-literal module |
| [0014](0014-diagnostic-model.md) | One diagnostic model, from Phase 1 |
| [0015](0015-schema-identity.md) | Schema identity: sorted nodes and an on-demand SHA-256 |
| [0016](0016-widget-classification.md) | An input is a widget exactly when the frontend makes it one |
