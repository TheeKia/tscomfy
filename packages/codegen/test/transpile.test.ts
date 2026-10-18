import { describe, expect, test } from "bun:test";
import { join } from "node:path";
import { transpile, transpileNameProblem } from "@tscomfy/codegen";
import {
  typedSchema,
  importApi,
  normalizeObjectInfo,
  parse,
  stringify,
  toApi,
  type Workflow,
  workflow,
} from "@tscomfy/core";
import {
  MOCK_API_WORKFLOW_NAMES,
  MOCK_UI_WORKFLOW_NAMES,
  type MockUiWorkflowName,
  readMockApiWorkflow,
  readMockObjectInfo,
  readMockUiApiWorkflow,
} from "@tscomfy/fixtures";
import {
  TRANSPILED_DIR,
  TRANSPILED_UI_DIR,
  transpileMock,
  transpileUiMock,
} from "./generated-fixtures.ts";
import { mock as autogrow } from "./generated/autogrow/index.ts";
import { mock as basic } from "./generated/basic-pipeline/index.ts";
import { mock as combos } from "./generated/combos/index.ts";

// The transpiler (docs/plan.md §10). The committed modules in generated/transpiled/ are
// type-checked by tsc -b and format-checked by oxfmt; here they are run.

const OPTIONS = { name: "prompt", schemaModule: "./index.js", schemaName: "mock" } as const;

async function load(name: string, dir = TRANSPILED_DIR): Promise<Workflow> {
  const module: unknown = await import(join(dir, `${name}.ts`));
  const prompt: unknown =
    typeof module === "object" && module !== null ? Reflect.get(module, "prompt") : undefined;
  if (typeof prompt !== "object" || prompt === null || !("graph" in prompt)) {
    throw new Error(`${name}.ts doesn't export a workflow`);
  }
  // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- checked to be a workflow
  return prompt as Workflow;
}

describe("committed transpiled prompts", () => {
  test.each(MOCK_API_WORKFLOW_NAMES)(
    "%s is up to date (bun run generate:fixtures)",
    async (name) => {
      const { code, diagnostics } = await transpileMock(name);
      expect(diagnostics).toEqual([]);
      expect(await Bun.file(join(TRANSPILED_DIR, `${name}.ts`)).text()).toBe(code);
    },
  );

  test.each(MOCK_API_WORKFLOW_NAMES)(
    "%s runs and exports the prompt it came from",
    async (name) => {
      const expected = stringify(parse(await readMockApiWorkflow(name)).value ?? null);
      expect(stringify(toApi(await load(name), { validate: false }))).toBe(expected);
    },
  );
});

/** Nodes missing a required input (a bypassed sampler, a decoder behind a muted Reroute): raw. */
const RAW_UI_NODES: Record<MockUiWorkflowName, [string, string][]> = {
  modes: [
    ["W_TRANSPILED_AS_RAW", "7"],
    ["W_TRANSPILED_AS_RAW", "3"],
  ],
  "subgraph-modes": [["W_TRANSPILED_AS_RAW", "5"]],
  "subgraph-primitive": [],
  subgraphs: [],
  txt2img: [],
};

describe("committed transpiled UI workflows", () => {
  test.each(MOCK_UI_WORKFLOW_NAMES)(
    "%s is up to date (bun run generate:fixtures)",
    async (name) => {
      const { code, diagnostics } = await transpileUiMock(name);
      expect(diagnostics.map((diagnostic) => [diagnostic.code, diagnostic.path.join(":")])).toEqual(
        RAW_UI_NODES[name],
      );
      expect(await Bun.file(join(TRANSPILED_UI_DIR, `${name}.ts`)).text()).toBe(code);
    },
  );

  test.each(MOCK_UI_WORKFLOW_NAMES)(
    "%s runs and exports the prompt the frontend queues for it",
    async (name) => {
      const expected = stringify(parse(await readMockUiApiWorkflow(name)).value ?? null);
      expect(stringify(toApi(await load(name, TRANSPILED_UI_DIR), { validate: false }))).toBe(
        expected,
      );
    },
  );
});

function transpiled(built: Workflow, options: Partial<Parameters<typeof transpile>[1]> = {}) {
  return transpile(built, { ...OPTIONS, ...options });
}

