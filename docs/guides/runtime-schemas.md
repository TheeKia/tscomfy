# Schemas at runtime

Generated types need a build step. A tool that works against whatever server it is pointed at (a
browser app, a bot, a workflow linter) can use the same machinery at runtime, without codegen:
the schema is data, and every function takes it as an argument.

## Reading `/object_info`

```ts
import { normalizeObjectInfo, typedSchema } from "@tscomfy/core";

const response = await fetch(`${server}/object_info`);
const { schema, diagnostics } = normalizeObjectInfo(await response.text());
const local = typedSchema(schema);
```

`normalizeObjectInfo` takes the response **text**: bounds and seeds beyond 2^53 only survive
tscomfy's own parser. It never throws: a node it can't read is dropped and reported, an input it
can't interpret is kept as `unknown` and reported, so one odd custom node can't break the rest.
The result is a frozen, plain `Schema` (see the `Schema` type for every field), with nodes in the
order of their class names whatever the server's load order.

`typedSchema` makes it usable where a generated schema is expected. Without generated types, the
builder's `n` has no functions; add nodes with `raw`, and everything else works as with types:

```ts
import { importUi, toApi, workflow } from "@tscomfy/core";

const built = workflow(local, ({ raw }) => {
  const image = raw("LoadImage", { image: "input.png" });
  raw("SaveImage", { images: image.output(0), filename_prefix: "copy" });
});
toApi(built); // validated against the server's schema

const { workflow: imported } = importUi(savedFile, local); // what the frontend would queue
```

Raw inputs are wire keys, so validation reports their mistakes at export instead of the compiler.

## Tooling helpers

| Function | Use |
|---|---|
| `validateApi(prompt, schema)` | Check a prompt from anywhere against a server, with the backend's rules |
| `accepts(input, output)` | Whether the backend accepts a link from an output into an input |
| `hashSchema(schema)` | A `sha256:` identity of the node definitions: equal across key order, whitespace, load order and ComfyUI version |
| `diffSchemas(before, after)` | Nodes, inputs, combo options and outputs that changed between two schemas |

`tscomfy check` is `diffSchemas` over the server and the snapshot `generate` saved.

## In a browser

The libraries use no Node, Bun or DOM API, so they bundle for the browser as they are. Two things
to know:
- The server must allow your page's origin (ComfyUI's `--enable-cors-header`) for `fetch` to
  read `/object_info`.
- Loading a generated schema module (`defineSchema`) throws on a runtime without `JSON.parse`
  source-text access, rather than round big integers silently. `parse` and the normalizer still
  work there, and report `W_PRECISION_LOSS` for each integer that may have been rounded.
