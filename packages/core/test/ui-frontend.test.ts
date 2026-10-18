import { describe, expect, test } from "bun:test";
import { importUi, stringify, toApi, toUi, workflow } from "@tscomfy/core";
import { readMockObjectInfo } from "@tscomfy/fixtures";
import { createdWidgets, frontendSlots, uncreatable } from "../src/frontend/node.ts";
import { sendsValue, widgetPersistence } from "../src/frontend/widgets.ts";
import { looseSchema } from "./loose.ts";
import { file, found, objects } from "./ui-helpers.ts";

// The frontend's node as tscomfy models it (src/frontend/node.ts), against what frontend 1.55.17
// creates: every expectation below was read from a node of that class created in the running
// frontend (`LiteGraph.createNode`, then `serialize()`; the mock classes registered with
// `app.registerNodeDef`), as docs/research/ui-format.md describes.

const extensions = looseSchema(await readMockObjectInfo("ui-extensions"));
const combos = looseSchema(await readMockObjectInfo("combos"));

function definition(classType: string) {
  const known = extensions.nodes[classType];
  if (known === undefined) throw new Error(`no ${classType}`);
  return known;
}

/** Widgets as `name saved|unsaved sent|unsent|queue = initial`. */
function widgetsOf(classType: string): string[] {
  return createdWidgets(definition(classType)).map(
    (widget) =>
      `${widget.name} ${widget.saved ? "saved" : "unsaved"} ${widget.sent === "value" ? "sent" : widget.sent === "never" ? "unsent" : "queue"} = ${stringify(widget.initial)}`,
  );
}

/** Slots as `name:type`, widget slots marked `(w)`, as the frontend lists `node.inputs`. */
function slotsOf(classType: string): string[] {
  return frontendSlots(definition(classType), {
    chosen: () => undefined,
    autogrow: (_, input) => input.slots.slice(0, Math.max(input.min + 1, 1)),
  }).map((slot) => `${slot.name}:${slot.type}${slot.widget ? "(w)" : ""}`);
}

describe("the widget registry", () => {
  test("says for each widget whether the frontend saves and sends its value", () => {
    expect(
      [
        "COLOR",
        "IMAGECOMPARE",
        "RESOLUTION_PREVIEW",
        "IMAGEUPLOAD",
        "AUDIOUPLOAD",
        "AUDIO_UI",
        "CAMERA_INFO_STATE",
        "CAMERA_ANGLE_VIEW",
        "LOAD_3D",
        "PREVIEW_3D",
        "MOCK_PACK_WIDGET",
      ].map((widget) => {
        const { saved, sent } = widgetPersistence(widget);
        return [widget, saved, sent, sendsValue(widget)];
      }),
    ).toEqual([
      ["COLOR", true, "value", true],
      ["IMAGECOMPARE", false, "value", true],
      ["RESOLUTION_PREVIEW", false, "never", false],
      ["IMAGEUPLOAD", true, "never", false],
      ["AUDIOUPLOAD", true, "never", false],
      ["AUDIO_UI", false, "never", false],
      ["CAMERA_INFO_STATE", false, "never", false],
      ["CAMERA_ANGLE_VIEW", true, "never", false],
      ["LOAD_3D", true, "queue", true],
      ["PREVIEW_3D", true, "value", true],
      // A pack's widget, which the schema can't describe: taken to be saved and sent.
      ["MOCK_PACK_WIDGET", true, "value", true],
    ]);
  });

  test("core extensions' widgets are value inputs, not sockets", () => {
    expect(
      [
        ["Load3D", "image"],
        ["RecordAudio", "audio"],
        ["WebcamCapture", "image"],
        ["CreateCameraInfo", "camera_info_state"],
      ].map(([classType = "", name]) => {
        const input = definition(classType).inputs.find((each) => each.name === name);
        return input?.kind === "value" ? input.widget : input?.kind;
      }),
    ).toEqual(["LOAD_3D", "AUDIO_RECORD", "WEBCAM", "CAMERA_INFO_STATE"]);
  });
});

