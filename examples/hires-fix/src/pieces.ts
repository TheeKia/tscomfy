// Reusable pieces: plain functions that take the builder's `n` and outputs, and return outputs.

import type { Out } from "@tscomfy/core";
import type { Nodes } from "./comfy/local/nodes.ts";

type Inputs<Class extends keyof Nodes> = Parameters<Nodes[Class]>[0];

/** A checkpoint file the server has. */
export type Checkpoint = Extract<Inputs<"CheckpointLoaderSimple">["ckpt_name"], string>;
/** A LoRA file the server has. */
export type LoraName = Extract<Inputs<"LoraLoader">["lora_name"], string>;
/** A sampler the server has. */
export type Sampler = Extract<Inputs<"KSampler">["sampler_name"], string>;

/** A LoRA to apply. A disabled one stays in the graph, bypassed, so it can be switched on in the UI. */
export interface Lora {
  readonly name: LoraName;
  readonly strength: number;
  readonly enabled?: boolean;
}

/** What sampling needs from a loaded model. */
export interface Model {
  readonly model: Out<"MODEL">;
  readonly clip: Out<"CLIP">;
  readonly vae: Out<"VAE">;
}

/** A checkpoint with a stack of LoRAs applied in order. */
export function loadModel(n: Nodes, checkpoint: Checkpoint, loras: readonly Lora[]): Model {
  const [model, clip, vae] = n.CheckpointLoaderSimple({ ckpt_name: checkpoint });
  const [loraModel, loraClip] = loras.reduce<readonly [Out<"MODEL">, Out<"CLIP">]>(
    ([model, clip], lora) =>
      n.LoraLoader(
        {
          model,
          clip,
          lora_name: lora.name,
          strength_model: lora.strength,
          strength_clip: lora.strength,
        },
        { title: `LoRA ${lora.name}`, ...(lora.enabled === false ? { mode: "bypass" } : {}) },
      ),
    [model, clip],
  );
  return { model: loraModel, clip: loraClip, vae };
}

/** A positive and a negative prompt, encoded once and shared by every pass. */
export interface Conditioning {
  readonly positive: Out<"CONDITIONING">;
  readonly negative: Out<"CONDITIONING">;
}

/** Encodes the prompts with the model's text encoder. */
export function encode(n: Nodes, { clip }: Model, prompt: string, negative: string): Conditioning {
  return {
    positive: n.CLIPTextEncode({ clip, text: prompt }),
    negative: n.CLIPTextEncode({ clip, text: negative }),
  };
}

/** One sampling pass over `latent`. */
export function sample(
  n: Nodes,
  { model }: Model,
  { positive, negative }: Conditioning,
  pass: {
    readonly latent: Out<"LATENT">;
    readonly seed: bigint;
    readonly sampler: Sampler;
    readonly steps: number;
    readonly denoise: number;
  },
): Out<"LATENT"> {
  return n.KSampler({
    model,
    positive,
    negative,
    latent_image: pass.latent,
    seed: pass.seed,
    steps: pass.steps,
    denoise: pass.denoise,
    sampler_name: pass.sampler,
    scheduler: "normal",
  });
}
