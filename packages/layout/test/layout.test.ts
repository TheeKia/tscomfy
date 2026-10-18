import { describe, expect, test } from "bun:test";
import {
  defineSchema,
  importApi,
  normalizeObjectInfo,
  stringify,
  toUi,
  typedSchema,
  uiNodeSizes,
  type Workflow,
  workflow,
} from "@tscomfy/core";
import {
  type MockApiWorkflowName,
  type MockObjectInfoName,
  readMockApiWorkflow,
  readMockObjectInfo,
} from "@tscomfy/fixtures";
import { layered, layout } from "@tscomfy/layout";

/** A saved node's position. */
const pos = (node: unknown): unknown =>
  typeof node === "object" && node !== null && "pos" in node ? node.pos : undefined;

/** A mock prompt imported over its mock schema. */
async function imported(
  schemaName: MockObjectInfoName,
  promptName: MockApiWorkflowName,
): Promise<Workflow> {
  const schema = typedSchema(normalizeObjectInfo(await readMockObjectInfo(schemaName)).schema);
  const { workflow: built, diagnostics } = importApi(await readMockApiWorkflow(promptName), schema);
  expect(diagnostics).toEqual([]);
  return built;
}

/** Each node's column: the distinct x positions, in order. */
function columns(
  positions: ReadonlyMap<string, readonly [number, number]>,
): Record<string, number> {
  const xs = [...new Set([...positions.values()].map(([x]) => x))].toSorted((a, b) => a - b);
  return Object.fromEntries([...positions].map(([id, [x]]) => [id, xs.indexOf(x)]));
}

describe("layered", () => {
  test("puts each box a column right of its rightmost source, ordered by its sources' rows", () => {
    const positions = layered(
      [
        { id: "a", width: 100, height: 50, sources: [] },
        { id: "b", width: 100, height: 50, sources: [] },
        { id: "c", width: 200, height: 50, sources: ["b"] },
        { id: "d", width: 100, height: 50, sources: ["a"] },
        { id: "e", width: 100, height: 50, sources: ["c", "d"] },
      ],
      { column: 10, row: 5 },
    );
    expect(Object.fromEntries(positions)).toEqual({
      a: [0, 0],
      b: [0, 55],
      // d's source (a) is in row 0, c's (b) in row 1: d goes first.
      d: [110, 0],
      c: [110, 55],
      e: [320, 0],
    });
  });

  test("ignores unknown sources and breaks cycles, deterministically", () => {
    const boxes = [
      { id: "x", width: 10, height: 10, sources: ["y", "nowhere"] },
      { id: "y", width: 10, height: 10, sources: ["x"] },
    ];
    expect(layered(boxes)).toEqual(layered(boxes));
    expect([...layered(boxes).keys()].toSorted()).toEqual(["x", "y"]);
  });

  test("refuses two boxes with one id", () => {
    const box = { id: "a", width: 10, height: 10, sources: [] };
    expect(() => layered([box, { ...box, sources: ["a"] }])).toThrow(
      new TypeError('layered: two boxes have the id "a"'),
    );
  });

  test("spaces columns 80 and rows 40 apart unless told otherwise", () => {
    const boxes = [
      { id: "a", width: 100, height: 50, sources: [] },
      { id: "b", width: 100, height: 50, sources: [] },
      { id: "c", width: 100, height: 50, sources: ["a"] },
    ];
    expect(Object.fromEntries(layered(boxes))).toEqual({ a: [0, 0], b: [0, 90], c: [180, 0] });
  });

  test("lays out long chains without deep recursion", () => {
    const boxes = Array.from({ length: 50_000 }, (_, index) => ({
      id: String(index),
      width: 10,
      height: 10,
      sources: index === 0 ? [] : [String(index - 1)],
    }));
    expect(layered(boxes).get("49999")).toEqual([49_999 * 90, 0]);
  });
});

describe("layout", () => {
  test("gives every node of a workflow a position toUi uses", async () => {
    const schema = defineSchema(
      stringify(normalizeObjectInfo(await readMockObjectInfo("basic-pipeline")).schema),
    );
    const built = workflow(schema, ({ raw }) => {
      const vae = raw("VAELoader", { vae_name: "pixel_space" }).output(0);
      raw("VAEDecode", { vae });
    });
    const positions = layout(built);
    expect([...positions.keys()]).toEqual(["1", "2"]);
    const nodes = toUi(built, { positions }).workflow["nodes"];
    expect(Array.isArray(nodes) ? nodes.map(pos) : []).toEqual([
      [0, 0],
      [400, 0],
    ]);
  });

  test("takes the spacing it is given", async () => {
    const schema = defineSchema(
      stringify(normalizeObjectInfo(await readMockObjectInfo("basic-pipeline")).schema),
    );
    const built = workflow(schema, ({ raw }) => {
      const vae = raw("VAELoader", { vae_name: "pixel_space" }).output(0);
      raw("VAELoader", { vae_name: "pixel_space" });
      raw("VAEDecode", { vae });
    });
    const sizes = uiNodeSizes(built);
    const [width = 0] = sizes.get("1") ?? [];
    const [, height = 0] = sizes.get("1") ?? [];
    expect(Object.fromEntries(layout(built, { column: 7, row: 3 }))).toEqual({
      "1": [0, 0],
      "2": [0, height + 3],
      "3": [width + 7, 0],
    });
  });

  test("follows links inside lists: Autogrow slots", async () => {
    const built = await imported("autogrow", "autogrow");
    // Node 2's only links are in its list of slots, node 3's in its own.
    expect(built.graph.nodes.get("2")?.inputs["images"]).toBeArray();
    expect(built.graph.nodes.get("3")?.inputs["ref_images"]).toBeArray();
    expect(columns(layout(built))).toEqual({ "1": 0, "6": 0, "2": 1, "4": 1, "3": 2, "5": 2 });
  });

  test("follows links inside dynamic-combo options, nested ones too", async () => {
    const built = await imported("dynamic-combo", "dynamic-combo");
    // Node 7's only link is in its option's Autogrow: { option, inputs: { images: [ref] } }.
    expect(built.graph.nodes.get("7")?.inputs["model"]).toMatchObject({ option: "Model [pro]" });
    expect(columns(layout(built))).toMatchObject({ "2": 0, "7": 1 });
  });
});