describe("the widgets core extensions make", () => {
  test("Load3D: three buttons after the model combo, a scene widget computed at queue time", () => {
    expect(widgetsOf("Load3D")).toEqual([
      'model_file saved sent = "none"',
      'upload 3d model saved sent = "upload3dmodel"',
      'upload extra resources saved sent = "uploadExtraResources"',
      'clear saved sent = "clear"',
      'image saved queue = ""',
      "width saved sent = 1024",
      "height saved sent = 1024",
    ]);
    // Load3DAdvanced: the extension retypes its scene widget, which adds no buttons.
    expect(widgetsOf("Load3DAdvanced")).toEqual([
      'model_file saved sent = "none"',
      'viewport_state saved queue = ""',
      "width saved sent = 1024",
      "height saved sent = 1024",
    ]);
    expect(slotsOf("Load3DAdvanced")).toContain("viewport_state:LOAD_3D_ADVANCED(w)");
  });

  test("Preview3D and SaveGLB get a preview input the server doesn't declare", () => {
    expect(widgetsOf("Preview3D")).toEqual(['model_file saved sent = ""', 'image saved sent = ""']);
    expect(slotsOf("Preview3D")).toEqual([
      "camera_info:LOAD3D_CAMERA",
      "bg_image:IMAGE",
      "model_file:STRING,FILE_3D_GLB,FILE_3D(w)",
      "image:PREVIEW_3D(w)",
    ]);
    expect(widgetsOf("SaveGLB")).toEqual([
      'filename_prefix saved sent = "3d/ComfyUI"',
      'image saved sent = ""',
    ]);
  });

  test("audio: a player on audio nodes, an upload button, a recorder with its button", () => {
    expect(widgetsOf("LoadAudio")).toEqual([
      'audio saved sent = "voice.wav"',
      'audioUI unsaved unsent = ""',
      'upload saved unsent = ""',
    ]);
    expect(slotsOf("LoadAudio")).toEqual([
      "audio:COMBO(w)",
      "audioUI:AUDIO_UI(w)",
      "upload:AUDIOUPLOAD(w)",
    ]);
    expect(widgetsOf("SaveAudio")).toEqual([
      'filename_prefix saved sent = "audio/ComfyUI"',
      'audioUI unsaved unsent = ""',
    ]);
    // The record button shares the recording's name, so the frontend renames it.
    expect(widgetsOf("RecordAudio")).toEqual([
      'audio saved queue = ""',
      'audio#1 saved unsent = ""',
    ]);
  });

  test("cameras, webcams: fixed names, unsent state, a capture button", () => {
    expect(widgetsOf("CameraAngle")).toEqual([
      "horizontal_angle saved sent = 0",
      "vertical_angle saved sent = 0",
      "zoom saved sent = 5",
      'view saved unsent = "camera"',
    ]);
    expect(widgetsOf("CreateCameraInfo").at(-1)).toBe('camera_info_state unsaved unsent = ""');
    expect(widgetsOf("WebcamCapture")).toEqual([
      'image saved queue = ""',
      "width saved sent = 0",
      "height saved sent = 0",
      "capture_on_queue saved sent = true",
      'waiting for camera... saved unsent = "capture"',
    ]);
    // A widget named by its type keeps that name whatever the input is called.
    expect(widgetsOf("MockExtensionWidgets")).toEqual([
      "before saved sent = 3",
      'image saved queue = ""',
      'view saved unsent = "camera"',
      'camera_info_state unsaved unsent = ""',
      'player unsaved unsent = ""',
      'take saved queue = ""',
      'take#1 saved unsent = ""',
      "after saved sent = 7",
    ]);
  });

  test("a remote combo: an auto-refresh toggle, then the refresh button it asks for", () => {
    expect(widgetsOf("MockRemoteControl")).toEqual([
      "file saved sent = null",
      "Auto-refresh after generation saved unsent = false",
      'refresh saved sent = "refresh"',
      'control_after_generate saved unsent = "randomize"',
      'control_filter_list saved unsent = ""',
      "after saved sent = 7",
    ]);
    expect(widgetsOf("LoadImageOutput")).toEqual([
      "image saved sent = null",
      "Auto-refresh after generation saved unsent = false",
      'refresh saved sent = "refresh"',
      'upload saved unsent = "image"',
    ]);
  });

  test("a FLOAT's control and a multi-select's start fixed; names an earlier widget has get #1", () => {
    expect(widgetsOf("MockFloatControls")).toEqual([
      "named saved sent = 0",
      'fixed saved unsent = "fixed"',
      "plain saved sent = 0",
      'control_after_generate saved unsent = "fixed"',
      "pick saved sent = []",
      'control_after_generate#1 saved unsent = "fixed"',
    ]);
  });

  test("a BOUNDING_BOX has a number widget per field, saved and never sent", () => {
    expect(widgetsOf("MockBoxThenWidth")).toEqual([
      'box saved sent = {"x":1,"y":2,"width":30,"height":40}',
      "x saved unsent = 1",
      "y saved unsent = 2",
      "width saved unsent = 30",
      "height saved unsent = 40",
      // The INT input named like a field: the frontend renames its widget, and sends that name.
      "width#1 saved sent = 9",
    ]);
  });
});

