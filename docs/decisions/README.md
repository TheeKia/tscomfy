# Architecture decision records

One short record per decision in docs/plan.md §3. Accepted 2026-10-17 unless noted; an ADR
changed later says so in its status line.

| ADR | Decision |
|---|---|
| [0001](0001-bun.md) | Bun as package manager, workspace tool, test runner and script runner (updated 2026-10-18: the CLI runs on Node too; releases publish with npm) |
| [0002](0002-typescript-7.md) | TypeScript 7 (native compiler) |
| [0003](0003-runtime-agnostic-libraries.md) | Runtime-agnostic library packages (updated 2026-10-18: the client) |
| [0004](0004-esm-unbundled-build.md) | ESM-only, unbundled build with source-first development |
| [0005](0005-zero-runtime-dependencies.md) | Zero runtime dependencies |
| [0006](0006-normalizer-in-core.md) | The object_info normalizer lives in core |
| [0007](0007-api-format-first.md) | API format first; the UI format on top |
| [0008](0008-explicit-typed-schema.md) | The schema is an explicit typed value |
| [0009](0009-branded-output-refs.md) | Output references are branded, covariant, frozen objects |
| [0010](0010-lossless-integers.md) | Lossless integers |
| [0011](0011-oxfmt-format-oxlint-lint.md) | oxfmt formats, oxlint lints |
| [0012](0012-ci.md) | CI runs the local gate and publishes releases (2026-10-18; was "no CI") |
| [0013](0013-generated-schema-module.md) | Generated runtime schema is a string-literal module |
| [0014](0014-diagnostic-model.md) | One diagnostic model |
| [0015](0015-schema-identity.md) | Schema identity: sorted nodes and an on-demand SHA-256 |
| [0016](0016-widget-classification.md) | An input is a widget exactly when the frontend makes it one |
| [0017](0017-ui-format.md) | UI import reproduces the frontend's prompt; UI export is flat (2026-10-18) |
| [0018](0018-dynamic-combo-shape.md) | Dynamic combos are `{ option, inputs }` |
| [0019](0019-combo-strictness.md) | Combos are strict, with two exceptions |
| [0020](0020-defaults-policy.md) | Fill the schema's defaults, never invent one |
| [0021](0021-validation-by-default.md) | `toApi` validates by default and throws |
| [0022](0022-api-surface-report.md) | The public API is pinned by declaration reports (2026-10-18) |
| [0023](0023-execution-client.md) | An execution client, `@tscomfy/client` (2026-10-18; revises the non-goal "executing workflows") |
| [0024](0024-job-outcomes.md) | The job record decides the outcome; events are a view (2026-10-18) |
| [0025](0025-build-returns-handles.md) | The build function may return handles (2026-10-18) |
