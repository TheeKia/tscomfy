import { describe, expect, test } from "bun:test";
import {
  type Diagnostic,
  importApi,
  importUi,
  parse,
  stringify,
  toApi,
  toUi,
  uiNodeSizes,
  workflow,
} from "@tscomfy/core";
import {
  MOCK_API_WORKFLOW_NAMES,
  MOCK_UI_WORKFLOW_NAMES,
  type MockApiWorkflowName,
  type MockObjectInfoName,
  type MockUiWorkflowName,
  readMockApiWorkflow,
  readMockObjectInfo,
  readMockUiApiWorkflow,
  readMockUiWorkflow,
} from "@tscomfy/fixtures";
import { isJsonObject } from "../src/json/value.ts";
import { looseSchema } from "./loose.ts";
import { renumbered } from "./prompts.ts";

// The UI format (docs/plan.md §11). The mock UI workflows' expected prompts were captured from
// frontend 1.55.17 itself (internal/fixtures/scripts/frontend.ts); the inline cases below follow
// probes run the same way.

const schema = looseSchema(await readMockObjectInfo("basic-pipeline"));

const found = (diagnostics: readonly Diagnostic[]): [string, (string | number)[]][] =>
  diagnostics.map((diagnostic) => [diagnostic.code, [...diagnostic.path]]);

/** The prompt the frontend builds for a UI workflow, through `importUi`. */
function queued(text: string): {
  readonly prompt: unknown;
  readonly found: [string, (string | number)[]][];
} {
  const { workflow: imported, diagnostics } = importUi(text, schema);
  return { prompt: toApi(imported, { validate: false }), found: found(diagnostics) };
}

/** A format 0.4 file around nodes and tuple links. */
const file = (
  nodes: readonly unknown[],
  links: readonly unknown[] = [],
  rest: object = {},
): string =>
  JSON.stringify({ last_node_id: 100, last_link_id: 100, nodes, links, version: 0.4, ...rest });

/** An object read back from a file, or a failed test. */
function object(value: unknown): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error("expected an object");
  }
  return Object.fromEntries(Object.entries(value));
}

/** The objects of a list read back from a file. */
function objects(value: unknown): Record<string, unknown>[] {
  if (!Array.isArray(value)) throw new Error("expected a list");
  return value.map((each: unknown) => object(each));
}

/** A Reroute fed by `link`. */
const reroute = (id: number, link: number, mode = 0): object => ({
  id,
  type: "Reroute",
  mode,
  inputs: [{ name: "", type: "*", link }],
});

const ckpt = { id: 1, type: "CheckpointLoaderSimple", widgets_values: ["model-a.safetensors"] };
const encode = (id: number, text: string, link: number | null): object => ({
  id,
  type: "CLIPTextEncode",
  inputs: [{ name: "clip", type: "CLIP", link }],
  widgets_values: [text],
});
const ckptPrompt = {
  inputs: { ckpt_name: "model-a.safetensors" },
  class_type: "CheckpointLoaderSimple",
  _meta: { title: "Load Checkpoint" },
};
const encodePrompt = (text: string, clip?: readonly [string, number]): object => ({
  inputs: { text, ...(clip === undefined ? {} : { clip }) },
  class_type: "CLIPTextEncode",
  _meta: { title: "CLIP Text Encode (Prompt)" },
});

describe("importUi: the frontend's prompt", () => {
  const warnings: Record<MockUiWorkflowName, [string, (string | number)[]][]> = {
    modes: [],
    "subgraph-modes": [["W_FRONTEND_QUIRK", ["40", "31"]]],
    // A PrimitiveNode feeding a promoted input: the frontend loses its value.
    "subgraph-primitive": [["W_FRONTEND_QUIRK", ["90"]]],
    subgraphs: [],
    txt2img: [],
  };

  test.each(MOCK_UI_WORKFLOW_NAMES)("%s, byte for byte", async (name) => {
    const { workflow: imported, diagnostics } = importUi(await readMockUiWorkflow(name), schema);
    expect(found(diagnostics)).toEqual(warnings[name]);
    expect(stringify(toApi(imported, { validate: false }))).toBe(
      stringify(parse(await readMockUiApiWorkflow(name)).value ?? null),
    );
  });

  test("keeps a seed beyond 2^53 exact, which the frontend rounds", async () => {
    const { workflow: imported } = importUi(await readMockUiWorkflow("txt2img"), schema);
    expect(imported.graph.nodes.get("2")?.inputs["seed"]).toBe(18446744073709551615n);
  });
});

