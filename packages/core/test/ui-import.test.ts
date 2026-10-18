import { describe, expect, test } from "bun:test";
import { importUi, parse, stringify, toApi } from "@tscomfy/core";
import {
  MOCK_UI_WORKFLOW_NAMES,
  type MockUiWorkflowName,
  readMockObjectInfo,
  readMockUiApiWorkflow,
  readMockUiWorkflow,
} from "@tscomfy/fixtures";
import { looseSchema } from "./loose.ts";
import {
  schema,
  found,
  queued,
  file,
  object,
  patched,
  objects,
  reroute,
  ckpt,
  encode,
  ckptPrompt,
  encodePrompt,
  widgets,
} from "./ui-helpers.ts";

// importUi (docs/plan.md §11): what the frontend queues for a UI workflow.

describe("importUi: the frontend's prompt", () => {
  const warnings: Record<MockUiWorkflowName, [string, (string | number)[]][]> = {
    modes: [],
    "subgraph-modes": [["W_FRONTEND_QUIRK", ["40:31"]]],
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

  test("values by position win over names, as in the frontend, with a warning if they disagree", () => {
    const named = { ...encode(2, "positional", null), widgets_values_named: { text: "named" } };
    expect(queued(file([named]))).toEqual({
      prompt: { "2": encodePrompt("positional") },
      found: [["W_WIDGET_VALUES_MISMATCH", ["2", "widgets_values"]]],
    });
  });

  test("names are read when the positions don't fit the layout (a pack's own widgets)", () => {
    const sampler = {
      id: 5,
      type: "KSampler",
      widgets_values: [9, "fixed", "pack widget", 30, 6, "dpmpp_2m", "karras", 0.5],
      widgets_values_named: {
        seed: 9,
        control_after_generate: "fixed",
        steps: 30,
        cfg: 6,
        sampler_name: "dpmpp_2m",
        scheduler: "karras",
        denoise: 0.5,
      },
    };
    const { prompt, found: codes } = queued(file([sampler]));
    expect(object(object(prompt)["5"])["inputs"]).toEqual({
      seed: 9,
      steps: 30,
      cfg: 6,
      sampler_name: "dpmpp_2m",
      scheduler: "karras",
      denoise: 0.5,
    });
    expect(codes).toEqual([]);
  });

  test("values saved as an object are read by name", () => {
    const latent = {
      id: 4,
      type: "EmptyLatentImage",
      widgets_values: { width: 640, height: 768, batch_size: 2 },
    };
    expect(object(object(queued(file([latent])).prompt)["4"])["inputs"]).toEqual({
      width: 640,
      height: 768,
      batch_size: 2,
    });
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
      ["W_NODE_LEFT_OUT", ["4"]],
      ["W_IMPORTED_AS_RAW", ["3"]],
    ]);
  });

  test("a link from a node the graph doesn't have is dropped", () => {
    const { prompt, found: codes } = queued(file([encode(2, "a", 1)], [[1, 9, 0, 2, 0, "CLIP"]]));
    expect(prompt).toEqual({ "2": encodePrompt("a") });
    expect(codes).toEqual([["W_UNRESOLVED_LINK", ["2", "inputs", "clip"]]]);
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
    const { found: codes } = queued(file([ckpt, "node"]));
    expect(codes).toEqual([["E_INVALID_WORKFLOW", ["nodes", 1]]]);
  });
});

/** A KSampler of the basic-pipeline mock, with saved inputs. */
const samplerNode = (inputs: readonly object[]): object => ({
  id: 5,
  type: "KSampler",
  inputs,
  widgets_values: [5, "fixed", 20, 8, "euler", "normal", 1],
});
const conditioning = (name: string, link: number): object => ({
  name,
  type: "CONDITIONING",
  link,
});
const encoders = [ckpt, encode(2, "a", 2), encode(3, "b", 3)];
const encoderLinks = [
  [2, 1, 1, 2, 0, "CLIP"],
  [3, 1, 1, 3, 0, "CLIP"],
];
const inputsOf = (prompt: unknown, id: string): Record<string, unknown> =>
  object(object(object(prompt)[id])["inputs"]);

