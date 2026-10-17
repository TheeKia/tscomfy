# ADR-0009: Output references are branded, covariant, frozen objects

Status: accepted, 2026-10-17

## Context

Links in API JSON are `[id, slot]` tuples, but list values are meaningful too (they are sent as `{"__value__": [...]}`), so a tuple ref would be ambiguous. Wiring mistakes must fail at compile time.

## Decision

At runtime a ref is a frozen `OutputRef` instance. At type level it is `Out<T>`, branded with a unique symbol and covariant in `T`. Socket inputs accept `Out<T | "*">`, so any-typed outputs fit everywhere.

## Consequences

- `instanceof` separates refs from values; the exporter writes them as `[id, slot]` with a string id.
- Compile-time compatibility is a subset of the backend's rule (union outputs must fit inside the input's set).

## Evidence

Verified on the real dump: every negative type test fires (docs/plan.md §16).