/** A raw node definition with inputs and named IMAGE outputs. */
const nodeOf = (name: string, outputs: readonly string[], inputs: object): object => ({
  [name]: {
    input: { required: inputs },
    output: outputs.map(() => "IMAGE"),
    output_name: outputs,
    name,
    display_name: name,
    category: "test",
    python_module: "nodes",
    output_node: outputs.length === 0,
  },
});

describe("transpile", () => {
  test("inlines single-use nodes one level deep, and names the rest after their outputs", () => {
    const built = workflow(basic, ({ n }) => {
      const [model, clip, vae] = n.CheckpointLoaderSimple({ ckpt_name: "model-a.safetensors" });
      const positive = n.CLIPTextEncode({ clip, text: "a" });
      const sampled = n.KSampler({
        model,
        positive,
        negative: positive,
        latent_image: n.EmptyLatentImage({}),
        seed: 1,
        sampler_name: "euler",
        scheduler: "simple",
      });
      n.SaveImage({ images: n.VAEDecode({ samples: sampled, vae }) });
    });
    const { code: inlined } = transpiled(built);
    expect(inlined).toContain("const conditioning = n.CLIPTextEncode(");
    expect(inlined).toContain('latent_image: n.EmptyLatentImage({}, { id: "3" }),');
    expect(inlined).toContain(
      'n.SaveImage({ images: n.VAEDecode({ samples: latent, vae }, { id: "5" }) }, { id: "6" });',
    );
    const { code: flat } = transpiled(built, { inline: false });
    expect(flat).toContain('const latent = n.EmptyLatentImage({}, { id: "3" });');
    expect(flat).toContain("const latent2 = n.KSampler(");
    expect(flat).not.toContain("latent_image: n.");
  });

  test("leaves out values equal to their defaults, at every level", () => {
    const built = workflow(basic, ({ n }) => {
      n.EmptyLatentImage({ width: 512, height: 768, batch_size: 1 });
    });
    expect(transpiled(built).code).toContain('n.EmptyLatentImage({ height: 768 }, { id: "1" });');
  });

  test("writes what the types can't express as raw, with a warning", () => {
    const built = workflow(combos, ({ n, raw }) => {
      // A legacy combo linked from an option list: the backend takes it, the types take `*` only.
      const [options] = n.MockComboOutput();
      raw("MockComboForms", {
        legacy_bare: options,
        v2_no_default: "one",
        legacy_control: "first",
      });
    });
    const imported = importApi(stringify(toApi(built, { validate: false })), combos).workflow;
    const result = transpiled(imported);
    expect(result.diagnostics.map((diagnostic) => [diagnostic.code, diagnostic.path])).toEqual([
      ["W_TRANSPILED_AS_RAW", ["2"]],
    ]);
    expect(result.code).toContain('raw(\n    "MockComboForms",');
  });

  test("writes an option by its key when only inputs the types lack are required", () => {
    // The option's one input is a display-only widget: the types have no property for it, so
    // they take the option by its key alone, and so must the transpiler.
    const schema = typedSchema(
      normalizeObjectInfo(
        JSON.stringify({
          Previewed: {
            input: {
              required: {
                mode: [
                  "COMFY_DYNAMICCOMBO_V3",
                  {
                    options: [
                      {
                        key: "preview",
                        inputs: { required: { size: ["RESOLUTION_PREVIEW", {}] } },
                      },
                    ],
                  },
                ],
              },
            },
            output: [],
            name: "Previewed",
            display_name: "Previewed",
            category: "test",
            python_module: "nodes",
            output_node: true,
          },
        }),
      ).schema,
    );
    const imported = importApi(
      '{"1": {"class_type": "Previewed", "inputs": {"mode": "preview"}}}',
      schema,
    );
    const result = transpiled(imported.workflow);
    expect(result.diagnostics).toEqual([]);
    expect(result.code).toContain('n.Previewed({ mode: "preview" }, { id: "1" });');
  });

  test("claims no name for a destructuring too wide to write", () => {
    const names = [
      "a_rather_long_output_name_for_the_very_first_output_of_this_node",
      "a_rather_long_output_name_for_the_very_second_output_of_this_node",
    ];
    const schema = typedSchema(
      normalizeObjectInfo(
        JSON.stringify({
          ...nodeOf(
            "Wide",
            [...names, "a_rather_long_output_name_for_the_very_third_output_of_this_node"],
            {},
          ),
          ...nodeOf("Single", [names[0] ?? ""], {}),
          ...nodeOf("Sink", [], { a: ["IMAGE"], b: ["IMAGE"], c: ["IMAGE"], d: ["IMAGE"] }),
        }),
      ).schema,
    );
    const built = workflow(schema, ({ raw }) => {
      const wide = raw("Wide", {});
      const single = raw("Single", {});
      raw("Sink", {
        a: wide.output(0),
        b: wide.output(2),
        c: single.output(0),
        d: single.output(0),
      });
    });
    const { code } = transpiled(
      importApi(stringify(toApi(built, { validate: false })), schema).workflow,
    );
    expect(code).toContain("const wide = n.Wide(");
    expect(code).toContain(
      "const aRatherLongOutputNameForTheVeryFirstOutputOfThisNode = n.Single(",
    );
  });

  test("leaves out cycles and dangling links, and reports them", async () => {
    const schema = typedSchema(normalizeObjectInfo(await readMockObjectInfo("sockets")).schema);
    const { workflow: cyclic } = importApi(
      JSON.stringify({
        a: { class_type: "MockAnyPassthrough", inputs: { value: ["b", 0] } },
        b: { class_type: "MockAnyPassthrough", inputs: { value: ["a", 0] } },
        c: { class_type: "MockUnknownPack", inputs: { value: ["gone", 0] } },
      }),
      schema,
    );
    const result = transpiled(cyclic);
    expect(result.diagnostics.map((diagnostic) => [diagnostic.code, diagnostic.path])).toEqual([
      ["E_DEPENDENCY_CYCLE", ["a"]],
      ["E_DEPENDENCY_CYCLE", ["b"]],
      ["E_DANGLING_LINK", ["c", "inputs", "value"]],
    ]);
    expect(result.code).toContain('raw("MockUnknownPack", {}, { id: "c" });');
  });

  test.each([
    [{ name: "default" }, 'the name "default" won\'t do: JavaScript reserves it'],
    [{ schemaName: "my-schema" }, "the schema name \"my-schema\" won't do: it isn't an identifier"],
    [{ name: "mock" }, 'the name and the schema name are both "mock"'],
    [{ name: "workflow" }, 'the name "workflow" won\'t do: the generated modules declare it'],
    [{ schemaName: "NodesOf" }, 'the schema name "NodesOf" won\'t do: the generated modules'],
    [{ name: "x".repeat(57) }, "is wider than 100 columns"],
  ])("refuses options %p", (options, message) => {
    const names = { name: "prompt", schemaName: "mock", ...options };
    expect(transpileNameProblem(names)).toContain(message);
    expect(() =>
      transpiled(
        workflow(basic, () => {}),
        options,
      ),
    ).toThrow(`transpile: ${transpileNameProblem(names) ?? ""}`);
  });

  test("takes names whose declaration fits on one line", () => {
    // `export const <name>: Workflow<NodesOf<typeof mock>> =` is 47 columns besides the name.
    expect(transpileNameProblem({ name: "x".repeat(53), schemaName: "mock" })).toBeUndefined();
    expect(transpileNameProblem({ name: "x".repeat(54), schemaName: "mock" })).toBe(
      `the declaration \`export const ${"x".repeat(54)}: Workflow<NodesOf<typeof mock>> =\` is wider than 100 columns`,
    );
  });

  test("is deterministic", async () => {
    const first = await transpileMock("dynamic-group");
    expect(await transpileMock("dynamic-group")).toEqual(first);
  });
});