// Cases settled in the frontend itself (docs/plan.md §16), rebuilt over the mocks.
describe("importUi: where links land", () => {
  test("links competing for one slot keep the first (normalizeConfiguredTopology)", () => {
    const text = file(
      [...encoders, samplerNode([conditioning("positive", 5), conditioning("negative", 6)])],
      [...encoderLinks, [5, 2, 0, 5, 1, "CONDITIONING"], [6, 3, 0, 5, 1, "CONDITIONING"]],
    );
    const inputs = inputsOf(queued(text).prompt, "5");
    expect(inputs["positive"]).toEqual(["2", 0]);
    expect(Object.hasOwn(inputs, "negative")).toBeFalse();
  });

  test("an input naming another node's link doesn't move it", () => {
    const latent = { id: 4, type: "EmptyLatentImage", widgets_values: [512, 512, 1] };
    const text = file(
      [...encoders, latent, samplerNode([conditioning("negative", 6)])],
      [...encoderLinks, [6, 3, 0, 4, 0, "CONDITIONING"]],
    );
    const { prompt } = queued(text);
    expect(inputsOf(prompt, "4")["width"]).toEqual(["3", 0]);
    expect(Object.hasOwn(inputsOf(prompt, "5"), "negative")).toBeFalse();
  });

  test("a link two inputs name stays on its own slot", () => {
    const text = file(
      [...encoders, samplerNode([conditioning("positive", 5), conditioning("negative", 5)])],
      [...encoderLinks, [5, 2, 0, 5, 1, "CONDITIONING"]],
    );
    const inputs = inputsOf(queued(text).prompt, "5");
    expect(inputs["positive"]).toEqual(["2", 0]);
    expect(Object.hasOwn(inputs, "negative")).toBeFalse();
  });

  test("a link past the node's slots moves to the input that names it", () => {
    const text = file(
      [...encoders, samplerNode([conditioning("positive", 5)])],
      [...encoderLinks, [5, 2, 0, 5, 14, "CONDITIONING"]],
    );
    expect(inputsOf(queued(text).prompt, "5")["positive"]).toEqual(["2", 0]);
  });

  test("an instance input saved under an old name keeps its link by slot", async () => {
    const base = object(JSON.parse(await readMockUiWorkflow("subgraphs")));
    const nodes = objects(base["nodes"]).map((node) =>
      node["id"] === 40
        ? patched(node, {
            inputs: objects(node["inputs"]).map((input) =>
              input["name"] === "clip" ? patched(input, { name: "clip_old" }) : input,
            ),
          })
        : node,
    );
    const { workflow: imported } = importUi(JSON.stringify({ ...base, nodes }), schema);
    expect(stringify(toApi(imported, { validate: false }))).toBe(
      stringify(parse(await readMockUiApiWorkflow("subgraphs")).value ?? null),
    );
  });

  test("a link by slot onto an option input the chosen option lacks is dropped", () => {
    const controls = {
      id: 22,
      type: "MockControls",
      widgets_values: [1, "fixed", 2, 3, "fixed", 4, 0.5, "fixed", "b", "fixed", ""],
    };
    // As created, slot 2 is the first option's `resize_type.height`; "scale width" has none.
    const resize = { id: 20, type: "MockResize", widgets_values: ["scale width", 300, "area"] };
    const { workflow: imported } = importUi(
      file([controls, resize], [[23, 22, 0, 20, 2, "INT"]]),
      widgets,
    );
    expect(toApi(imported, { validate: false })["20"]?.inputs).toEqual({
      resize_type: "scale width",
      "resize_type.width": 300,
      scale_method: "area",
    });
  });
});

