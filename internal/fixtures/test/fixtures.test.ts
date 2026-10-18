import { describe, expect, test } from "bun:test";
import { readdir } from "node:fs/promises";
import {
  listCorpus,
  MOCK_API_WORKFLOW_DIR,
  MOCK_API_WORKFLOW_NAMES,
  MOCK_OBJECT_INFO_DIR,
  MOCK_OBJECT_INFO_NAMES,
  MOCK_UI_API_WORKFLOW_DIR,
  MOCK_UI_EXPORT_DIR,
  MOCK_UI_WORKFLOW_DIR,
  MOCK_UI_WORKFLOW_NAMES,
  readMockApiWorkflow,
  readMockObjectInfo,
  readMockUiApiWorkflow,
  readMockUiWorkflow,
} from "@tscomfy/fixtures";

describe("mock object_info", () => {
  test("the name list matches the files on disk", async () => {
    const onDisk = (await readdir(MOCK_OBJECT_INFO_DIR))
      .filter((name) => name.endsWith(".json"))
      .map((name) => name.slice(0, -".json".length))
      .toSorted();
    expect(onDisk).toEqual([...MOCK_OBJECT_INFO_NAMES]);
  });

  test.each(MOCK_OBJECT_INFO_NAMES)("%s is a JSON object", async (name) => {
    const parsed: unknown = JSON.parse(await readMockObjectInfo(name));
    expect(parsed).toBeObject();
    expect(Array.isArray(parsed)).toBeFalse();
  });
});

describe("mock API workflows", () => {
  test("the name list matches the files on disk", async () => {
    const onDisk = (await readdir(MOCK_API_WORKFLOW_DIR))
      .filter((name) => name.endsWith(".json"))
      .map((name) => name.slice(0, -".json".length))
      .toSorted();
    expect(onDisk).toEqual([...MOCK_API_WORKFLOW_NAMES]);
  });

  test.each(MOCK_API_WORKFLOW_NAMES)("%s is a JSON object", async (name) => {
    const parsed: unknown = JSON.parse(await readMockApiWorkflow(name));
    expect(parsed).toBeObject();
  });
});

describe("mock UI workflows", () => {
  test.each([MOCK_UI_WORKFLOW_DIR, MOCK_UI_API_WORKFLOW_DIR, MOCK_UI_EXPORT_DIR])(
    "the name list matches the files in %s",
    async (dir) => {
      const onDisk = (await readdir(dir))
        .filter((name) => name.endsWith(".json"))
        .map((name) => name.slice(0, -".json".length))
        .toSorted();
      expect(onDisk).toEqual([...MOCK_UI_WORKFLOW_NAMES]);
    },
  );

  test.each(MOCK_UI_WORKFLOW_NAMES)("%s and its prompt are JSON objects", async (name) => {
    const ui: unknown = JSON.parse(await readMockUiWorkflow(name));
    const prompt: unknown = JSON.parse(await readMockUiApiWorkflow(name));
    expect(ui).toBeObject();
    expect(prompt).toBeObject();
  });
});

describe("corpus", () => {
  const sections = ["object-info", "workflows/api", "workflows/ui", "workflows/ui-api"] as const;

  test.each(sections)("%s lists only JSON files, sorted", async (section) => {
    const names = (await listCorpus(section)).map((file) => file.name);
    expect(names).toEqual(names.toSorted());
    expect(names.every((name) => name.endsWith(".json"))).toBeTrue();
  });

  test("a missing section lists as empty", async () => {
    // @ts-expect-error -- deliberately not a CorpusSection, to exercise the ENOENT path
    expect(await listCorpus("does-not-exist")).toEqual([]);
  });
});
