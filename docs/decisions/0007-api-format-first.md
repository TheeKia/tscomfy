# ADR-0007: API format first; the UI format on top

Status: accepted, 2026-10-17; updated 2026-10-18 (the UI format was added)

## Context

ComfyUI has two formats: the API prompt (a flat map of nodes and links) and the UI workflow (positions, groups, subgraphs, positional widget values).

## Decision

The core graph maps 1:1 to the API format, which was built first. UI-format import and export are separate modules on top of the same graph (`core/src/ui/`, ADR-0017), with layout in its own package (`@tscomfy/layout`).

## Consequences

- UI-format quirks (widget order, virtual nodes, subgraph flattening) never shape the core model.
- `importUi` resolves what the graph doesn't hold (Reroutes, PrimitiveNodes, subgraphs) into the graph the frontend would queue; `toUi` writes positions only `@tscomfy/layout` or the caller supplies. Adding them in Phase 8 didn't change the core model.

## Evidence

docs/plan.md §11.
