# @tscomfy/layout

Automatic layout for tscomfy workflows written in the ComfyUI frontend's UI format: positions
for `toUi`, in columns by dependency depth, left to right. Pure, with no runtime dependencies.

```sh
npm install @tscomfy/layout @tscomfy/core
```

```ts
import { stringify, toUi } from "@tscomfy/core";
import { layout } from "@tscomfy/layout";

const { workflow: ui } = toUi(txt2img, { positions: layout(txt2img) });
const file = stringify(ui); // opens in the ComfyUI frontend
```

Needs ES2024 (Node 24 or later, Bun 1.4 or later). See the [guides](https://github.com/TheeKia/tscomfy/tree/main/docs/guides), in particular
[the UI format](https://github.com/TheeKia/tscomfy/tree/main/docs/guides/ui-format.md).

## License

MIT
