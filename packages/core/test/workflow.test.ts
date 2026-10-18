import { describe, expect, test } from "bun:test";
import { type GraphNode, isOutputRef, workflow } from "@tscomfy/core";
import { readMockObjectInfo } from "@tscomfy/fixtures";
import { type LooseNodes, looseSchema } from "./loose.ts";

async function asyncBuild(): Promise<void> {
  await Promise.resolve();
}

const basic = looseSchema(await readMockObjectInfo("basic-pipeline"));
const outputs = looseSchema(await readMockObjectInfo("outputs"));

function nodes(built: {
  readonly graph: { readonly nodes: ReadonlyMap<string, GraphNode> };
}): GraphNode[] {
  return [...built.graph.nodes.values()];
}

describe("ids", () => {
  test("are sequential, skip explicit ones, and keep creation order", () => {
    const built = workflow(basic, ({ n }) => {
      n["VAELoader"]?.({ vae_name: "pixel_space" });
      n["VAELoader"]?.({ vae_name: "pixel_space" }, { id: "3" });
      n["VAELoader"]?.({ vae_name: "pixel_space" });
      n["VAELoader"]?.({ vae_name: "pixel_space" });
      n["VAELoader"]?.({ vae_name: "pixel_space" }, { id: "custom" });
    });
    expect(nodes(built).map((node) => node.id)).toEqual(["1", "3", "2", "4", "custom"]);
  });

  test.each(["", "1"])("throw for an empty or taken explicit id %p", (id) => {
    expect(() =>
      workflow(basic, ({ n }) => {
        n["VAELoader"]?.({ vae_name: "pixel_space" });
        n["VAELoader"]?.({ vae_name: "pixel_space" }, { id });
      }),
    ).toThrow(TypeError);
  });
});

describe("results", () => {
  test("match the node's outputs: a handle, one output, or a tuple with names", () => {
    workflow(basic, ({ n }) => {
      const saved = n["SaveImage"]?.({ images: n["VAEDecode"]!({}) });
      expect(saved).toMatchObject({ id: "2" });
      const vae = n["VAELoader"]!({ vae_name: "pixel_space" });
      expect(isOutputRef(vae)).toBeTrue();
      expect([vae.node, vae.slot]).toEqual(["3", 0]);
      const loaded = n["CheckpointLoaderSimple"]!({ ckpt_name: "model-a.safetensors" });
      expect(loaded).toHaveLength(3);
      expect(loaded.id).toBe("4");
      expect(Reflect.get(loaded, "CLIP")).toBe(loaded[1]);
      expect(Object.isFrozen(loaded)).toBeTrue();
    });
  });

  test("leave duplicated, reserved and numeric names to their index", () => {
    workflow(outputs, ({ n }) => {
      const result = n["MockOutputNames"]!({});
      expect(Object.keys(result).filter((key) => !/^\d+$/.test(key))).toEqual(["has space", "id"]);
      expect(result.length).toBe(7);
    });
  });

  test("are frozen references that only the builder makes", () => {
    workflow(basic, ({ n }) => {
      const vae = n["VAELoader"]!({ vae_name: "pixel_space" });
      expect(Object.isFrozen(vae)).toBeTrue();
      expect(isOutputRef({ node: "1", slot: 0 })).toBeFalse();
    });
  });
});

describe("handles", () => {
  test("are what the build function returned, kept as returned", () => {
    const built = workflow(basic, ({ n }) => {
      const save = n["SaveImage"]!({ images: n["VAEDecode"]!({}) }, { id: "save" });
      return { save, label: "kept" };
    });
    expect(built.handles.save.id).toBe("save");
    expect(built.handles.label).toBe("kept");
    expect(Object.isFrozen(built)).toBeTrue();
  });

  test("are undefined when the build function returns nothing", () => {
    const built = workflow(basic, ({ n }) => {
      n["VAELoader"]?.({ vae_name: "pixel_space" });
    });
    expect(built.handles).toBeUndefined();
    expect(Object.keys(built)).toEqual(["schema", "graph", "handles"]);
  });
});

