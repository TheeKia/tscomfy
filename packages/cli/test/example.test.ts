import { expect, test } from "bun:test";
import { join } from "node:path";
import { parse } from "@tscomfy/core";
import { MOCK_OBJECT_INFO_DIR } from "@tscomfy/fixtures";
import { runExample } from "./example.ts";

// examples/txt2img end to end over the basic-pipeline mock (see example.ts).

test("examples/txt2img type-checks against generated types and prints its prompt", async () => {
  const { tsc, main } = await runExample(
    join(MOCK_OBJECT_INFO_DIR, "basic-pipeline.json"),
    "a dog",
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
