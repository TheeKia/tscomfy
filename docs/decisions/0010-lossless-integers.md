# ADR-0010: Lossless integers

Status: accepted, 2026-10-17

## Context

Seeds go up to 2^64-1 and 102 INT inputs in a real dump have `max` beyond 2^53, which JavaScript numbers can't represent exactly.

## Decision

INT values accept `number | bigint`. Our own deterministic serializer writes bigint as a JSON number. Parsing uses `JSON.parse` source-text access to keep big integers exact; where a runtime lacks it, ints above 2^53 produce a `W_PRECISION_LOSS` diagnostic.

## Consequences

- No dependency for big-number JSON.
- Everything that reads JSON from outside (the normalizer, the importer) takes raw text, never a parsed value, which has already lost precision.
- The parser turns every integer literal beyond 2^53 into a bigint; each consumer decides per field (e.g. FLOAT bounds become numbers rounded inward, plan §9).
- `parse` and `stringify` came first, in Phase 1, because the normalizer needs them.
- `parse` also reads Python's `NaN`/`Infinity` and literals beyond the double range as `null` (`W_NON_FINITE_NUMBER`), so its result is always valid JSON data and one bad value can't invalidate a dump.
- Without source-text access, the normalizer moves unsafe integer bounds inward by one double.
- `toApi()` may return objects holding bigint; `stringify()` is the way to serialize them.

## Evidence

Verified in Bun 1.4.3 and Node 26. Parsing the 3.4 MB dump with source-text access takes 26 ms, vs 4 ms without, and recovers 134 bounds beyond 2^53 (plan §16).