describe("importUi: values and ids", () => {
  test("positional values settle afresh as dynamic combos add widgets", async () => {
    const local = looseSchema(await readMockObjectInfo("dynamic-combo"));
    const nested = {
      id: 4,
      type: "MockDynamicComboNested",
      widgets_values: ["mp4", "h264", "custom"],
    };
    const { workflow: imported } = importUi(file([nested]), local);
    expect(toApi(imported, { validate: false })["4"]?.inputs).toEqual({
      format: "mp4",
      "format.codec": "h264",
      "format.codec.encoding": "custom",
      "format.codec.encoding.crf": 23,
      // Not "custom", which an earlier layout put here.
      codec: "auto",
    });
  });

  test("placeholders old files saved for forceInput inputs are dropped (migrateWidgetsValues)", () => {
    const legacy = { id: 7, type: "MockLegacyForceInput", widgets_values: ["myprefix", 0, "json"] };
    const { workflow: imported, diagnostics } = importUi(file([legacy]), widgets);
    expect(diagnostics).toEqual([]);
    expect(toApi(imported, { validate: false })["7"]?.inputs).toEqual({
      prefix: "myprefix",
      format: "json",
    });
  });

  test("a promoted value saved as null is sent as null", async () => {
    const base = object(JSON.parse(await readMockUiWorkflow("subgraphs")));
    const nodes = objects(base["nodes"]).map((node) =>
      node["id"] === 40 ? patched(node, { widgets_values: [null] }) : node,
    );
    expect(
      inputsOf(queued(JSON.stringify({ ...base, nodes })).prompt, "40:31:21")["text"],
    ).toBeNull();
  });

  test("string ids are ids; a repeated id is reminted, its links staying with the first", () => {
    const first = { id: "4", type: "EmptyLatentImage", widgets_values: [640, 512, 1] };
    const second = { id: 4, type: "EmptyLatentImage", widgets_values: [768, 512, 1] };
    const decode = {
      id: 6,
      type: "VAEDecode",
      inputs: [{ name: "samples", type: "LATENT", link: 9 }],
    };
    const { prompt, found: codes } = queued(
      file([first, second, decode], [[9, 4, 0, 6, 0, "LATENT"]]),
    );
    expect(codes).toEqual([]);
    expect(inputsOf(prompt, "4")["width"]).toBe(640);
    expect(inputsOf(prompt, "101")["width"]).toBe(768);
    expect(inputsOf(prompt, "6")["samples"]).toEqual(["4", 0]);
  });
});

const latent = { id: 4, type: "EmptyLatentImage", widgets_values: [1024, 512, 1] };
const save = (prefix: string): object => ({
  id: 8,
  type: "SaveImage",
  inputs: [{ name: "images", type: "IMAGE", link: null }],
  widgets_values: [prefix],
});

describe("importUi: file names", () => {
  test("controls and frontend-only nodes are found, by their default titles too", () => {
    const primitive = { id: 12, type: "PrimitiveNode", widgets_values: [640, "fixed"] };
    const { prompt } = queued(
      file([
        samplerNode([]),
        primitive,
        save(
          "a_%KSampler.control_after_generate%_%KSampler.seed%_%Primitive.value%_%PrimitiveNode.value%",
        ),
      ]),
    );
    expect(inputsOf(prompt, "8")["filename_prefix"]).toBe("a_fixed_5_640_%PrimitiveNode.value%");
  });

  test("%Node.widget% is replaced, by search name or title (applyTextReplacements)", () => {
    const { prompt } = queued(
      file([samplerNode([]), latent, save("img_%KSampler.steps%_%Empty Latent Image.width%_%x%")]),
    );
    expect(inputsOf(prompt, "8")["filename_prefix"]).toBe("img_20_1024_%x%");
  });

  test("%date:…% can't be reproduced and is reported", () => {
    const { prompt, found: codes } = queued(file([save("d_%date:yyyy-MM-dd%")]));
    expect(inputsOf(prompt, "8")["filename_prefix"]).toBe("d_%date:yyyy-MM-dd%");
    expect(codes).toEqual([["W_QUEUE_TIME_VALUE", ["8", "filename_prefix"]]]);
  });

  test("a PrimitiveNode replaces before it writes, when its property says so", () => {
    const primitive = {
      id: 12,
      type: "PrimitiveNode",
      properties: { "Run widget replace on values": true },
      widgets_values: ["p_%KSampler.steps%"],
      outputs: [{ name: "STRING", type: "STRING", widget: { name: "text" }, links: [5] }],
    };
    const target = {
      ...encode(2, "own", null),
      inputs: [{ name: "text", type: "STRING", widget: { name: "text" }, link: 5 }],
    };
    const { prompt } = queued(
      file([samplerNode([]), primitive, target], [[5, 12, 0, 2, 1, "STRING"]]),
    );
    expect(inputsOf(prompt, "2")["text"]).toBe("p_20");
  });
});

