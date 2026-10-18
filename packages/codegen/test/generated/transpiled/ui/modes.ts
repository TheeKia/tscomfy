// Transpiled by @tscomfy/codegen 0.1.1.
// Regenerate with: bun run generate:fixtures

import { type NodesOf, type Workflow, workflow } from "@tscomfy/core";
import { mock } from "../../basic-pipeline/index.ts";

export const prompt: Workflow<NodesOf<typeof mock>> = workflow(mock, ({ n, raw }) => {
  const [model] = n.CheckpointLoaderSimple({ ckpt_name: "model-a.safetensors" }, { id: "1" });
  n.VAELoader({ vae_name: "pixel_space" }, { id: "6", mode: "mute" });
  const kSampler = raw(
    "KSampler",
    {
      seed: 5,
      steps: 20,
      cfg: 8,
      sampler_name: "euler",
      scheduler: "normal",
      denoise: 1,
      model: model,
      latent_image: n.EmptyLatentImage({}, { id: "2" }),
    },
    { id: "7", mode: "bypass" },
  );
  const vaeDecode = raw("VAEDecode", { samples: kSampler.output(0) }, { id: "3" });
  n.SaveImage({ images: vaeDecode.output(0) }, { id: "5" });
});
