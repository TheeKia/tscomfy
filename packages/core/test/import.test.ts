import { describe, expect, test } from "bun:test";
import {
  type Diagnostic,
  type GraphNode,
  importApi,
  isOutputRef,
  parse,
  stringify,
  toApi,
} from "@tscomfy/core";
import {
  MOCK_API_WORKFLOW_NAMES,
  type MockApiWorkflowName,
  type MockObjectInfoName,
  readMockApiWorkflow,
  readMockObjectInfo,
} from "@tscomfy/fixtures";
import { looseSchema } from "./loose.ts";

// API import (docs/plan.md §10): the exporter in reverse.

/** The mock schema each mock prompt was written for. */
const SCHEMAS: Record<MockApiWorkflowName, MockObjectInfoName> = {
  autogrow: "autogrow",
  "dynamic-combo": "dynamic-combo",
  "dynamic-group": "dynamic-group",
  lists: "combos",
  txt2img: "basic-pipeline",
  "value-widgets": "widget-types",
};

const found = (diagnostics: readonly Diagnostic[]): [string, (string | number)[]][] =>
  diagnostics.map((diagnostic) => [diagnostic.code, [...diagnostic.path]]);

async function imported(name: MockObjectInfoName, prompt: unknown) {
  const schema = looseSchema(await readMockObjectInfo(name));
  return importApi(JSON.stringify(prompt), schema);
}

function nodes(result: {
  readonly workflow: { readonly graph: { readonly nodes: ReadonlyMap<string, GraphNode> } };
}): GraphNode[] {
  return [...result.workflow.graph.nodes.values()];
}

describe("round trip", () => {
  test.each(MOCK_API_WORKFLOW_NAMES)("%s re-exports byte for byte", async (name) => {
    const text = await readMockApiWorkflow(name);
    const schema = looseSchema(await readMockObjectInfo(SCHEMAS[name]));
    const { workflow, diagnostics } = importApi(text, schema);
    expect(diagnostics).toEqual([]);
    expect(stringify(toApi(workflow, { validate: false }))).toBe(
      stringify(parse(text).value ?? null),
    );
  });
});

describe("importApi", () => {
  test("folds wire keys back into structured inputs, links into references", async () => {
    const result = await imported("dynamic-combo", {
      "1": { class_type: "MockVideoSource", inputs: {} },
      "2": {
        class_type: "MockDynamicComboNested",
        inputs: {
          format: "mp4",
          "format.codec": "h264",
          "format.codec.encoding": "custom",
          "format.codec.encoding.crf": 20,
          video: ["1", 0],
        },
        _meta: { title: "Encode" },
      },
    });
    expect(result.diagnostics).toEqual([]);
    const [source, encode] = nodes(result);
    expect(source).toMatchObject({ id: "1", classType: "MockVideoSource", raw: true });
    expect(encode).toMatchObject({ id: "2", title: "Encode", raw: false });
    const { video, format } = encode?.inputs ?? {};
    expect(isOutputRef(video)).toBeTrue();
    expect(video).toMatchObject({ node: "1", slot: 0 });
    expect(format).toEqual({
      option: "mp4",
      inputs: {
        codec: { option: "h264", inputs: { encoding: { option: "custom", inputs: { crf: 20 } } } },
      },
    });
  });

  test("keeps a title only when it isn't the display name the exporter would write", async () => {
    const result = await imported("basic-pipeline", {
      "1": {
        class_type: "VAELoader",
        inputs: { vae_name: "pixel_space" },
        _meta: { title: "Load VAE" },
      },
      "2": {
        class_type: "VAELoader",
        inputs: { vae_name: "pixel_space" },
        _meta: { title: "Mine" },
      },
    });
    expect(nodes(result).map((node) => node.title)).toEqual([undefined, "Mine"]);
  });

  test("reads Autogrow slots as a list from the first, by name otherwise", async () => {
    const result = await imported("autogrow", {
      a: {
        class_type: "MockAutogrowPrefix",
        inputs: { "images.image0": ["s", 0], "images.image1": ["s", 0] },
      },
      b: { class_type: "MockAutogrowPrefix", inputs: { "images.image1": ["s", 0] } },
      c: { class_type: "MockAutogrowNames", inputs: { expression: "a", "values.b": ["s", 0] } },
    });
    const [a, b, c] = nodes(result);
    expect(Array.isArray(a?.inputs["images"])).toBeTrue();
    expect(Object.keys(b?.inputs["images"] ?? {})).toEqual(["image1"]);
    expect(Object.keys(c?.inputs["values"] ?? {})).toEqual(["b"]);
  });

  test("keeps nodes whose keys don't fold back as raw nodes, so they export as they came", async () => {
    const prompt = {
      gap: {
        class_type: "MockDynamicGroupOptional",
        inputs: { text: "", "replacements.1.find": "a", "replacements.1.replace": "b" },
      },
    };
    const result = await imported("dynamic-group", prompt);
    expect(found(result.diagnostics)).toEqual([["W_IMPORTED_AS_RAW", ["gap"]]]);
    expect(nodes(result)[0]?.raw).toBeTrue();
    expect(toApi(result.workflow, { validate: false, meta: false })).toEqual(prompt);
  });

  test("unwraps lists and CURVE values the exporter wraps", async () => {
    const result = await imported("widget-types", {
      "1": {
        class_type: "MockValueWidgets",
        inputs: {
          compare: { __value__: ["a.png", "b.png"] },
          curve_value: { __type__: "CURVE", __value__: [[0, 0]] },
        },
      },
    });
    expect(nodes(result)[0]?.inputs).toMatchObject({
      compare: ["a.png", "b.png"],
      curve_value: [[0, 0]],
    });
  });

  const failures: [string, string, [string, (string | number)[]][]][] = [
    ["not JSON", "{", [["E_INVALID_JSON", []]]],
    ["not an object", "[1]", [["E_INVALID_PROMPT", []]]],
    ["a node that isn't an object", '{"1": 2}', [["E_INVALID_PROMPT", ["1"]]]],
    [
      "a node without a class",
      '{"1": {"inputs": {}}}',
      [["E_INVALID_PROMPT", ["1", "class_type"]]],
    ],
    [
      "inputs that aren't an object",
      '{"1": {"class_type": "X", "inputs": 1}}',
      [["E_INVALID_PROMPT", ["1", "inputs"]]],
    ],
    [
      "a list that isn't a link",
      '{"1": {"class_type": "X", "inputs": {"a": [1, 2]}}}',
      [["E_INVALID_LINK", ["1", "inputs", "a"]]],
    ],
  ];
  test.each(failures)("reports %s", async (_name, text, expected) => {
    const schema = looseSchema(await readMockObjectInfo("basic-pipeline"));
    expect(found(importApi(text, schema).diagnostics)).toEqual(expected);
  });

  test("keeps big integers exact", async () => {
    const schema = looseSchema(await readMockObjectInfo("basic-pipeline"));
    const text = '{"1": {"class_type": "MockSeed", "inputs": {"seed": 18446744073709551615}}}';
    expect(nodes(importApi(text, schema))[0]?.inputs["seed"]).toBe(18446744073709551615n);
  });
});
