import { describe, expect, test } from "bun:test";
import {
  type InputDef,
  type NodeDef,
  normalizeObjectInfo,
  type NormalizeResult,
  parse,
  stringify,
} from "@tscomfy/core";
import {
  MOCK_OBJECT_INFO_NAMES,
  type MockObjectInfoName,
  readMockObjectInfo,
} from "@tscomfy/fixtures";
import { isJsonObject } from "../src/json/value.ts";

async function normalizeMock(name: MockObjectInfoName): Promise<NormalizeResult> {
  return normalizeObjectInfo(await readMockObjectInfo(name));
}

async function nodeOf(mock: MockObjectInfoName, classType: string): Promise<NodeDef> {
  const node = (await normalizeMock(mock)).schema.nodes[classType];
  expect(node).toBeDefined();
  return node!;
}

function inputOf(node: NodeDef, name: string): InputDef {
  const input = node.inputs.find((candidate) => candidate.name === name);
  expect(input).toBeDefined();
  return input!;
}

describe("snapshots", () => {
  test.each(MOCK_OBJECT_INFO_NAMES)("%s", async (name) => {
    expect(await normalizeMock(name)).toMatchSnapshot();
  });
});

describe("schema", () => {
  test("sorts nodes by class type in code-unit order", async () => {
    const { schema } = await normalizeMock("names");
    expect(Object.keys(schema.nodes)).toEqual([
      "Context Big (mock-pack)",
      "Mock Node 🐍",
      "MockModelMergeBlocks",
      "MockOddInputNames",
      "TextEncodeMock1.5",
    ]);
  });

  test("doesn't depend on the server's node order", async () => {
    const text = await readMockObjectInfo("basic-pipeline");
    const root = parse(text).value;
    if (!isJsonObject(root)) throw new Error("expected an object");
    const reversed = Object.fromEntries(Object.entries(root).toReversed());
    const a = normalizeObjectInfo(text).schema;
    const b = normalizeObjectInfo(stringify(reversed)).schema;
    expect(stringify(b)).toBe(stringify(a));
  });

  test("is deterministic and deeply frozen", async () => {
    const text = await readMockObjectInfo("dynamic-combo");
    const { schema } = normalizeObjectInfo(text);
    expect(stringify(normalizeObjectInfo(text).schema)).toBe(stringify(schema));
    const node = schema.nodes["MockDynamicComboNested"]!;
    expect(Object.isFrozen(schema)).toBeTrue();
    expect(Object.isFrozen(schema.nodes)).toBeTrue();
    expect(Object.isFrozen(node.inputs[1])).toBeTrue();
    expect(Object.isFrozen(node.outputs)).toBeTrue();
  });

  test("builds every object in a fixed field order", async () => {
    // Bun's snapshots sort keys, so pin the order stringify (and so the hash, D15) sees.
    const node = await nodeOf("basic-pipeline", "KSampler");
    expect(Object.keys(node)).toEqual([
      "classType",
      "displayName",
      "category",
      "pythonModule",
      "description",
      "outputNode",
      "isInputList",
      "deprecated",
      "experimental",
      "inputs",
      "outputs",
    ]);
    expect(Object.keys(inputOf(node, "seed"))).toEqual([
      "kind",
      "name",
      "required",
      "tooltip",
      "lazy",
      "rawLink",
      "type",
      "socketless",
      "default",
      "min",
      "max",
    ]);
    expect(Object.keys(node.outputs[0]!)).toEqual(["index", "name", "type", "isList", "tooltip"]);
  });

  test("keys nodes in a null-prototype record", async () => {
    const { schema } = await normalizeMock("basic-pipeline");
    expect(Object.getPrototypeOf(schema.nodes)).toBeNull();
    expect(schema.nodes["constructor"]).toBeUndefined();
  });

  test("records the ComfyUI version only when given", async () => {
    const text = await readMockObjectInfo("basic-pipeline");
    expect(normalizeObjectInfo(text, { comfyVersion: "0.41.0" }).schema.comfyVersion).toBe(
      "0.41.0",
    );
    expect("comfyVersion" in normalizeObjectInfo(text).schema).toBeFalse();
  });

  test("reports invalid JSON and an invalid document with an empty schema", () => {
    for (const [text, code] of [
      ["{", "E_INVALID_JSON"],
      ["[1]", "E_INVALID_OBJECT_INFO"],
    ] as const) {
      const { schema, diagnostics } = normalizeObjectInfo(text);
      expect(Object.keys(schema.nodes)).toEqual([]);
      expect(diagnostics.map((diagnostic) => diagnostic.code)).toEqual([code]);
    }
  });
});

