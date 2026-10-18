// Transpiled by @tscomfy/codegen 0.1.0.
// Regenerate with: bun run generate:fixtures

import { type NodesOf, type Workflow, workflow } from "@tscomfy/core";
import { mock } from "../../basic-pipeline/index.ts";

export const prompt: Workflow<NodesOf<typeof mock>> = workflow(mock, ({ n, raw }) => {
  const [model, clip] = n.CheckpointLoaderSimple({ ckpt_name: "model-a.safetensors" }, { id: "1" });
  n.CLIPTextEncode({ text: "promoted outer", clip }, { id: "40:31:21" });
  n.CLIPTextEncode({ text: "sibling", clip }, { id: "40:32" });
  raw(
    "KSampler",
    {
      seed: 5,
      steps: 20,
      cfg: 7,
      sampler_name: "euler",
      scheduler: "normal",
      denoise: 1,
      model: model,
      negative: n.CLIPTextEncode({ text: "neg", clip }, { id: "3" }),
      latent_image: n.EmptyLatentImage({}, { id: "4" }),
    },
    { id: "5" },
  );
});
