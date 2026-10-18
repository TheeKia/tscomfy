// A node as the ComfyUI frontend creates it from its definition (docs/plan.md §11, §12): its
// widgets, which a UI workflow saves positionally in `widgets_values` and a prompt sends by name,
// and its input slots, which links target. One model for the UI format and for bypass.
// ComfyUI_frontend 1.55.17, read as a specification (`litegraphService.ts` `addInputs`,
// `addInputSocket`, `addInputWidget`; `widgets.ts` `addValueControlWidgets`; `dynamicWidgets.ts`;
// `widgetId.ts` `ensureUniqueWidgetNames`; the core extensions' `beforeRegisterNodeDef`,
// `getCustomWidgets` and `nodeCreated` hooks) and checked by creating nodes in the running frontend
// (docs/research/ui-format.md).

import { isJsonArray, isJsonObject, type JsonValue } from "../json/value.ts";
import { typeText } from "../schema/type-text.ts";
import type { AutogrowInput, ComboInput, InputDef, NodeDef, ValueInput } from "../schema/types.ts";
import { isPrimitiveWidget, widgetPersistence, type WidgetSending } from "./widgets.ts";

/**
 * What a widget is for: an input's value (of an input the server declares, which `key` names, or
 * one a core extension adds), a control after it, a combo's control filter, or a part the
 * input's widget adds (a BOUNDING_BOX field, a button).
 */
export type WidgetRole = "value" | "control" | "filter" | "part";

/** One widget of a node, in the frontend's widget order. */
export interface FrontendWidget {
  readonly role: WidgetRole;
  /**
   * The widget's name, which `widgets_values_named` keys and a prompt sends: an input's name, a
   * control's, a button's, or a fixed one (`view`); a name an earlier widget has gets `#1`, `#2`…
   */
  readonly name: string;
  /** The wire key of the input whose value it holds; absent for controls and buttons. */
  readonly key?: string;
  /** The input it edits; absent for controls, buttons and inputs the frontend adds itself. */
  readonly input?: InputDef;
  /** Saved in `widgets_values` (`widget.serialize !== false`). */
  readonly saved: boolean;
  /** What a prompt carries for it (`widget.options.serialize !== false`). */
  readonly sent: WidgetSending;
  /** The value the frontend creates it with. */
  readonly initial: JsonValue;
  /** For a BOUNDING_BOX field widget: the field of the box it shows. */
  readonly field?: string;
}

/** One input slot of a node, in the frontend's slot order. */
export interface FrontendSlot {
  /** The slot's name, which is the wire key of the input it feeds. */
  readonly name: string;
  /** The declared type the frontend gives the slot. */
  readonly type: string;
  /**
   * The input it feeds (an Autogrow slot: the template); absent for the inputs the frontend adds
   * itself, which send nothing.
   */
  readonly input?: InputDef;
  /** A widget-backed slot: linking it replaces the widget's value in the prompt. */
  readonly widget: boolean;
}

/** How {@link frontendSlots} lays out what a node's values decide. */
export interface SlotOptions {
  /** A dynamic combo's selected key, by its wire key. */
  readonly chosen: (key: string) => JsonValue | undefined;
  /** The slots of an Autogrow that are listed, by name, given its wire key. */
  readonly autogrow: (key: string, input: AutogrowInput) => readonly string[];
  /**
   * The node as just created, before any value is set: every dynamic combo on its first option,
   * whose slots come before the combo's own (the frontend adds them while it creates the combo's
   * widget). Links that name no input land on this layout.
   */
  readonly fresh?: boolean;
  /**
   * A dynamic combo `chosen` gives no key for: on its first option, as the frontend creates it
   * (the default), or with no option slots, as for a prompt that sends none of them.
   */
  readonly unset?: "first" | "none";
}

/**
 * Classes whose widgets frontend JavaScript builds from what the user does, beyond what the
 * definition says: CustomCombo's option fields and its `index`. Their saved values and what the
 * frontend sends for them can't be reproduced.
 */
export const SCRIPTED_WIDGETS: ReadonlySet<string> = new Set(["CustomCombo"]);

/**
 * Why the frontend can't create a node of this class, or `undefined` when it can. The upload
 * button's constructor throws when its file combo has no widget (the combo is named `upload`, so
 * the button replaces it, or is `forceInput`), and when an input asks for an upload button
 * directly; the frontend then shows a placeholder and sends it without a class.
 */
