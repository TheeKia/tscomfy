import { describe, expect, test } from "bun:test";
import { join } from "node:path";
import {
  DIAGNOSTIC_CODES,
  exportApi,
  workflow,
  type Diagnostic,
  type DiagnosticCode,
  normalizeObjectInfo,
  parse,
} from "@tscomfy/core";
import { readMockObjectInfo } from "@tscomfy/fixtures";
import { parseWith } from "../src/json/parse.ts";
import { looseSchema } from "./loose.ts";

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

/** Exports a workflow with a dynamic combo whose flattened key collides with another input. */
async function collision(): Promise<readonly Diagnostic[]> {
  const schema = looseSchema(await readMockObjectInfo("dynamic-combo"));
  const built = workflow(schema, ({ n }) => {
    n["MockDynamicComboCollision"]?.({ format: "mp4" }, { id: "5" });
  });
  return exportApi(built).diagnostics;
}

const malformed = async (): Promise<readonly Diagnostic[]> =>
  normalizeObjectInfo(await readMockObjectInfo("malformed")).diagnostics;

interface Producer {
  readonly produce: () => Promise<readonly Diagnostic[]> | readonly Diagnostic[];
  /** Where the diagnostic must point. */
  readonly path: readonly (string | number)[];
}

/** Codes codegen reports; their negative tests are in packages/codegen/test. */
const CODEGEN_CODES = ["W_EMPTY_COMBO", "W_UNTYPED_INPUT"] as const;
type CoreCode = Exclude<DiagnosticCode, (typeof CODEGEN_CODES)[number]>;
const isCoreCode = (code: DiagnosticCode): code is CoreCode =>
  !(CODEGEN_CODES as readonly DiagnosticCode[]).includes(code);

/** One negative test per code: an input that must produce it, at a precise path. */
const PRODUCERS: Record<CoreCode, Producer> = {
  E_INVALID_JSON: { produce: () => parse("{").diagnostics, path: [] },
  W_PRECISION_LOSS: {
    produce: () => parseWith('{"max":[18446744073709551615]}', false).diagnostics,
    path: ["max", 0],
  },
  W_NON_FINITE_NUMBER: { produce: () => parse('{"max":Infinity}').diagnostics, path: ["max"] },
  E_INVALID_OBJECT_INFO: { produce: () => normalizeObjectInfo("[]").diagnostics, path: [] },
  E_INVALID_NODE: { produce: malformed, path: ["MockBadOutputOption", "output", 0, 1] },
  W_INVALID_NODE_FIELD: { produce: malformed, path: ["MockBadInputSpecs", "output_name"] },
  W_NODE_NAME_MISMATCH: { produce: malformed, path: ["MockNameMismatch", "name"] },
  E_INVALID_INPUT_SECTION: {
    produce: malformed,
    path: ["MockBadInputSpecs", "input", "optional"],
  },
  E_DUPLICATE_INPUT: {
    produce: malformed,
    path: ["MockDuplicateInput", "input", "optional", "value"],
  },
  W_INPUT_ORDER_MISMATCH: { produce: malformed, path: ["MockPartialOrder", "input_order"] },
  W_INVALID_INPUT_SPEC: {
    produce: malformed,
    path: ["MockBadInputSpecs", "input", "required", "null_spec"],
  },
  W_UNSUPPORTED_INPUT_TYPE: {
    produce: malformed,
    path: ["MockBadInputSpecs", "input", "required", "unknown_v3_type", 0],
  },
  E_INPUT_KEY_COLLISION: { produce: collision, path: ["5", "inputs", "format.codec"] },
  W_INVALID_INPUT_OPTION: {
    produce: malformed,
    path: ["MockBadInputSpecs", "input", "required", "options_not_object", 1],
  },
};

describe("every code has a negative test", () => {
  test.each(codes.filter(isCoreCode))("%s", async (code) => {
    const { produce, path } = PRODUCERS[code];
    const found = (await produce()).filter((diagnostic) => diagnostic.code === code);
    expect(found.map((diagnostic) => diagnostic.path)).toContainEqual(path);
    for (const diagnostic of found) {
      expect(diagnostic.severity).toBe(DIAGNOSTIC_CODES[code]);
      expect(Object.isFrozen(diagnostic)).toBeTrue();
    }
  });
});
