import { describe, expect, test } from "bun:test";
import { join } from "node:path";
import { transpile } from "@tscomfy/codegen";
import {
  defineSchema,
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
  readMockApiWorkflow,
  readMockObjectInfo,
} from "@tscomfy/fixtures";
import { TRANSPILED_DIR, transpileMock } from "./generated-fixtures.ts";
import { mock as basic } from "./generated/basic-pipeline/index.ts";
import { mock as combos } from "./generated/combos/index.ts";

// The transpiler (docs/plan.md §10). The committed modules in generated/transpiled/ are
// type-checked by tsc -b and format-checked by oxfmt; here they are run.

const OPTIONS = { name: "prompt", schemaModule: "./index.js", schemaName: "mock" } as const;

async function load(name: string): Promise<Workflow> {
  const module: unknown = await import(join(TRANSPILED_DIR, `${name}.ts`));
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

function transpiled(built: Workflow, options: Partial<Parameters<typeof transpile>[1]> = {}) {
  return transpile(built, { ...OPTIONS, ...options });
}

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

  test("leaves out cycles and dangling links, and reports them", async () => {
    const schema = defineSchema(
      stringify(normalizeObjectInfo(await readMockObjectInfo("sockets")).schema),
    );
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

  test("breaks a header that doesn't fit, as oxfmt does", () => {
    const built = workflow(basic, () => {});
    const name = "aVeryLongWorkflowNameThatKeepsGoing";
    const result = transpiled(built, { name, schemaName: "anEvenLongerSchemaNameForThisServer" });
    expect(result.code).toContain(
      `export const ${name}: Workflow<NodesOf<typeof anEvenLongerSchemaNameForThisServer>> = workflow(\n  anEvenLongerSchemaNameForThisServer,\n  () => {},\n);\n`,
    );
  });

  test.each([
    [{ name: "default" }, "options.name"],
    [{ schemaName: "my-schema" }, "options.schemaName"],
    [{ name: "mock" }, "must differ"],
  ])("refuses options %p", (options, message) => {
    expect(() =>
      transpiled(
        workflow(basic, () => {}),
        options,
      ),
    ).toThrow(message);
  });

  test("is deterministic", async () => {
    const first = await transpileMock("dynamic-group");
    expect(await transpileMock("dynamic-group")).toEqual(first);
  });
});
