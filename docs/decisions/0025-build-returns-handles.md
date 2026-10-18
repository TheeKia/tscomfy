# ADR-0025: The build function may return handles

Status: accepted, 2026-10-18

## Context

`workflow(schema, build)` calls `build` and returns a frozen `Workflow`; `build` returns `void`.
A node's handle, such as a `SaveImage` node's, exists only inside `build`. To find that node's
outputs after a run, a user either assigns the handle to a variable outside `build` or gives the
node an explicit id and repeats it as a string. Both are awkward, and the string loses the link
to the node.

ComfyScript's runtime shows the better shape: results are looked up by the builder's own output
reference (docs/research/comfyui-execution.md §9).

## Decision

1. **`build` may return a value.** `workflow<N, H>(schema, build: (context) => H)` returns a
   `Workflow<N, H>` whose `handles` property holds what `build` returned, usually an object of
   node handles: `return { save, preview }`.
2. **The type parameter defaults to `unknown`.** `Workflow<N>` means "a workflow with any
   handles", so every existing signature that takes a `Workflow<N>` (`toApi`, `prune`, user
   helpers) accepts every workflow, with or without handles. A `build` that returns nothing gives
   `Workflow<N, void>` and `handles: undefined` at runtime. A default of `undefined` was rejected:
   a workflow with handles would then no longer fit `Workflow<N>`, breaking those signatures.
3. **Operations keep handles.** Operations that derive a workflow from another keep its handles,
   since they keep node ids.
4. **Importers give `undefined`.** `importApi` and `importUi` return workflows with
   `handles: undefined`.
5. **Handles aren't checked.** The value is kept as returned. A handle of a node that an
   operation removed stays valid as a value and simply finds no outputs.

## Consequences

- `@tscomfy/client` looks outputs up by handle (`outputFiles(outcome, wf.handles.save)`). A
  workflow function such as the examples' `txt2img` can hand its interesting nodes to callers
  without a second return value.
- `Workflow` gains a type parameter and a property. The change shows in `docs/api/core.md`. The
  transpiler's output, which names `Workflow<NodesOf<…>>` for a `build` that returns nothing, is
  unaffected.
- A thenable return value is still refused, as before: an async `build` would add nodes too late.

## Alternatives

- **A separate function returning `{ workflow, handles }`.** It gives two ways to build the same
  thing, and the handles get separated from the workflow they belong to.
- **Look outputs up by title or class type.** Titles are optional and not unique; class types
  repeat. Both lose the compile-time link.
- **Change nothing.** The client still accepts a handle or a node id. This ADR only removes the
  need to capture handles outside `build`.

## Evidence

Before this change, `packages/core/src/graph/workflow.ts`: `workflow` returned
`Object.freeze({ schema, graph })`, and `build` returned `void`.
