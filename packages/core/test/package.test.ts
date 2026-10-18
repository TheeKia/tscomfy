import { expect, test } from "bun:test";
import * as core from "@tscomfy/core";

test("@tscomfy/core resolves to its source entry under the @tscomfy/source condition", () => {
  expect(import.meta.resolve("@tscomfy/core")).toEndWith("/packages/core/src/index.ts");
});

test("exports exactly the documented runtime values", () => {
  // The types are pinned by docs/api/core.md; this pins what exists at runtime.
  expect(Object.keys(core).toSorted()).toEqual([
    "DIAGNOSTIC_CODES",
    "ValidationError",
    "accepts",
    "createDiagnostic",
    "defineSchema",
    "diffSchemas",
    "exportApi",
    "hashSchema",
    "importApi",
    "importUi",
    "isOutputRef",
    "namedOutputs",
    "normalizeObjectInfo",
    "parse",
    "prune",
    "sendsInputValue",
    "splitOutputs",
    "stringify",
    "toApi",
    "toUi",
    "typedSchema",
    "uiNodeSizes",
    "validate",
    "validateApi",
    "workflow",
  ]);
});
