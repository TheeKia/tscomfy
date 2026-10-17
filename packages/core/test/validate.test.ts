import { describe, expect, test } from "bun:test";
import {
  type ApiPrompt,
  type Diagnostic,
  type MatchTypeInput,
  type Schema,
  exportApi,
  toApi,
  validate,
  validateApi,
  ValidationError,
  workflow,
} from "@tscomfy/core";
import { type MockObjectInfoName, readMockObjectInfo } from "@tscomfy/fixtures";
import { looseSchema } from "./loose.ts";
import { node, PIPELINE, schemaOf, validated } from "./prompts.ts";

/** A MatchType input of template `t`. */
function matchInput(name: string): MatchTypeInput {
  return {
    kind: "matchType",
    name,
    required: true,
    lazy: false,
    rawLink: false,
    templateId: "t",
    allowed: { kind: "any" },
  };
}

// Validation (docs/plan.md §8). Each case gives the exact diagnostics, as [code, path], in order.

type Found = [string, (string | number)[]];
const found = (diagnostics: readonly Diagnostic[]): Found[] =>
  diagnostics.map((diagnostic) => [diagnostic.code, [...diagnostic.path]]);

/** Diagnostics of `prompt` plus a valid pipeline, over basic-pipeline and the given mocks. */
async function check(prompt: ApiPrompt, ...names: readonly MockObjectInfoName[]): Promise<Found[]> {
  return found(await validated(prompt, ...names));
}

const basic = looseSchema(await readMockObjectInfo("basic-pipeline"));
const checkpoint = node("CheckpointLoaderSimple", { ckpt_name: "model-a.safetensors" });

describe("prompts", () => {
  test("a complete txt2img prompt is valid", async () => {
    const prompt: ApiPrompt = {
      ckpt: checkpoint,
      pos: node("CLIPTextEncode", { text: "a cat", clip: ["ckpt", 1] }),
      neg: node("CLIPTextEncode", { text: "", clip: ["ckpt", 1] }),
      sample: node("KSampler", {
        seed: 18446744073709551615n,
        steps: 20,
        cfg: 7.5,
        sampler_name: "euler",
        scheduler: "karras",
        denoise: 1,
        model: ["ckpt", 0],
        positive: ["pos", 0],
        negative: ["neg", 0],
        latent_image: ["latent", 0],
      }),
      decode: node("VAEDecode", { samples: ["sample", 0], vae: ["ckpt", 2] }),
    };
    expect(await check(prompt)).toEqual([]);
  });

  test("reports an empty prompt as having no output node, and nothing else", async () => {
    expect(found(validateApi({}, await schemaOf("basic-pipeline")))).toEqual([
      ["E_NO_OUTPUT_NODE", []],
    ]);
  });

  test("checks nothing else about a node of an unknown class, nor links from it", async () => {
    const prompt = {
      x: node("NoSuchNode", { anything: ["nowhere", 9] }),
      decode: node("VAEDecode", { samples: ["x", 5], vae: ["vae", 0] }),
    };
    expect(await check(prompt)).toEqual([["E_UNKNOWN_CLASS_TYPE", ["x", "class_type"]]]);
  });

  test("reports node by node, then the prompt as a whole", async () => {
    const prompt = {
      "1": node("VAEDecode", { samples: ["2", 0], vae: "v" }),
      "2": node("NoSuchNode"),
      "3": node("VAELoader", { vae_name: 1 }),
    };
    expect(found(validateApi(prompt, await schemaOf("basic-pipeline")))).toEqual([
      ["E_NOT_A_LINK", ["1", "inputs", "vae"]],
      ["E_UNKNOWN_CLASS_TYPE", ["2", "class_type"]],
      ["E_NOT_IN_COMBO", ["3", "inputs", "vae_name"]],
      ["E_NO_OUTPUT_NODE", []],
    ]);
  });

  test("reports nodes that aren't prompt nodes, and doesn't throw on them", async () => {
    const prompt = {
      a: null,
      b: { class_type: "VAELoader" },
      c: { class_type: 3, inputs: {} },
      d: node("VAEDecode", { samples: ["a", 0], vae: ["vae", 0] }),
    };
    // Validation also takes JSON from elsewhere, read with parse.
    const diagnostics = validateApi({ ...PIPELINE, ...prompt }, await schemaOf("basic-pipeline"));
    expect(found(diagnostics)).toEqual([
      ["E_INVALID_PROMPT", ["a"]],
      ["E_INVALID_PROMPT", ["b"]],
      ["E_INVALID_PROMPT", ["c"]],
    ]);
  });

  test("reports in prompt order, then input order", async () => {
    const prompt = {
      "1": node("VAEDecode", { extra: 1, vae: "v" }),
      "2": node("VAELoader", { vae_name: 3 }),
    };
    expect(await check(prompt)).toEqual([
      ["E_UNKNOWN_INPUT", ["1", "inputs", "extra"]],
      ["E_MISSING_INPUT", ["1", "inputs", "samples"]],
      ["E_NOT_A_LINK", ["1", "inputs", "vae"]],
      ["E_NOT_IN_COMBO", ["2", "inputs", "vae_name"]],
    ]);
  });
});

