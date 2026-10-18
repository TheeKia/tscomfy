# @tscomfy/codegen

[![npm](https://img.shields.io/npm/v/@tscomfy/codegen)](https://www.npmjs.com/package/@tscomfy/codegen)

The code generator behind `tscomfy generate` and `tscomfy transpile`, for running them from
your own code: a build step, a service that generates types for whichever server it is pointed
at, a tool that converts workflows. Most projects only need
[`@tscomfy/cli`](https://www.npmjs.com/package/@tscomfy/cli). Pure: it returns files as data and
never touches the file system.

```sh
npm install @tscomfy/codegen @tscomfy/core
```

## Generating types

```ts
import { generate } from "@tscomfy/codegen";
import { normalizeObjectInfo } from "@tscomfy/core";

const response = await fetch("http://127.0.0.1:8188/object_info");
const { schema } = normalizeObjectInfo(await response.text());
const { files, diagnostics } = generate(schema, { exportName: "local" });
// files: [{ path: "nodes.ts", contents }, { path: "index.ts", contents }]
```

`nodes.ts` holds the types, `index.ts` the schema `workflow` takes. The diagnostics are
`W_EMPTY_COMBO` (a combo with no options, such as a loader with no models installed, typed as
`string`) and `W_UNTYPED_INPUT` (an input the normalizer couldn't interpret, typed as `unknown`).
The same schema always gives the same bytes.

| Option | What |
|---|---|
| `exportName` | The constant `index.ts` exports. `exportNameProblem(name)` says why a name is refused, or returns `undefined` |
| `importExtension` | How `index.ts` imports `nodes.ts`: `".js"` (default) for `tsc` and bundlers, `".ts"` to run the sources directly |
| `command` | The command that regenerates the files, recorded in their headers |

`tscomfy generate` also writes the response and a manifest next to these, for `tscomfy check`.

## Transpiling a workflow

```ts
import { transpile } from "@tscomfy/codegen";
import { importUi } from "@tscomfy/core";
import { local } from "./comfy/local/index.js";

const { workflow } = importUi(savedFileText, local);
const { code, diagnostics } = transpile(workflow, {
  name: "portrait",
  schemaModule: "./comfy/local/index.js",
  schemaName: "local",
});
```

`code` is a module exporting `portrait`, built with the generated types and formatted as oxfmt
formats it. Running it and exporting with `toApi` gives the same prompt as `toApi(workflow)`. A
node the types can't express is written as `raw(…)` and reported as `W_TRANSPILED_AS_RAW`.

| Option | What |
|---|---|
| `name` | The exported constant |
| `schemaModule`, `schemaName` | Where the generated schema is imported from, and its export |
| `inline` | Write a node used once inline at its use. Default `true` |
| `header` | Extra comment lines at the top |

`transpileNameProblem(options)` checks `name` and `schemaName` before you call it.

## Requirements

ES2024: Node 24 or later, Bun 1.4 or later, or any runtime `@tscomfy/core` runs on.

## Documentation

[Importing and transpiling](https://github.com/TheeKia/tscomfy/blob/main/docs/guides/import-and-transpile.md),
[schemas at runtime](https://github.com/TheeKia/tscomfy/blob/main/docs/guides/runtime-schemas.md),
and [the API reference](https://github.com/TheeKia/tscomfy/blob/main/docs/api/codegen.md).

## License

MIT
