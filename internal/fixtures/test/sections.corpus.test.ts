import { describe, expect, test } from "bun:test";
import { type CorpusSection, listCorpus } from "@tscomfy/fixtures";

// Later corpus tests trust each section to hold the format it is named after, so check that first.
// Plain JSON.parse is enough here: only the shape is inspected, never a big integer.

type ShapeCheck = (value: unknown) => boolean;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

const isObjectInfo: ShapeCheck = (value) =>
  isRecord(value) &&
  Object.values(value).every((node) => isRecord(node) && "input" in node && "output" in node);

const isApiWorkflow: ShapeCheck = (value) =>
  isRecord(value) &&
  Object.values(value).every(
    (node) => isRecord(node) && typeof node["class_type"] === "string" && isRecord(node["inputs"]),
  );

const isUiWorkflow: ShapeCheck = (value) => isRecord(value) && Array.isArray(value["nodes"]);

const sections: readonly (readonly [CorpusSection, string, ShapeCheck])[] = [
  ["object-info", "an /object_info response", isObjectInfo],
  ["workflows/api", "an API-format workflow", isApiWorkflow],
  ["workflows/ui", "a UI-format workflow", isUiWorkflow],
];

const listings = await Promise.all(sections.map(([section]) => listCorpus(section)));

for (const [index, [section, format, check]] of sections.entries()) {
  const files = listings[index] ?? [];
  describe(section, () => {
    if (files.length === 0) {
      test.skip("is empty", () => {});
    }
    for (const file of files) {
      test(`${file.name} is ${format}`, async () => {
        expect(check(JSON.parse(await Bun.file(file.path).text()))).toBeTrue();
      });
    }
  });
}
