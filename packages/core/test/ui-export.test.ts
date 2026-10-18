import { describe, expect, test } from "bun:test";
import {
  type Diagnostic,
  exportApi,
  importApi,
  importUi,
  type InputDef,
  type InputValue,
  type Out,
  parse,
  stringify,
  toApi,
  toUi,
  uiNodeSizes,
  workflow,
} from "@tscomfy/core";
import {
  MOCK_API_WORKFLOW_NAMES,
  MOCK_OBJECT_INFO_NAMES,
  MOCK_UI_WORKFLOW_NAMES,
  type MockApiWorkflowName,
  type MockObjectInfoName,
  readMockApiWorkflow,
  readMockObjectInfo,
  readMockUiExportPrompt,
  readMockUiWorkflow,
} from "@tscomfy/fixtures";
import { isJsonObject } from "../src/json/value.ts";
import { looseSchema } from "./loose.ts";
import { renumbered } from "./prompts.ts";
import { schema, found, objects, widgets } from "./ui-helpers.ts";

// toUi (docs/plan.md §11): UI workflows the frontend loads to the prompt toApi builds.

describe("the widgets the frontend saves", () => {
  const built = workflow(widgets, ({ n }) => {
    n["MockControls"]?.({ seed: 1, noise_seed: 2, value: 3, steps: 4, strength: 0.5, mode: "b" });
    n["MockUploads"]?.({ image: "b.png", video: "a.mp4" });
    n["MockUploadOptional"]?.({ image: "a.png" });
    n["MockAnimatedUpload"]?.({ image: "a.webp" });
    n["MockAudioUpload"]?.({ audio: "a.wav" });
    n["MockAudioUploadOtherName"]?.({ clip: "a.wav" });
  });
  const { workflow: ui } = toUi(built);
  const saved = objects(ui["nodes"]).map((node) => [
    node["type"],
    node["widgets_values"],
    node["widgets_values_named"],
  ]);

  test("controls, filters and upload buttons, in the frontend's order", () => {
    expect(saved).toEqual([
      [
        "MockControls",
        [1, "fixed", 2, 3, "fixed", 4, 0.5, "fixed", "b", "fixed", ""],
        {
          // On by default for `seed`; off for `noise_seed` with an explicit false; named after
          // a string option; a name an earlier control has gets `#1`, `#2` (the frontend's
          // `ensureUniqueWidgetNames`).
          seed: 1,
          control_after_generate: "fixed",
          noise_seed: 2,
          value: 3,
          fixed: "fixed",
          steps: 4,
          strength: 0.5,
          "control_after_generate#1": "fixed",
          mode: "b",
          "control_after_generate#2": "fixed",
          control_filter_list: "",
        },
      ],
      // One button, for the first required upload combo.
      [
        "MockUploads",
        ["b.png", "a.mp4", "image"],
        { image: "b.png", video: "a.mp4", upload: "image" },
      ],
      ["MockUploadOptional", ["a.png"], { image: "a.png" }],
      ["MockAnimatedUpload", ["a.webp", "image"], { image: "a.webp", upload: "image" }],
      ["MockAudioUpload", ["a.wav", ""], { audio: "a.wav", upload: "" }],
      ["MockAudioUploadOtherName", ["a.wav"], { clip: "a.wav" }],
    ]);
  });

  test("positional values are read back past every one of them", () => {
    const nodes = objects(ui["nodes"]).map((node) =>
      Object.fromEntries(Object.entries(node).filter(([key]) => key !== "widgets_values_named")),
    );
    const back = importUi(JSON.stringify({ ...ui, nodes }), widgets);
    expect(back.diagnostics).toEqual([]);
    expect(toApi(back.workflow, { validate: false })).toEqual(toApi(built, { validate: false }));
  });
});

