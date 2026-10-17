import { describe, expect, test } from "bun:test";
import { defineSchema, normalizeObjectInfo, stringify } from "@tscomfy/core";
import { MOCK_OBJECT_INFO_NAMES, readMockObjectInfo } from "@tscomfy/fixtures";

describe("defineSchema", () => {
  test.each(MOCK_OBJECT_INFO_NAMES)("restores the %s schema exactly", async (name) => {
    const { schema } = normalizeObjectInfo(await readMockObjectInfo(name), {
      comfyVersion: "0.41.0",
    });
    const loaded = defineSchema(stringify(schema));
    expect(stringify(loaded)).toBe(stringify(schema));
    expect(loaded).toEqual(schema);
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
});
