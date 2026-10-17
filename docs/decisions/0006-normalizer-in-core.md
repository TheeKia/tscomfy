# ADR-0006: The object_info normalizer lives in core

Status: accepted, 2026-10-17

## Context

Apps that build workflows against a live server, for example in a browser, need to normalize `/object_info` at runtime without running codegen.

## Decision

`normalizeObjectInfo` lives in `@tscomfy/core` under `src/object-info/`. That module is the only code that knows the raw format; everything else uses the normalized `Schema`.

## Consequences

- Codegen depends only on the `Schema` model.
- A raw-format change touches one module.

## Evidence

docs/plan.md §4 and §5.