describe("toUi", () => {
  test.each(MOCK_UI_WORKFLOW_NAMES)(
    "the frontend loads the export of %s to the prompt its import gives",
    async (name) => {
      const { workflow: ui } = toUi(importUi(await readMockUiWorkflow(name), schema).workflow);
      const ours = toApi(importUi(stringify(ui), schema).workflow, { validate: false });
      const theirs = parse(await readMockUiExportPrompt(name)).value;
      if (!isJsonObject(theirs)) throw new Error("expected a prompt");
      expect(Object.keys(ours)).toEqual(Object.keys(theirs));
      // MockSeed isn't a server class: the frontend sends it without one.
      const declared = name === "txt2img" ? ["2"] : [];
      for (const id of Object.keys(theirs)) {
        if (declared.includes(id)) continue;
        expect(stringify(ours[id] ?? null)).toBe(stringify(theirs[id] ?? null));
      }
    },
  );

  test.each(MOCK_UI_WORKFLOW_NAMES)(
    "loading the export of %s reproduces its prompt",
    async (name) => {
      const first = importUi(await readMockUiWorkflow(name), schema).workflow;
      const { workflow: ui, ids } = toUi(first);
      const second = toApi(importUi(stringify(ui), schema).workflow, { validate: false });
      // Subgraph interiors come back flat, under the numbers `toUi` gave them.
      expect(stringify(second)).toBe(stringify(renumbered(toApi(first, { validate: false }), ids)));
    },
  );

  /** The mock schema each mock prompt was written for. */
  const schemas: Record<MockApiWorkflowName, MockObjectInfoName> = {
    autogrow: "autogrow",
    "dynamic-combo": "dynamic-combo",
    "dynamic-group": "dynamic-group",
    lists: "combos",
    txt2img: "basic-pipeline",
    "value-widgets": "widget-types",
  };
  /** Nodes whose prompt the UI format changes, all reported or documented on `toUi`. */
  const changed: Record<MockApiWorkflowName, readonly string[]> = {
    autogrow: [],
    // An optional dynamic combo left out: the frontend sends its first option.
    "dynamic-combo": ["8"],
    // DynamicGroup rows: no widgets in the frontend (W_UI_VALUE_LOST).
    "dynamic-group": ["2", "3", "4"],
    // An unknown class linked to nothing: dropped on import.
    lists: ["4"],
    txt2img: [],
    // IMAGECOMPARE: a widget the frontend doesn't save (W_UI_VALUE_LOST).
    "value-widgets": ["2"],
  };

  test.each(MOCK_API_WORKFLOW_NAMES)("%s survives the round trip", async (name) => {
    const local = looseSchema(await readMockObjectInfo(schemas[name]));
    const text = await readMockApiWorkflow(name);
    const { workflow: ui } = toUi(importApi(text, local).workflow);
    const back = toApi(importUi(stringify(ui), local).workflow, { validate: false });
    const original = parse(text).value;
    if (!isJsonObject(original)) throw new Error("expected a prompt");
    for (const id of Object.keys(original)) {
      if (changed[name].includes(id)) {
        expect(stringify(back[id] ?? null)).not.toBe(stringify(original[id] ?? null));
      } else {
        expect(stringify(back[id] ?? null)).toBe(stringify(original[id] ?? null));
      }
    }
  });

  test("reports what the format can't carry", async () => {
    const local = looseSchema(await readMockObjectInfo("widget-types"));
    const { workflow: imported } = importApi(await readMockApiWorkflow("value-widgets"), local);
    expect(found(toUi(imported).diagnostics)).toEqual([
      ["W_UNKNOWN_UI_CLASS", ["1"]],
      ["W_UI_VALUE_LOST", ["2", "inputs", "compare"]],
    ]);
    const { workflow: seeded } = importUi(await readMockUiWorkflow("txt2img"), schema);
    expect(found(toUi(seeded).diagnostics)).toEqual([
      ["W_UNSAFE_INTEGER", ["2", "inputs", "seed"]],
    ]);
  });

  test("writes the frontend's layout: ids, slots, widget values, links, modes", () => {
    const built = workflow(schema, ({ n }) => {
      const [model, clip] = n["CheckpointLoaderSimple"]?.(
        { ckpt_name: "model-b.safetensors" },
        { id: "ckpt" },
      ) ?? [undefined, undefined];
      const positive = n["CLIPTextEncode"]?.({ text: "a cat", clip }, { id: "3" });
      n["KSampler"]?.(
        {
          model,
          seed: 7,
          steps: 20,
          cfg: 8,
          sampler_name: "euler",
          scheduler: "normal",
          positive,
          negative: positive,
          latent_image: n["EmptyLatentImage"]?.({}, { mode: "mute" }),
          denoise: 1,
        },
        { id: "sampler", mode: "bypass", title: "Sample" },
      );
    });
    const { workflow: ui, diagnostics } = toUi(built);
    expect(diagnostics).toEqual([]);
    const nodes = objects(ui["nodes"]);
    expect(nodes.map((node) => [node["id"], node["type"], node["mode"]])).toEqual([
      // Integer ids stay; the others get the next free numbers, in graph order.
      [4, "CheckpointLoaderSimple", 0],
      [3, "CLIPTextEncode", 0],
      [1, "EmptyLatentImage", 2],
      [5, "KSampler", 4],
    ]);
    const sampler = nodes[3] ?? {};
    expect(sampler["title"]).toBe("Sample");
    expect(sampler["widgets_values"]).toEqual([7, "fixed", 20, 8, "euler", "normal", 1]);
    expect(sampler["widgets_values_named"]).toEqual({
      seed: 7,
      control_after_generate: "fixed",
      steps: 20,
      cfg: 8,
      sampler_name: "euler",
      scheduler: "normal",
      denoise: 1,
    });
    // Sockets first, then the widgets' slots, as the frontend creates them.
    expect(objects(sampler["inputs"]).map((slot) => slot["name"])).toEqual([
      "model",
      "positive",
      "negative",
      "latent_image",
      "seed",
      "steps",
      "cfg",
      "sampler_name",
      "scheduler",
      "denoise",
    ]);
    expect(ui["links"]).toEqual([
      [1, 4, 1, 3, 0, "CLIP"],
      [2, 4, 0, 5, 0, "MODEL"],
      [3, 3, 0, 5, 1, "CONDITIONING"],
      [4, 3, 0, 5, 2, "CONDITIONING"],
      [5, 1, 0, 5, 3, "LATENT"],
    ]);
    expect(objects(nodes[0]?.["outputs"]).map((out) => out["links"])).toEqual([[2], [1], null]);
    expect(ui["last_node_id"]).toBe(5);
    expect(ui["last_link_id"]).toBe(5);
    expect(ui["version"]).toBe(0.4);
  });

  test("is deterministic, and places nodes where it is told", async () => {
    const { workflow: imported } = importUi(await readMockUiWorkflow("txt2img"), schema);
    const first = stringify(toUi(imported).workflow);
    expect(stringify(toUi(imported).workflow)).toBe(first);
    expect(toUi(imported).workflow["id"]).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
    );
    const placed = toUi(imported, { positions: new Map([["6", [400, 120]]]) }).workflow;
    const sampler = objects(placed["nodes"]).find((node) => node["id"] === 6);
    expect(sampler?.["pos"]).toEqual([400, 120]);
  });

  test("sizes nodes for their sockets, widgets and text boxes, as written", async () => {
    const { workflow: imported } = importUi(await readMockUiWorkflow("txt2img"), schema);
    const sizes = uiNodeSizes(imported);
    // KSampler: 4 sockets, 7 widgets (the seed's control among them).
    expect(sizes.get("6")).toEqual([320, 310]);
    // CLIPTextEncode: 1 socket and 1 output, a multiline text widget.
    expect(sizes.get("3")).toEqual([320, 190]);
    const written = objects(toUi(imported).workflow["nodes"]);
    expect(written.map((node) => node["size"])).toEqual(
      [...imported.graph.nodes.keys()].map((id) => sizes.get(id)),
    );
  });
});

