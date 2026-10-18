import { describe, expect, test } from "bun:test";
import {
  type InputValue,
  isOutputRef,
  type Out,
  prune,
  splitOutputs,
  toApi,
  type Workflow,
  workflow,
} from "@tscomfy/core";
import { readMockObjectInfo } from "@tscomfy/fixtures";
import { ownerOf } from "../src/graph/output-ref.ts";
import { looseSchema } from "./loose.ts";

// Graph operations (docs/plan.md §12).

const basic = looseSchema(await readMockObjectInfo("basic-pipeline"));

const ids = (built: Workflow): string[] => [...built.graph.nodes.keys()];

/** The builders that made a workflow's references. */
const owners = (each: Workflow): Set<object | undefined> =>
  new Set(references(each).map((ref) => ownerOf(ref)));

/** Every output reference in a workflow's inputs. */
function references(each: Workflow): Out<string>[] {
  const found: Out<string>[] = [];
  const walk = (value: InputValue): void => {
    if (isOutputRef(value)) found.push(value);
    else if (Array.isArray(value)) value.forEach(walk);
    else if (typeof value === "object" && value !== null) Object.values(value).forEach(walk);
  };
  for (const node of each.graph.nodes.values()) Object.values(node.inputs).forEach(walk);
  return found;
}

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
  // A muted decode: kept with what it links to, so no link points to a node left out.
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
      "extraVae",
      "muted",
      "save3",
    ]);
  });

  test("exports what the original exports, less the nodes it drops", () => {
    const original = toApi(built, { validate: false });
    const pruned = toApi(prune(built), { validate: false });
    expect(Object.keys(pruned)).toEqual(
      Object.keys(original).filter((id) => !["stray", "unknown"].includes(id)),
    );
    for (const [id, node] of Object.entries(pruned)) expect(original[id]).toEqual(node);
  });

  test("returns a new, frozen workflow whose references are its own", () => {
    const pruned = prune(built);
    expect(pruned).not.toBe(built);
    expect(Object.isFrozen(pruned)).toBeTrue();
    const [owner, ...others] = owners(pruned);
    expect(others).toEqual([]);
    expect(owner).toBeDefined();
    expect(owners(built).has(owner)).toBeFalse();
    expect(() => toApi(pruned, { validate: false })).not.toThrow();
  });
});

describe("splitOutputs", () => {
  test("gives one workflow per output node that runs, each with what it needs", () => {
    expect(splitOutputs(built).map(ids)).toEqual([
      ["ckpt", "latent", "pos", "sample", "decode", "save"],
      ["ckpt", "latent", "decode2", "save2"],
      ["latent", "extraVae", "muted", "save3"],
    ]);
  });

  test("puts an output node another depends on in both", () => {
    const outputs = looseSchema(
      JSON.stringify({
        Out: {
          input: { required: {}, optional: { x: ["IMAGE"] } },
          output: ["IMAGE"],
          name: "Out",
          display_name: "Out",
          category: "t",
          python_module: "nodes",
          output_node: true,
        },
      }),
    );
    const chained = workflow(outputs, ({ n }) => {
      const first = n["Out"]!({}, { id: "a" });
      n["Out"]?.({ x: first }, { id: "b" });
    });
    expect(splitOutputs(chained).map(ids)).toEqual([["a"], ["a", "b"]]);
  });

  test("takes time in proportion to what it returns", () => {
    const many = workflow(basic, ({ n }) => {
      for (let index = 0; index < 10_000; index++) {
        n["SaveImage"]?.({ images: n["VAEDecode"]!({}) });
      }
    });
    const started = performance.now();
    expect(splitOutputs(many)).toHaveLength(10_000);
    expect(performance.now() - started).toBeLessThan(2_000);
  });
});
