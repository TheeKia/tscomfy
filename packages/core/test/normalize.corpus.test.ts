import { describe, expect, test } from "bun:test";
import { normalizeObjectInfo, parse, stringify } from "@tscomfy/core";
import { listCorpus } from "@tscomfy/fixtures";
import { isJsonObject } from "../src/json/value.ts";

// Corpus tests (docs/plan.md §13): the same checks as the mock suites, on real local dumps.

const dumps = await listCorpus("object-info");

describe("normalize the corpus", () => {
  if (dumps.length === 0) test.skip("object-info is empty", () => {});

  for (const dump of dumps) {
    test(`${dump.name}: every node normalizes or has an error diagnostic`, async () => {
      const text = await Bun.file(dump.path).text();
      const { schema, diagnostics } = normalizeObjectInfo(text);
      const root = parse(text).value;
      const listed = isJsonObject(root) ? Object.keys(root) : [];
      const dropped = new Set(
        diagnostics
          .filter((diagnostic) => diagnostic.code === "E_INVALID_NODE")
          .map((diagnostic) => diagnostic.path[0]),
      );
      for (const classType of listed) {
        expect(Object.hasOwn(schema.nodes, classType) !== dropped.has(classType)).toBeTrue();
      }
      for (const diagnostic of diagnostics) {
        expect(diagnostic.path.length).toBeGreaterThan(0);
        expect(listed).toContain(String(diagnostic.path[0]));
      }
    });

    test(`${dump.name}: is deterministic and serializable`, async () => {
      const text = await Bun.file(dump.path).text();
      const first = stringify(normalizeObjectInfo(text).schema);
      expect(stringify(normalizeObjectInfo(text).schema)).toBe(first);
      expect(parse(first).diagnostics).toEqual([]);
    });

    test(`${dump.name}: parse keeps every value, big integers included`, async () => {
      const { value, diagnostics } = parse(await Bun.file(dump.path).text());
      expect(diagnostics).toEqual([]);
      expect(parse(stringify(value!)).value).toEqual(value);
    });
  }
});