describe("upload buttons and the inputs named upload", () => {
  test("a required input named upload is replaced by the button; an optional one keeps it", () => {
    expect(widgetsOf("MockUploadNamedInput")).toEqual([
      'image saved sent = "a.png"',
      'upload saved unsent = "image"',
      "z saved sent = 1",
    ]);
    expect(slotsOf("MockUploadNamedInput")).toEqual([
      "image:COMBO(w)",
      "upload:IMAGEUPLOAD(w)",
      "z:INT(w)",
    ]);
    expect(widgetsOf("MockUploadOptionalInput")).toEqual([
      'image saved sent = "a.png"',
      'upload saved sent = "u"',
    ]);
  });

  test("a node whose upload combo the button would replace can't be created", () => {
    const remote = combos.nodes["MockComboUploadRemote"];
    if (remote === undefined) throw new Error("no MockComboUploadRemote");
    expect(uncreatable(remote)).toContain("upload combo upload");
    // An input asking for an upload button itself: the button's constructor throws.
    const picker = looseSchema(
      JSON.stringify({
        MockPicker: { input: { required: { picker: ["IMAGEUPLOAD", {}] } }, output: [] },
      }),
    ).nodes["MockPicker"];
    expect(picker === undefined ? "missing" : uncreatable(picker)).toContain("picker");
  });

  test("toUi writes such a node by name; importUi reads it back raw, the same prompt", () => {
    const built = workflow(combos, ({ n }) => {
      n["MockComboUploadRemote"]?.({ upload: "photo-2.webp", remote: "x.png" }, { id: "1" });
    });
    const exported = toUi(built);
    expect(found(exported.diagnostics)).toEqual([["W_UNKNOWN_UI_CLASS", ["1"]]]);
    const back = importUi(stringify(exported.workflow), combos);
    expect(found(back.diagnostics)).toEqual([["W_IMPORTED_AS_RAW", ["1"]]]);
    expect(stringify(toApi(back.workflow, { validate: false }))).toBe(
      stringify(toApi(built, { validate: false })),
    );
  });

  test("toUi: the value of a replaced input is lost, and the names agree with the positions", () => {
    const built = workflow(extensions, ({ n }) => {
      n["MockUploadNamedInput"]?.({ image: "a.png", upload: "kept?", z: 2 }, { id: "1" });
    });
    const exported = toUi(built);
    expect(found(exported.diagnostics)).toEqual([["W_UI_VALUE_LOST", ["1", "inputs", "upload"]]]);
    const [node] = objects(exported.workflow["nodes"]);
    expect(node?.["widgets_values"]).toEqual(["a.png", "image", 2]);
    expect(node?.["widgets_values_named"]).toEqual({ image: "a.png", upload: "image", z: 2 });
    const back = importUi(stringify(exported.workflow), extensions);
    expect(back.diagnostics).toEqual([]);
  });
});

