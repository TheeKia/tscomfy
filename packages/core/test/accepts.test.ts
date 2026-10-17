import { expect, test } from "bun:test";
import { accepts } from "@tscomfy/core";
import { ACCEPTS_CASES } from "./accepts-cases.ts";

test.each(ACCEPTS_CASES.map((row) => [row.name, row] as const))("%s", (_name, row) => {
  expect(accepts(row.input, row.output)).toBe(row.expected);
});