describe("links", () => {
  test.each([
    ["a one-item list", ["latent"], "E_INVALID_LINK"],
    ["a numeric node id", [1, 0], "E_INVALID_LINK"],
    ["a negative slot", ["latent", -1], "E_INVALID_LINK"],
    ["a fractional slot", ["latent", 0.5], "E_INVALID_LINK"],
    ["a missing node", ["nowhere", 0], "E_DANGLING_LINK"],
    ["a slot past the outputs", ["latent", 1], "E_DANGLING_LINK"],
    ["a node without outputs", ["out", 0], "E_DANGLING_LINK"],
    ["the wrong type", ["vae", 0], "E_TYPE_MISMATCH"],
  ])("rejects %s", async (_name, samples, code) => {
    expect(await check({ decode: node("VAEDecode", { samples, vae: ["vae", 0] }) })).toEqual([
      [code, ["decode", "inputs", "samples"]],
    ]);
  });

  test("checks links into inputs it can't read, except for their type", async () => {
    const prompt = {
      bad: node("MockBadInputSpecs", {
        null_spec: ["nowhere", 0],
        string_spec: [1, 2, 3],
        number_type: ["decode", 7],
        empty_tuple: ["vae", 0],
      }),
    };
    const diagnostics = (await check(prompt, "malformed")).filter(
      ([code]) => code !== "E_MISSING_INPUT",
    );
    expect(diagnostics).toEqual([
      ["E_DANGLING_LINK", ["bad", "inputs", "null_spec"]],
      ["E_INVALID_LINK", ["bad", "inputs", "string_spec"]],
      ["E_DANGLING_LINK", ["bad", "inputs", "number_type"]],
    ]);
  });

  test("accepts a link into a widget of the same type, and `*` either way", async () => {
    const prompt = {
      seed: node("MockSeed", { seed: 1 }),
      any: node("MockAnyPassthrough", { value: ["vae", 0] }),
      latent: node("EmptyLatentImage", { width: ["seed", 0], height: 512, batch_size: 1 }),
      decode: node("VAEDecode", { samples: ["latent", 0], vae: ["any", 0] }),
    };
    expect(await check(prompt, "sockets")).toEqual([]);
  });

  test("checks a legacy combo's link against its exact option list", async () => {
    const prompt = {
      options: node("MockComboOutput"),
      pick: node("MockComboForms", {
        legacy_bare: ["options", 0],
        legacy_with_options: "beta",
        v2: ["options", 0],
        v2_no_default: "one",
        legacy_control: "first",
      }),
    };
    expect(await check(prompt, "combos")).toEqual([
      ["E_TYPE_MISMATCH", ["pick", "inputs", "legacy_bare"]],
    ]);
  });
});