describe("sources written as raw", () => {
  test("type as `*` downstream, as raw(…).output() does", async () => {
    // A known class kept raw (an input the class doesn't have) feeds a constrained MatchType node:
    // its parameter falls back to the allowed types, which an IMAGE-only input can't take.
    const text = (await readMockObjectInfo("basic-pipeline")).trimEnd().slice(0, -1);
    const match = (await readMockObjectInfo("match-type")).trimStart().slice(1);
    const schema = typedSchema(normalizeObjectInfo(`${text},${match}`).schema);
    const prompt = {
      "1": { class_type: "EmptyLatentImage", inputs: { width: 512, height: 512, batch_size: 1 } },
      "2": { class_type: "VAELoader", inputs: { vae_name: "pixel_space" } },
      "3": { class_type: "VAEDecode", inputs: { samples: ["1", 0], vae: ["2", 0], extra: 5 } },
      "4": { class_type: "MockMatchConstrained", inputs: { input: ["3", 0], scale: 1 } },
      "5": { class_type: "SaveImage", inputs: { images: ["4", 0], filename_prefix: "x" } },
    };
    const result = transpiled(importApi(JSON.stringify(prompt), schema).workflow);
    expect(result.diagnostics.map((diagnostic) => [diagnostic.code, diagnostic.path])).toEqual([
      ["W_TRANSPILED_AS_RAW", ["3"]],
      ["W_TRANSPILED_AS_RAW", ["5"]],
    ]);
  });
});

