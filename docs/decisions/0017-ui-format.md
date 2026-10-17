# ADR-0017: UI import reproduces the frontend's prompt; UI export is flat

Status: accepted, 2026-10-18

## Context

A UI workflow (what the frontend saves) is not a graph of the nodes that run. It holds frontend-only
nodes (Reroute, PrimitiveNode, Note), subgraphs with promoted widget values, positional widget
values that include widgets no input owns (`control_after_generate`, the `upload` button,
dynamic-combo options) and modes. What the backend receives is what the frontend's
`graphToPrompt` builds from it, and that has quirks: a muted subgraph nested in another still sends
its interior; a PrimitiveNode wired into a promoted subgraph input loses its value; a node of a
missing class is sent without `class_type`.

## Decision

- **`importUi` means "what the frontend would queue".** `toApi(importUi(x))` is the prompt
  frontend 1.55.17 builds for `x`, key order included. This is checked against prompts captured
  from the frontend itself (`internal/fixtures/scripts/frontend.ts`), for the committed mocks and
  the local corpus.
- **Quirks are reproduced, with `W_FRONTEND_QUIRK`.** The goal is the prompt the user would
  actually get; the warning says where it is probably not what they meant.
- **Where the frontend sends garbage, we don't.** A node of a class the schema doesn't have stays
  raw, with its class, its links and its values by name (`W_IMPORTED_AS_RAW`); the backend
  rejects the frontend's version anyway. One linked to nothing (a pack's frontend-only label) is
  left out.
- **Values by name win.** `widgets_values_named` (1.55 and later) is used when present: it is
  exact even for pack widgets the schema can't predict. The frontend restores by position, but
  the two agree in every file 1.55 writes. Without names, values are read by position over the
  layout the frontend creates, and a count that doesn't fit is reported.
- **Big integers stay exact**, which is better than parity: the frontend's parser rounds them.
- **`toUi` writes a flat graph**, format 0.4 with tuple links, every slot in the frontend's order,
  controls set to `fixed` so the frontend doesn't change a seed after queueing. Subgraph
  interiors come back as plain nodes. What the format can't carry is reported
  (`W_UI_VALUE_LOST`, `W_UNKNOWN_UI_CLASS`, `W_UNSAFE_INTEGER`).
- **Layout is a separate package**, `@tscomfy/layout`, so `core` stays small: `toUi` takes
  positions, and puts nodes without one in a column.

## Consequences

- The importer must know the frontend's widget layout per input kind, which needed three schema
  fields the normalizer used to drop: `control_after_generate` (INT, FLOAT, COMBO) and the upload
  kinds of a combo.
- Pack JavaScript that changes the prompt at queue time (date substitutions, injected links,
  extra widgets) can't be reproduced from the schema. The corpus test declares such nodes in a
  local file instead of hiding them.
- Exporting subgraph definitions, legacy `proxyWidgets` and legacy group nodes are not supported.

## Evidence

Plan §11 and §16; `docs/research/ui-format.md`.
