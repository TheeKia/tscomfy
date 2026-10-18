// Transpiled by @tscomfy/codegen 0.1.1.
// Regenerate with: bun run generate:fixtures

import { type NodesOf, type Workflow, workflow } from "@tscomfy/core";
import { mock } from "../basic-pipeline/index.ts";

export const prompt: Workflow<NodesOf<typeof mock>> = workflow(mock, ({ n }) => {
  const [model, clip, vae] = n.CheckpointLoaderSimple(
    { ckpt_name: "model-b.safetensors" },
    { id: "1" },
  );
  const latent = n.KSampler(
    {
      model,
      seed: n.MockSeed({ seed: 18446744073709551615n }, { id: "2" }),
      sampler_name: "euler",
      scheduler: "karras",
      positive: n.CLIPTextEncode({ text: "a cat", clip }, { id: "3" }),
      negative: n.CLIPTextEncode({ text: "", clip }, { id: "4" }),
      latent_image: n.EmptyLatentImage({ width: 1024 }, { id: "5" }),
    },
    { id: "6" },
  );
  n.SaveImage(
    { images: n.VAEDecode({ samples: latent, vae }, { id: "7" }) },
    { id: "8", title: "Result" },
  );
});
