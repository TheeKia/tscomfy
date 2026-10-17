import { describe, expect, test } from "bun:test";
import { type BuildContext, type Diagnostic, exportApi, validate, workflow } from "@tscomfy/core";
import { applyModes, type ModalNode } from "../src/api/modes.ts";
import { type LooseNodes, looseSchema } from "./loose.ts";

// Bypass and mute (docs/plan.md §12), case by case against the frontend's algorithm
// (ExecutableNodeDTO `resolveOutput`, `_getBypassSlotIndex`).

function node(
  required: Record<string, unknown>,
  output: readonly string[],
  extra: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    input: { required },
    input_order: { required: Object.keys(required) },
    output,
    output_is_list: output.map(() => false),
    output_name: output,
    category: "test",
    python_module: "nodes",
    output_node: false,
    ...extra,
  };
}

const schema = looseSchema(
  JSON.stringify({
    Src: node({}, ["IMAGE", "MASK", "LATENT"]),
    // Two sockets, IMAGE and MASK, passing through.
    Pass: node({ image: ["IMAGE"], mask: ["MASK"] }, ["IMAGE", "MASK"]),
    // MASK first, so IMAGE is found by its exact type.
    Swapped: node({ mask: ["MASK"], image: ["IMAGE"] }, ["IMAGE"]),
    // A LATENT, then a union: IMAGE matches the union only by validity.
    Loose: node({ latent: ["LATENT"], either: ["IMAGE,MASK"] }, ["IMAGE"]),
    // A widget declared before a socket: the frontend lists sockets first.
    Widgeted: node({ strength: ["FLOAT", { default: 1 }], image: ["IMAGE"] }, ["IMAGE"]),
    // An untyped input: the next hop's target type is `*`.
    Any: node({ value: ["*"] }, ["IMAGE"]),
    Sink: node(
      {
        image: ["IMAGE"],
        mask: ["MASK"],
        any: ["*"],
        latent: ["LATENT"],
        either: ["IMAGE,MASK"],
      },
      [],
      { output_node: true },
    ),
  }),
);

type Links = Record<string, readonly [string, number] | undefined>;

/** Exports a graph and returns the sink's links (by input) and the diagnostics' codes and paths. */
function sinkOf(build: (context: BuildContext<LooseNodes>) => void): {
  readonly links: Links;
  readonly ids: readonly string[];
  readonly dropped: readonly (readonly (string | number)[])[];
} {
  const { prompt, diagnostics } = exportApi(workflow(schema, build), { validate: false });
  const sink = Object.values(prompt).find((each) => each.class_type === "Sink");
  const links: Links = {};
  for (const [key, value] of Object.entries(sink?.inputs ?? {})) {
    if (Array.isArray(value)) links[key] = [String(value[0]), Number(value[1])];
  }
  return {
    links,
    ids: Object.keys(prompt),
    dropped: diagnostics
      .filter((diagnostic: Diagnostic) => diagnostic.code === "W_LINK_DROPPED")
      .map((diagnostic) => diagnostic.path),
  };
}

describe("mute", () => {
  test("leaves the node out, and the inputs linked to it, but sends their consumer", () => {
    const result = sinkOf(({ n }) => {
      const [image, mask] = n["Src"]!({}, { id: "src" });
      n["Sink"]?.(
        { image: n["Pass"]!({ image, mask }, { id: "p", mode: "mute" })[0], mask },
        { id: "s" },
      );
    });
    expect(result.ids).toEqual(["src", "s"]);
    expect(result.links).toEqual({ mask: ["src", 1] });
    expect(result.dropped).toEqual([["s", "inputs", "image"]]);
  });

  test("makes a required input missing, which validation then reports", () => {
    const built = workflow(schema, ({ n }) => {
      const [image, mask, latent] = n["Src"]!({}, { id: "src" });
      const muted = n["Pass"]!({ image, mask }, { id: "p", mode: "mute" });
      n["Sink"]?.({ image: muted[0], mask, any: image, latent, either: image }, { id: "s" });
    });
    expect(validate(built).map((diagnostic) => [diagnostic.code, diagnostic.path])).toEqual([
      ["W_LINK_DROPPED", ["s", "inputs", "image"]],
      ["E_MISSING_INPUT", ["s", "inputs", "image"]],
    ]);
  });
});

