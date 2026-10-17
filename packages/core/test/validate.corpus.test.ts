import { describe, expect, test } from "bun:test";
import { normalizeObjectInfo, parse, validateApi } from "@tscomfy/core";
import { listCorpus } from "@tscomfy/fixtures";

// Corpus tests (docs/plan.md §13): every API workflow the frontend exported must validate against
// the dump of the server it came from without an error. Validation may be stricter than the
// backend only where the types are; frontend output is what the types model.

const dumps = await listCorpus("object-info");
const workflows = await listCorpus("workflows/api");

describe("validate the corpus workflows", () => {
  if (dumps.length === 0 || workflows.length === 0) {
    test.skip("object-info or workflows/api is empty", () => {});
  }
  for (const dump of dumps) {
    for (const file of workflows) {
      test(`${file.name} over ${dump.name}`, async () => {
        const { schema } = normalizeObjectInfo(await Bun.file(dump.path).text());
        const parsed = parse(await Bun.file(file.path).text());
        expect(parsed.diagnostics).toEqual([]);
        const diagnostics = validateApi(parsed.value ?? null, schema);
        expect(diagnostics.filter((diagnostic) => diagnostic.severity === "error")).toEqual([]);
      });
    }
  }
});
