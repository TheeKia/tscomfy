import { describe, expect, test } from "bun:test";
import { join } from "node:path";
import { importUi, parse, stringify, toApi, toUi } from "@tscomfy/core";
import { CORPUS_DIR, listCorpus } from "@tscomfy/fixtures";
import { isJsonObject } from "../src/json/value.ts";
import { looseSchema } from "./loose.ts";
import { renumbered } from "./prompts.ts";

// Corpus tests (docs/plan.md §14 Phase 8): every UI workflow imports to the prompt frontend
// 1.55.17 builds for it (captured into workflows/ui-api by internal/fixtures/scripts/frontend.ts),
// node by node, key order included; and loading our export of it gives the same prompt again.
//
// What pack JavaScript changes at queue time can't be reproduced from the schema. Such nodes are
// declared, with a reason, in corpus/workflows/ui-differences.json: {"<file>": {"<id>": "why"}}.

const dumps = await listCorpus("object-info");
const workflows = await listCorpus("workflows/ui");
const captures = new Map((await listCorpus("workflows/ui-api")).map((file) => [file.name, file]));
const differencesFile = Bun.file(join(CORPUS_DIR, "workflows", "ui-differences.json"));
const differences = (await differencesFile.exists())
  ? parse(await differencesFile.text()).value
  : undefined;

/** The ids declared to differ in one file. */
function declared(name: string): string[] {
  const entry = isJsonObject(differences) ? differences[name] : undefined;
  return isJsonObject(entry) ? Object.keys(entry) : [];
}

describe("import the corpus UI workflows as the frontend does", () => {
  if (dumps.length === 0 || captures.size === 0) {
    test.skip("object-info or workflows/ui-api is empty", () => {});
  }
  for (const dump of dumps) {
    for (const file of workflows) {
      const capture = captures.get(file.name);
      if (capture === undefined) continue;
      test(`${file.name} over ${dump.name}`, async () => {
        const schema = looseSchema(await Bun.file(dump.path).text());
        const { workflow, diagnostics } = importUi(await Bun.file(file.path).text(), schema);
        expect(diagnostics.filter((d) => d.severity === "error")).toEqual([]);
        const prompt = toApi(workflow, { validate: false });
        const expected = parse(await Bun.file(capture.path).text()).value;
        if (!isJsonObject(expected)) throw new Error(`${capture.name}: expected a prompt`);
        expect(Object.keys(prompt)).toEqual(Object.keys(expected));
        const differing = Object.keys(expected)
          .filter((id) => stringify(prompt[id] ?? null) !== stringify(expected[id] ?? null))
          .toSorted();
        expect(differing).toEqual(
          declared(file.name)
            .filter((id) => Object.hasOwn(expected, id))
            .toSorted(),
        );
      });
    }
  }
});

describe("our export of each corpus UI workflow imports to the same prompt", () => {
  if (dumps.length === 0 || workflows.length === 0) {
    test.skip("object-info or workflows/ui is empty", () => {});
  }
  for (const dump of dumps) {
    for (const file of workflows) {
      test(`${file.name} over ${dump.name}`, async () => {
        const schema = looseSchema(await Bun.file(dump.path).text());
        const first = importUi(await Bun.file(file.path).text(), schema).workflow;
        const { workflow: ui, ids } = toUi(first);
        const second = importUi(stringify(ui), schema);
        expect(second.diagnostics.filter((d) => d.severity === "error")).toEqual([]);
        // Subgraph interiors come back flat, under the numbers `toUi` gave them.
        expect(toApi(second.workflow, { validate: false })).toEqual(
          renumbered(toApi(first, { validate: false }), ids),
        );
      });
    }
  }
});
