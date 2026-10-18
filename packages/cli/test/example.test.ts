import { expect, test } from "bun:test";
import { join } from "node:path";
import {
  importUi,
  type JsonObject,
  type JsonValue,
  normalizeObjectInfo,
  parse,
  stringify,
  toApi,
  typedSchema,
} from "@tscomfy/core";
import { MOCK_OBJECT_INFO_DIR } from "@tscomfy/fixtures";
import { runExample } from "./example.ts";

// The examples end to end over the basic-pipeline mock (see example.ts).

function isJsonObject(value: JsonValue | undefined): value is JsonObject {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

test("examples/txt2img type-checks against generated types and prints its prompt", async () => {
  const { tsc, main } = await runExample(
    "txt2img",
    join(MOCK_OBJECT_INFO_DIR, "basic-pipeline.json"),
    ["a dog"],
  );
  expect(tsc).toEqual({ code: 0, stdout: "", stderr: "" });
  expect(main?.stderr).toBe("");
  expect(main?.code).toBe(0);
  const printed = parse(main?.stdout ?? "");
  expect(printed.diagnostics).toEqual([]);
  expect(printed.value).toEqual({
    prompt: {
      "1": {
        inputs: { ckpt_name: "model-a.safetensors" },
        class_type: "CheckpointLoaderSimple",
        _meta: { title: "Load Checkpoint" },
      },
      "2": {
        inputs: { text: "a dog", clip: ["1", 1] },
        class_type: "CLIPTextEncode",
        _meta: { title: "CLIP Text Encode (Prompt)" },
      },
      "3": {
        inputs: { text: "", clip: ["1", 1] },
        class_type: "CLIPTextEncode",
        _meta: { title: "CLIP Text Encode (Prompt)" },
      },
      "4": {
        inputs: { width: 1024, height: 1024, batch_size: 1 },
        class_type: "EmptyLatentImage",
        _meta: { title: "Empty Latent Image" },
      },
      "5": {
        inputs: {
          seed: 42,
          steps: 30,
          cfg: 8,
          sampler_name: "euler",
          scheduler: "normal",
          denoise: 1,
          model: ["1", 0],
          positive: ["2", 0],
          negative: ["3", 0],
          latent_image: ["4", 0],
        },
        class_type: "KSampler",
        _meta: { title: "KSampler" },
      },
      "6": {
        inputs: { samples: ["5", 0], vae: ["1", 2] },
        class_type: "VAEDecode",
        _meta: { title: "VAE Decode" },
      },
      "7": {
        inputs: { filename_prefix: "tscomfy", images: ["6", 0] },
        class_type: "SaveImage",
        _meta: { title: "Result" },
      },
    },
  });
}, 30_000);

test("examples/hires-fix builds its two passes, and a UI workflow that imports to the same prompt", async () => {
  const from = join(MOCK_OBJECT_INFO_DIR, "basic-pipeline.json");
  const { tsc, main } = await runExample("hires-fix", from, ["a fox"]);
  expect(tsc).toEqual({ code: 0, stdout: "", stderr: "" });
  expect(main?.stderr).toBe("");
  expect(main?.code).toBe(0);
  const printed = parse(main?.stdout ?? "");
  expect(printed.diagnostics).toEqual([]);
  const prompt = isJsonObject(printed.value) ? printed.value["prompt"] : undefined;
  if (!isJsonObject(prompt)) throw new Error("expected a prompt");
  const nodes = Object.entries(prompt).map(([id, node]) => {
    if (!isJsonObject(node) || !isJsonObject(node["inputs"])) throw new Error("expected a node");
    return { id, classType: node["class_type"], inputs: node["inputs"] };
  });
  expect(nodes.map((node) => node.classType)).toEqual([
    "CheckpointLoaderSimple",
    "LoraLoader",
    "CLIPTextEncode",
    "CLIPTextEncode",
    "EmptyLatentImage",
    "KSampler",
    "VAEDecode",
    "PreviewImage",
    "LatentUpscaleBy",
    "KSampler",
    "VAEDecode",
    "SaveImage",
  ]);
  // The second LoRA is bypassed: it isn't sent, and both passes take the first LoRA's model.
  // The prompts are encoded once and shared by both passes.
  const samplers = nodes.filter((node) => node.classType === "KSampler");
  expect(
    samplers.map(({ inputs }) => [inputs["model"], inputs["positive"], inputs["negative"]]),
  ).toEqual([
    [
      ["2", 0],
      ["4", 0],
      ["5", 0],
    ],
    [
      ["2", 0],
      ["4", 0],
      ["5", 0],
    ],
  ]);
  expect(samplers.map(({ inputs }) => inputs["denoise"])).toEqual([1, 0.5]);

  const ui = await runExample("hires-fix", from, ["--ui", "hires.json", "a fox"], ["hires.json"]);
  expect(ui.main?.code).toBe(0);
  const file = ui.files.get("hires.json");
  if (file === undefined) throw new Error("hires.json wasn't written");
  const schema = typedSchema(normalizeObjectInfo(await Bun.file(from).text()).schema);
  const imported = importUi(file, schema);
  expect(imported.diagnostics).toEqual([]);
  expect(stringify(toApi(imported.workflow))).toBe(stringify(prompt));
}, 60_000);