describe("nodes", () => {
  test("reads node fields", async () => {
    const node = await nodeOf("basic-pipeline", "CheckpointLoaderSimple");
    expect(node).toMatchObject({
      classType: "CheckpointLoaderSimple",
      displayName: "Load Checkpoint",
      category: "loaders",
      pythonModule: "nodes",
      description: "Loads a diffusion model checkpoint.",
      outputNode: false,
      isInputList: false,
      deprecated: false,
      experimental: false,
    });
  });

  test("drops hidden inputs", async () => {
    const node = await nodeOf("hidden", "MockHiddenInputs");
    expect(node.inputs.map((input) => input.name)).toEqual(["images"]);
  });

  test("orders inputs by input_order, required first", async () => {
    const node = await nodeOf("basic-pipeline", "KSampler");
    expect(node.inputs.map((input) => input.name)).toEqual([
      "model",
      "seed",
      "steps",
      "cfg",
      "sampler_name",
      "scheduler",
      "positive",
      "negative",
      "latent_image",
      "denoise",
    ]);
  });

  test("falls back to key order without input_order", async () => {
    const node = await nodeOf("legacy-and-flags", "MockLegacyMinimal");
    expect(node.inputs.map((input) => [input.name, input.required])).toEqual([
      ["image", true],
      ["amount", true],
      ["mask", false],
    ]);
  });

  test("keeps dotted and non-identifier input names whole", async () => {
    const merge = await nodeOf("names", "MockModelMergeBlocks");
    expect(merge.inputs.map((input) => input.name)).toContain("input_blocks.0.");
    const odd = await nodeOf("names", "MockOddInputNames");
    expect(odd.inputs.map((input) => input.name)).toEqual([
      "with space",
      "with-dash",
      "1st",
      "constructor",
    ]);
  });

  test("treats null as unset", async () => {
    const { schema, diagnostics } = await normalizeMock("nulls");
    expect(diagnostics).toEqual([]);
    const node = schema.nodes["MockNullFields"]!;
    expect(node.displayName).toBe("MockNullFields");
    expect("description" in node).toBeFalse();
    expect(inputOf(node, "strength")).not.toHaveProperty("default");
    expect(inputOf(node, "strength")).not.toHaveProperty("tooltip");
    expect(node.outputs.map((output) => output.isList)).toEqual([false, true]);
  });

  test("reads flags", async () => {
    expect(await nodeOf("legacy-and-flags", "MockDeprecated")).toMatchObject({ deprecated: true });
    expect(await nodeOf("legacy-and-flags", "MockDevOnly")).toMatchObject({ experimental: true });
    expect(await nodeOf("outputs", "MockInputList")).toMatchObject({ isInputList: true });
  });
});

