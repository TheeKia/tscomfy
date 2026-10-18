// Type tests for the builder (docs/plan.md §7) over a generated schema.

import { transpile, type TranspileResult } from "@tscomfy/codegen";
import {
  type ApiPrompt,
  type Diagnostic,
  exportApi,
  importApi,
  importUi,
  type NodeHandle,
  type Out,
  prune,
  type RawNode,
  splitOutputs,
  toApi,
  toUi,
  uiNodeSizes,
  validate,
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
  n.VAELoader({ vae_name: "pixel_space" }, { mode: "bypass" });
  n.VAELoader({ vae_name: "pixel_space" }, { mode: "mute" });
  // @ts-expect-error -- the frontend's other modes (always, on event, on trigger) aren't modes here
  n.VAELoader({ vae_name: "pixel_space" }, { mode: "always" });
});

// A build function that returns nothing gives no handles.
expectTypeOf(built).toEqualTypeOf<Workflow<Nodes, void>>();
expectTypeOf(built).toExtend<Workflow<Nodes>>();
expectTypeOf(toApi(built)).toEqualTypeOf<ApiPrompt>();
// Any workflow exports, whatever its Nodes.
expectTypeOf<Workflow<Nodes>>().toExtend<Workflow>();

// What the build function returns becomes `handles`, typed as returned.
const withHandles = workflow(mock, ({ n }) => {
  const [model, clip, vae] = n.CheckpointLoaderSimple({ ckpt_name: "model-a.safetensors" });
  const sampled = n.KSampler({
    model,
    positive: n.CLIPTextEncode({ clip, text: "a cat" }),
    negative: n.CLIPTextEncode({ clip, text: "" }),
    latent_image: n.EmptyLatentImage({}),
    sampler_name: "euler",
    scheduler: "normal",
  });
  const save = n.SaveImage({ images: n.VAEDecode({ samples: sampled, vae }) });
  return { save, sampled };
});
expectTypeOf(withHandles.handles).toEqualTypeOf<{
  save: NodeHandle;
  sampled: Out<"LATENT">;
}>();
// A workflow with handles fits every function that takes a workflow, and operations keep them.
expectTypeOf(withHandles).toExtend<Workflow<Nodes>>();
expectTypeOf(withHandles).toExtend<Workflow>();
expectTypeOf(toApi(withHandles)).toEqualTypeOf<ApiPrompt>();
expectTypeOf(exportApi(withHandles).prompt).toEqualTypeOf<ApiPrompt>();
expectTypeOf(validate(withHandles)).toEqualTypeOf<readonly Diagnostic[]>();
expectTypeOf(toUi(withHandles).diagnostics).toEqualTypeOf<readonly Diagnostic[]>();
expectTypeOf(uiNodeSizes(withHandles).size).toEqualTypeOf<number>();
expectTypeOf(
  transpile(withHandles, { name: "w", schemaName: "mock", schemaModule: "./mock.ts" }),
).toEqualTypeOf<TranspileResult>();
expectTypeOf(prune(withHandles)).toEqualTypeOf<typeof withHandles>();
expectTypeOf(splitOutputs(withHandles)).toEqualTypeOf<readonly (typeof withHandles)[]>();
// Imported workflows have none.
expectTypeOf(importApi("{}", mock).workflow.handles).toEqualTypeOf<undefined>();
expectTypeOf(importUi("{}", mock).workflow.handles).toEqualTypeOf<undefined>();
