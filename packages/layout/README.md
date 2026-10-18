# @tscomfy/layout

[![npm](https://img.shields.io/npm/v/@tscomfy/layout)](https://www.npmjs.com/package/@tscomfy/layout)

Positions for the workflow files `toUi` writes, so they open in the ComfyUI frontend laid out
rather than stacked in one column. Nodes flow left to right: each sits one column right of the
rightmost node it takes an input from, ordered within its column by where its inputs come from.
Pure, with no runtime dependencies.

```sh
npm install @tscomfy/layout @tscomfy/core
```

```ts
import { stringify, toUi } from "@tscomfy/core";
import { layout } from "@tscomfy/layout";

const { workflow: file } = toUi(txt2img, { positions: layout(txt2img) });
const text = stringify(file); // drag it onto the frontend
```

`layout(workflow, spacing?)` sizes each node as `toUi` draws it (`uiNodeSizes` in core).
`spacing` is `{ column, row }`, the gaps between columns and between nodes in a column, in canvas
units; the default is `{ column: 80, row: 40 }`.

`layered(boxes, spacing?)` is the same algorithm over boxes of your own, each
`{ id, width, height, sources }`, for a layout of anything else:

```ts
import { layered } from "@tscomfy/layout";

const positions = layered([
  { id: "a", width: 200, height: 100, sources: [] },
  { id: "b", width: 200, height: 100, sources: ["a"] },
]);
// Map { "a" => [0, 0], "b" => [280, 0] }
```

## Requirements

ES2024: Node 24 or later, Bun 1.4 or later, or any runtime `@tscomfy/core` runs on.

## Documentation

[The UI format](https://github.com/TheeKia/tscomfy/blob/main/docs/guides/ui-format.md) and
[the API reference](https://github.com/TheeKia/tscomfy/blob/main/docs/api/layout.md).

## License

MIT