describe("widgets", () => {
  test("keeps integers beyond 2^53 exact", async () => {
    const node = await nodeOf("numbers", "MockNumbers");
    expect(inputOf(node, "seed")).toMatchObject({
      kind: "int",
      min: 0,
      max: 18446744073709551615n,
      default: 0,
    });
    expect(inputOf(node, "signed")).toMatchObject({
      min: -9223372036854775808n,
      max: 9223372036854775807n,
    });
  });

  test("rounds FLOAT bounds written as huge integers inward", async () => {
    const input = inputOf(await nodeOf("numbers", "MockNumbers"), "huge_float");
    expect(input.kind).toBe("float");
    if (input.kind !== "float") return;
    expect(BigInt(input.max!)).toBeLessThanOrEqual(18446744073709551615n);
    expect(BigInt(input.min!)).toBeGreaterThanOrEqual(-18446744073709551615n);
    expect(input.max).toBe(18446744073709549568);
    expect(input.min).toBe(-18446744073709549568);
  });

  test("drops defaults outside the bounds, also after rounding", async () => {
    const { schema, diagnostics } = await normalizeMock("numbers");
    const node = schema.nodes["MockNumbers"]!;
    expect(inputOf(node, "below_min_default")).not.toHaveProperty("default");
    expect(inputOf(node, "rounded_up_default")).not.toHaveProperty("default");
    expect(
      diagnostics.map((diagnostic) => [diagnostic.code, diagnostic.path.slice(3).join("/")]),
    ).toEqual([
      ["W_INVALID_INPUT_OPTION", "below_min_default/1/default"],
      ["W_INVALID_INPUT_OPTION", "rounded_up_default/1/default"],
    ]);
  });

  test("bounds a FLOAT written beyond the double range by the largest double", async () => {
    const input = inputOf(await nodeOf("numbers", "MockNumbers"), "beyond_double");
    expect(input).toMatchObject({ min: -Number.MAX_VALUE, max: Number.MAX_VALUE, default: 0 });
  });

  test("keeps list-valued defaults", async () => {
    const node = await nodeOf("numbers", "MockNumbers");
    expect(inputOf(node, "list_default")).toMatchObject({ kind: "float", default: [1] });
    expect(inputOf(node, "int_list_default")).toMatchObject({ kind: "int", default: [1, 2, 3] });
  });

  test("reads string and boolean widgets", async () => {
    const node = await nodeOf("numbers", "MockNumbers");
    expect(inputOf(node, "text")).toMatchObject({
      kind: "string",
      multiline: true,
      dynamicPrompts: true,
      default: "",
      required: false,
    });
    expect(inputOf(node, "toggle")).toMatchObject({ kind: "boolean", default: true });
    expect(inputOf(node, "no_default_bool")).not.toHaveProperty("default");
  });

  test("makes forceInput widgets sockets", async () => {
    const node = await nodeOf("sockets", "MockSockets");
    expect(inputOf(node, "forced_int")).toEqual({
      kind: "socket",
      name: "forced_int",
      required: true,
      lazy: false,
      rawLink: false,
      type: { kind: "named", name: "INT" },
    });
    expect(inputOf(node, "socketless")).toMatchObject({ kind: "string", socketless: true });
  });

  test("treats TYPE:name as a socket type of its own", async () => {
    const input = inputOf(await nodeOf("numbers", "MockNumbers"), "typed_seed");
    expect(input).toMatchObject({ kind: "socket", type: { kind: "named", name: "INT:seed" } });
  });

  test("picks the widget by widgetType and keeps the socket type", async () => {
    const node = await nodeOf("widget-types", "MockWidgetTypeOverrides");
    expect(inputOf(node, "rate")).toMatchObject({
      kind: "float",
      type: { kind: "union", names: ["FLOAT", "INT"] },
      default: 24,
    });
    expect(inputOf(node, "file")).toMatchObject({
      kind: "string",
      type: { kind: "union", names: ["STRING", "MOCK_FILE"] },
    });
    // A primitive type decides the kind: the backend coerces by it, whatever the widget.
    expect(inputOf(node, "sketch")).toMatchObject({
      kind: "string",
      widgetType: "PAINTER",
      type: { kind: "named", name: "STRING" },
    });
    expect(inputOf(node, "count")).toMatchObject({ kind: "int", widgetType: "COMBO", default: 1 });
    expect(inputOf(node, "picker")).toMatchObject({
      kind: "combo",
      type: { kind: "named", name: "COMBO" },
      widgetType: "MOCK_PACK_PICKER",
      options: ["a", "b"],
    });
    expect(inputOf(node, "size")).toMatchObject({
      kind: "combo",
      form: "combo",
      type: { kind: "named", name: "MOCK_SIZE" },
      options: ["s", "m"],
    });
    expect(inputOf(node, "timestamp")).toMatchObject({
      kind: "string",
      widgetType: "MOCK_PACK_TIMESTAMP",
    });
    expect(inputOf(node, "custom")).toMatchObject({
      kind: "socket",
      type: { kind: "named", name: "MOCK_PACK_STATE" },
    });
  });

  test("reads core value widgets", async () => {
    const node = await nodeOf("widget-types", "MockValueWidgets");
    expect(inputOf(node, "region")).toMatchObject({
      kind: "value",
      widget: "BOUNDING_BOX",
      socketless: true,
      default: { x: 0, y: 0, width: 64, height: 64 },
    });
    expect(inputOf(node, "palette")).toMatchObject({
      kind: "value",
      widget: "COLORS",
      default: [],
    });
    expect(inputOf(node, "compare")).not.toHaveProperty("default");
    expect(inputOf(node, "curve")).toMatchObject({
      kind: "socket",
      type: { kind: "named", name: "CURVE" },
    });
    expect(inputOf(node, "preview")).toMatchObject({
      kind: "value",
      widget: "RESOLUTION_PREVIEW",
      required: false,
    });
  });
});

