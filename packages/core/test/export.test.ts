import { describe, expect, test } from "bun:test";
import { exportApi, stringify, toApi, ValidationError, workflow } from "@tscomfy/core";
import { readMockObjectInfo } from "@tscomfy/fixtures";
import { looseSchema } from "./loose.ts";

// Exporter rules not covered by the parity prompts (packages/codegen/test/parity.test.ts).

const basic = looseSchema(await readMockObjectInfo("basic-pipeline"));
const combos = looseSchema(await readMockObjectInfo("combos"));
const dynamicCombo = looseSchema(await readMockObjectInfo("dynamic-combo"));

describe("toApi", () => {
  test("leaves out _meta on request", () => {
    const built = workflow(basic, ({ n }) => {
      n["VAELoader"]?.({ vae_name: "pixel_space" });
    });
    expect(toApi(built, { meta: false })).toEqual({
      "1": { inputs: { vae_name: "pixel_space" }, class_type: "VAELoader" },
    });
  });

  test("orders node ids as the frontend does: integer-like ids numerically", () => {
    const built = workflow(basic, ({ n }) => {
      for (let index = 0; index < 11; index++) n["VAELoader"]?.({ vae_name: "pixel_space" });
    });
    expect(Object.keys(toApi(built))).toEqual([
      "1",
      "2",
      "3",
      "4",
      "5",
      "6",
      "7",
      "8",
      "9",
      "10",
      "11",
    ]);
  });

  test("keeps big integers exact through stringify", () => {
    const built = workflow(basic, ({ n }) => {
      n["KSampler"]?.({ seed: 18446744073709551615n });
    });
    expect(stringify(toApi(built))).toContain('"seed":18446744073709551615,');
  });

  test("passes inputs the schema doesn't know through, after the known ones", () => {
    const built = workflow(basic, ({ n }) => {
      n["VAELoader"]?.({ extra: [1], vae_name: "pixel_space" });
    });
    expect(Object.entries(toApi(built)["1"]?.inputs ?? {})).toEqual([
      ["vae_name", "pixel_space"],
      ["extra", { __value__: [1] }],
    ]);
  });

  test("gives a combo with a falsy default its first option, as the frontend does", () => {
    const built = workflow(combos, ({ n }) => {
      n["MockComboNumeric"]?.({ v2_mixed: 2 });
    });
    // legacy_numeric's default 10 and v2_numeric's 5 are kept; falsy_default's 0 becomes "auto".
    expect(toApi(built)["1"]?.inputs).toEqual({
      legacy_numeric: 10,
      v2_numeric: 5,
      v2_mixed: 2,
      falsy_default: "auto",
    });
  });

  test("throws a ValidationError for a key collision, and reports it without throwing", () => {
    const built = workflow(dynamicCombo, ({ n }) => {
      n["MockDynamicComboCollision"]?.({ format: "mp4" });
    });
    expect(() => toApi(built)).toThrow(ValidationError);
    const { prompt, diagnostics } = exportApi(built);
    expect(diagnostics.map((diagnostic) => diagnostic.code)).toEqual(["E_INPUT_KEY_COLLISION"]);
    expect(prompt["1"]?.inputs).toEqual({ format: "mp4", "format.codec": "h264" });
  });

  test("throws for an output reference nested inside a value", () => {
    const built = workflow(basic, ({ n, raw }) => {
      const vae = n["VAELoader"]!({ vae_name: "pixel_space" });
      raw("X", { nested: { vae } });
    });
    expect(() => toApi(built)).toThrow(TypeError);
  });

  test("sends an explicit null, rather than the default", async () => {
    const widgets = looseSchema(await readMockObjectInfo("widget-types"));
    const built = workflow(widgets, ({ n }) => {
      n["MockValueWidgets"]?.({ compare: null, color: null, curve_value: null });
    });
    expect(toApi(built)["1"]?.inputs).toMatchObject({
      color: null,
      compare: null,
      curve_value: null,
    });
  });

  test("passes unknown keys inside structured values through, flattened", async () => {
    const groups = looseSchema(await readMockObjectInfo("dynamic-group"));
    const built = workflow(groups, ({ n }) => {
      n["MockDynamicGroupOptional"]?.({ replacements: [{ find: "a", extra: 1 }] });
    });
    expect(toApi(built)["1"]?.inputs).toEqual({
      text: "",
      "replacements.0.find": "a",
      "replacements.0.replace": "",
      "replacements.0.extra": 1,
    });
  });

  test("reports more group rows than the maximum and sends only the allowed ones", async () => {
    const groups = looseSchema(await readMockObjectInfo("dynamic-group"));
    const built = workflow(groups, ({ n }) => {
      n["MockDynamicGroupOptionalMin"]?.({ rows: [{}, {}, {}, {}] });
    });
    const { prompt, diagnostics } = exportApi(built);
    expect(diagnostics.map((diagnostic) => [diagnostic.code, diagnostic.path])).toEqual([
      ["E_TOO_MANY_DYNAMIC_INPUTS", ["1", "inputs", "rows"]],
    ]);
    expect(Object.keys(prompt["1"]?.inputs ?? {})).toEqual([
      "rows.0.value",
      "rows.1.value",
      "rows.2.value",
    ]);
  });
});
