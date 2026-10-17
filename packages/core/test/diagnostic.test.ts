import { describe, expect, test } from "bun:test";
import { join } from "node:path";
import {
  DIAGNOSTIC_CODES,
  type Diagnostic,
  type DiagnosticCode,
  normalizeObjectInfo,
  parse,
} from "@tscomfy/core";
import { readMockObjectInfo } from "@tscomfy/fixtures";
import { parseWith } from "../src/json/parse.ts";

const isCode = (key: string): key is DiagnosticCode => Object.hasOwn(DIAGNOSTIC_CODES, key);
const codes = Object.keys(DIAGNOSTIC_CODES).filter(isCode);
const byCodeUnit = (a: string, b: string): number => (a === b ? 0 : a < b ? -1 : 1);

describe("registry", () => {
  test.each(codes)("%s has the severity its prefix names", (code) => {
    expect(DIAGNOSTIC_CODES[code]).toBe(code.startsWith("E_") ? "error" : "warning");
    expect(code).toMatch(/^[EW]_[A-Z0-9_]+$/);
  });

  test("docs/diagnostics.md documents exactly the registered codes", async () => {
    const doc = await Bun.file(join(import.meta.dir, "../../../docs/diagnostics.md")).text();
    const documented = [...doc.matchAll(/^\| `([EW]_[A-Z0-9_]+)` \|/gm)].map(
      (match) => match[1] ?? "",
    );
    expect(documented.toSorted(byCodeUnit)).toEqual(codes.toSorted(byCodeUnit));
  });
});

const malformed = async (): Promise<readonly Diagnostic[]> =>
  normalizeObjectInfo(await readMockObjectInfo("malformed")).diagnostics;

/** One negative test per code: an input that must produce it. */
const PRODUCERS: Record<
  DiagnosticCode,
  () => Promise<readonly Diagnostic[]> | readonly Diagnostic[]
> = {
  E_INVALID_JSON: () => parse("{").diagnostics,
  W_PRECISION_LOSS: () => parseWith("[18446744073709551615]", false).diagnostics,
  E_INVALID_OBJECT_INFO: () => normalizeObjectInfo("[]").diagnostics,
  E_INVALID_NODE: malformed,
  W_INVALID_NODE_FIELD: malformed,
  W_NODE_NAME_MISMATCH: malformed,
  E_INVALID_INPUT_SECTION: malformed,
  E_DUPLICATE_INPUT: malformed,
  W_INPUT_ORDER_MISMATCH: malformed,
  W_INVALID_INPUT_SPEC: malformed,
  W_UNSUPPORTED_INPUT_TYPE: malformed,
  W_INVALID_INPUT_OPTION: async () =>
    normalizeObjectInfo(await readMockObjectInfo("combos")).diagnostics,
};

describe("every code has a negative test", () => {
  test.each(codes)("%s", async (code) => {
    const diagnostics = await PRODUCERS[code]();
    const found = diagnostics.find((diagnostic) => diagnostic.code === code);
    expect(found).toBeDefined();
    expect(found?.severity).toBe(DIAGNOSTIC_CODES[code]);
    expect(Object.isFrozen(found)).toBeTrue();
  });
});