describe("values", () => {
  test.each([
    ["the maximum seed", 18446744073709551615n, []],
    ["one past it", 18446744073709551616n, ["E_OUT_OF_RANGE"]],
    ["below the minimum", -1, ["E_OUT_OF_RANGE"]],
    ["a fraction", 1.5, ["W_NON_INTEGER_VALUE"]],
    ["a fraction truncated below the minimum", -0.5, ["W_NON_INTEGER_VALUE"]],
    ["a numeric string", "5", ["E_INVALID_VALUE"]],
    ["null", null, ["E_INVALID_VALUE"]],
    ["a boolean", true, ["E_INVALID_VALUE"]],
    ["a wrapped number", { __value__: 5 }, []],
  ])("checks an INT: %s", async (_name, seed, codes) => {
    const diagnostics = await check({ seed: node("MockSeed", { seed }) });
    expect(diagnostics.map(([code]) => code)).toEqual(codes);
  });

  test("checks a fractional INT's bounds after truncating it, as the backend does", async () => {
    const latent = node("EmptyLatentImage", { width: 16.9, height: 15.9, batch_size: 1 });
    expect(await check({ latent })).toEqual([
      ["W_NON_INTEGER_VALUE", ["latent", "inputs", "width"]],
      ["W_NON_INTEGER_VALUE", ["latent", "inputs", "height"]],
      ["E_OUT_OF_RANGE", ["latent", "inputs", "height"]],
    ]);
  });

  test("truncates only inputs typed exactly INT, as the backend's int() does", async () => {
    const prompt = {
      pack: node("MockIntWidgetOnPackType", { level: 10.5, ratio: 1 }),
      exact: node("MockIntWidgetOnPackType", { level: 9.5, ratio: 100000000000000000000n }),
    };
    expect(await check(prompt, "widget-types")).toEqual([
      ["E_OUT_OF_RANGE", ["pack", "inputs", "level"]],
    ]);
  });

  test.each([
    ["in range", 4, []],
    ["above the maximum", 8.5, ["E_OUT_OF_RANGE"]],
    ["a big integer, which float() reads", 2n ** 60n, ["E_OUT_OF_RANGE"]],
    ["a string", "7", ["E_INVALID_VALUE"]],
  ])("checks a FLOAT: %s", async (_name, factor, codes) => {
    const prompt = {
      resize: node("MockDynamicComboSimple", {
        image: ["decode", 0],
        mode: "scale by",
        "mode.factor": factor,
      }),
    };
    const diagnostics = await check(prompt, "dynamic-combo");
    expect(diagnostics.map(([code]) => code)).toEqual(codes);
  });

  test("checks STRING and BOOLEAN values by type only", async () => {
    const prompt = {
      text: node("CLIPTextEncode", { text: false, clip: ["ckpt", 1] }),
      ckpt: checkpoint,
      group: node("MockDynamicGroup", {
        model: ["ckpt", 0],
        "loras.0.lora_name": "lora-a.safetensors",
        "loras.0.strength": 1,
        "loras.0.enabled": "yes",
      }),
    };
    expect(await check(prompt, "dynamic-group")).toEqual([
      ["E_INVALID_VALUE", ["text", "inputs", "text"]],
      ["E_INVALID_VALUE", ["group", "inputs", "loras.0.enabled"]],
    ]);
  });
});

describe("combos", () => {
  test("checks membership exactly, by value and type", async () => {
    const prompt = {
      numeric: node("MockComboNumeric", {
        legacy_numeric: 10,
        v2_numeric: "5",
        v2_mixed: 4,
        falsy_default: 0,
      }),
      flags: node("MockComboBoolean", { flag: 1, mode: "auto" }),
    };
    expect(await check(prompt, "combos")).toEqual([
      ["E_NOT_IN_COMBO", ["numeric", "inputs", "v2_numeric"]],
      ["E_NOT_IN_COMBO", ["flags", "inputs", "flag"]],
    ]);
  });

  test("checks each element of a multi-select, and refuses lists elsewhere", async () => {
    const prompt = {
      multi: node("MockComboMultiselect", {
        tags: { __value__: ["red", "pink"] },
        legacy_multi: "a",
        frontend_multi: { __value__: ["x"] },
      }),
    };
    expect(await check(prompt, "combos")).toEqual([
      ["E_NOT_IN_COMBO", ["multi", "inputs", "tags"]],
      ["E_INVALID_VALUE", ["multi", "inputs", "frontend_multi"]],
    ]);
  });

  test("only warns for upload, remote and empty combos, whose options are runtime state", async () => {
    const prompt = {
      upload: node("MockComboUploadRemote", { upload: "photo-1.png", remote: "x.png" }),
      empty: node("MockComboEmpty", { legacy_empty: "m.safetensors", v2_empty: { x: 1 } }),
    };
    expect(await check(prompt, "combos")).toEqual([
      ["W_UNLISTED_COMBO_VALUE", ["upload", "inputs", "remote"]],
      ["W_UNLISTED_COMBO_VALUE", ["empty", "inputs", "legacy_empty"]],
      ["E_INVALID_VALUE", ["empty", "inputs", "v2_empty"]],
    ]);
  });
});

