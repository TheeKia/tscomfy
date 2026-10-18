import { describe, expect, test } from "bun:test";
import {
  defineSchema,
  importApi,
  normalizeObjectInfo,
  type Schema,
  stringify,
  toApi,
  typedSchema,
} from "@tscomfy/core";
import { MOCK_OBJECT_INFO_NAMES, readMockObjectInfo } from "@tscomfy/fixtures";
import { parseWith } from "../src/json/parse.ts";
import { schemaFromParse } from "../src/schema/typed.ts";

describe("defineSchema", () => {
  test.each(MOCK_OBJECT_INFO_NAMES)("restores the %s schema exactly", async (name) => {
    const { schema } = normalizeObjectInfo(await readMockObjectInfo(name), {
      comfyVersion: "0.41.0",
    });
    const loaded = defineSchema(stringify(schema));
    expect(stringify(loaded)).toBe(stringify(schema));
    expect<Schema>(loaded).toEqual(schema);
  });

  test("keeps big integers, a null-prototype record and deep immutability", async () => {
    const loaded = defineSchema(
      stringify(normalizeObjectInfo(await readMockObjectInfo("numbers")).schema),
    );
    const seed = loaded.nodes["MockNumbers"]?.inputs[0];
    expect(seed).toMatchObject({ name: "seed", max: 18446744073709551615n });
    expect(Object.getPrototypeOf(loaded.nodes)).toBeNull();
    expect(Object.isFrozen(seed)).toBeTrue();
  });

  test.each([
    "{",
    "[]",
    '{"formatVersion":2,"nodes":{}}',
    '{"formatVersion":1}',
    '{"formatVersion":1,"nodes":[]}',
  ])("throws for text codegen didn't write: %s", (text) => {
    expect(() => defineSchema(text)).toThrow(TypeError);
  });

  test("explains a runtime without JSON.parse source-text access", async () => {
    const text = stringify(normalizeObjectInfo(await readMockObjectInfo("numbers")).schema);
    expect(() => schemaFromParse(parseWith(text, false))).toThrow(/source-text access/);
  });
});

describe("typedSchema", () => {
  test("types a schema read at runtime, frozen, for importing and exporting", async () => {
    const { schema } = normalizeObjectInfo(await readMockObjectInfo("basic-pipeline"));
    const typed = typedSchema(schema);
    expect<Schema>(typed).toEqual(schema);
    const prompt =
      '{"1":{"inputs":{"vae_name":"pixel_space"},"class_type":"VAELoader","_meta":{"title":"Load VAE"}}}';
    const { workflow, diagnostics } = importApi(prompt, typed);
    expect(diagnostics).toEqual([]);
    expect(stringify(toApi(workflow, { validate: false }))).toBe(prompt);
  });

  test("freezes a schema built by hand, without inherited node names", () => {
    const typed = typedSchema({ formatVersion: 1, nodes: {} });
    expect(Object.isFrozen(typed)).toBeTrue();
    expect(Object.getPrototypeOf(typed.nodes)).toBeNull();
    expect(typed.nodes["constructor"]).toBeUndefined();
  });
});
