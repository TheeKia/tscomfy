import { describe, expect, test } from "bun:test";
import { type JsonValue, parse, stringify } from "@tscomfy/core";
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

  test("reads non-finite numbers as null, at their paths", () => {
    const result = parse('{"a":[NaN, "NaN Infinity"],"b":{"c":-Infinity},"d":1e400,"e":Infinity}');
    expect(result.value).toEqual({ a: [null, "NaN Infinity"], b: { c: null }, d: null, e: null });
    expect(result.diagnostics.map((diagnostic) => [diagnostic.code, diagnostic.path])).toEqual([
      ["W_NON_FINITE_NUMBER", ["a", 0]],
      ["W_NON_FINITE_NUMBER", ["b", "c"]],
      ["W_NON_FINITE_NUMBER", ["d"]],
      ["W_NON_FINITE_NUMBER", ["e"]],
    ]);
  });

  test("keeps a 400-digit integer as a bigint", () => {
    expect(parse(`[${"9".repeat(400)}]`).value).toEqual([10n ** 400n - 1n]);
  });

  test("still rejects other invalid JSON that mentions NaN", () => {
    expect(parse("[NaN,]").diagnostics.map((diagnostic) => diagnostic.code)).toEqual([
      "E_INVALID_JSON",
    ]);
  });

  test("without source-text access, also reads overflowing literals as null", () => {
    const result = parseWith("[1e400, 18446744073709551615]", false);
    expect(result.value).toEqual([null, 18446744073709552000]);
    expect(result.diagnostics.map((diagnostic) => diagnostic.code)).toEqual([
      "W_NON_FINITE_NUMBER",
      "W_PRECISION_LOSS",
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

  test("writes unsafe integer-valued numbers so they round-trip as numbers", () => {
    const values = [2 ** 64 - 2048, -(2 ** 64), 1e21, Number.MAX_VALUE, 2 ** 53];
    expect(stringify(values)).toBe(
      "[1.844674407370955e+19,-1.8446744073709552e+19,1e+21,1.7976931348623157e+308,9.007199254740992e+15]",
    );
    expect(parse(stringify(values)).value).toEqual(values);
    expect(JSON.parse(stringify(values))).toEqual(values);
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

  test("throws for undefined, which code without exactOptionalPropertyTypes can pass", () => {
    const record: { [key: string]: JsonValue } = { a: 1 };
    Reflect.set(record, "b", undefined);
    expect(() => stringify(record)).toThrow(TypeError);
    const holey: JsonValue[] = [1];
    holey.length = 2;
    expect(() => stringify(holey)).toThrow(TypeError);
  });

  test.each(MOCK_OBJECT_INFO_NAMES)("round-trips the %s mock without loss", async (name) => {
    const { value, diagnostics } = parse(await readMockObjectInfo(name));
    expect(diagnostics).toEqual([]);
    expect(value).toBeDefined();
    expect(parse(stringify(value!)).value).toEqual(value);
  });
});
