import { describe, expect, test } from "bun:test";
import { prune, splitOutputs, toApi, type Workflow, workflow } from "@tscomfy/core";
import { readMockObjectInfo } from "@tscomfy/fixtures";
import { looseSchema } from "./loose.ts";

// Graph operations (docs/plan.md §12).

const basic = looseSchema(await readMockObjectInfo("basic-pipeline"));

const ids = (built: Workflow): string[] => [...built.graph.nodes.keys()];

/** Two pipelines from one checkpoint, a stray node, and a muted branch. */
const built = workflow(basic, ({ n, raw }) => {
  const [model, clip, vae] = n["CheckpointLoaderSimple"]!(
    { ckpt_name: "model-a.safetensors" },
    { id: "ckpt" },
  );
  const latent = n["EmptyLatentImage"]!({}, { id: "latent" });
  const positive = n["CLIPTextEncode"]!({ clip, text: "a" }, { id: "pos" });
  const sampled = n["KSampler"]!(
    {
      model,
      positive,
      negative: positive,
      latent_image: latent,
      seed: 1,
      sampler_name: "euler",
      scheduler: "simple",
    },
    { id: "sample" },
  );
  n["SaveImage"]?.(
    { images: n["VAEDecode"]!({ samples: sampled, vae }, { id: "decode" }) },
    { id: "save" },
  );
  n["SaveImage"]?.(
    { images: n["VAEDecode"]!({ samples: latent, vae }, { id: "decode2" }) },
    { id: "save2" },
  );
  n["VAELoader"]?.({ vae_name: "pixel_space" }, { id: "stray" });
  raw("UnknownPack", {}, { id: "unknown" });
  // A muted decode: kept, as save3's link points to it, but its own sources aren't needed.
  const extra = n["VAELoader"]!({ vae_name: "pixel_space" }, { id: "extraVae" });
  const muted = n["VAEDecode"]!({ samples: latent, vae: extra }, { id: "muted", mode: "mute" });
  n["SaveImage"]?.({ images: muted }, { id: "save3" });
  // A bypassed output node doesn't run, so nothing is kept for it.
  n["SaveImage"]?.({ images: muted }, { id: "bypassedSave", mode: "bypass" });
});

describe("prune", () => {
  test("keeps the output nodes that run and what they need, in graph order", () => {
    expect(ids(prune(built))).toEqual([
      "ckpt",
      "latent",
      "pos",
      "sample",
      "decode",
      "save",
      "decode2",
      "save2",
      "muted",
      "save3",
    ]);
  });

  test("exports what the original exports, less the nodes it drops", () => {
    const original = toApi(built, { validate: false });
    const pruned = toApi(prune(built), { validate: false });
    expect(Object.keys(pruned)).toEqual(
      Object.keys(original).filter((id) => !["stray", "unknown", "extraVae"].includes(id)),
    );
    for (const [id, node] of Object.entries(pruned)) expect(original[id]).toEqual(node);
  });

  test("returns a new, frozen workflow whose references are its own", () => {
    const pruned = prune(built);
    expect(pruned).not.toBe(built);
    expect(Object.isFrozen(pruned)).toBeTrue();
    expect(() => toApi(pruned, { validate: false })).not.toThrow();
  });
});

describe("splitOutputs", () => {
  test("gives one workflow per output node that runs, each with what it needs", () => {
    expect(splitOutputs(built).map(ids)).toEqual([
      ["ckpt", "latent", "pos", "sample", "decode", "save"],
      ["ckpt", "latent", "decode2", "save2"],
      ["muted", "save3"],
    ]);
  });
});
