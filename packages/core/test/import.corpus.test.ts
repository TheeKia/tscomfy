import { describe, expect, test } from "bun:test";
import { importApi, normalizeObjectInfo, parse, stringify, toApi } from "@tscomfy/core";
import { listCorpus } from "@tscomfy/fixtures";
import { looseSchema } from "./loose.ts";

// Corpus tests (docs/plan.md §14 Phase 6): every API workflow re-exports byte for byte, key order
// included: stringify(toApi(importApi(x))) equals stringify(parse(x)).

const dumps = await listCorpus("object-info");
const workflows = await listCorpus("workflows/api");

describe("round-trip the corpus workflows", () => {
  if (dumps.length === 0 || workflows.length === 0) {
    test.skip("object-info or workflows/api is empty", () => {});
  }
  for (const dump of dumps) {
    for (const file of workflows) {
      test(`${file.name} over ${dump.name}`, async () => {
        const text = await Bun.file(file.path).text();
        const objectInfo = await Bun.file(dump.path).text();
        expect(
          normalizeObjectInfo(objectInfo).diagnostics.filter((d) => d.severity === "error"),
        ).toEqual([]);
        const { workflow, diagnostics } = importApi(text, looseSchema(objectInfo));
        expect(diagnostics).toEqual([]);
        expect(workflow.graph.nodes.size).toBeGreaterThan(0);
        expect([...workflow.graph.nodes.values()].filter((node) => node.raw)).toEqual([]);
        expect(stringify(toApi(workflow))).toBe(stringify(parse(text).value ?? null));
      });
    }
  }
});