export function uncreatable(definition: NodeDef): string | undefined {
  return analyze(definition).uncreatable;
}

/**
 * The inputs of a node as the frontend holds them once its core extensions have changed its
 * definition (`beforeRegisterNodeDef`): the declared ones in input order, an `upload` button's
 * replacing a required input of that name in place, then those the extensions add.
 */
export function frontendInputs(definition: NodeDef): readonly NodeInput[] {
  return analyze(definition).inputs;
}

/**
 * The widgets of a node, in order (§11): each input's widgets in input order (a value widget,
 * then a control after `control_after_generate`, then a combo's filter), a dynamic combo followed
 * by the chosen option's widgets depth-first, the widgets of the inputs core extensions add
 * (upload buttons, previews), then the buttons they add once the node exists. Names an earlier
 * widget has are renamed as the frontend renames them. `chosen` gives a dynamic combo's selected
 * key, by its wire key; without one, its first option.
 */
export function frontendWidgets(
  definition: NodeDef,
  chosen: (key: string) => JsonValue | undefined,
): readonly FrontendWidget[] {
  const analysis = analyze(definition);
  if (!analysis.dynamic) return createdWidgets(definition);
  return buildWidgets(definition, analysis, chosen);
}

/** The widgets of a node just created: {@link frontendWidgets} with every dynamic combo unset. */
export function createdWidgets(definition: NodeDef): readonly FrontendWidget[] {
  const known = CREATED.get(definition);
  if (known !== undefined) return known;
  const widgets = buildWidgets(definition, analyze(definition), () => undefined);
  CREATED.set(definition, widgets);
  return widgets;
}

/**
 * The input slots of a node as the frontend creates and then loads it: sockets in input order
 * (inputs without a widget, `forceInput` inputs, MatchType inputs, Autogrow slots), then the
 * slots of widgets in input order (the frontend gives every widget a slot: it ignores
 * `socketless`), a chosen dynamic-combo option's slots right after the combo's own, then the
 * inputs core extensions add.
 */
export function frontendSlots(definition: NodeDef, options: SlotOptions): FrontendSlot[] {
  const { chosen, autogrow, fresh = false, unset = "first" } = options;
  const sockets: FrontendSlot[] = [];
  const widgets: FrontendSlot[] = [];
  const grown = (input: AutogrowInput, key: string): FrontendSlot[] => {
    const template = slotOf(input.template, key);
    if (template === undefined) return [];
    return autogrow(key, input).map((slot) => ({
      name: `${key}.${slot}`,
      type: template.type,
      input: input.template,
      widget: false,
    }));
  };
  /** A dynamic combo's chosen option, slot by slot in declaration order. */
  const option = (input: InputDef, key: string): FrontendSlot[] => {
    if (input.kind !== "dynamicCombo") return [];
    const given = fresh ? undefined : chosen(key);
    const selected = given ?? (unset === "first" || fresh ? input.options[0]?.key : undefined);
    const found = input.options.find((each) => each.key === selected);
    const slots: FrontendSlot[] = [];
    for (const child of found?.inputs ?? []) {
      const childKey = `${key}.${child.name}`;
      if (child.kind === "autogrow") {
        slots.push(...grown(child, childKey));
        continue;
      }
      const own = slotOf(child, childKey);
      const nested = option(child, childKey);
      if (fresh) slots.push(...nested);
      if (own !== undefined) slots.push(own);
      if (!fresh) slots.push(...nested);
    }
    return slots;
  };
  for (const { input, declared } of analyze(definition).inputs) {
    if (input.kind === "autogrow") {
      sockets.push(...grown(input, input.name));
      continue;
    }
    const own = slotOf(input, input.name);
    if (own === undefined) continue;
    const slot = declared ? own : { name: own.name, type: own.type, widget: own.widget };
    const chosenSlots = option(input, input.name);
    (own.widget ? widgets : sockets).push(
      ...(fresh ? [...chosenSlots, slot] : [slot, ...chosenSlots]),
    );
  }
  return [...sockets, ...widgets];
}

/**
 * Whether a `control_after_generate` adds a control: the frontend tests it for truthiness, so
 * `false` and `""` add none.
 */