describe("combos", () => {
  test("unifies the legacy and COMBO forms", async () => {
    const node = await nodeOf("combos", "MockComboForms");
    expect(inputOf(node, "legacy_with_options")).toMatchObject({
      kind: "combo",
      form: "legacy",
      options: ["alpha", "beta"],
      default: "beta",
    });
    expect(inputOf(node, "v2")).toMatchObject({
      kind: "combo",
      form: "combo",
      options: ["one", "two", "three"],
      default: "two",
    });
  });

  test("keeps numeric and boolean options", async () => {
    const numeric = await nodeOf("combos", "MockComboNumeric");
    expect(inputOf(numeric, "v2_mixed")).toMatchObject({ options: ["auto", 2, 4] });
    const boolean = await nodeOf("combos", "MockComboBoolean");
    expect(inputOf(boolean, "flag")).toMatchObject({ options: [false, true], default: true });
  });

  test("drops a default that is not an option", async () => {
    const { schema, diagnostics } = await normalizeMock("combos");
    expect(inputOf(schema.nodes["MockComboBoolean"]!, "mode")).not.toHaveProperty("default");
    expect(diagnostics.map((diagnostic) => [diagnostic.code, diagnostic.path])).toEqual([
      ["W_INVALID_INPUT_OPTION", ["MockComboBoolean", "input", "required", "mode", 1, "default"]],
    ]);
  });

  test("flags upload, remote, multiselect and empty combos", async () => {
    const upload = await nodeOf("combos", "MockComboUploadRemote");
    expect(inputOf(upload, "upload")).toMatchObject({ upload: true, remote: false });
    expect(inputOf(upload, "remote")).toMatchObject({ upload: true, remote: true, options: [] });
    const multi = await nodeOf("combos", "MockComboMultiselect");
    expect(inputOf(multi, "tags")).toMatchObject({ multiselect: true, default: ["red"] });
    const empty = await nodeOf("combos", "MockComboEmpty");
    expect(empty.inputs.map((input) => input.kind === "combo" && input.options.length)).toEqual([
      0, 0,
    ]);
  });

  test("keeps a pack's widget-like custom type a socket", async () => {
    const node = await nodeOf("combos", "MockCustomWidgetType");
    expect(inputOf(node, "components")).toMatchObject({
      kind: "socket",
      type: { kind: "named", name: "MOCK_COMBO" },
    });
  });
});

