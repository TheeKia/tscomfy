# @tscomfy/codegen

[![npm](https://img.shields.io/npm/v/@tscomfy/codegen)](https://www.npmjs.com/package/@tscomfy/codegen)

The code generator behind `tscomfy generate` and `tscomfy transpile`: turns a normalized
tscomfy schema into the generated node types and runtime schema module, and transpiles workflows
to builder code. Pure: it returns files as data and never touches the filesystem. Most projects
use it through [`@tscomfy/cli`](https://www.npmjs.com/package/@tscomfy/cli).

```sh
npm install @tscomfy/codegen @tscomfy/core
```

```ts
import { generate } from "@tscomfy/codegen";
import { normalizeObjectInfo } from "@tscomfy/core";

const response = await fetch("http://127.0.0.1:8188/object_info");
const { schema, diagnostics } = normalizeObjectInfo(await response.text());
const { files } = generate(schema, { exportName: "local" });
// files: [{ path: "nodes.ts", contents }, { path: "index.ts", contents }]
```

Needs ES2024 (Node 24 or later, Bun 1.4 or later). See the [guides](https://github.com/TheeKia/tscomfy/tree/main/docs/guides).

## License

MIT