export function controlOn(control: boolean | string | undefined): control is true | string {
  return control === true || (typeof control === "string" && control !== "");
}

/** An input of the node as the frontend holds it, and whether the server declares it. */
export interface NodeInput {
  readonly input: InputDef;
  /** Declared by the server; otherwise added by a core extension, and never sent. */
  readonly declared: boolean;
}

/** What a definition becomes in the frontend, computed once per definition. */
interface Analysis {
  readonly inputs: readonly NodeInput[];
  /** Has a dynamic combo, so its widgets depend on the values chosen. */
  readonly dynamic: boolean;
  readonly uncreatable: string | undefined;
}

const ANALYSES = new WeakMap<NodeDef, Analysis>();
const CREATED = new WeakMap<NodeDef, readonly FrontendWidget[]>();

/** Nodes whose `LOAD_3D` widget is named `viewport_state` (`load3d.ts`); `image` elsewhere. */
const VIEWPORT_STATE_NODES: ReadonlySet<string> = new Set([
  "Preview3DAdvanced",
  "Save3DAdvanced",
  "PreviewGaussianSplat",
  "PreviewPointCloud",
  "SaveGaussianSplat",
  "SavePointCloud",
]);
/** Nodes the 3D extensions give a `PREVIEW_3D` input named `image` (`load3d.ts`, `saveMesh.ts`). */
const PREVIEW_3D_NODES: ReadonlySet<string> = new Set(["Preview3D", "SaveGLB"]);
/** Nodes the audio extension gives an `AUDIO_UI` player input named `audioUI` (`uploadAudio.ts`). */
const AUDIO_UI_NODES: ReadonlySet<string> = new Set([
  "LoadAudio",
  "SaveAudio",
  "PreviewAudio",
  "SaveAudioMP3",
  "SaveAudioOpus",
  "SaveAudioAdvanced",
]);
/** The buttons the `LOAD_3D` widget adds after a `model_file` widget, with their values. */
const LOAD_3D_BUTTONS: readonly (readonly [name: string, value: string])[] = [
  ["upload 3d model", "upload3dmodel"],
  ["upload extra resources", "uploadExtraResources"],
  ["clear", "clear"],
];
/** The toggle the frontend adds after every remote combo. */
const REMOTE_TOGGLE: FrontendWidget = {
  role: "part",
  name: "Auto-refresh after generation",
  saved: true,
  sent: "never",
  initial: false,
};
/** The refresh button a remote combo asks for (`addRefreshButton`). */
const REFRESH_BUTTON: FrontendWidget = {
  role: "part",
  name: "refresh",
  saved: true,
  sent: "value",
  initial: "refresh",
};
/** The fields of a BOUNDING_BOX value, each with a number widget of its own. */
const BOX_FIELDS = ["x", "y", "width", "height"] as const;
/**
 * The values the frontend's value widgets start from when the server gives no default (their
 * composables), where that isn't `null`.
 */
const CREATED_VALUES: ReadonlyMap<string, JsonValue> = new Map<string, JsonValue>([
  ["MARKDOWN", ""],
  ["COLOR", "#000000"],
  ["TEXTAREA", ""],
  ["BOUNDING_BOX", { x: 0, y: 0, width: 512, height: 512 }],
  ["COMPOSITOR", {}],
  [
    "CURVE",
    {
      points: [
        [0, 0],
        [1, 1],
      ],
      interpolation: "monotone_cubic",
    },
  ],
  ["RANGE", { min: 0, max: 1 }],
  [
    "VIDEO_EDIT",
    { trim: { start_time: 0, duration: 0 }, crop: { x: 0, y: 0, width: 0, height: 0 } },
  ],
  ["BOUNDING_BOXES", []],
  ["COLORS", []],
  ["IMAGECOMPARE", ["", ""]],
]);
/** DOM widgets that hold no value of their own: created, saved and restored as `""`. */
const DOM_WIDGETS: ReadonlySet<string> = new Set([
  "LOAD_3D",
  "LOAD_3D_ADVANCED",
  "PREVIEW_3D",
  "WEBCAM",
  "AUDIO_RECORD",
  "AUDIO_UI",
  "AUDIOUPLOAD",
  "CAMERA_INFO_STATE",
]);

