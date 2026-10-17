# ADR-0010: Lossless integers

Status: accepted, 2026-10-17

## Context

Seeds go up to 2^64-1 and 102 INT inputs in a real dump have `max` beyond 2^53, which JavaScript numbers can't represent exactly.

## Decision

INT values accept `number | bigint`. Our own deterministic serializer writes bigint as a JSON number. Parsing uses `JSON.parse` source-text access to keep big integers exact; where a runtime lacks it, ints above 2^53 produce a `W_PRECISION_LOSS` diagnostic.

## Consequences

- No dependency for big-number JSON.
- `toApi()` may return objects holding bigint; `stringify()` is the way to serialize them.

## Evidence

Verified in Bun 1.4.3 and Node 26.