describe("importUi: core extension classes", () => {
  test("a frontend-saved Load3D: buttons skipped by position, the computed scene reported", () => {
    const text = file([
      {
        id: 5,
        type: "Load3D",
        widgets_values: ["none", "upload3dmodel", "uploadExtraResources", "clear", "", 640, 480],
      },
    ]);
    const { workflow: imported, diagnostics } = importUi(text, extensions);
    expect(found(diagnostics)).toEqual([["W_QUEUE_TIME_VALUE", ["5", "inputs", "image"]]]);
    expect(toApi(imported, { validate: false })["5"]?.inputs).toEqual({
      model_file: "none",
      width: 640,
      height: 480,
    });
  });

  test("CameraAngle's view mode is restored but not sent", () => {
    const text = file([{ id: 3, type: "CameraAngle", widgets_values: [30, 15, 4.5, "camera"] }]);
    const { workflow: imported, diagnostics } = importUi(text, extensions);
    expect(diagnostics).toEqual([]);
    expect(imported.graph.nodes.get("3")?.inputs["view"]).toBeUndefined();
  });

  test("a renamed widget is sent under its new name, as the frontend sends it", () => {
    const text = file([
      {
        id: 1,
        type: "MockBoxThenWidth",
        widgets_values: [{ x: 5, y: 6, width: 70, height: 80 }, 1, 2, 3, 4, 11],
      },
    ]);
    const { workflow: imported, diagnostics } = importUi(text, extensions);
    expect(diagnostics).toEqual([]);
    // The frontend's prompt for this file: {"box": {…}, "width#1": 11}.
    expect(imported.graph.nodes.get("1")?.inputs).toEqual({
      box: { x: 5, y: 6, width: 70, height: 80 },
      "width#1": 11,
    });
  });
});

describe("toUi: core extension classes", () => {
  test("writes the widgets the frontend saves, buttons and box fields included", () => {
    const built = workflow(extensions, ({ n }) => {
      n["Load3D"]?.({ model_file: "none", width: 640, height: 480 }, { id: "1" });
      n["ImageCropV2"]?.({ crop_region: { x: 8, y: 16, width: 256, height: 128 } }, { id: "2" });
      n["LoadImageOutput"]?.({ image: "out.png [output]" }, { id: "3" });
    });
    const exported = toUi(built);
    expect(found(exported.diagnostics)).toEqual([]);
    expect(objects(exported.workflow["nodes"]).map((node) => node["widgets_values"])).toEqual([
      ["none", "upload3dmodel", "uploadExtraResources", "clear", "", 640, 480],
      [{ x: 8, y: 16, width: 256, height: 128 }, 8, 16, 256, 128],
      ["out.png [output]", false, "refresh", "image"],
    ]);
  });

  test("a value for a widget the frontend computes at queue time is reported", () => {
    const built = workflow(extensions, ({ n }) => {
      n["RecordAudio"]?.({ audio: "audio/take.wav" }, { id: "4" });
    });
    expect(found(toUi(built).diagnostics)).toEqual([
      ["W_QUEUE_TIME_VALUE", ["4", "inputs", "audio"]],
    ]);
  });

  test("every widget gets a slot, socketless or not, as in the frontend", () => {
    const built = workflow(extensions, ({ n }) => {
      n["ImageCropV2"]?.({}, { id: "2" });
    });
    const [node] = objects(toUi(built).workflow["nodes"]);
    expect(objects(node?.["inputs"]).map((slot) => slot["name"])).toEqual(["image", "crop_region"]);
  });
});

describe("slots of inputs tscomfy can't read and of non-socket templates", () => {
  const local = looseSchema(
    JSON.stringify({
      MockOdd: {
        input: {
          required: {
            future: ["COMFY_FUTURE_V3", {}],
            choices: [
              "COMFY_AUTOGROW_V3",
              {
                template: {
                  input: { required: { c: [["a", "b"], { forceInput: true }] } },
                  prefix: "c",
                  min: 1,
                  max: 3,
                },
              },
            ],
            counts: [
              "COMFY_AUTOGROW_V3",
              {
                template: {
                  input: { required: { n: ["INT", { forceInput: true }] } },
                  prefix: "n",
                  min: 1,
                  max: 3,
                },
              },
            ],
          },
        },
        output: [],
      },
    }),
  );

  test("an unknown input is a socket of its type; Autogrow slots take the template's type", () => {
    // Probed: the frontend types a legacy-combo template's slots COMBO and an INT one's INT.
    const node = local.nodes["MockOdd"];
    if (node === undefined) throw new Error("no MockOdd");
    expect(
      frontendSlots(node, {
        chosen: () => undefined,
        autogrow: (_, input) => input.slots.slice(0, 2),
      }).map((slot) => `${slot.name}:${slot.type}${slot.widget ? "(w)" : ""}`),
    ).toEqual([
      "future:COMFY_FUTURE_V3",
      "choices.c0:COMBO",
      "choices.c1:COMBO",
      "counts.n0:INT",
      "counts.n1:INT",
    ]);
  });
});