/** One full row of MockDynamicGroup's `loras`, as wire keys. */
function row(index: string): { readonly [key: string]: string | number | boolean } {
  return {
    [`loras.${index}.lora_name`]: "lora-a.safetensors",
    [`loras.${index}.strength`]: 1,
    [`loras.${index}.enabled`]: true,
  };
}

describe("dynamic inputs", () => {
  const image = ["decode", 0] as const;

  test("requires an Autogrow's first `min` slots when its template is required", async () => {
    const prompt = {
      none: node("MockAutogrowPrefix"),
      two: node("MockAutogrowPrefix", { "images.image0": image, "images.image1": image }),
      past: node("MockAutogrowPrefix", { "images.image0": image, "images.image50": image }),
      // Optional Autogrow, required template: the backend still requires the first slot.
      optional: node("MockAutogrowOptionalRequired"),
      // Optional template: nothing is required.
      template: node("MockAutogrowOptionalTemplate"),
      names: node("MockAutogrowNames", { expression: "a", "values.a": ["seed", 0] }),
      seed: node("MockSeed", { seed: 1 }),
    };
    expect(await check(prompt, "autogrow")).toEqual([
      ["E_MISSING_INPUT", ["none", "inputs", "images.image0"]],
      ["E_UNKNOWN_INPUT", ["past", "inputs", "images.image50"]],
      ["E_MISSING_INPUT", ["optional", "inputs", "images.image0"]],
      ["E_MISSING_INPUT", ["names", "inputs", "values.b"]],
    ]);
  });

  test("expands only the chosen option of a dynamic combo", async () => {
    const prompt = {
      keep: node("MockDynamicComboSimple", { image, mode: "keep", "mode.width": 1 }),
      scale: node("MockDynamicComboSimple", { image, mode: "scale dimensions", "mode.width": 1 }),
      wrong: node("MockDynamicComboSimple", { image, mode: "stretch", "mode.width": 1 }),
      missing: node("MockDynamicComboSimple", { image }),
      typed: node("MockDynamicComboSimple", { image, mode: 2 }),
      // The backend compares the choice as it is: a link or a wrapped key drops the input.
      linked: node("MockDynamicComboSimple", { image, mode: ["any", 0], "mode.factor": "x" }),
      wrapped: node("MockDynamicComboSimple", { image, mode: { __value__: "scale by" } }),
      any: node("MockAnyPassthrough", { value: ["vae", 0] }),
    };
    expect(await check(prompt, "dynamic-combo", "sockets")).toEqual([
      ["E_UNKNOWN_INPUT", ["keep", "inputs", "mode.width"]],
      ["E_MISSING_INPUT", ["scale", "inputs", "mode.height"]],
      // The option's own keys aren't reported again.
      ["E_UNKNOWN_DYNAMIC_OPTION", ["wrong", "inputs", "mode"]],
      ["E_MISSING_INPUT", ["missing", "inputs", "mode"]],
      ["E_INVALID_VALUE", ["typed", "inputs", "mode"]],
      ["E_INVALID_VALUE", ["linked", "inputs", "mode"]],
      ["E_INVALID_VALUE", ["wrapped", "inputs", "mode"]],
    ]);
  });

  test("reads DynamicGroup keys as the backend does: rows, gaps, bounds", async () => {
    const model = ["ckpt", 0] as const;
    const prompt = {
      ckpt: checkpoint,
      gap: node("MockDynamicGroup", { model, ...row("3") }),
      none: node("MockDynamicGroup", { model }),
      bad: node("MockDynamicGroup", { model, ...row("0"), "loras.01.strength": 1, "loras.x": 1 }),
      past: node("MockDynamicGroup", { model, ...row("0"), ...row("20") }),
      partial: node("MockDynamicGroup", { model, "loras.0.lora_name": "lora-b.safetensors" }),
    };
    expect(await check(prompt, "dynamic-group")).toEqual([
      ["E_TOO_FEW_DYNAMIC_INPUTS", ["none", "inputs", "loras"]],
      ["E_UNKNOWN_INPUT", ["bad", "inputs", "loras.01.strength"]],
      ["E_UNKNOWN_INPUT", ["bad", "inputs", "loras.x"]],
      ["E_TOO_MANY_DYNAMIC_INPUTS", ["past", "inputs", "loras.20.lora_name"]],
      ["E_TOO_MANY_DYNAMIC_INPUTS", ["past", "inputs", "loras.20.strength"]],
      ["E_TOO_MANY_DYNAMIC_INPUTS", ["past", "inputs", "loras.20.enabled"]],
      ["E_MISSING_INPUT", ["partial", "inputs", "loras.0.strength"]],
      ["E_MISSING_INPUT", ["partial", "inputs", "loras.0.enabled"]],
    ]);
  });
});

