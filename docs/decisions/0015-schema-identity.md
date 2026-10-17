# ADR-0015: Schema identity

Status: accepted, 2026-10-17

## Context

Generated files carry a schema hash in their header, and `tscomfy check` needs a fast way to tell whether a server's schema changed. The plan had a `source.hash` field with no algorithm and no defined input. `core` is runtime-agnostic and has no dependencies, so `node:crypto` is out, and `crypto.subtle` is async. The server lists nodes in its load order, which this project doesn't control.

## Decision

- The normalizer sorts `Schema.nodes` by class type in UTF-16 code-unit order (not `localeCompare`, whose order depends on the process locale: Node under `LANG=sv_SE` sorts `z` before `ä`, Bun doesn't). Inputs keep the frontend's order and combo options the server's, because those orders carry meaning. JavaScript still enumerates integer-like keys (a class named `"10"`) first, in numeric order; that is deterministic too, and `stringify` follows the same rule.
- `hashSchema(schema): string` returns `sha256:<hex>` over the UTF-8 bytes of `stringify({ formatVersion, nodes })`. It is synchronous and uses a small hand-written SHA-256.
- The hash isn't stored in `Schema`. Codegen computes it for file headers and the CLI for `check`. `Schema.comfyVersion` stays as plain metadata and isn't hashed.

## Consequences

- Same nodes, same hash: whitespace, key order, node load order and a ComfyUI upgrade that changes no node don't count as drift. Anything that changes generated output (tooltips, combo options, bounds) does.
- `normalizeObjectInfo` stays cheap and synchronous for runtime users who never need a hash.
- The normalizer must build objects in a fixed field order, because `stringify` keeps insertion order.
- About 60 lines of SHA-256 to maintain, tested against published vectors and `Bun.CryptoHasher`.

## Alternatives

- Hashing the raw `/object_info` text: changes with whitespace and node load order.
- `crypto.subtle.digest`: standard and fast, but async, which would make codegen async.
- FNV-1a or another small non-cryptographic hash: enough for identity, but nonstandard and harder to check with external tools.

## Evidence

Hand-written SHA-256: 62 ms on the 3.4 MB dump in Bun 1.4.3, matching `Bun.CryptoHasher` (plan §16).
