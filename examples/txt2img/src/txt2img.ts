import { type Workflow, workflow } from "@tscomfy/core";
import { local } from "./comfy/local/index.ts";
import type { Nodes } from "./comfy/local/nodes.ts";

/** A checkpoint file the server has: the generated literal union, whatever its alias is called. */
export type Checkpoint = Extract<
  Parameters<Nodes["CheckpointLoaderSimple"]>[0]["ckpt_name"],
  string
>;

export interface Txt2ImgParams {
  readonly checkpoint: Checkpoint;
  readonly prompt: string;
  readonly negative?: string;
  readonly seed: bigint;
  readonly steps?: number;
  readonly width?: number;
  readonly height?: number;
}

/** A plain txt2img graph: checkpoint, two prompts, an empty latent, a sampler, decode, save. */
export function txt2img(params: Txt2ImgParams): Workflow<Nodes> {
  return workflow(local, ({ n }) => {
    const [model, clip, vae] = n.CheckpointLoaderSimple({ ckpt_name: params.checkpoint });
    const latent = n.KSampler({
      model,
      positive: n.CLIPTextEncode({ clip, text: params.prompt }),
      negative: n.CLIPTextEncode({ clip, text: params.negative ?? "" }),
      latent_image: n.EmptyLatentImage({
        width: params.width ?? 1024,
        height: params.height ?? 1024,
      }),
      seed: params.seed,
      steps: params.steps ?? 30,
      sampler_name: "euler",
      scheduler: "normal",
    });
    n.SaveImage(
      { images: n.VAEDecode({ samples: latent, vae }), filename_prefix: "tscomfy" },
      { title: "Result" },
    );
  });
}

/** The server's checkpoint files, in its order. */
export function checkpoints(): Checkpoint[] {
  const input = local.nodes["CheckpointLoaderSimple"]?.inputs.find(
    (each) => each.name === "ckpt_name",
  );
  const options = input?.kind === "combo" ? input.options : [];
  return options.filter((option): option is Checkpoint => typeof option === "string");
}
