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
    // A socketless widget, then a socket: the frontend still gives the widget a slot (probed).
    Socketless: node({ text: ["STRING", { default: "q", socketless: true }], image: ["IMAGE"] }, [
      "IMAGE",
      "IMAGE",
    ]),
    // An untyped input: the next hop's target type is `*`.
    Any: node({ value: ["*"] }, ["IMAGE"]),
    Switch: node(
      {
        on_false: ["COMFY_MATCHTYPE_V3", { template: { template_id: "t", allowed_types: "*" } }],
        on_true: ["COMFY_MATCHTYPE_V3", { template: { template_id: "t", allowed_types: "*" } }],
      },
      ["COMFY_MATCHTYPE_V3"],
      { output_matchtypes: ["t"] },
    ),
    // A legacy combo with forceInput is a socket to the frontend, in declaration order.
    Forced: node(
      {
        steps: ["INT", { default: 20 }],
        sampler: [["a", "b"], { forceInput: true }],
        image: ["IMAGE"],
      },
      ["COMBO", "IMAGE"],
    ),
    // An optional widget the frontend never sends (CameraAngle's view): it has no default to send.
    Viewed: node({}, [], {
      input: { optional: { view: ["INT", { default: 3, widgetType: "CAMERA_ANGLE_VIEW" }] } },
    }),
    // A dynamic combo whose option has a widget before a socket.
    Options: node(
      {
        mode: [
          "COMFY_DYNAMICCOMBO_V3",
          {
            options: [
              {
                key: "a",
                inputs: { required: { strength: ["FLOAT", { default: 1 }], image: ["IMAGE"] } },
              },
              { key: "b", inputs: { required: {} } },
            ],
          },
        ],
      },
      ["IMAGE", "IMAGE"],
    ),
    Seeded: node({ seed: ["INT", { default: 7 }], noise: ["INT"] }, ["LATENT"], {
      output_node: true,
    }),
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

describe("slots", () => {
  test("a socketless widget has a slot, which an untyped link through a bypass picks", () => {
    // Probed in frontend 1.55.17: output 1 of the bypassed node into `*` takes input 1, the
    // widget's slot (sockets first: image, text), which isn't linked: nothing is sent.
    const result = sinkOf(({ n }) => {
      const [image] = n["Src"]!({}, { id: "src" });
      const bypassed = n["Socketless"]!({ image }, { id: "b", mode: "bypass" });
      n["Sink"]?.({ any: bypassed[1] }, { id: "s" });
    });
    expect(result.links).toEqual({});
    expect(result.dropped).toEqual([["s", "inputs", "any"]]);
  });
});

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
    // (The frontend, given a node with no input at all, throws rather than build the prompt;
    // here the link is dropped and reported.)
    const result = sinkOf(({ n }) => {
      const [image, mask] = n["Src"]!({}, { id: "src" });
      const passed = n["Pass"]!({ image, mask }, { id: "p", mode: "bypass" });
      n["Sink"]?.({ any: passed[1] }, { id: "s" });
    });
    expect(result.links).toEqual({ any: ["src", 1] });
    // Output 2 of a node with no inputs: rule 1 picks input 0, which doesn't exist.
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

