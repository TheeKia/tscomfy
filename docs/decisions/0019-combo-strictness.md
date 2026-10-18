# ADR-0019: Combos are strict, with two exceptions

Status: accepted, 2026-10-17 (recorded 2026-10-18)

## Context

Combo options in `/object_info` are often the server's files (checkpoints, LoRAs, images). Typing them as literal unions catches misspelled samplers and missing models at compile time, but ties the types to one server's state.

## Decision

Combos are literal unions of the server's options (plan §6.5), with two exceptions:
- upload and remote combos take any string besides their listed options (`Alias | (string & {})`): their options are runtime state, the files someone uploaded or a list the frontend fetches;
- empty combos (no model installed) are `string`, with `W_EMPTY_COMBO`.

Validation follows the types: a value outside an upload, remote or empty combo is a warning (`W_UNLISTED_COMBO_VALUE`), outside any other combo an error.

There is no option to loosen file combos for projects that target several servers.

## Consequences

- The types describe the server they were generated from; `tscomfy check` tells when it changed, and new uploads don't count as drift.
- A project for several servers generates one schema per server and builds each workflow against the server it runs on (ADR-0008).

## Alternatives

- `--combos loose-files`, planned early on: loosened types would compile values that validation against the generating server rejects, which breaks the soundness ordering (what compiles passes validation).
- Strings everywhere: no autocomplete and no compile-time check of the most common mistake.

## Evidence

36 to 55 empty combos in the real dump depending on installed models; the combo rows of `packages/codegen/test/encoding.test-d.ts` and `soundness.test.ts`.
