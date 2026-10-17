import { describe, expect, test } from "bun:test";
import {
  type ApiNode,
  type ApiPrompt,
  type JsonValue,
  normalizeObjectInfo,
  parse,
  validateApi,
} from "@tscomfy/core";
import { listCorpus } from "@tscomfy/fixtures";
import { isJsonObject } from "../src/json/value.ts";

// Corpus tests (docs/plan.md §13): every API workflow the frontend exported must validate against
// the dump of the server it came from without an error. Validation may be stricter than the
// backend only where the types are; frontend output is what the types model.

const dumps = await listCorpus("object-info");
const workflows = await listCorpus("workflows/api");

/** A parsed prompt, if it has the API shape. */
function asPrompt(value: JsonValue | undefined): ApiPrompt | undefined {
  if (!isJsonObject(value)) return undefined;
  const nodes: [string, ApiNode][] = [];
  for (const [id, node] of Object.entries(value)) {
    if (!isJsonObject(node)) return undefined;
    const { class_type: classType, inputs } = node;
    if (typeof classType !== "string" || !isJsonObject(inputs)) return undefined;
    nodes.push([id, { class_type: classType, inputs }]);
  }
  return Object.fromEntries(nodes);
}

describe("validate the corpus workflows", () => {
  if (dumps.length === 0 || workflows.length === 0) {
    test.skip("object-info or workflows/api is empty", () => {});
  }
  for (const dump of dumps) {
    for (const file of workflows) {
      test(`${file.name} over ${dump.name}`, async () => {
        const { schema } = normalizeObjectInfo(await Bun.file(dump.path).text());
        const parsed = parse(await Bun.file(file.path).text());
        const prompt = asPrompt(parsed.value);
        expect(prompt).toBeDefined();
        const diagnostics = validateApi(prompt ?? {}, schema);
        expect(diagnostics.filter((diagnostic) => diagnostic.severity === "error")).toEqual([]);
      });
    }
  }
});