describe("bypass", () => {
  test("2. takes the input at the output's index when it fits both types", () => {
    const result = sinkOf(({ n }) => {
      const [image, mask] = n["Src"]!({}, { id: "src" });
      const passed = n["Pass"]!({ image, mask }, { id: "p", mode: "bypass" });
      n["Sink"]?.({ image: passed[0], mask: passed[1] }, { id: "s" });
    });
    expect(result.ids).toEqual(["src", "s"]);
    expect(result.links).toEqual({ image: ["src", 0], mask: ["src", 1] });
  });

  test("3. else the first input of exactly the target's type", () => {
    const result = sinkOf(({ n }) => {
      const [image, mask] = n["Src"]!({}, { id: "src" });
      n["Sink"]?.(
        { image: n["Swapped"]!({ mask, image }, { id: "w", mode: "bypass" }) },
        { id: "s" },
      );
    });
    expect(result.links).toEqual({ image: ["src", 0] });
  });

  test("4. else the first input valid for both", () => {
    const result = sinkOf(({ n }) => {
      const [image, , latent] = n["Src"]!({}, { id: "src" });
      const passed = n["Loose"]!({ latent, either: image }, { id: "l", mode: "bypass" });
      n["Sink"]?.({ image: passed }, { id: "s" });
    });
    expect(result.links).toEqual({ image: ["src", 0] });
  });

  test("5. else the link is dropped, with a warning", () => {
    const result = sinkOf(({ n }) => {
      const [image, mask] = n["Src"]!({}, { id: "src" });
      n["Sink"]?.(
        { latent: n["Pass"]!({ image, mask }, { id: "p", mode: "bypass" })[0] },
        { id: "s" },
      );
    });
    expect(result.links).toEqual({});
    expect(result.dropped).toEqual([["s", "inputs", "latent"]]);
  });

  test("1. for a `*` target, the input at the output's index, or the first", () => {
    const result = sinkOf(({ n }) => {
      const [image, mask] = n["Src"]!({}, { id: "src" });
      const passed = n["Pass"]!({ image, mask }, { id: "p", mode: "bypass" });
      n["Sink"]?.({ any: passed[1] }, { id: "s" });
    });
    expect(result.links).toEqual({ any: ["src", 1] });
    // Output 0 of a node with no inputs: index 0, which doesn't exist, so nothing.
    const empty = sinkOf(({ n }) => {
      n["Sink"]?.({ any: n["Src"]!({}, { id: "src", mode: "bypass" })[2] }, { id: "s" });
    });
    expect(empty.dropped).toEqual([["s", "inputs", "any"]]);
  });

  test("lists sockets before widgets, whatever the declaration order", () => {
    const result = sinkOf(({ n }) => {
      const [image] = n["Src"]!({}, { id: "src" });
      n["Sink"]?.(
        { any: n["Widgeted"]!({ strength: 0.5, image }, { id: "g", mode: "bypass" }) },
        { id: "s" },
      );
    });
    // Slot 0 is the image socket, not the strength widget declared before it.
    expect(result.links).toEqual({ any: ["src", 0] });
  });

  test("drops the link when the input it chooses isn't linked", () => {
    const result = sinkOf(({ n }) => {
      const [, mask] = n["Src"]!({}, { id: "src" });
      n["Sink"]?.({ image: n["Pass"]!({ mask }, { id: "p", mode: "bypass" })[0] }, { id: "s" });
    });
    expect(result.links).toEqual({});
    expect(result.dropped).toEqual([["s", "inputs", "image"]]);
  });

  test("resolves through chains, checking each hop against the input it passed through", () => {
    // Any's input is `*`, so the hop into Swapped uses rule 1 (same index: its MASK input),
    // though the sink wanted an IMAGE.
    const result = sinkOf(({ n }) => {
      const [image, mask] = n["Src"]!({}, { id: "src" });
      const swapped = n["Swapped"]!({ mask, image }, { id: "w", mode: "bypass" });
      const any = n["Any"]!({ value: swapped }, { id: "a", mode: "bypass" });
      n["Sink"]?.({ image: any }, { id: "s" });
    });
    expect(result.ids).toEqual(["src", "s"]);
    expect(result.links).toEqual({ image: ["src", 1] });
  });

  test("hands a muted node behind a bypassed one nothing to link", () => {
    const result = sinkOf(({ n }) => {
      const [image, mask] = n["Src"]!({}, { id: "src" });
      const muted = n["Pass"]!({ image, mask }, { id: "m", mode: "mute" });
      const passed = n["Pass"]!({ image: muted[0], mask }, { id: "p", mode: "bypass" });
      n["Sink"]?.({ image: passed[0], mask: passed[1] }, { id: "s" });
    });
    expect(result.links).toEqual({ mask: ["src", 1] });
    expect(result.dropped).toEqual([["s", "inputs", "image"]]);
  });

  test("doesn't send a bypassed output node", () => {
    const result = sinkOf(({ n }) => {
      const [image] = n["Src"]!({}, { id: "src" });
      n["Sink"]?.({ image }, { id: "s", mode: "bypass" });
    });
    expect(result.ids).toEqual(["src"]);
  });

  test("drops links through bypassed nodes that form a cycle, rather than looping", () => {
    // The builder can't make a cycle; an imported UI workflow could.
    const definition = schema.nodes["Pass"];
    const sink = schema.nodes["Sink"];
    const pass = (id: string, from: string): ModalNode => ({
      id,
      node: { class_type: "Pass", inputs: { image: [from, 0] } },
      definition,
      mode: "bypass",
    });
    const diagnostics: Diagnostic[] = [];
    const entries = applyModes(
      [
        pass("a", "b"),
        pass("b", "a"),
        {
          id: "s",
          node: { class_type: "Sink", inputs: { image: ["a", 0] } },
          definition: sink,
          mode: undefined,
        },
      ],
      diagnostics,
    );
    expect(entries).toEqual([["s", { class_type: "Sink", inputs: {} }]]);
    expect(diagnostics.map((diagnostic) => diagnostic.message)).toEqual([
      "Input image of node s is left out: the bypassed nodes it is linked through form a cycle at node a.",
    ]);
  });
});