describe("slots as the frontend has them", () => {
  test("narrows MatchType types by the node's links, for the consumer and the bypassed node", () => {
    // on_true's IMAGE narrows on_false to IMAGE, so the bypassed Swapped's IMAGE input (rule 3)
    // feeds it, not the MASK one at the same index (rule 1, were on_false still `*`).
    const result = sinkOf(({ n }) => {
      const [image, mask] = n["Src"]!({}, { id: "src" });
      const swapped = n["Swapped"]!({ mask, image }, { id: "w", mode: "bypass" });
      const picked = n["Switch"]!({ on_false: swapped, on_true: image }, { id: "sw" });
      n["Sink"]?.({ image: picked }, { id: "s" });
    });
    const { prompt } = exportApi(
      workflow(schema, ({ n }) => {
        const [image, mask] = n["Src"]!({}, { id: "src" });
        const swapped = n["Swapped"]!({ mask, image }, { id: "w", mode: "bypass" });
        n["Switch"]?.({ on_false: swapped, on_true: image }, { id: "sw" });
      }),
      { validate: false },
    );
    expect(prompt["sw"]?.inputs).toEqual({ on_false: ["src", 0], on_true: ["src", 0] });
    expect(result.links).toEqual({ image: ["sw", 0] });
  });

  test("narrows a bypassed MatchType node's output to what its links share", () => {
    // The bypassed switch's output is IMAGE (its on_true), so its IMAGE input is chosen.
    const result = sinkOf(({ n }) => {
      const [image, mask] = n["Src"]!({}, { id: "src" });
      const picked = n["Switch"]!({ on_false: mask, on_true: image }, { id: "sw", mode: "bypass" });
      n["Sink"]?.({ either: picked }, { id: "s" });
    });
    expect(result.links).toEqual({ either: ["src", 1] });
  });

  test("lists a forceInput legacy combo among the sockets, in declaration order", () => {
    // Slots: sampler (socket), image (socket), steps (widget): output 1 takes input 1, the image.
    const result = sinkOf(({ n }) => {
      const [options, image] = n["Src"]!({}, { id: "src" });
      const forced = n["Forced"]!({ sampler: options, image }, { id: "f", mode: "bypass" });
      n["Sink"]?.({ any: forced[1] }, { id: "s" });
    });
    expect(result.links).toEqual({ any: ["src", 1] });
  });

  test("lists a chosen option's inputs in declaration order, after the combo's slot", () => {
    // Slots: mode, mode.strength, mode.image: output 1 takes mode.strength, which isn't linked.
    const result = sinkOf(({ n }) => {
      const image = n["Src"]!({}, { id: "src" })[0]!;
      const options = n["Options"]!(
        { mode: { option: "a", inputs: { image } } },
        { id: "o", mode: "bypass" },
      );
      n["Sink"]?.({ any: options[1] }, { id: "s" });
    });
    expect(result.links).toEqual({});
    expect(result.dropped).toEqual([["s", "inputs", "any"]]);
  });

  test("keeps a widget's value when its link resolves to nothing", () => {
    const { prompt, diagnostics } = exportApi(
      workflow(schema, ({ n }) => {
        const [, , latent] = n["Src"]!({}, { id: "src" });
        const muted = n["Pass"]!({}, { id: "m", mode: "mute" });
        n["Seeded"]?.({ seed: muted[0], noise: muted[0] }, { id: "s" });
        void latent;
      }),
      { validate: false },
    );
    // seed is a widget with a default: the frontend sends that; noise has none: left out.
    expect(prompt["s"]?.inputs).toEqual({ seed: 7 });
    expect(diagnostics.map((diagnostic) => diagnostic.message)).toEqual([
      "Input seed of node s sends its widget's value instead: it is linked to node m, which is muted.",
      "Input noise of node s is left out: it is linked to node m, which is muted.",
    ]);
  });

  test("gives a raw node's widget its value too when its link resolves to nothing", () => {
    // The frontend's node has the widget, holding that value. And the transpiler writes a node
    // the types can't express as raw, which must export as the node did.
    const typed = workflow(schema, ({ n }) => {
      const muted = n["Pass"]!({}, { id: "m", mode: "mute" });
      n["Seeded"]?.({ seed: muted[0]! }, { id: "s" });
    });
    const rawNode = workflow(schema, ({ n, raw }) => {
      const muted = n["Pass"]!({}, { id: "m", mode: "mute" });
      raw("Seeded", { seed: muted[0]! }, { id: "s" });
    });
    const prompt = exportApi(typed, { validate: false }).prompt;
    expect(prompt["s"]?.inputs).toEqual({ seed: 7 });
    expect(exportApi(rawNode, { validate: false }).prompt).toEqual(prompt);
  });

  test("sends no default for a widget the frontend never sends when its link resolves to nothing", () => {
    const { prompt, diagnostics } = exportApi(
      workflow(schema, ({ n }) => {
        const muted = n["Pass"]!({}, { id: "m", mode: "mute" });
        n["Viewed"]?.({ view: muted[0] }, { id: "v" });
      }),
      { validate: false },
    );
    expect(prompt["v"]?.inputs).toEqual({});
    expect(diagnostics.map((diagnostic) => diagnostic.message)).toEqual([
      "Input view of node v is left out: it is linked to node m, which is muted.",
    ]);
  });

  test.each(["bypass", "mute"] as const)(
    "keeps a link to an output a node on %s doesn't have, for validation to report",
    (mode) => {
      const built = workflow(schema, ({ n, raw }) => {
        const image = n["Src"]!({}, { id: "src" })[0]!;
        const off = raw("Pass", { image }, { id: "p", mode });
        n["Sink"]?.({ image: off.output(5) }, { id: "s" });
      });
      const { prompt, diagnostics } = exportApi(built);
      expect(prompt["s"]?.inputs).toEqual({ image: ["p", 5] });
      expect(diagnostics.map((diagnostic) => [diagnostic.code, diagnostic.path])).toContainEqual([
        "E_DANGLING_LINK",
        ["s", "inputs", "image"],
      ]);
    },
  );
});

describe("modes", () => {
  test("refuse anything but bypass and mute at runtime", () => {
    expect(() =>
      workflow(schema, ({ raw }) => {
        Reflect.apply(raw, undefined, ["Src", {}, { mode: "always" }]);
      }),
    ).toThrow(TypeError);
  });

  test("resolve many links through a long bypassed chain in linear time", () => {
    const built = workflow(schema, ({ n }) => {
      const [image, mask] = n["Src"]!({}, { id: "src" });
      let current = n["Pass"]!({ image, mask }, { id: "p0", mode: "bypass" });
      for (let index = 1; index < 10_000; index++) {
        current = n["Pass"]!(
          { image: current[0], mask },
          { id: `p${String(index)}`, mode: "bypass" },
        );
        n["Sink"]?.({ image: current[0] }, { id: `s${String(index)}` });
      }
    });
    const started = performance.now();
    const { prompt } = exportApi(built, { validate: false });
    expect(performance.now() - started).toBeLessThan(2_000);
    expect(prompt["s9999"]?.inputs).toEqual({ image: ["src", 0] });
  });
});