function analyze(definition: NodeDef): Analysis {
  const known = ANALYSES.get(definition);
  if (known !== undefined) return known;
  const analysis = analyzeAnew(definition);
  ANALYSES.set(definition, analysis);
  return analysis;
}

/**
 * The node's inputs once the core extensions' `beforeRegisterNodeDef` hooks have run: inputs
 * they add go after every declared one (`getOrderedInputSpecs` puts inputs `input_order` doesn't
 * list last), an `upload` they add replaces a required input of that name in place, and one an
 * optional input already has is lost to it.
 */
function analyzeAnew(definition: NodeDef): Analysis {
  const { classType } = definition;
  let uncreatableReason: string | undefined;
  const inputs: NodeInput[] = definition.inputs.map((input) =>
    classType === "Load3DAdvanced" && input.name === "viewport_state" && input.kind === "value"
      ? { input: retyped(input, "LOAD_3D_ADVANCED"), declared: true }
      : { input, declared: true },
  );
  const add = (input: InputDef): void => {
    const at = inputs.findIndex((each) => each.input.name === input.name);
    const existing = inputs[at];
    if (existing === undefined) inputs.push({ input, declared: false });
    else if (existing.input.required) inputs[at] = { input, declared: false };
  };
  if (PREVIEW_3D_NODES.has(classType)) add(pseudo("image", "PREVIEW_3D"));
  if (AUDIO_UI_NODES.has(classType)) add(pseudo("audioUI", "AUDIO_UI"));
  const required = definition.inputs.filter((input) => input.required);
  const audio = required.find((input) => input.name === "audio" && uploads(input, "audio"));
  if (audio !== undefined) add(pseudo("upload", "AUDIOUPLOAD"));
  const media = required.find(
    (input): input is ComboInput => input.kind === "combo" && isMediaUpload(input),
  );
  if (media !== undefined) {
    if (media.name === "upload" || media.forceInput === true) {
      uncreatableReason = `its upload combo ${media.name} gets no widget for the upload button to fill (${media.forceInput === true ? "it is forceInput" : "the button replaces it"}), so the button's constructor throws`;
    }
    add(pseudo("upload", "IMAGEUPLOAD"));
  }
  const direct = definition.inputs.find(
    (input) =>
      input.kind === "value" && (input.widget === "IMAGEUPLOAD" || input.widget === "AUDIOUPLOAD"),
  );
  if (direct !== undefined && uncreatableReason === undefined) {
    uncreatableReason = `its input ${direct.name} asks for an upload button, whose constructor throws without the file combo an upload extension names`;
  }
  return {
    inputs,
    dynamic: inputs.some(({ input }) => input.kind === "dynamicCombo"),
    uncreatable: uncreatableReason,
  };
}

function buildWidgets(
  definition: NodeDef,
  analysis: Analysis,
  chosen: (key: string) => JsonValue | undefined,
): readonly FrontendWidget[] {
  const widgets: FrontendWidget[] = [];
  const visit = (input: InputDef, key: string, declared: boolean): void => {
    const edits = declared ? { key, input } : {};
    switch (input.kind) {
      case "int":
      case "float": {
        widgets.push(...typedWidgets(input, key, edits, widgets, definition.classType));
        // The frontend tests the option for truthiness: `false` and `""` add no control.
        if (input.kind === "int") {
          const control = intControl(input);
          if (controlOn(control)) widgets.push(controlWidget(control, "randomize"));
        } else if (controlOn(input.control)) {
          widgets.push(controlWidget(input.control, "fixed", false));
        }
        break;
      }
      case "combo":
        if (input.forceInput === true) break;
        widgets.push(...typedWidgets(input, key, edits, widgets, definition.classType));
        if (controlOn(input.control)) {
          widgets.push(controlWidget(input.control, input.multiselect ? "fixed" : "randomize"));
          if (!input.multiselect) {
            widgets.push({
              role: "filter",
              name: "control_filter_list",
              saved: true,
              sent: "never",
              initial: "",
            });
          }
        }
        break;
      case "string":
      case "boolean":
      case "value":
        widgets.push(...typedWidgets(input, key, edits, widgets, definition.classType));
        break;
      case "dynamicCombo": {
        const first = input.options[0]?.key ?? "";
        widgets.push({
          role: "value",
          name: key,
          ...edits,
          saved: true,
          sent: "value",
          initial: first,
        });
        const selected = chosen(key) ?? first;
        const option = input.options.find((each) => each.key === selected);
        for (const child of option?.inputs ?? []) visit(child, `${key}.${child.name}`, declared);
        break;
      }
      case "socket":
      case "matchType":
      case "autogrow":
      case "dynamicGroup":
      case "unknown":
        break;
    }
  };
  for (const { input, declared } of analysis.inputs) visit(input, input.name, declared);
  // The webcam extension adds its capture button once the node exists (`nodeCreated`); it is
  // saved, and sent as nothing (`serializeValue` returns undefined).
  if (definition.classType === "WebcamCapture") {
    widgets.push({
      role: "part",
      name: "waiting for camera...",
      saved: true,
      sent: "never",
      initial: "capture",
    });
  }
  return uniquelyNamed(widgets);
}

