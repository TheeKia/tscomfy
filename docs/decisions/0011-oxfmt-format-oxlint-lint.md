# ADR-0011: oxfmt formats, oxlint lints

Status: accepted, 2026-10-17 (revised the same day: oxfmt replaced Biome as the formatter)

## Context

Biome can lint and format. oxlint offers type-aware rules via tsgolint, built on TypeScript 7. oxfmt
is the formatter from the same toolchain as oxlint.

## Decision

oxfmt is the formatter, with import sorting on. oxlint with `--type-aware` is the only linter.
Markdown is not formatted.

## Consequences

- One toolchain (oxc) for linting and formatting.
- Biome's linter was rejected: in testing, its type inference missed cross-package floating promises,
  cross-package truthiness checks and `noUncheckedIndexedAccess` nullability; oxlint caught all of them.
- oxfmt is still 0.x and releases weekly. The version is pinned exactly; an upgrade that reformats
  code lands as its own change.
- `sortImports` sets `newlinesBetween: false`, so imports stay in one block as before.
- oxfmt sorts `package.json` keys (its default).
- Markdown is excluded: oxfmt pads table columns, which makes the wide tables in the docs hard to edit
  and turns one-cell edits into whole-table diffs.
- `unicorn/no-empty-file` is off: tsc and the tests already catch an accidentally empty module.

## Evidence

Verified with a probe file: every configured oxlint rule fires. oxfmt 0.73.0 with this config
reproduces Biome 2.5.15's output on every TypeScript file, including import order (docs/plan.md §16).