describe("the graph", () => {
  test("records structured inputs and options, frozen", () => {
    const built = workflow(basic, ({ n }) => {
      n["EmptyLatentImage"]?.({ width: 1024, height: undefined }, { title: "Latent" });
    });
    const [latent] = nodes(built);
    expect(latent).toEqual({
      id: "1",
      classType: "EmptyLatentImage",
      inputs: { width: 1024 },
      title: "Latent",
      raw: false,
    });
    expect(Object.isFrozen(built)).toBeTrue();
    expect(Object.isFrozen(latent?.inputs)).toBeTrue();
    // Not a Map: no mutators, and Map's own methods refuse it.
    expect("set" in built.graph.nodes).toBeFalse();
    const set = (map: object): unknown => Map.prototype.set.call(map, "x", latent);
    expect(() => set(built.graph.nodes)).toThrow(TypeError);
  });

  test("records raw nodes and gives untyped outputs", () => {
    const built = workflow(basic, ({ raw }) => {
      const source = raw("SomePackNode", { "a.b": 1 });
      expect(source.output(2)).toMatchObject({ node: "1", slot: 2 });
    });
    expect(nodes(built)[0]).toMatchObject({
      classType: "SomePackNode",
      inputs: { "a.b": 1 },
      raw: true,
    });
  });

  test("keeps builds independent and closes after the build", () => {
    let leaked: LooseNodes[string] | undefined;
    const first = workflow(basic, ({ n }) => {
      workflow(basic, ({ n: inner }) => {
        inner["VAELoader"]?.({ vae_name: "pixel_space" });
      });
      n["VAELoader"]?.({ vae_name: "pixel_space" });
      leaked = n["VAELoader"];
    });
    expect(nodes(first).map((node) => node.id)).toEqual(["1"]);
    expect(() => leaked?.()).toThrow(TypeError);
  });

  test("reads unknown class types as undefined", () => {
    workflow(basic, ({ n }) => {
      expect(n["NoSuchNode"]).toBeUndefined();
      expect("KSampler" in n).toBeTrue();
      expect("NoSuchNode" in n).toBeFalse();
    });
  });

  test.each([
    ["a function", () => 1],
    ["a non-finite number", Number.NaN],
    ["a class instance", new Date(0)],
  ])("throws for an input that is %s", (_name, value) => {
    expect(() =>
      workflow(basic, ({ raw }) => {
        Reflect.apply(raw, undefined, ["X", { value }]);
      }),
    ).toThrow(TypeError);
  });

  test("rejects an output of another workflow", () => {
    let foreign: unknown;
    workflow(basic, ({ n }) => {
      foreign = n["VAELoader"]!({ vae_name: "pixel_space" });
    });
    expect(() =>
      workflow(basic, ({ raw }) => {
        Reflect.apply(raw, undefined, ["X", { vae: foreign }]);
      }),
    ).toThrow(/another workflow/);
  });

  test("rejects holes in arrays", () => {
    expect(() =>
      workflow(basic, ({ raw }) => {
        const values: number[] = [];
        values[0] = 1;
        values[2] = 3;
        raw("X", { values });
      }),
    ).toThrow(/hole/);
  });

  test("rejects an async build function", () => {
    // The types allow it (a Promise is assignable to void), so it must fail at runtime.
    expect(() => Reflect.apply(workflow, undefined, [basic, asyncBuild])).toThrow(/synchronous/);
  });

  test("closes the builder even when the build function throws", () => {
    let leaked: LooseNodes[string] | undefined;
    expect(() =>
      workflow(basic, ({ n }) => {
        leaked = n["VAELoader"];
        throw new Error("boom");
      }),
    ).toThrow("boom");
    expect(() => leaked?.({ vae_name: "pixel_space" })).toThrow(TypeError);
  });

  test("keeps n read-only", () => {
    workflow(basic, ({ n }) => {
      expect(Reflect.defineProperty(n, "VAELoader", { value: 1 })).toBeFalse();
      expect(Reflect.set(n, "VAELoader", 1)).toBeFalse();
      expect(Reflect.deleteProperty(n, "VAELoader")).toBeFalse();
      expect(typeof n["VAELoader"]).toBe("function");
    });
  });

  test.each([
    ["options that aren't an object", ["X", {}, "title"], /options must be an object/],
    ["an id that isn't a string", ["X", {}, { id: 1 }], /options.id must be a string/],
    ["a title that isn't a string", ["X", {}, { title: 1 }], /options.title must be a string/],
    ["a mode the frontend doesn't have", ["X", {}, { mode: "never" }], /options.mode/],
    ["inputs that aren't a plain object", ["X", [1]], /inputs must be a plain object/],
  ])("throws for %s", (_name, args, message) => {
    expect(() =>
      workflow(basic, ({ raw }) => {
        Reflect.apply(raw, undefined, args);
      }),
    ).toThrow(message);
  });

  test.each([-1, 1.5, Number.NaN])("rejects raw output slot %p", (slot) => {
    workflow(basic, ({ raw }) => {
      expect(() => raw("X").output(slot)).toThrow(TypeError);
    });
  });
});