/** The widgets one input gets from the widget its type names. */
function typedWidgets(
  input: Extract<InputDef, { kind: "int" | "float" | "string" | "boolean" | "combo" | "value" }>,
  key: string,
  edits: { readonly key?: string; readonly input?: InputDef },
  before: readonly FrontendWidget[],
  classType: string,
): FrontendWidget[] {
  const widget = widgetOf(input);
  const persistence = widgetPersistence(widget);
  const own = (name: string, initial: JsonValue): FrontendWidget => ({
    role: "value",
    name,
    ...edits,
    ...persistence,
    initial,
  });
  switch (widget) {
    case "BOUNDING_BOX": {
      // The box, then a number widget per field: saved, never sent.
      const box = createdValue(input, widget);
      const fields = isJsonObject(box) ? box : {};
      return [
        own(key, box),
        ...BOX_FIELDS.map((field): FrontendWidget => ({
          role: "part",
          name: field,
          saved: true,
          sent: "never",
          initial: fields[field] ?? null,
          field,
        })),
      ];
    }
    case "AUDIO_RECORD":
      // The recording, then the record button, which shares its name (renamed `#1`).
      return [own(key, ""), { role: "part", name: key, saved: true, sent: "never", initial: "" }];
    case "CAMERA_ANGLE_VIEW":
      return [own("view", "camera")];
    case "CAMERA_INFO_STATE":
      return [own("camera_info_state", "")];
    case "LOAD_3D": {
      const buttons = before.some((each) => each.name === "model_file")
        ? LOAD_3D_BUTTONS.map(([name, value]): FrontendWidget => ({
            role: "part",
            name,
            saved: true,
            sent: "value",
            initial: value,
          }))
        : [];
      return [
        ...buttons,
        own(VIEWPORT_STATE_NODES.has(classType) ? "viewport_state" : "image", ""),
      ];
    }
    case "LOAD_3D_ADVANCED":
      return [own("viewport_state", "")];
    case "PREVIEW_3D":
      return [own("image", "")];
    case "IMAGEUPLOAD":
      return [own(key, "image")];
    case "COMBO":
      // A remote combo's auto-refresh toggle follows it (`useRemoteWidget`): saved, never sent.
      // So does its refresh button when it asks for one: saved, and sent under its label.
      if (input.kind !== "combo" || !input.remote) return [own(key, createdValue(input, widget))];
      return [
        own(key, createdValue(input, widget)),
        REMOTE_TOGGLE,
        ...(input.refreshButton === true ? [REFRESH_BUTTON] : []),
      ];
    default:
      return [own(key, DOM_WIDGETS.has(widget) ? "" : createdValue(input, widget))];
  }
}

/** The frontend widget an input's type names: `widgetType ?? type`. */
function widgetOf(
  input: Extract<InputDef, { kind: "int" | "float" | "string" | "boolean" | "combo" | "value" }>,
): string {
  switch (input.kind) {
    case "int":
      return input.widgetType ?? "INT";
    case "float":
      return input.widgetType ?? "FLOAT";
    case "string":
      return input.widgetType ?? "STRING";
    case "boolean":
      return input.widgetType ?? "BOOLEAN";
    case "combo":
      return input.widgetType ?? "COMBO";
    case "value":
      return input.widget;
  }
}