describe("importUi: what the frontend refuses or can't express", () => {
  /** A definition passing CONDITIONING through an inner Reroute. */
  const passThrough = {
    id: "00000000-0000-4000-8000-000000000001",
    name: "Pass",
    inputNode: { id: -10, bounding: [0, 0, 1, 1] },
    outputNode: { id: -20, bounding: [0, 0, 1, 1] },
    inputs: [{ id: "a", name: "conditioning", type: "CONDITIONING", linkIds: [1] }],
    outputs: [{ id: "b", name: "CONDITIONING", type: "CONDITIONING", linkIds: [2] }],
    nodes: [{ id: 1, type: "Reroute", inputs: [{ name: "", type: "*", link: 1 }] }],
    links: [
      { id: 1, origin_id: -10, origin_slot: 0, target_id: 1, target_slot: 0, type: "*" },
      { id: 2, origin_id: 1, origin_slot: 0, target_id: -20, target_slot: 0, type: "*" },
    ],
  };
  const instance = (id: number, link: number): object => ({
    id,
    type: passThrough.id,
    inputs: [conditioning("conditioning", link)],
  });

  test("two instances of one subgraph in a row: resolved, and the frontend's refusal reported", () => {
    const text = file(
      [
        ...encoders,
        instance(10, 20),
        instance(11, 21),
        samplerNode([conditioning("positive", 22)]),
      ],
      [
        ...encoderLinks,
        [20, 2, 0, 10, 0, "CONDITIONING"],
        [21, 10, 0, 11, 0, "CONDITIONING"],
        [22, 11, 0, 5, 1, "CONDITIONING"],
      ],
      { definitions: { subgraphs: [passThrough] } },
    );
    const { prompt, found: codes } = queued(text);
    expect(inputsOf(prompt, "5")["positive"]).toEqual(["2", 0]);
    expect(codes).toEqual([["W_FRONTEND_QUIRK", ["5", "inputs", "positive"]]]);
  });

  test("a subgraph that contains itself: the frontend loads nothing", () => {
    const looping = { ...passThrough, nodes: [{ id: 1, type: passThrough.id }], links: [] };
    const { prompt, found: codes } = queued(
      file([instance(10, 20)], [], { definitions: { subgraphs: [looping] } }),
    );
    expect(prompt).toEqual({});
    expect(codes).toEqual([["E_INVALID_WORKFLOW", ["definitions", "subgraphs", passThrough.id]]]);
  });

  test("a legacy group node is reported", () => {
    const group = { id: 4, type: "workflow>Latent" };
    const { found: codes } = queued(
      file([group], [], { extra: { groupNodes: { Latent: { nodes: [], links: [] } } } }),
    );
    expect(codes).toEqual([["E_LEGACY_GROUP_NODE", ["4"]]]);
  });
});

describe("importUi: ids the frontend reassigns", () => {
  test("a node whose id an earlier remint took is reminted in turn, and its links follow", () => {
    const latents = [640, 768, 832].map((width, at) => ({
      id: at === 2 ? 101 : 4,
      type: "EmptyLatentImage",
      widgets_values: [width, 512, 1],
    }));
    const decode = {
      id: 6,
      type: "VAEDecode",
      inputs: [{ name: "samples", type: "LATENT", link: 9 }],
    };
    const { prompt } = queued(file([...latents, decode], [[9, 101, 0, 6, 0, "LATENT"]]));
    expect(inputsOf(prompt, "101")["width"]).toBe(768);
    expect(inputsOf(prompt, "102")["width"]).toBe(832);
    expect(inputsOf(prompt, "6")["samples"]).toEqual(["102", 0]);
  });

  test("a fractional id is an id", () => {
    const fractional = { id: 4.5, type: "EmptyLatentImage", widgets_values: [640, 512, 1] };
    expect(inputsOf(queued(file([fractional])).prompt, "4.5")["width"]).toBe(640);
  });
});

describe("importUi: size", () => {
  test("many file names and many links into one node import in linear time", () => {
    const count = 20_000;
    const nodes: object[] = [];
    for (let id = 1; id <= count; id++) {
      nodes.push({ id, type: "EmptyLatentImage", widgets_values: [64, 64, 1] });
      nodes.push(patched(object(save("x_%EmptyLatentImage.width%_%Nope.w%")), { id: count + id }));
    }
    const wide = {
      id: 3 * count,
      type: "PackWide",
      inputs: Array.from({ length: count }, (_, at) => ({ name: `in${String(at)}`, link: at + 1 })),
    };
    const links = Array.from({ length: count }, (_, at) => [
      at + 1,
      1,
      0,
      3 * count,
      count - 1 - at,
      "*",
    ]);
    const started = performance.now();
    const { prompt } = queued(file([...nodes, wide], links, { last_node_id: 3 * count }));
    expect(performance.now() - started).toBeLessThan(5000);
    expect(inputsOf(prompt, String(2 * count))["filename_prefix"]).toBe("x_64_%Nope.w%");
    expect(inputsOf(prompt, String(3 * count))["in0"]).toEqual(["1", 0]);
  });

  test("a long Reroute chain into many consumers imports in linear time, without recursion", () => {
    const count = 50_000;
    const nodes: object[] = [{ id: 1, type: "EmptyLatentImage", widgets_values: [512, 512, 1] }];
    const links: unknown[] = [];
    for (let id = 2; id <= count; id++) {
      nodes.push({ id, type: "Reroute", inputs: [{ name: "", type: "*", link: id }] });
      links.push([id, id - 1, 0, id, 0, "*"]);
    }
    for (let id = count + 1; id <= count + 1000; id++) {
      nodes.push({
        id,
        type: "VAEDecode",
        inputs: [{ name: "samples", type: "LATENT", link: id }],
      });
      links.push([id, count, 0, id, 0, "LATENT"]);
    }
    const started = performance.now();
    const { prompt } = queued(file(nodes, links, { last_node_id: count + 1000 }));
    expect(performance.now() - started).toBeLessThan(5000);
    expect(inputsOf(prompt, String(count + 1000))["samples"]).toEqual(["1", 0]);
  });
});