describe("importUi: reading the file", () => {
  test("links come from the links array, placed on the input that references them", () => {
    // Link 1 says slot 3, but the saved `clip` input references it: the frontend goes by that.
    const text = file([ckpt, encode(2, "a", 1)], [[1, 1, 1, 2, 3, "CLIP"]]);
    expect(queued(text).prompt).toEqual({ "1": ckptPrompt, "2": encodePrompt("a", ["1", 1]) });
  });

  test("a link only on an input, not in the links array, is no link", () => {
    expect(queued(file([ckpt, encode(2, "a", 7)])).prompt).toEqual({
      "1": ckptPrompt,
      "2": encodePrompt("a"),
    });
  });

  test("a link no input references lands on the slot it names", () => {
    const text = file([ckpt, encode(2, "a", null)], [[1, 1, 1, 2, 0, "CLIP"]]);
    expect(queued(text).prompt).toEqual({ "1": ckptPrompt, "2": encodePrompt("a", ["1", 1]) });
  });

  test("format 1 has object links; tuple links there are dropped, as the frontend drops them", () => {
    const link = { id: 1, origin_id: 1, origin_slot: 1, target_id: 2, target_slot: 0 };
    const nodes = [ckpt, encode(2, "a", 1)];
    expect(queued(JSON.stringify({ version: 1, nodes, links: [link] })).prompt).toEqual({
      "1": ckptPrompt,
      "2": encodePrompt("a", ["1", 1]),
    });
    const tuples = queued(JSON.stringify({ version: 1, nodes, links: [[1, 1, 1, 2, 0, "CLIP"]] }));
    expect(tuples.prompt).toEqual({ "1": ckptPrompt, "2": encodePrompt("a") });
    expect(tuples.found).toEqual([["E_INVALID_WORKFLOW", ["links", 0]]]);
  });

  test("named values win over positional ones", () => {
    const named = { ...encode(2, "positional", null), widgets_values_named: { text: "named" } };
    expect(queued(file([named])).prompt).toEqual({ "2": encodePrompt("named") });
  });

  test("too few positional values: the rest keep their defaults", () => {
    const sampler = { id: 5, type: "KSampler", widgets_values: [5, "fixed", 30] };
    const { prompt, found: codes } = queued(file([sampler]));
    expect(prompt).toEqual({
      "5": {
        inputs: {
          seed: 5,
          steps: 30,
          cfg: 8,
          sampler_name: "euler",
          scheduler: "simple",
          denoise: 1,
        },
        class_type: "KSampler",
        _meta: { title: "KSampler" },
      },
    });
    expect(codes).toEqual([["W_WIDGET_VALUES_MISMATCH", ["5", "widgets_values"]]]);
  });

  test("a combo saved as null takes its first option; old sampler names lose `sample_`", () => {
    const sampler = {
      id: 5,
      type: "KSampler",
      widgets_values: [5, "fixed", 20, 8, "sample_dpmpp_2m", null, 1],
    };
    const { inputs } = object(object(queued(file([sampler])).prompt)["5"]);
    expect(inputs).toMatchObject({ sampler_name: "dpmpp_2m", scheduler: "simple" });
  });

  test("Reroutes resolve through; a muted one passes nothing on", () => {
    const links = [
      [1, 1, 1, 10, 0, "*"],
      [2, 10, 0, 11, 0, "*"],
      [3, 11, 0, 2, 0, "CLIP"],
    ];
    const rest = [reroute(11, 2), encode(2, "a", 3)];
    expect(queued(file([ckpt, reroute(10, 1), ...rest], links)).prompt).toEqual({
      "1": ckptPrompt,
      "2": encodePrompt("a", ["1", 1]),
    });
    expect(queued(file([ckpt, reroute(10, 1, 2), ...rest], links)).prompt).toEqual({
      "1": ckptPrompt,
      "2": encodePrompt("a"),
    });
  });

  test("Notes are dropped; a PrimitiveNode writes its value into the widgets it feeds", () => {
    const primitive = {
      id: 12,
      type: "PrimitiveNode",
      widgets_values: ["from the primitive"],
      outputs: [{ name: "STRING", type: "STRING", widget: { name: "text" }, links: [5] }],
    };
    const target = {
      ...encode(2, "own", null),
      inputs: [{ name: "text", type: "STRING", widget: { name: "text" }, link: 5 }],
    };
    const note = { id: 13, type: "Note", widgets_values: ["a note"] };
    const markdown = { id: 14, type: "MarkdownNote", widgets_values: ["# a note"] };
    const text = file([primitive, target, note, markdown], [[5, 12, 0, 2, 1, "STRING"]]);
    expect(queued(text)).toEqual({
      prompt: { "2": encodePrompt("from the primitive") },
      found: [],
    });
  });

  test("an unknown class: kept raw while linked, with its named values; dropped otherwise", () => {
    const pack = {
      id: 3,
      type: "PackEncode",
      inputs: [{ name: "clip", type: "CLIP", link: 1 }],
      widgets_values: ["x"],
      widgets_values_named: { prompt: "x" },
    };
    const label = { id: 4, type: "PackLabel", widgets_values: ["a label"] };
    const { prompt, found: codes } = queued(file([ckpt, pack, label], [[1, 1, 1, 3, 0, "CLIP"]]));
    expect(prompt).toEqual({
      "1": ckptPrompt,
      // The frontend sends it without a class, which the backend rejects; we keep the class.
      "3": {
        inputs: { prompt: "x", clip: ["1", 1] },
        class_type: "PackEncode",
        _meta: { title: "PackEncode" },
      },
    });
    expect(codes).toEqual([
      ["W_IMPORTED_AS_RAW", ["4"]],
      ["W_IMPORTED_AS_RAW", ["3"]],
    ]);
  });

  test("a link from a node the graph doesn't have is dropped", () => {
    const { prompt, found: codes } = queued(file([encode(2, "a", 1)], [[1, 9, 0, 2, 0, "CLIP"]]));
    expect(prompt).toEqual({ "2": encodePrompt("a") });
    expect(codes).toEqual([["W_UNRESOLVED_LINK", ["links", 1]]]);
  });

  test("a loop of Reroutes is dropped", () => {
    const links = [
      [1, 11, 0, 10, 0, "*"],
      [2, 10, 0, 11, 0, "*"],
      [3, 11, 0, 2, 0, "CLIP"],
    ];
    const { prompt, found: codes } = queued(
      file([reroute(10, 1), reroute(11, 2), encode(2, "a", 3)], links),
    );
    expect(prompt).toEqual({ "2": encodePrompt("a") });
    expect(codes.map(([code]) => code)).toEqual(["W_UNRESOLVED_LINK"]);
  });

  test("unreadable files and nodes", () => {
    expect(found(importUi("[]", schema).diagnostics)).toEqual([["E_INVALID_WORKFLOW", []]]);
    expect(found(importUi("{", schema).diagnostics).map(([code]) => code)).toEqual([
      "E_INVALID_JSON",
    ]);
    const { found: codes } = queued(file([ckpt, { id: 1, type: "VAEDecode" }, "node"]));
    expect(codes).toEqual([
      ["E_INVALID_WORKFLOW", ["nodes", 1]],
      ["E_INVALID_WORKFLOW", ["nodes", 2]],
    ]);
  });
});

const widgets = looseSchema(await readMockObjectInfo("ui-widgets"));

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
          // a string option; one shared name, so the last control's value stands.
          seed: 1,
          control_after_generate: "fixed",
          noise_seed: 2,
          value: 3,
          fixed: "fixed",
          steps: 4,
          strength: 0.5,
          mode: "b",
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
    "loading the export of %s reproduces its prompt",
    async (name) => {
      const first = importUi(await readMockUiWorkflow(name), schema).workflow;
      const { workflow: ui, ids } = toUi(first);
      const second = toApi(importUi(stringify(ui), schema).workflow, { validate: false });
      // Subgraph interiors come back flat, under the numbers `toUi` gave them.
      expect(second).toEqual(renumbered(toApi(first, { validate: false }), ids));
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