/** The value a widget is created with: the default, else what the widget starts from. */
function createdValue(
  input: Extract<InputDef, { kind: "int" | "float" | "string" | "boolean" | "combo" | "value" }>,
  widget: string,
): JsonValue {
  if (input.default !== undefined) return input.default;
  const created = isPrimitiveWidget(widget) ? undefined : CREATED_VALUES.get(widget);
  if (created !== undefined) return created;
  switch (input.kind) {
    case "int":
    case "float":
      return 0;
    case "string":
      return "";
    case "boolean":
      return false;
    case "combo":
      return input.options[0] ?? null;
    case "value":
      return null;
  }
}

/**
 * `ensureUniqueWidgetNames`: a widget whose name an earlier one has becomes `name#1` (or the next
 * number neither taken nor any widget's own name).
 */
function uniquelyNamed(widgets: readonly FrontendWidget[]): readonly FrontendWidget[] {
  const reserved = new Set(widgets.map((widget) => widget.name));
  const used = new Set<string>();
  return widgets.map((widget) => {
    if (!used.has(widget.name)) {
      used.add(widget.name);
      return widget;
    }
    let index = 1;
    while (
      used.has(`${widget.name}#${String(index)}`) ||
      reserved.has(`${widget.name}#${String(index)}`)
    )
      index++;
    const name = `${widget.name}#${String(index)}`;
    used.add(name);
    return { ...widget, name };
  });
}

/** The slot one input gets, if it gets one. */
function slotOf(input: InputDef, key: string): FrontendSlot | undefined {
  switch (input.kind) {
    case "socket":
      return { name: key, type: typeText(input.type), input, widget: false };
    case "matchType":
      return { name: key, type: typeText(input.allowed), input, widget: false };
    case "unknown":
      return { name: key, type: unknownType(input.spec), input, widget: false };
    case "combo":
      return { name: key, type: "COMBO", input, widget: input.forceInput !== true };
    case "int":
    case "float":
    case "string":
    case "boolean":
    case "value":
      return { name: key, type: typeText(input.type), input, widget: true };
    case "dynamicCombo":
      return { name: key, type: "COMFY_DYNAMICCOMBO_V3", input, widget: true };
    case "autogrow":
    case "dynamicGroup":
      return undefined;
  }
}

/** The type the frontend gives an input it can't read: the spec's type string, else `*`. */
function unknownType(spec: JsonValue): string {
  const head = isJsonArray(spec) ? spec[0] : undefined;
  return typeof head === "string" ? head : "*";
}

/** An INT's control: as stated, or on by default for inputs named `seed` or `noise_seed`. */
function intControl(input: Extract<InputDef, { kind: "int" }>): boolean | string {
  return input.control ?? (input.name === "seed" || input.name === "noise_seed");
}

/**
 * The control widget after a value (`addValueControlWidget`): named after the option when it is
 * a string, valued after it too, else `fallback` (the composables' default: `randomize` for INT
 * and single-select combos, `fixed` for FLOAT and multi-select combos; a FLOAT's control starts
 * `fixed` even when named). Saved, never sent.
 */
function controlWidget(control: true | string, fallback: string, named = true): FrontendWidget {
  return {
    role: "control",
    name: control === true ? "control_after_generate" : control,
    saved: true,
    sent: "never",
    initial: control === true || !named ? fallback : control,
  };
}

/** A combo the image upload extension gives a button (`isMediaUploadComboInput`). */
function isMediaUpload(input: ComboInput): boolean {
  const comboType =
    input.form === "legacy" || (input.type.kind === "named" && input.type.name === "COMBO");
  return comboType && ["image", "video", "animated_image"].some((kind) => uploads(input, kind));
}

function uploads(input: InputDef, kind: string): boolean {
  return input.kind === "combo" && (input.uploads ?? []).some((each) => each === kind);
}

/** An input a core extension adds: a required widget of `widget`'s type, with a slot. */
function pseudo(name: string, widget: string): ValueInput {
  return {
    kind: "value",
    name,
    required: true,
    lazy: false,
    rawLink: false,
    type: { kind: "named", name: widget },
    socketless: false,
    widget,
  };
}

/** A declared input the 3D extension retypes (`load3dAdvanced.ts`). */
function retyped(input: ValueInput, widget: string): ValueInput {
  return { ...input, widget, type: { kind: "named", name: widget } };
}
