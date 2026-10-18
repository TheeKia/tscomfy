# ADR-0018: Dynamic combos are `{ option, inputs }`

Status: accepted, 2026-10-17 (recorded 2026-10-18)

## Context

A `COMFY_DYNAMICCOMBO_V3` input chooses an option, and each option adds inputs of its own, which may be dynamic combos again. The builder needs one value shape for it that the types can check and the exporter can flatten to the wire keys (`format`, `format.codec`, `format.codec.encoding`). In the real dump 189 dynamic inputs sit inside options, 111 of 608 options have no inputs, and `SaveVideo` has both a top-level `codec` and an option input `format.codec`.

## Decision

A dynamic combo's value is `{ option: "<key>", inputs: { … } }`, nested as deep as the options go, or the bare key for an option whose inputs may all be left out. The generated type is a union of one interface per option (plan §6.4).

## Consequences

- Option inputs can't collide with the node's own inputs, nor with a key named `option`: they live in their own object.
- The type is recursive, and TS 7 reports a wrong nested choice precisely (`"h265"` is not assignable to `"auto" | "av1" | "h264"`).
- The exporter flattens depth-first in the frontend's order and the importer folds the keys back by the schema; neither splits on dots.

## Alternatives

- Flattening option inputs into the node's inputs, as rvion/comfy-ts does: unsafe (`codec` vs `format.codec`), not recursive, and a combinatorial union per node.
- `{ option, ...inputs }`: shorter, but an option input named `option` would collide.

## Evidence

The real dump's shapes (plan §16, "Dump facts"); the type tests in `packages/codegen/test/encoding.test-d.ts` and the parity prompt `mocks/workflows/api/dynamic-combo.json`.