const extensions = looseSchema(await readMockObjectInfo("ui-extensions"));

/** A save node whose file name references widgets. */
const named = (prefix: string): object => ({
  id: 9,
  type: "SaveImage",
  properties: {},
  widgets_values: [prefix],
});

describe("importUi: load-time fixups, as the frontend applies them", () => {
  test("a control saved as a boolean: only KSampler, KSamplerAdvanced and PrimitiveNode's", () => {
    // Probed: KSamplerAdvanced's `true` reads back as `randomize`; a class merely starting with
    // `KSampler` keeps `true` (the frontend's file name then says `true`).
    const text = file([
      {
        id: 1,
        type: "KSamplerAdvanced",
        widgets_values: ["enable", 42, true, 20, 8, "euler", "normal", 0, 10000, "disable"],
      },
      { id: 2, type: "KSamplerMockVariant", widgets_values: [1, true, 20] },
      { id: 3, type: "PrimitiveNode", title: "P", widgets_values: [5, false] },
      named(
        "%KSamplerAdvanced.control_after_generate%_%KSamplerMockVariant.control_after_generate%_%P.control_after_generate%",
      ),
    ]);
    const { workflow: imported } = importUi(text, extensions);
    expect(imported.graph.nodes.get("9")?.inputs["filename_prefix"]).toBe("randomize_true_fixed");
  });

  test("a control saved as null takes its first option, fixed; a dynamic combo its first key", () => {
    const text = file([
      { id: 1, type: "KSamplerMockVariant", widgets_values: [1, null, 20] },
      { id: 2, type: "CreateCameraInfo", widgets_values: [null, 1, 2, 3, 0, 0, 0, 0, 35, 1, null] },
      named("%KSamplerMockVariant.control_after_generate%"),
    ]);
    const { workflow: imported } = importUi(text, extensions);
    expect(imported.graph.nodes.get("9")?.inputs["filename_prefix"]).toBe("fixed");
    expect(toApi(imported, { validate: false })["2"]?.inputs).toMatchObject({
      mode: "orbit",
      "mode.yaw": 1,
      camera_type: "perspective",
    });
  });
});

describe("importUi: links the frontend refuses", () => {
  test("each link from a missing node is named in its own warning", () => {
    const text = file(
      [encode(2, "a", 11), encode(3, "b", 12)],
      [
        [11, 9, 0, 2, 0, "CLIP"],
        [12, 9, 0, 3, 0, "CLIP"],
      ],
    );
    const { diagnostics } = importUi(text, schema);
    expect(diagnostics.map((diagnostic) => diagnostic.message)).toEqual([
      "Link 11 comes from node 9, which the graph doesn't have; dropping it.",
      "Link 12 comes from node 9, which the graph doesn't have; dropping it.",
    ]);
  });

  test("through a shared Reroute, the link into the missing node is named for both", () => {
    const text = file(
      [reroute(5, 13), encode(2, "a", 11), encode(3, "b", 12)],
      [
        [13, 9, 0, 5, 0, "CLIP"],
        [11, 5, 0, 2, 0, "CLIP"],
        [12, 5, 0, 3, 0, "CLIP"],
      ],
    );
    const { diagnostics } = importUi(text, schema);
    expect(diagnostics.map((diagnostic) => diagnostic.message)).toEqual([
      "Link 13 comes from node 9, which the graph doesn't have; dropping it.",
      "Link 13 comes from node 9, which the graph doesn't have; dropping it.",
    ]);
  });
});