describe("MatchType", () => {
  test("checks a template's allowed types", async () => {
    const prompt = {
      ok: node("MockMatchConstrained", { input: ["decode", 0], scale: 1 }),
      bad: node("MockMatchConstrained", { input: ["vae", 0], scale: 1 }),
    };
    expect(await check(prompt, "match-type")).toEqual([
      ["E_TYPE_MISMATCH", ["bad", "inputs", "input"]],
    ]);
  });

  test("follows the first declared input, as the types do", async () => {
    const prompt = {
      agree: node("MockSwitch", { switch: true, on_false: ["decode", 0], on_true: ["decode", 0] }),
      differ: node("MockSwitch", { switch: true, on_false: ["decode", 0], on_true: ["vae", 0] }),
      // The first one unlinked: the types infer nothing from it, so anything goes.
      second: node("MockSwitch", { switch: true, on_true: ["vae", 0] }),
      // Linked to `*`: the same.
      any: node("MockSwitch", { switch: true, on_false: ["pass", 0], on_true: ["vae", 0] }),
      pass: node("MockAnyPassthrough", { value: ["vae", 0] }),
      // An Autogrow: its first slot infers, the others agree.
      grow: node("MockAutogrowMatchType", {
        "values.value0": ["decode", 0],
        "values.value1": ["vae", 0],
      }),
      // The first slot `*`: anything goes.
      open: node("MockAutogrowMatchType", {
        "values.value0": ["pass", 0],
        "values.value1": ["vae", 0],
        "values.value2": ["decode", 0],
      }),
    };
    expect(await check(prompt, "match-type", "sockets", "autogrow")).toEqual([
      ["E_MATCH_TYPE_MISMATCH", ["differ", "inputs", "on_true"]],
      ["E_MATCH_TYPE_MISMATCH", ["grow", "inputs", "values.value1"]],
    ]);
  });

  test("infers from the input the types infer from, even in an option not chosen", async () => {
    // `mode.c` (option "x") infers template t; with "y" chosen, nothing does, so a and b may differ.
    const custom = await schemaOf("basic-pipeline");
    const schema = {
      ...custom,
      nodes: {
        ...custom.nodes,
        DC: {
          classType: "DC",
          displayName: "DC",
          category: "test",
          pythonModule: "nodes",
          outputNode: false,
          isInputList: false,
          deprecated: false,
          experimental: false,
          inputs: [
            {
              kind: "dynamicCombo",
              name: "mode",
              required: true,
              lazy: false,
              rawLink: false,
              options: [
                { key: "x", inputs: [matchInput("c")] },
                { key: "y", inputs: [] },
              ],
            },
            { ...matchInput("a"), required: false },
            { ...matchInput("b"), required: false },
          ],
          outputs: [],
        },
      },
    } satisfies Schema;
    const prompt = {
      ...PIPELINE,
      y: node("DC", { mode: "y", a: ["decode", 0], b: ["vae", 0] }),
      x: node("DC", { mode: "x", "mode.c": ["decode", 0], a: ["vae", 0] }),
    };
    expect(found(validateApi(prompt, schema))).toEqual([
      ["E_MATCH_TYPE_MISMATCH", ["x", "inputs", "a"]],
    ]);
  });

  test("leaves the output `*` when the inferring input is empty, as the types do", async () => {
    // ComfyUI's own switch: only on_true linked. The types give Out<"*">, which fits anywhere.
    const prompt = {
      picked: node("MockSwitch", { switch: true, on_true: ["decode", 0] }),
      out2: node("VAEDecode", { samples: ["picked", 0], vae: ["vae", 0] }),
    };
    expect(await check(prompt, "match-type")).toEqual([]);
  });

  test("resolves long MatchType chains without deep recursion", async () => {
    const chain: { [id: string]: ReturnType<typeof node> } = {};
    for (let index = 0; index < 20_000; index++) {
      chain[`s${String(index)}`] = node("MockSwitch", {
        switch: true,
        on_false: index === 19_999 ? ["latent", 0] : [`s${String(index + 1)}`, 0],
      });
    }
    chain["use"] = node("VAEDecode", { samples: ["s0", 0], vae: ["vae", 0] });
    expect(await check(chain, "match-type")).toEqual([]);
    chain["bad"] = node("SaveImage", { filename_prefix: "x", images: ["s0", 0] });
    expect(await check(chain, "match-type")).toEqual([
      ["E_TYPE_MISMATCH", ["bad", "inputs", "images"]],
    ]);
  });

  test("gives a MatchType output the type its template resolved to", async () => {
    const prompt = {
      latent: node("MockSwitch", { switch: true, on_false: ["latent0", 0] }),
      latent0: node("EmptyLatentImage", { width: 512, height: 512, batch_size: 1 }),
      chained: node("MockSwitch", { switch: true, on_false: ["latent", 0] }),
      out: node("SaveImage", { filename_prefix: "x", images: ["chained", 0] }),
    };
    expect(await check(prompt, "match-type")).toEqual([
      ["E_TYPE_MISMATCH", ["out", "inputs", "images"]],
    ]);
  });
});

