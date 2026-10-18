import { describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { generate, type GeneratedFile } from "@tscomfy/codegen";
import { normalizeObjectInfo } from "@tscomfy/core";
import { oxfmt, typecheckProject } from "@tscomfy/fixtures";

// Generated code must be exactly what oxfmt produces (docs/plan.md §9), whatever the server's
// names, and server text must never break out of comments. Each case is a hand-written node
// definition built to hit one layout rule or one hostile name.

function node(classType: string, fields: Record<string, unknown>): Record<string, unknown> {
  return {
    [classType]: {
      input: { required: {} },
      output: [],
      name: classType,
      display_name: classType,
      category: "mock",
      python_module: "custom_nodes.mock-pack",
      output_node: false,
      ...fields,
    },
  };
}

const LONG = "X".repeat(70);
const templates = (count: number): Record<string, unknown> =>
  Object.fromEntries(
    Array.from({ length: count }, (_, index) => [
      `branch_${String(index)}`,
      [
        "COMFY_MATCHTYPE_V3",
        { template: { template_id: `a_rather_long_template_identifier_${String(index)}` } },
      ],
    ]),
  );

const CASES: Record<string, Record<string, unknown>> = {
  "a long class name with several outputs": node(`${LONG}Loader`, {
    output: ["MODEL", "CLIP", "VAE"],
  }),
  "many MatchType templates": node("ManyTemplates", {
    input: { required: templates(4) },
    output: ["COMFY_MATCHTYPE_V3", "COMFY_MATCHTYPE_V3"],
    output_matchtypes: [
      "a_rather_long_template_identifier_0",
      "a_rather_long_template_identifier_3",
    ],
  }),
  "a tuple that fits on the next line only": node("Y".repeat(60), {
    output: ["MODEL", "CLIP", "CONDITIONING"],
  }),
  "a long tuple": node("ManyOutputs", {
    output: Array.from({ length: 12 }, (_, index) => `TYPE_NUMBER_${String(index)}`),
    output_name: Array.from({ length: 12 }, (_, index) => `out_${String(index)}`),
  }),
  "wide characters near the width limit": node("WideCombo", {
    input: {
      required: {
        cjk: [
          ["全部", "選択肢一", "選択肢二", "選択肢三", "選択肢四", "選択肢五", "選択肢六", "七七"],
        ],
        fullwidth: [
          [
            "ｆｕｌｌ",
            "ﾊﾝｶｸ",
            "한국어한국어한국어한국어한국어한국어한국어한국어한국어한국어한국어한",
          ],
        ],
        emoji: [["🔞️Select the nsfw add to the text", "🐍 snake", "combining é é mark"]],
      },
    },
  }),
  "quotes in names and options": node('Say "Hi" Node', {
    input: {
      required: {
        'say "hi"': [["it's", 'say "hi"', "both \"a\" 'b'", "back\\slash"]],
        mode: [
          "COMFY_DYNAMICCOMBO_V3",
          { options: [{ key: 'opt "a"', inputs: { required: { x: ["INT", {}] } } }] },
        ],
      },
    },
  }),
  "unicode identifier keys": node("UnicodeKeys", {
    input: { required: { café: ["INT", {}], 日本: ["STRING", {}], naïve_name: ["FLOAT", {}] } },
  }),
  "a long input name with a long type": node("LongInput", {
    input: {
      required: {
        [`a_${"very_".repeat(14)}long_input`]: ["A_VERY_LONG_CUSTOM_SOCKET_TYPE_NAME_FOR_TESTING"],
      },
    },
  }),
  "comment injection": node("Evil */ export const pwned = 1; /*", {
    description: "line one\nline two line three */ export const also = 2; /*",
    input: {
      required: {
        "k*/x": [["a"], { tooltip: "a */ b\r\nc d" }],
        mode: ["COMFY_DYNAMICCOMBO_V3", { options: [{ key: "k*/x", inputs: { required: {} } }] }],
      },
    },
  }),
};

describe("generated code is oxfmt-formatted and compiles", () => {
  test.each(Object.keys(CASES))(
    "%s",
    async (name) => {
      const text = JSON.stringify(CASES[name]);
      const { schema, diagnostics } = normalizeObjectInfo(text, {
        comfyVersion: "0.41\nexport const fromVersion = 3;",
      });
      expect(diagnostics.filter((diagnostic) => diagnostic.severity === "error")).toEqual([]);
      const { files } = generate(schema, {
        exportName: "averyLongExportName".repeat(3),
        command: "tscomfy generate export const fromCommand = 4;",
      });
      await expectFormattedAndCompiling(files);
      for (const file of files) {
        expect(file.contents).not.toMatch(/^export const (pwned|also|fromVersion|fromCommand)/m);
      }
    },
    60_000,
  );

  test("an empty schema", async () => {
    const { files } = generate(normalizeObjectInfo("{}").schema, { exportName: "empty" });
    await expectFormattedAndCompiling(files);
  }, 60_000);
});

async function expectFormattedAndCompiling(files: readonly GeneratedFile[]): Promise<void> {
  const formatted = await Promise.all(files.map((file) => oxfmt(file.path, file.contents)));
  expect(formatted.map((result) => result.output)).toEqual(files.map((file) => file.contents));

  const directory = await mkdtemp(join(tmpdir(), "tscomfy-format-"));
  try {
    await Promise.all(files.map((file) => Bun.write(join(directory, file.path), file.contents)));
    const tsc = await typecheckProject(directory);
    expect(tsc.output).toBe("");
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}
