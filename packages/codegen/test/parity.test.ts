import { describe, expect, test } from "bun:test";
import { parse, stringify, toApi, validate, type Workflow, workflow } from "@tscomfy/core";
import {
  MOCK_API_WORKFLOW_NAMES,
  type MockApiWorkflowName,
  readMockApiWorkflow,
} from "@tscomfy/fixtures";
import { mock as autogrowSchema } from "./generated/autogrow/index.ts";
import { mock as basicSchema } from "./generated/basic-pipeline/index.ts";
import { mock as combosSchema } from "./generated/combos/index.ts";
import { mock as dynamicComboSchema } from "./generated/dynamic-combo/index.ts";
import { mock as dynamicGroupSchema } from "./generated/dynamic-group/index.ts";
import { mock as widgetTypesSchema } from "./generated/widget-types/index.ts";

// Parity with the ComfyUI frontend (docs/plan.md §7.4): each workflow, built with the generated
// types, must export byte for byte to the committed prompt the frontend would send for the same
// graph. The expected prompts are hand-written from the frontend rules, not produced by toApi.

const WORKFLOWS: Record<MockApiWorkflowName, () => Workflow> = {
  // A txt2img graph shaped like a real frontend export: a seed node feeding the sampler's seed
  // widget, defaults filled in, a title override.
  txt2img: () =>
    workflow(basicSchema, ({ n }) => {
      const [model, clip, vae] = n.CheckpointLoaderSimple({ ckpt_name: "model-b.safetensors" });
      const seed = n.MockSeed({ seed: 18446744073709551615n });
      const positive = n.CLIPTextEncode({ clip, text: "a cat" });
      const negative = n.CLIPTextEncode({ clip, text: "" });
      const latent = n.EmptyLatentImage({ width: 1024 });
      const sampled = n.KSampler({
        latent_image: latent,
        negative,
        positive,
        model,
        seed,
        sampler_name: "euler",
        scheduler: "karras",
      });
      n.SaveImage({ images: n.VAEDecode({ samples: sampled, vae }) }, { title: "Result" });
    }),
  // Nested options flattened depth-first, option defaults, bare keys, option sockets last.
  "dynamic-combo": () =>
    workflow(dynamicComboSchema, ({ n, raw }) => {
      const video = raw("MockVideoSource", { file: "clip.mp4" }).output(0);
      const image = raw("MockImageSource").output(0);
      const audio = raw("MockAudioSource").output(0);
      n.MockDynamicComboNested({
        video,
        format: {
          option: "mp4",
          inputs: { codec: { option: "h264", inputs: { encoding: { option: "custom" } } } },
        },
      });
      n.MockDynamicComboSimple({ image, mode: "keep" });
      n.MockDynamicComboSimple({
        image,
        mode: { option: "scale dimensions", inputs: { width: 768 } },
      });
      n.MockDynamicComboMixed({
        model: { option: "Model [pro]", inputs: { prompt: "a cat", images: { image_1: image } } },
      });
      n.MockDynamicComboOptional({ audio });
      n.MockDynamicComboOptional({ audio, format: "flac" });
    }),
  // Only given slots are sent, at their slot names.
  autogrow: () =>
    workflow(autogrowSchema, ({ n, raw }) => {
      const sources = raw("MockSources");
      const grown = n.MockAutogrowPrefix({ images: [sources.output(0), sources.output(0)] });
      n.MockAutogrowPrefixOptional({ prompt: "a cat", ref_images: [grown] });
      n.MockAutogrowNames({ values: { a: sources.output(1), b: sources.output(2) } });
      n.MockAutogrowMatchType({ values: [grown, sources.output(0)] });
      n.MockAutogrowOptionalTemplate({});
    }),
  // Rows flattened to group.<row>.<field>, with row defaults filled in.
  "dynamic-group": () =>
    workflow(dynamicGroupSchema, ({ n, raw }) => {
      const model = raw("MockModelSource").output(0);
      n.MockDynamicGroup({
        model,
        loras: [
          { lora_name: "lora-a.safetensors" },
          { lora_name: "lora-b.safetensors", strength: 0.5, enabled: false },
        ],
      });
      n.MockDynamicGroupOptional({ text: "hello", replacements: [{ find: "l" }] });
      n.MockDynamicGroupOptionalMin({ rows: [{}] });
    }),
  // JSON-valued widgets: lists wrapped, CURVE marked, display-only widgets never sent.
  "value-widgets": () =>
    workflow(widgetTypesSchema, ({ n, raw }) => {
      const state = raw("MockStateSource").output(0);
      n.MockValueWidgets({ compare: ["before.png", "after.png"] });
      n.MockWidgetTypeOverrides({ custom: state });
    }),
  // Multi-selects start empty; a raw node's inputs pass through, lists wrapped.
  lists: () =>
    workflow(combosSchema, ({ n, raw }) => {
      n.MockComboMultiselect({ tags: ["red", "blue"] });
      n.MockComboMultiselect();
      n.MockComboBoolean({ mode: "auto" });
      raw("MockRawLists", { values: [1, 2, 3], label: "raw" });
    }),
};

describe("frontend parity", () => {
  test.each(MOCK_API_WORKFLOW_NAMES)("%s", async (name) => {
    const expected = parse(await readMockApiWorkflow(name));
    expect(expected.diagnostics).toEqual([]);
    expect(expected.value).toBeDefined();
    // Raw nodes of classes the mock schemas don't have make these fragments, not runnable prompts.
    const prompt = toApi(WORKFLOWS[name](), { validate: false });
    expect(stringify(prompt)).toBe(stringify(expected.value ?? null));
  });
});

describe("what compiles passes validation", () => {
  // The soundness ordering (AGENTS.md): the typed nodes of each workflow are valid; only the raw
  // nodes standing in for other packs, and the missing output node they imply, are reported.
  test.each(MOCK_API_WORKFLOW_NAMES)("%s", (name) => {
    const codes = new Set(validate(WORKFLOWS[name]()).map((diagnostic) => diagnostic.code));
    codes.delete("E_UNKNOWN_CLASS_TYPE");
    codes.delete("E_NO_OUTPUT_NODE");
    expect([...codes]).toEqual([]);
  });
});