describe("dynamic inputs", () => {
  test("expands Autogrow slots in both forms", async () => {
    const prefix = inputOf(await nodeOf("autogrow", "MockAutogrowPrefix"), "images");
    expect(prefix).toMatchObject({ kind: "autogrow", form: "prefix", min: 1 });
    if (prefix.kind !== "autogrow") return;
    expect(prefix.slots).toHaveLength(50);
    expect(prefix.slots.slice(0, 2)).toEqual(["image0", "image1"]);
    expect(prefix.template).toMatchObject({ kind: "socket", name: "image", required: true });

    const names = inputOf(await nodeOf("autogrow", "MockAutogrowNames"), "values");
    expect(names).toMatchObject({
      form: "names",
      slots: ["a", "b", "c", "d"],
      min: 2,
      template: { kind: "socket", type: { kind: "union", names: ["FLOAT", "INT"] } },
    });
    const optional = inputOf(await nodeOf("autogrow", "MockAutogrowOptionalTemplate"), "masks");
    expect(optional).toMatchObject({ required: false, template: { required: false } });
  });

  test("reads nested dynamic combos recursively", async () => {
    const format = inputOf(await nodeOf("dynamic-combo", "MockDynamicComboNested"), "format");
    expect(format.kind).toBe("dynamicCombo");
    if (format.kind !== "dynamicCombo") return;
    expect(format.options.map((option) => option.key)).toEqual(["auto", "mp4"]);
    const codec = format.options[1]!.inputs[0]!;
    expect(codec).toMatchObject({ kind: "dynamicCombo", name: "codec" });
    if (codec.kind !== "dynamicCombo") return;
    expect(codec.options[1]!.inputs[0]).toMatchObject({
      kind: "dynamicCombo",
      name: "encoding",
      options: [
        { key: "auto", inputs: [] },
        { key: "custom", inputs: [{ kind: "int", name: "crf", default: 23 }] },
      ],
    });
  });

  test("reads Autogrow and MatchType inside dynamic combo options", async () => {
    const model = inputOf(await nodeOf("dynamic-combo", "MockDynamicComboMixed"), "model");
    expect(model).toMatchObject({
      options: [
        {
          key: "Model [pro]",
          inputs: [{ kind: "string" }, { kind: "autogrow", form: "names", required: false }],
        },
        {
          key: "List",
          inputs: [{ kind: "matchType", templateId: "item", allowed: { kind: "any" } }],
        },
      ],
    });
  });

  test("reads dynamic groups", async () => {
    const loras = inputOf(await nodeOf("dynamic-group", "MockDynamicGroup"), "loras");
    expect(loras).toMatchObject({ kind: "dynamicGroup", min: 1, max: 20, groupName: "LoRA" });
    if (loras.kind !== "dynamicGroup") return;
    expect(loras.fields.map((field) => [field.name, field.kind])).toEqual([
      ["lora_name", "combo"],
      ["strength", "float"],
      ["enabled", "boolean"],
    ]);
    const optional = inputOf(
      await nodeOf("dynamic-group", "MockDynamicGroupOptional"),
      "replacements",
    );
    expect(optional).toMatchObject({ required: false, min: 0, max: 5 });
    expect(optional).not.toHaveProperty("groupName");
  });

  test("links MatchType outputs to their templates", async () => {
    const node = await nodeOf("match-type", "MockMatchMultiOutput");
    expect(node.outputs.map((output) => [output.type, output.matchTemplate])).toEqual([
      [{ kind: "named", name: "FLOW_CONTROL" }, undefined],
      [{ kind: "named", name: "INT" }, undefined],
      [{ kind: "any" }, "item"],
      [{ kind: "any" }, "carried"],
    ]);
    const constrained = await nodeOf("match-type", "MockMatchConstrained");
    expect(inputOf(constrained, "input")).toMatchObject({
      allowed: { kind: "union", names: ["IMAGE", "MASK"] },
    });
  });
});

describe("outputs", () => {
  test("keeps every slot, duplicates included", async () => {
    const node = await nodeOf("outputs", "MockOutputNames");
    expect(node.outputs.map((output) => [output.index, output.name])).toEqual([
      [0, "images"],
      [1, "images"],
      [2, "length"],
      [3, "id"],
      [4, "0"],
      [5, "map"],
      [6, "has space"],
    ]);
    expect(node.outputs[0]?.tooltip).toBe("First copy.");
  });

  test("reads list outputs and option-list outputs", async () => {
    expect(
      (await nodeOf("outputs", "MockListOutputs")).outputs.map((output) => output.isList),
    ).toEqual([true, false]);
    const combo = await nodeOf("combos", "MockComboOutput");
    expect(combo.outputs[0]).toMatchObject({
      name: "sampler_name",
      type: { kind: "combo", options: ["euler", "dpmpp_2m"] },
    });
  });

  test("defaults names and list flags on older servers", async () => {
    const node = await nodeOf("legacy-and-flags", "MockLegacyMinimal");
    expect(node.outputs).toEqual([
      { index: 0, name: "IMAGE", type: { kind: "named", name: "IMAGE" }, isList: false },
    ]);
  });

  test("ignores output metadata beyond the outputs", async () => {
    const node = await nodeOf("outputs", "MockExtraOutputMetadata");
    expect(node.outputs).toEqual([
      {
        index: 0,
        name: "model",
        type: { kind: "named", name: "MODEL" },
        isList: false,
        tooltip: "The patched model.",
      },
    ]);
  });
});