describe("cycles", () => {
  test("reports each cycle once, at the node it returns to, and still terminates", async () => {
    const prompt = {
      a: node("MockSwitch", { switch: true, on_false: ["b", 0] }),
      b: node("MockSwitch", { switch: true, on_false: ["a", 0] }),
      // Two inputs on the same back edge: one cycle.
      self: node("MockSwitch", { switch: true, on_false: ["self", 0], on_true: ["self", 0] }),
    };
    const diagnostics = await validated(prompt, "match-type", "sockets");
    expect(found(diagnostics)).toEqual([
      ["E_DEPENDENCY_CYCLE", ["a"]],
      ["E_DEPENDENCY_CYCLE", ["self"]],
    ]);
    expect(diagnostics[0]?.message).toContain("a (MockSwitch) → b (MockSwitch) → a (MockSwitch)");
    expect(diagnostics[1]?.message).toContain("self (MockSwitch) → self (MockSwitch)");
  });

  test("handles long chains without deep recursion", async () => {
    const chain: { [id: string]: ReturnType<typeof node> } = {};
    for (let index = 0; index < 20_000; index++) {
      chain[`n${String(index)}`] = node("MockAnyPassthrough", {
        value: index === 0 ? ["vae", 0] : [`n${String(index - 1)}`, 0],
      });
    }
    expect(await check(chain, "sockets")).toEqual([]);
  });
});

describe("toApi", () => {
  test("throws a ValidationError with every diagnostic, and returns with validate: false", () => {
    const built = workflow(basic, ({ n, raw }) => {
      n["SaveImage"]?.({ images: raw("VAELoader", { vae_name: "nope" }).output(0) });
    });
    expect(() => toApi(built)).toThrow(ValidationError);
    expect(found(validate(built))).toEqual([
      ["E_NOT_IN_COMBO", ["1", "inputs", "vae_name"]],
      ["E_TYPE_MISMATCH", ["2", "inputs", "images"]],
    ]);
    expect(Object.keys(toApi(built, { validate: false }))).toEqual(["1", "2"]);
  });

  test("returns despite warnings, which exportApi reports", () => {
    const built = workflow(basic, ({ n }) => {
      const latent = n["EmptyLatentImage"]!({ width: 512.5 });
      const vae = n["VAELoader"]!({ vae_name: "pixel_space" });
      n["SaveImage"]?.({ images: n["VAEDecode"]!({ samples: latent, vae }) });
    });
    expect(toApi(built)["1"]?.inputs).toEqual({ width: 512.5, height: 512, batch_size: 1 });
    expect(found(exportApi(built).diagnostics)).toEqual([
      ["W_NON_INTEGER_VALUE", ["1", "inputs", "width"]],
    ]);
  });

  test("validates the prompt it sends: export diagnostics first, then validation", () => {
    const built = workflow(basic, ({ n }) => {
      n["VAELoader"]?.({ vae_name: "pixel_space" });
    });
    expect(found(validate(built))).toEqual([["E_NO_OUTPUT_NODE", []]]);
  });
});

test("reports a prompt that isn't an object", async () => {
  const schema = await schemaOf("basic-pipeline");
  for (const prompt of [null, [], "x", 1]) {
    expect(found(validateApi(prompt, schema))).toEqual([["E_INVALID_PROMPT", []]]);
  }
});
