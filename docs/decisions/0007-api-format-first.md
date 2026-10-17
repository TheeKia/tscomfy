# ADR-0007: API format first, UI format later

Status: accepted, 2026-10-17

## Context

ComfyUI has two formats: the API prompt (a flat map of nodes and links) and the UI workflow (positions, groups, subgraphs, positional widget values).

## Decision

The core graph maps 1:1 to the API format, which is built first. UI-format import and export come in later phases as separate modules, with layout in its own package.

## Consequences

- UI-format quirks (widget order, virtual nodes, subgraph flattening) never shape the core model.
- Users can't round-trip UI files until Phase 8; existing UI workflows are covered by the API transpiler only once exported as API JSON.
- Phase 8 (2026-10-18) added them as planned: `core/src/ui/` reads UI workflows into the same graph, resolving what the graph doesn't hold, and `@tscomfy/layout` positions exports (ADR-0017). The core model didn't change.

## Evidence

docs/plan.md §11.
