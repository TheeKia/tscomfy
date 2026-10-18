import { type Workflow, workflow } from "@tscomfy/core";
import { local } from "./comfy/local/index.ts";
import type { Nodes } from "./comfy/local/nodes.ts";
import { type Checkpoint, encode, type Lora, loadModel, type Sampler, sample } from "./pieces.ts";

export interface HiresFixParams {
  readonly checkpoint: Checkpoint;
  readonly loras?: readonly Lora[];
  readonly prompt: string;
  readonly negative?: string;
  readonly seed: bigint;
  readonly sampler?: Sampler;
  readonly width?: number;
  readonly height?: number;
  /** How much larger the second pass is. */
  readonly scale?: number;
  /** How much the second pass may change the upscaled image, from 0 to 1. */
  readonly denoise?: number;
}

/**
 * Two passes: a first image at the base size, previewed, then the latent upscaled and sampled
 * again at a lower denoise, saved.
 */
export function hiresFix(params: HiresFixParams): Workflow<Nodes> {
  return workflow(local, ({ n }) => {
    const model = loadModel(n, params.checkpoint, params.loras ?? []);
    const conditioning = encode(n, model, params.prompt, params.negative ?? "");
    const pass = { seed: params.seed, sampler: params.sampler ?? "euler" };
    const base = sample(n, model, conditioning, {
      ...pass,
      latent: n.EmptyLatentImage({ width: params.width ?? 1024, height: params.height ?? 1024 }),
      steps: 25,
      denoise: 1,
    });
    n.PreviewImage({ images: n.VAEDecode({ samples: base, vae: model.vae }) }, { title: "Base" });
    const upscaled = n.LatentUpscaleBy({
      samples: base,
      upscale_method: "bislerp",
      scale_by: params.scale ?? 1.5,
    });
    const refined = sample(n, model, conditioning, {
      ...pass,
      latent: upscaled,
      steps: 15,
      denoise: params.denoise ?? 0.5,
    });
    n.SaveImage(
      {
        images: n.VAEDecode({ samples: refined, vae: model.vae }),
        filename_prefix: "tscomfy/hires",
      },
      { title: "Hires" },
    );
  });
}
