import { describe, expect, test } from "bun:test";
import { exportApi, stringify, toApi, ValidationError, workflow } from "@tscomfy/core";
import { readMockObjectInfo } from "@tscomfy/fixtures";
import { looseSchema } from "./loose.ts";

// Exporter rules not covered by the parity prompts (packages/codegen/test/parity.test.ts). These
// graphs are fragments, not prompts the backend would run, so validation (validate.test.ts) is
// off.

const basic = looseSchema(await readMockObjectInfo("basic-pipeline"));
const combos = looseSchema(await readMockObjectInfo("combos"));
const dynamicCombo = looseSchema(await readMockObjectInfo("dynamic-combo"));
const autogrow = looseSchema(await readMockObjectInfo("autogrow"));
const dynamicGroup = looseSchema(await readMockObjectInfo("dynamic-group"));

describe("toApi", () => {
  test("leaves out _meta on request", () => {
    const built = workflow(basic, ({ n }) => {
      n["VAELoader"]?.({ vae_name: "pixel_space" });
    });
    expect(toApi(built, { meta: false, validate: false })).toEqual({
      "1": { inputs: { vae_name: "pixel_space" }, class_type: "VAELoader" },
    });
  });

  test("orders node ids as the frontend does: integer-like ids numerically", () => {
    const built = workflow(basic, ({ n }) => {
      for (let index = 0; index < 11; index++) n["VAELoader"]?.({ vae_name: "pixel_space" });
    });
    expect(Object.keys(toApi(built, { validate: false }))).toEqual([
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
    expect(stringify(toApi(built, { validate: false }))).toContain('"seed":18446744073709551615,');
  });

  test("passes inputs the schema doesn't know through, after the known ones", () => {
    const built = workflow(basic, ({ n }) => {
      n["VAELoader"]?.({ extra: [1], vae_name: "pixel_space" });
    });
    expect(Object.entries(toApi(built, { validate: false })["1"]?.inputs ?? {})).toEqual([
      ["vae_name", "pixel_space"],
      ["extra", { __value__: [1] }],
    ]);
  });

  test("gives a combo with a falsy default its first option, as the frontend does", () => {
    const built = workflow(combos, ({ n }) => {
      n["MockComboNumeric"]?.({ v2_mixed: 2 });
    });
    // legacy_numeric's default 10 and v2_numeric's 5 are kept; falsy_default's 0 becomes "auto".
    expect(toApi(built, { validate: false })["1"]?.inputs).toEqual({
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
    expect(() => toApi(built, { validate: false })).toThrow(ValidationError);
    const { prompt, diagnostics } = exportApi(built, { validate: false });
    expect(diagnostics.map((diagnostic) => diagnostic.code)).toEqual(["E_INPUT_KEY_COLLISION"]);
    expect(prompt["1"]?.inputs).toEqual({ format: "mp4", "format.codec": "h264" });
  });

  test("throws for an output reference nested inside a value", () => {
    const built = workflow(basic, ({ n, raw }) => {
      const vae = n["VAELoader"]!({ vae_name: "pixel_space" });
      raw("X", { nested: { vae } });
    });
    expect(() => toApi(built, { validate: false })).toThrow(TypeError);
  });

  test("sends an explicit null, rather than the default", async () => {
    const widgets = looseSchema(await readMockObjectInfo("widget-types"));
    const built = workflow(widgets, ({ n }) => {
      n["MockValueWidgets"]?.({ compare: null, color: null, curve_value: null });
    });
    expect(toApi(built, { validate: false })["1"]?.inputs).toMatchObject({
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
    expect(toApi(built, { validate: false })["1"]?.inputs).toEqual({
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
    const { prompt, diagnostics } = exportApi(built, { validate: false });
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

/** Each diagnostic of a workflow as its code and path. */
function codes(built: Parameters<typeof exportApi>[0]): string[] {
  return exportApi(built).diagnostics.map(
    (diagnostic) => `${diagnostic.code} ${diagnostic.path.join(" ")}`,
  );
}

describe("values the types reject", () => {
  // Plain JavaScript, or a cast, can still pass them. They are sent under their own key, as an
  // unknown input is, so validation reports them rather than the exporter dropping them.

  test("an Autogrow given one link instead of a list", () => {
    const built = workflow(autogrow, ({ n, raw }) => {
      const image = raw("MockSources").output(0);
      n["MockAutogrowPrefixOptional"]?.({ prompt: "x", ref_images: image });
    });
    expect(toApi(built, { validate: false })["2"]?.inputs).toEqual({
      prompt: "x",
      ref_images: ["1", 0],
    });
    expect(codes(built)).toContain("E_UNKNOWN_INPUT 2 inputs ref_images");
  });

  test("a DynamicGroup given a record, and a row that isn't one", () => {
    const built = workflow(dynamicGroup, ({ n }) => {
      n["MockDynamicGroupOptional"]?.({ text: "t", replacements: { find: "a" } });
      n["MockDynamicGroupOptional"]?.({ text: "u", replacements: ["oops", { find: "x" }] });
    });
    const prompt = toApi(built, { validate: false });
    expect(prompt["1"]?.inputs["replacements"]).toEqual({ find: "a" });
    expect(prompt["2"]?.inputs["replacements.0"]).toBe("oops");
    expect(codes(built)).toContain("E_UNKNOWN_INPUT 1 inputs replacements");
    expect(codes(built)).toContain("E_UNKNOWN_INPUT 2 inputs replacements.0");
  });

  test.each([
    ["a misspelled inputs key", { option: "scale dimensions", input: { width: 9 } }],
    ["inputs that aren't a record", { option: "scale dimensions", inputs: [1, 2] }],
  ])("a dynamic combo with %s", (_name, mode) => {
    const built = workflow(dynamicCombo, ({ n, raw }) => {
      n["MockDynamicComboSimple"]?.({ image: raw("MockImageSource").output(0), mode });
    });
    expect(toApi(built, { validate: false })["2"]?.inputs["mode"]).toEqual(mode);
    expect(codes(built)).toContain("E_INVALID_VALUE 2 inputs mode");
  });

  test("a dynamic combo linked to a muted node is left out, not sent as the dropped link", () => {
    const built = workflow(dynamicCombo, ({ n, raw }) => {
      const mode = raw("MockChooser", {}, { mode: "mute" }).output(0);
      n["MockDynamicComboSimple"]?.({ image: raw("MockImageSource").output(0), mode });
    });
    const { prompt, diagnostics } = exportApi(built, { validate: false });
    expect(prompt["3"]?.inputs).toEqual({ image: ["2", 0] });
    expect(diagnostics.map((diagnostic) => diagnostic.message)).toEqual([
      "Input mode of node 3 is left out: it is linked to node 1, which is muted.",
    ]);
  });
});

describe("exportApi", () => {
  test("with modes: false, sends bypassed and muted nodes as if they ran", () => {
    const built = workflow(basic, ({ n }) => {
      const vae = n["VAELoader"]!({ vae_name: "pixel_space" }, { mode: "mute" });
      n["VAEDecode"]?.({ vae }, { mode: "bypass" });
    });
    const { prompt, diagnostics } = exportApi(built, { modes: false, validate: false });
    expect(Object.keys(prompt)).toEqual(["1", "2"]);
    expect(prompt["2"]?.inputs).toEqual({ vae: ["1", 0] });
    expect(diagnostics).toEqual([]);
    expect(Object.keys(exportApi(built, { validate: false }).prompt)).toEqual([]);
  });
});
