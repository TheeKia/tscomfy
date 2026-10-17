import { describe, expect, test } from "bun:test";
import { diffSchemas, hashSchema, normalizeObjectInfo, type Schema } from "@tscomfy/core";
import { MOCK_OBJECT_INFO_NAMES, readMockObjectInfo } from "@tscomfy/fixtures";

/** A schema of raw nodes, each given as its required inputs and any other fields to override. */
function schema(
  nodes: Readonly<Record<string, readonly [Record<string, unknown>, object?]>>,
): Schema {
  const raw = Object.fromEntries(
    Object.entries(nodes).map(([name, [required, overrides]]) => [
      name,
      {
        input: { required },
        input_order: { required: Object.keys(required) },
        output: ["IMAGE"],
        output_is_list: [false],
        output_name: ["IMAGE"],
        name,
        display_name: name,
        description: "",
        python_module: "nodes",
        category: "test",
        output_node: false,
        ...overrides,
      },
    ]),
  );
  const { schema: result, diagnostics } = normalizeObjectInfo(JSON.stringify(raw));
  expect(diagnostics).toEqual([]);
  return result;
}

const NONE = { added: [], removed: [], changed: [] };
const UNCHANGED = {
  inputsAdded: [],
  inputsRemoved: [],
  inputsChanged: [],
  outputsChanged: false,
  detailsChanged: false,
};

describe("diffSchemas", () => {
  test("finds nothing between a schema and itself, for every mock", async () => {
    for (const name of MOCK_OBJECT_INFO_NAMES) {
      // oxlint-disable-next-line no-await-in-loop -- reading mocks one by one is fine in a test
      const { schema: each } = normalizeObjectInfo(await readMockObjectInfo(name));
      expect(diffSchemas(each, each)).toEqual(NONE);
    }
  });

  test("lists added and removed nodes in code-unit order", () => {
    const before = schema({ b: [{}], Kept: [{}], a: [{}] });
    const after = schema({ Kept: [{}], Z: [{}], C: [{}] });
    expect(diffSchemas(before, after)).toEqual({
      added: ["C", "Z"],
      removed: ["a", "b"],
      changed: [],
    });
  });

  test("lists inputs added and removed, in their node's order", () => {
    const before = schema({ N: [{ a: ["INT"], b: ["INT"], c: ["INT"] }] });
    const after = schema({ N: [{ d: ["INT"], a: ["INT"], e: ["INT"] }] });
    expect(diffSchemas(before, after).changed).toEqual([
      { ...UNCHANGED, classType: "N", inputsAdded: ["d", "e"], inputsRemoved: ["b", "c"] },
    ]);
  });

  test("tells combo options apart from other changes to a combo", () => {
    const before = schema({
      N: [{ only: [["a", "b", 1]], spec: [["a", "b"]], moved: [["a", "b"]] }],
    });
    const after = schema({
      N: [
        { only: [["b", 1, true, "c"]], spec: [["a", "b"], { default: "b" }], moved: [["b", "a"]] },
      ],
    });
    expect(diffSchemas(before, after).changed[0]?.inputsChanged).toEqual([
      { name: "only", optionsAdded: [true, "c"], optionsRemoved: ["a"], specChanged: false },
      { name: "spec", optionsAdded: [], optionsRemoved: [], specChanged: true },
      // The same options in another order: the frontend's first option, a default, changes.
      { name: "moved", optionsAdded: [], optionsRemoved: [], specChanged: true },
    ]);
  });

  test("reports any change to a non-combo input, or a change of kind, as a spec change", () => {
    const before = schema({ N: [{ bound: ["INT", { max: 10 }], kind: [["a"]], link: ["IMAGE"] }] });
    const after = schema({
      N: [{ bound: ["INT", { max: 20 }], kind: ["STRING"], link: ["MASK"] }],
    });
    expect(diffSchemas(before, after).changed[0]?.inputsChanged).toEqual(
      ["bound", "kind", "link"].map((name) => ({
        name,
        optionsAdded: [],
        optionsRemoved: [],
        specChanged: true,
      })),
    );
  });

  test("flags changed outputs, details, and a reordering of the inputs both sides have", () => {
    const before = schema({
      Outputs: [{}],
      Details: [{}],
      Order: [{ a: ["INT"], b: ["INT"], c: ["INT"] }],
      Shrunk: [{ a: ["INT"], b: ["INT"] }],
    });
    const after = schema({
      Outputs: [{}, { output: ["MASK"] }],
      Details: [{}, { category: "moved", output_node: true }],
      Order: [{ b: ["INT"], a: ["INT"], c: ["INT"] }],
      Shrunk: [{ b: ["INT"] }],
    });
    expect(diffSchemas(before, after).changed).toEqual([
      { ...UNCHANGED, classType: "Details", detailsChanged: true },
      { ...UNCHANGED, classType: "Order", detailsChanged: true },
      { ...UNCHANGED, classType: "Outputs", outputsChanged: true },
      // Removing an input isn't a reordering of the rest.
      { ...UNCHANGED, classType: "Shrunk", inputsRemoved: ["a"] },
    ]);
  });

  test("is empty exactly when the hashes are equal", () => {
    const variants = [
      schema({ N: [{ a: [["x", "y"]] }] }),
      schema({ N: [{ a: [["y", "x"]] }] }),
      schema({ N: [{ a: [["x", "y"]] }, { description: "new" }] }),
      schema({ N: [{ a: [["x", "y"]] }], M: [{}] }),
    ];
    for (const before of variants) {
      for (const after of variants) {
        const { added, removed, changed } = diffSchemas(before, after);
        const empty = added.length + removed.length + changed.length === 0;
        expect(empty).toBe(hashSchema(before) === hashSchema(after));
      }
    }
  });
});