/** A value for a required input: its default, a link for a socket, the first option. */
const sample = (input: InputDef, link: Out<string>): InputValue | undefined => {
  switch (input.kind) {
    case "socket":
    case "matchType":
    case "unknown":
      return link;
    case "int":
      return input.default ?? input.min ?? 1;
    case "float":
      return input.default ?? input.min ?? 0.5;
    case "string":
      return input.default ?? "s";
    case "boolean":
      return input.default ?? true;
    case "combo":
      return input.forceInput === true ? link : (input.default ?? input.options[0] ?? "x");
    case "value":
      return input.default ?? null;
    case "dynamicCombo":
      return input.options[0]?.key;
    case "autogrow":
      return input.form === "prefix"
        ? Array.from({ length: Math.max(input.min, 1) }, () => link)
        : Object.fromEntries(
            input.slots.slice(0, Math.max(input.min, 1)).map((slot) => [slot, link]),
          );
    case "dynamicGroup":
      return Array.from({ length: input.min }, () => ({}));
  }
};
/** The diagnostics about node 1. */
const own = (diagnostics: readonly Diagnostic[]): Diagnostic[] =>
  diagnostics.filter((diagnostic) => diagnostic.path[0] === "1");

describe("every mock class through toUi and importUi", () => {
  /** What the format can't carry, each reported (docs/diagnostics.md). */
  const EXPORT_CODES = new Set([
    "W_UI_VALUE_LOST",
    "W_QUEUE_TIME_VALUE",
    "W_EXTENSION_WIDGETS",
    "W_UNKNOWN_UI_CLASS",
    "W_UNSAFE_INTEGER",
  ]);

  test.each(MOCK_OBJECT_INFO_NAMES)(
    "%s: the same prompt, apart from what is reported",
    async (name) => {
      const local = looseSchema(await readMockObjectInfo(name));
      for (const [classType, definition] of Object.entries(local.nodes)) {
        const built = workflow(local, ({ n, raw }) => {
          const link = raw("ExternalSource", {}, { id: "2" }).output(0);
          const inputs = Object.fromEntries(
            definition.inputs
              .filter((input) => input.required)
              .map((input) => [input.name, sample(input, link)]),
          );
          n[classType]?.(inputs, { id: "1" });
        });
        const original = exportApi(built, { validate: false });
        // A class whose inputs collide can't be exported at all (E_INPUT_KEY_COLLISION).
        if (original.diagnostics.some((diagnostic) => diagnostic.severity === "error")) continue;
        const exported = toUi(built);
        const reported = own(exported.diagnostics);
        expect([classType, reported.filter((each) => !EXPORT_CODES.has(each.code))]).toEqual([
          classType,
          [],
        ]);
        const back = importUi(stringify(exported.workflow), local);
        const raw = reported.some((each) => each.code === "W_UNKNOWN_UI_CLASS");
        // Import reports only the same causes: a value computed at queue time, scripted widgets,
        // and a node the frontend can't create, read back raw.
        expect([
          classType,
          own(back.diagnostics)
            .map((each) => each.code)
            .filter(
              (code) =>
                code !== "W_QUEUE_TIME_VALUE" &&
                code !== "W_EXTENSION_WIDGETS" &&
                !(raw && code === "W_IMPORTED_AS_RAW"),
            ),
        ]).toEqual([classType, []]);
        const lost = new Set(reported.map((each) => String(each.path[2])));
        const before = original.prompt["1"]?.inputs ?? {};
        const after = toApi(back.workflow, { validate: false })["1"]?.inputs ?? {};
        const kept = Object.keys(before).filter((key) => !lost.has(key));
        expect([classType, kept.map((key) => [key, after[key]])]).toEqual([
          classType,
          kept.map((key) => [key, before[key]]),
        ]);
        // Keys the import adds: optional widgets the frontend sends with their initial values (a
        // documented exception), or a renamed widget's name.
        const optional = definition.inputs
          .filter((input) => !input.required)
          .map((input) => input.name);
        const added = Object.keys(after).filter((key) => !Object.hasOwn(before, key));
        expect([
          classType,
          added.filter(
            (key) =>
              !optional.some((each) => key === each || key.startsWith(`${each}.`)) &&
              !(key.includes("#") && lost.has(key.slice(0, key.indexOf("#")))) &&
              !definition.inputs.some(
                (input) => input.kind === "dynamicCombo" && key.startsWith(`${input.name}.`),
              ),
          ),
        ]).toEqual([classType, []]);
      }
    },
  );
});

