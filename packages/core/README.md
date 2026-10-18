# @tscomfy/core

[![npm](https://img.shields.io/npm/v/@tscomfy/core)](https://www.npmjs.com/package/@tscomfy/core)

Type-safe ComfyUI workflows in TypeScript: the `/object_info` normalizer and schema model, the
workflow builder, API and UI format export and import, validation and graph operations. No
runtime dependencies; runs in Node, Bun, Deno and browsers.

```sh
npm install @tscomfy/core
npm install --save-dev @tscomfy/cli
npx tscomfy generate --url http://127.0.0.1:8188 --out src/comfy/local
```

```ts
import { stringify, toApi, workflow } from "@tscomfy/core";
import { local } from "./comfy/local/index.js"; // generated from your server

const txt2img = workflow(local, ({ n }) => {
  const [model, clip, vae] = n.CheckpointLoaderSimple({ ckpt_name: "sd_xl_base_1.0.safetensors" });
  const latent = n.KSampler({
    model,
    positive: n.CLIPTextEncode({ clip, text: "a cat in a hat" }),
    negative: n.CLIPTextEncode({ clip, text: "" }),
    latent_image: n.EmptyLatentImage({ width: 1024, height: 1024 }),
    seed: 42n,
    sampler_name: "euler",
    scheduler: "normal",
  });
  n.SaveImage({ images: n.VAEDecode({ samples: latent, vae }) });
});

const body = stringify({ prompt: toApi(txt2img) }); // POST it to /prompt
```

Needs ES2024 and `JSON.parse` source-text access (Node 24 or later, Bun 1.4 or later).
See the [guides](https://github.com/TheeKia/tscomfy/tree/main/docs/guides), starting with [getting started](https://github.com/TheeKia/tscomfy/tree/main/docs/guides/getting-started.md).

## License

MIT
