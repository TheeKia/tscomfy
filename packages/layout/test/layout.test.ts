import { describe, expect, test } from "bun:test";
import { defineSchema, normalizeObjectInfo, stringify, toUi, workflow } from "@tscomfy/core";
import { readMockObjectInfo } from "@tscomfy/fixtures";
import { layered, layout } from "@tscomfy/layout";

/** A saved node's position. */
const pos = (node: unknown): unknown =>
  typeof node === "object" && node !== null && "pos" in node ? node.pos : undefined;

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
});
