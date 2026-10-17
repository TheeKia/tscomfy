import { describe, expect, test } from "bun:test";
import { toFloatBound, toIntBound } from "../src/object-info/numbers.ts";

// Inward rounding (docs/plan.md §9): every value inside our bound is inside the backend's.

describe("FLOAT bounds", () => {
  test.each([
    [18446744073709551615n, "max", 18446744073709549568],
    [-18446744073709551615n, "min", -18446744073709549568],
    [18446744073709551615n, "min", 18446744073709551616],
    [9007199254740993n, "max", 9007199254740992],
    [9007199254740993n, "min", 9007199254740994],
  ] as const)("%p as %s becomes %p", (value, side, expected) => {
    expect(toFloatBound(value, side, false)).toBe(expected);
  });

  test("keeps exactly representable bounds", () => {
    expect(toFloatBound(2n ** 64n, "max", false)).toBe(2 ** 64);
    expect(toFloatBound(0.25, "min", false)).toBe(0.25);
  });

  test("uses the largest double for bounds beyond the double range, where it is inside", () => {
    const huge = 10n ** 400n;
    expect(toFloatBound(huge, "max", false)).toBe(Number.MAX_VALUE);
    expect(toFloatBound(-huge, "min", false)).toBe(-Number.MAX_VALUE);
    expect(toFloatBound(huge, "min", false)).toBeUndefined();
    expect(toFloatBound(-huge, "max", false)).toBeUndefined();
  });

  test("moves unsafe integer bounds inward when the parser was inexact", () => {
    expect(toFloatBound(2 ** 64, "max", true)).toBe(2 ** 64 - 2048);
    expect(toFloatBound(2 ** 64, "min", true)).toBe(2 ** 64 + 4096);
    expect(toFloatBound(2 ** 64, "max", false)).toBe(2 ** 64);
    expect(toFloatBound(1.5, "max", true)).toBe(1.5);
  });
});

describe("INT bounds", () => {
  test("rounds fractional bounds inward", () => {
    expect(toIntBound(2.5, "max", false)).toBe(2);
    expect(toIntBound(2.5, "min", false)).toBe(3);
    expect(toIntBound(-2.5, "max", false)).toBe(-3);
  });

  test("keeps big integers exact, and moves inexact ones inward", () => {
    expect(toIntBound(18446744073709551615n, "max", false)).toBe(18446744073709551615n);
    expect(toIntBound(2 ** 64, "max", false)).toBe(2n ** 64n);
    expect(toIntBound(2 ** 64, "max", true)).toBe(2n ** 64n - 2048n);
    expect(toIntBound(2 ** 64, "min", true)).toBe(2n ** 64n + 4096n);
  });
});