describe("toUi: integers the frontend rounds", () => {
  test("only a bigint outside the safe range is reported; a large number round-trips", () => {
    const built = workflow(schema, ({ n }) => {
      n["MockSeed"]?.({ seed: 42n }, { id: "1" });
      n["MockSeed"]?.({ seed: 2 ** 60 }, { id: "2" });
      n["MockSeed"]?.({ seed: 18446744073709551615n }, { id: "3" });
    });
    expect(found(toUi(built).diagnostics)).toEqual([["W_UNSAFE_INTEGER", ["3", "inputs", "seed"]]]);
  });
});

const extensions = looseSchema(await readMockObjectInfo("ui-extensions"));

describe("toUi: widgets the frontend doesn't send", () => {
  test("CameraAngle's view is no value to lose when it isn't given", () => {
    const built = workflow(extensions, ({ n }) => {
      n["CameraAngle"]?.({ horizontal_angle: 30 }, { id: "3" });
    });
    expect(toApi(built, { validate: false })["3"]?.inputs).toEqual({
      horizontal_angle: 30,
      vertical_angle: 0,
      zoom: 5,
    });
    expect(found(toUi(built).diagnostics)).toEqual([]);
  });

  test("a view given is sent by toApi and lost in the UI file", () => {
    const built = workflow(extensions, ({ n }) => {
      n["CameraAngle"]?.({ view: "top" }, { id: "3" });
    });
    expect(toApi(built, { validate: false })["3"]?.inputs["view"]).toBe("top");
    expect(found(toUi(built).diagnostics)).toEqual([["W_UI_VALUE_LOST", ["3", "inputs", "view"]]]);
  });
});

