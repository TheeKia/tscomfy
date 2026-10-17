// Type tests for the builder (docs/plan.md §7) over a generated schema.

import {
  type ApiPrompt,
  type Out,
  type RawNode,
  toApi,
  type Workflow,
  workflow,
} from "@tscomfy/core";
import { expectTypeOf } from "expect-type";
import { mock } from "./generated/basic-pipeline/index.ts";
import type { Nodes } from "./generated/basic-pipeline/nodes.ts";

const built = workflow(mock, ({ n, raw }) => {
  expectTypeOf(n).toEqualTypeOf<Nodes>();
  const [model, clip, vae] = n.CheckpointLoaderSimple({ ckpt_name: "model-a.safetensors" });
  // @ts-expect-error -- no such node class
  void n.NoSuchNode;

  const source = raw("SomePackNode", { "a.b": 1 });
  expectTypeOf(source).toEqualTypeOf<RawNode>();
  expectTypeOf(source.output(0)).toEqualTypeOf<Out<"*">>();
  // An untyped output fits any socket; validation checks it at runtime.
  const latent = source.output(0);
  const sampled = n.KSampler({
    model,
    positive: n.CLIPTextEncode({ clip, text: "a cat" }),
    negative: n.CLIPTextEncode({ clip, text: "" }),
    latent_image: latent,
    sampler_name: "euler",
    scheduler: "normal",
  });
  n.SaveImage({ images: n.VAEDecode({ samples: sampled, vae }) }, { title: "Result", id: "save" });
  // @ts-expect-error -- bypass and mute arrive with graph operations (§12)
  n.VAELoader({ vae_name: "pixel_space" }, { mode: "bypass" });
});

expectTypeOf(built).toEqualTypeOf<Workflow<Nodes>>();
expectTypeOf(toApi(built)).toEqualTypeOf<ApiPrompt>();
// Any workflow exports, whatever its Nodes.
expectTypeOf<Workflow<Nodes>>().toExtend<Workflow>();
