import { describe, expect, test } from "bun:test";
import { parse, stringify } from "@tscomfy/core";
import { MOCK_OBJECT_INFO_NAMES, readMockObjectInfo } from "@tscomfy/fixtures";
import { parseWith } from "../src/json/parse.ts";
import { isJsonObject } from "../src/json/value.ts";

describe("parse", () => {
  test("parses JSON like JSON.parse inside the safe range", () => {
    expect(parse('{"a":[1,-2.5,1e3,true,null,"x"],"b":{}}')).toEqual({
      value: { a: [1, -2.5, 1000, true, null, "x"], b: {} },
      diagnostics: [],
    });
  });

  test.each([
    ["18446744073709551615", 18446744073709551615n],
    ["-9223372036854775808", -9223372036854775808n],
    ["9007199254740993", 9007199254740993n],
  ])("keeps the integer %s exact as a bigint", (literal, expected) => {
    expect(parse(`{"max":${literal}}`).value).toEqual({ max: expected });
    expect(parse(`[${literal}]`).value).toEqual([expected]);
  });

  test("keeps safe integers, fractions and exponents as numbers", () => {
    expect(parse("[9007199254740991, 1e20, 1.5e300, -0, 0.1]").value).toEqual([
      9007199254740991, 1e20, 1.5e300, -0, 0.1,
    ]);
  });

  test("reports invalid JSON instead of throwing", () => {
    const result = parse("{nope");
    expect(result.value).toBeUndefined();
    expect(result.diagnostics).toHaveLength(1);
    expect(result.diagnostics[0]).toMatchObject({
      code: "E_INVALID_JSON",
      severity: "error",
      path: [],
    });
  });

  test("defines __proto__ as an ordinary key", () => {
    const value = parse('{"__proto__": {"polluted": true}}').value;
    if (!isJsonObject(value)) throw new Error("expected an object");
    expect(Object.keys(value)).toEqual(["__proto__"]);
    expect(Object.getPrototypeOf(value)).toBe(Object.prototype);
  });

  test("without source-text access, reports each integer that may have lost precision", () => {
    const result = parseWith('{"a":{"max":18446744073709551615},"b":[1,9007199254740993]}', false);
    expect(result.value).toEqual({ a: { max: 18446744073709552000 }, b: [1, 9007199254740992] });
    expect(result.diagnostics.map((diagnostic) => [diagnostic.code, diagnostic.path])).toEqual([
      ["W_PRECISION_LOSS", ["a", "max"]],
      ["W_PRECISION_LOSS", ["b", 1]],
    ]);
  });

  test("this runtime has source-text access", () => {
    expect(parseWith("[18446744073709551615]", true)).toEqual(parse("[18446744073709551615]"));
    expect(parse("[18446744073709551615]").diagnostics).toEqual([]);
  });
});

describe("stringify", () => {
  test("writes compact JSON in insertion order, like JSON.stringify", () => {
    const value = { z: 1, a: [true, null, 'q"\n '], m: { n: -0.5, e: 1e21 } };
    expect(stringify(value)).toBe(JSON.stringify(value));
  });

  test("writes bigint as a plain integer literal", () => {
    expect(stringify({ seed: 18446744073709551615n, list: [-1n] })).toBe(
      '{"seed":18446744073709551615,"list":[-1]}',
    );
  });

  test.each([Number.NaN, Number.POSITIVE_INFINITY])(
    "throws for %p, which has no JSON form",
    (value) => {
      expect(() => stringify([value])).toThrow(TypeError);
    },
  );

  test.each(MOCK_OBJECT_INFO_NAMES)("round-trips the %s mock without loss", async (name) => {
    const { value, diagnostics } = parse(await readMockObjectInfo(name));
    expect(diagnostics).toEqual([]);
    expect(value).toBeDefined();
    expect(parse(stringify(value!)).value).toEqual(value);
  });
});
