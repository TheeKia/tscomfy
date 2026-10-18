# Guides

For people using tscomfy. In reading order:

1. [Getting started](getting-started.md): generate types from your server, build a workflow,
   export it, keep the types in sync.
2. [Building workflows](building-workflows.md): node functions and their outputs, inputs and
   defaults, dynamic inputs, reusable pieces, raw nodes.
3. [Exporting and validating](export-and-validate.md): the prompt `toApi` builds, validation,
   diagnostics.
4. [Graph operations](graph-operations.md): bypass and mute, `prune`, `splitOutputs`.
5. [Importing and transpiling](import-and-transpile.md): prompts and saved workflows into
   workflows and into code.
6. [The UI format](ui-format.md): writing files the frontend opens, reading files it saved.
7. [Schemas at runtime](runtime-schemas.md): tscomfy without codegen, for tools that work against
   any server.
8. [The CLI](cli.md): every command and option of `tscomfy`.

Reference:
- The packages, each with what it exports: [core](../../packages/core),
  [cli](../../packages/cli), [layout](../../packages/layout), [codegen](../../packages/codegen).
- [Diagnostics](../diagnostics.md): every code, what it means and what happens.
- [API surface](../api/): every declaration of the published packages, with their docs.
- [Examples](../../examples/): complete projects.

How and why it is built this way: [the design](../plan.md) and its
[decision records](../decisions/README.md).
