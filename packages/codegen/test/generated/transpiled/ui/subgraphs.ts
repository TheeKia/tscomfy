// Transpiled by @tscomfy/codegen 0.3.0.
// Regenerate with: bun run generate:fixtures

import { type NodesOf, type Workflow, workflow } from "@tscomfy/core";
import { mock } from "../../basic-pipeline/index.ts";

export const prompt: Workflow<NodesOf<typeof mock>> = workflow(mock, ({ n }) => {
  const [model, clip, vae] = n.CheckpointLoaderSimple(
    { ckpt_name: "model-a.safetensors" },
    { id: "1" },
  );
  const conditioning = n.CLIPTextEncode({ text: "promoted outer", clip }, { id: "40:31:21" });
  n.CLIPTextEncode({ text: "sibling", clip }, { id: "40:101" });
  n.CLIPTextEncode({ text: "second instance", clip }, { id: "60:31:21" });
  n.CLIPTextEncode({ text: "sibling", clip }, { id: "60:101" });
  const latent = n.KSampler(
    {
      model,
      seed: 5,
      cfg: 7,
      sampler_name: "euler",
      scheduler: "normal",
      positive: conditioning,
      negative: n.CLIPTextEncode({ text: "neg", clip }, { id: "3" }),
      latent_image: n.EmptyLatentImage({}, { id: "4" }),
    },
    { id: "5" },
  );
  n.SaveImage({ images: n.VAEDecode({ samples: latent, vae }, { id: "32" }) }, { id: "33" });
});