describe("malformed input", () => {
  test("drops unusable nodes and keeps the rest", async () => {
    const { schema } = await normalizeMock("malformed");
    expect(Object.keys(schema.nodes)).toEqual([
      "MockBadInputSpecs",
      "MockDuplicateInput",
      "MockMatchNoTemplate",
      "MockNameMismatch",
      "MockPartialOrder",
    ]);
  });

  test("keeps uninterpretable specs as unknown inputs", async () => {
    const node = await nodeOf("malformed", "MockBadInputSpecs");
    expect(node.inputs.map((input) => [input.name, input.kind])).toEqual([
      ["null_spec", "unknown"],
      ["string_spec", "unknown"],
      ["number_type", "unknown"],
      ["empty_tuple", "unknown"],
      ["options_not_object", "int"],
      ["dynamic_combo_no_options", "unknown"],
      ["autogrow_no_template", "unknown"],
      ["matchtype_no_template", "unknown"],
      ["dynamic_group_no_template", "unknown"],
      ["unknown_v3_type", "unknown"],
      ["null_options", "int"],
      ["legacy_object_option", "unknown"],
      ["autogrow_bad_max", "unknown"],
      ["dynamic_group_bad_counts", "unknown"],
      ["dynamic_combo_duplicates", "dynamicCombo"],
    ]);
    expect(inputOf(node, "unknown_v3_type")).toMatchObject({
      spec: ["COMFY_SOMETHING_NEW_V3", { anything: true }],
    });
  });

  test("keeps the first of two inputs with one name", async () => {
    const node = await nodeOf("malformed", "MockDuplicateInput");
    expect(node.inputs).toHaveLength(1);
    expect(node.inputs[0]).toMatchObject({ kind: "int", required: true });
  });

  test("treats null options as none, without a diagnostic", async () => {
    const { diagnostics } = await normalizeMock("malformed");
    const paths = diagnostics.map((diagnostic) => diagnostic.path.join("/"));
    expect(paths.some((path) => path.includes("null_options"))).toBeFalse();
  });

  test("keeps the first of duplicate dynamic-combo keys and nested inputs", async () => {
    const { schema, diagnostics } = await normalizeMock("malformed");
    const input = inputOf(schema.nodes["MockBadInputSpecs"]!, "dynamic_combo_duplicates");
    expect(input).toMatchObject({ options: [{ key: "a", inputs: [{ name: "v", kind: "int" }] }] });
    const base = ["MockBadInputSpecs", "input", "required", "dynamic_combo_duplicates", 1];
    const found = diagnostics.map((diagnostic) => [diagnostic.code, diagnostic.path]);
    expect(found).toContainEqual([
      "E_DUPLICATE_INPUT",
      [...base, "options", 0, "inputs", "optional", "v"],
    ]);
    expect(found).toContainEqual(["W_INVALID_INPUT_OPTION", [...base, "options", 1, "key"]]);
  });

  test("orders an incomplete input_order like the frontend", async () => {
    const node = await nodeOf("malformed", "MockPartialOrder");
    expect(node.inputs.map((input) => input.name)).toEqual(["a", "c", "b"]);
  });

  test("lets a MatchType output without a template connect like *", async () => {
    const { schema, diagnostics } = await normalizeMock("malformed");
    expect(schema.nodes["MockMatchNoTemplate"]?.outputs).toEqual([
      { index: 0, name: "COMFY_MATCHTYPE_V3", type: { kind: "any" }, isList: false },
    ]);
    expect(diagnostics.map((diagnostic) => [diagnostic.code, diagnostic.path])).toContainEqual([
      "W_INVALID_NODE_FIELD",
      ["MockMatchNoTemplate", "output", 0],
    ]);
  });

  test("reads Python's NaN and Infinity as unset", () => {
    const node = {
      input: {
        required: {
          x: [
            "FLOAT",
            { min: "@-Infinity", max: "@Infinity", default: "@NaN", tooltip: "NaN, Infinity" },
          ],
        },
      },
      output: [],
      name: "MockNonFinite",
      display_name: "Mock Non Finite",
      category: "mock",
      python_module: "custom_nodes.mock-pack",
      output_node: false,
    };
    const text = JSON.stringify({ MockNonFinite: node }).replaceAll(/"@(-?Infinity|NaN)"/g, "$1");
    const { schema, diagnostics } = normalizeObjectInfo(text);
    const input = inputOf(schema.nodes["MockNonFinite"]!, "x");
    expect(input).toMatchObject({ kind: "float", tooltip: "NaN, Infinity" });
    expect(input).not.toContainAnyKeys(["min", "max", "default"]);
    const spec = ["MockNonFinite", "input", "required", "x", 1];
    expect(diagnostics.map((diagnostic) => [diagnostic.code, diagnostic.path])).toEqual([
      ["W_NON_FINITE_NUMBER", [...spec, "min"]],
      ["W_NON_FINITE_NUMBER", [...spec, "max"]],
      ["W_NON_FINITE_NUMBER", [...spec, "default"]],
    ]);
  });
});