describe("toUi: inputs named like Object.prototype members", () => {
  test("are written as given, and the file loads back to the same prompt", () => {
    const proto = looseSchema(
      JSON.stringify({
        Proto: {
          input: {
            required: { a: ["INT", { default: 3 }] },
            optional: { valueOf: ["INT", {}], constructor: ["STRING", {}] },
          },
          output: [],
          output_is_list: [],
          output_name: [],
          name: "Proto",
          display_name: "Proto",
          category: "test",
          python_module: "nodes",
          output_node: true,
        },
      }),
    );
    const given = workflow(proto, ({ n }) => {
      n["Proto"]?.({ valueOf: 4, constructor: "c" }, { id: "1" });
    });
    const loaded = importUi(stringify(toUi(given).workflow), proto);
    expect(found(loaded.diagnostics)).toEqual([]);
    expect(toApi(loaded.workflow, { validate: false })).toEqual(toApi(given, { validate: false }));

    // Left out, they hold the frontend's initial values, as any optional widget does.
    const left = workflow(proto, ({ n }) => {
      n["Proto"]?.({}, { id: "1" });
    });
    const [node] = objects(toUi(left).workflow["nodes"]);
    expect(node?.["widgets_values"]).toEqual([3, 0, ""]);
    expect(node?.["widgets_values_named"]).toEqual({ a: 3, valueOf: 0, constructor: "" });
  });
});

describe("toUi: links to nodes the workflow doesn't have", () => {
  test("are reported: toApi sends them and the frontend won't", async () => {
    const basic = looseSchema(await readMockObjectInfo("basic-pipeline"));
    const prompt = { "2": { class_type: "CLIPTextEncode", inputs: { text: "a", clip: ["9", 1] } } };
    const imported = importApi(JSON.stringify(prompt), basic);
    expect(found(toUi(imported.workflow).diagnostics)).toEqual([
      ["W_UI_VALUE_LOST", ["2", "inputs", "clip"]],
    ]);
  });
});