describe("what the exporter can't send", () => {
  test("is reported, and a node only the dropped part used is still written", () => {
    // Five slots where the Autogrow has four: the types refuse it, so build it untyped.
    const built = workflow(autogrow, ({ n, raw }) => {
      const image = raw("MockImages").output(0);
      const only = raw("MockOnlyHere", {}, { id: "only-here" }).output(0);
      Reflect.apply(n.MockAutogrowOptionalRequired, undefined, [
        { images: [image, image, image, image, only] },
      ]);
    });
    const result = transpiled(built);
    expect(result.diagnostics.map((diagnostic) => diagnostic.code)).toEqual([
      "E_TOO_MANY_DYNAMIC_INPUTS",
      "W_TRANSPILED_AS_RAW",
    ]);
    expect(result.code).toContain('raw("MockOnlyHere", {}, { id: "only-here" });');
  });
});

describe("cycles", () => {
  test("tell nodes on a cycle from nodes that depend on one", async () => {
    const schema = typedSchema(normalizeObjectInfo(await readMockObjectInfo("sockets")).schema);
    const { workflow: cyclic } = importApi(
      JSON.stringify({
        a: { class_type: "MockAnyPassthrough", inputs: { value: ["b", 0] } },
        b: { class_type: "MockAnyPassthrough", inputs: { value: ["a", 0] } },
        c: { class_type: "MockAnyPassthrough", inputs: { value: ["b", 0] } },
      }),
      schema,
    );
    const messages = transpiled(cyclic).diagnostics.map((diagnostic) => diagnostic.message);
    expect(messages).toEqual([
      "Node a (MockAnyPassthrough) depends on itself through its links; leaving it out.",
      "Node b (MockAnyPassthrough) depends on itself through its links; leaving it out.",
      "Node c (MockAnyPassthrough) depends on nodes in a cycle; leaving it out.",
    ]);
  });
});

describe("large workflows", () => {
  test("transpile long chains and wide fans in linear time, without deep recursion", async () => {
    const schema = typedSchema(
      normalizeObjectInfo(
        `${(await readMockObjectInfo("sockets")).trimEnd().slice(0, -1)},${(await readMockObjectInfo("match-type")).trimStart().slice(1)}`,
      ).schema,
    );
    const nodes: Record<string, unknown> = {
      s: { class_type: "MockSource", inputs: {} },
    };
    // A MatchType chain listed in reverse, and a fan of consumers of one node.
    for (let index = 0; index < 20_000; index++) {
      nodes[`m${String(index)}`] = {
        class_type: "MockSwitch",
        inputs: { switch: true, on_false: [index === 19_999 ? "s" : `m${String(index + 1)}`, 0] },
      };
      nodes[`f${String(index)}`] = {
        class_type: "MockAnyPassthrough",
        inputs: { value: ["s", 0] },
      };
    }
    const started = performance.now();
    const result = transpiled(importApi(JSON.stringify(nodes), schema).workflow);
    expect(performance.now() - started).toBeLessThan(10_000);
    expect(result.diagnostics).toEqual([]);
    expect(result.code).toContain('{ id: "f19999" }');
    expect(result.code).toContain('{ id: "m0" }');
  }, 30_000);
});

describe("modes", () => {
  test("are written as node options", () => {
    const built = workflow(basic, ({ n }) => {
      const vae = n.VAELoader({ vae_name: "pixel_space" }, { mode: "bypass" });
      n.SaveImage({
        images: n.VAEDecode({ samples: n.EmptyLatentImage({}), vae }, { mode: "mute" }),
      });
    });
    const { code } = transpiled(built);
    expect(code).toContain('{ id: "1", mode: "bypass" }');
    expect(code).toContain('{ id: "3", mode: "mute" }');
  });
});
