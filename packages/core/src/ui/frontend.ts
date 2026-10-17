// A node as the ComfyUI frontend creates it from its definition (docs/plan.md §11): its widgets,
// which the UI format saves positionally in `widgets_values`, and its input slots, which links in
// the UI format target. Frontend 1.55.17 (`litegraphService.ts` `addInputs`, `widgets.ts`
// `addValueControlWidgets`, `dynamicWidgets.ts`, the upload extensions), read as a specification.

import type { JsonValue } from "../json/value.ts";
import type { InputDef, NodeDef, SocketType } from "../schema/types.ts";

/** One widget of a node, in the frontend's widget order. */
export interface FrontendWidget {
  /** The widget's name: an input's name, a control's, or a pseudo-input's (`upload`). */
  readonly name: string;
  /** The wire key whose value it holds; absent for controls and buttons. */
  readonly key?: string;
  /** The input it edits; absent for controls and buttons. */
  readonly input?: InputDef;
  /** Saved in `widgets_values` (`widget.serialize !== false`). */
  readonly persisted: boolean;
  /** The value the frontend creates it with. */
  readonly initial: JsonValue;
}

/** One input slot of a node, in the frontend's slot order. */
export interface FrontendSlot {
  /** The slot's name, which is the wire key of the input it feeds. */
  readonly name: string;
  /** The declared type the frontend gives the slot. */
  readonly type: string;
  /** The input it belongs to. */
  readonly input: InputDef;
  /** A widget-backed slot: linking it replaces the widget's value in the prompt. */
  readonly widget: boolean;
}

/**
 * The widgets of a node, in order (§11): each input's widgets in input order (a value widget,
 * then a control after `control_after_generate`, then a combo's filter), a dynamic combo followed
 * by the chosen option's widgets depth-first, then the `upload` button the upload extensions add.
 * `chosen` gives a dynamic combo's selected key, by its wire key.
 */
export function frontendWidgets(
  definition: NodeDef,
  chosen: (key: string) => JsonValue | undefined,
): FrontendWidget[] {
  const widgets: FrontendWidget[] = [];
  const visit = (inputs: readonly InputDef[], prefix: string): void => {
    for (const input of inputs) {
      const key = `${prefix}${input.name}`;
      switch (input.kind) {
        case "int":
        case "float": {
          widgets.push({ name: key, key, input, persisted: true, initial: initialValue(input) });
          const control = input.kind === "int" ? intControl(input) : input.control;
          if (control !== undefined && control !== false) widgets.push(controlWidget(control));
          break;
        }
        case "combo": {
          if (input.forceInput === true) break;
          widgets.push({ name: key, key, input, persisted: true, initial: initialValue(input) });
          if (input.control !== undefined && input.control !== false) {
            widgets.push(controlWidget(input.control));
            if (!input.multiselect) {
              widgets.push({ name: "control_filter_list", persisted: true, initial: "" });
            }
          }
          break;
        }
        case "string":
        case "boolean":
          widgets.push({ name: key, key, input, persisted: true, initial: initialValue(input) });
          break;
        case "value":
          widgets.push({
            name: key,
            key,
            input,
            persisted: persistsValue(input.widget),
            initial: initialValue(input),
          });
          break;
        case "dynamicCombo": {
          const first = input.options[0]?.key ?? "";
          widgets.push({ name: key, key, input, persisted: true, initial: first });
          const selected = chosen(key) ?? first;
          const option = input.options.find((each) => each.key === selected);
          if (option !== undefined) visit(option.inputs, `${key}.`);
          break;
        }
        case "socket":
        case "matchType":
        case "autogrow":
        case "dynamicGroup":
        case "unknown":
          break;
      }
    }
  };
  visit(definition.inputs, "");
  const upload = uploadWidget(definition);
  if (upload !== undefined) widgets.push(upload);
  return widgets;
}

/**
 * The input slots of a node as the frontend creates and then loads it: sockets in input order
 * (inputs without a widget, `forceInput` legacy combos, MatchType inputs, Autogrow slots), then
 * the slots of widgets in input order, a chosen dynamic-combo option's slots right after the
 * combo's own. `autogrowSlots` gives how many slots of an Autogrow are listed (the frontend shows
 * the linked ones and one more).
 */
export function frontendSlots(
  definition: NodeDef,
  chosen: (key: string) => JsonValue | undefined,
  autogrowSlots: (key: string, input: Extract<InputDef, { kind: "autogrow" }>) => number,
): FrontendSlot[] {
  const sockets: FrontendSlot[] = [];
  const widgets: FrontendSlot[] = [];
  /** A dynamic combo's chosen option, slot by slot in declaration order. */
  const option = (input: InputDef, key: string): FrontendSlot[] => {
    if (input.kind !== "dynamicCombo") return [];
    const selected = chosen(key) ?? input.options[0]?.key;
    const found = input.options.find((each) => each.key === selected);
    const slots: FrontendSlot[] = [];
    for (const child of found?.inputs ?? []) {
      const childKey = `${key}.${child.name}`;
      if (child.kind === "autogrow") {
        slots.push(...grown(child, childKey));
        continue;
      }
      const own = slotOf(child, childKey);
      if (own !== undefined) slots.push(own);
      slots.push(...option(child, childKey));
    }
    return slots;
  };
  const grown = (input: Extract<InputDef, { kind: "autogrow" }>, key: string): FrontendSlot[] => {
    const type = templateType(input.template);
    return input.slots.slice(0, autogrowSlots(key, input)).map((slot) => ({
      name: `${key}.${slot}`,
      type,
      input: input.template,
      widget: false,
    }));
  };
  for (const input of definition.inputs) {
    if (input.kind === "autogrow") {
      sockets.push(...grown(input, input.name));
      continue;
    }
    const own = slotOf(input, input.name);
    if (own === undefined) continue;
    (own.widget ? widgets : sockets).push(own, ...option(input, input.name));
  }
  return [...sockets, ...widgets];
}

function slotOf(input: InputDef, key: string): FrontendSlot | undefined {
  switch (input.kind) {
    case "socket":
      return { name: key, type: typeText(input.type), input, widget: false };
    case "matchType":
      return { name: key, type: typeText(input.allowed), input, widget: false };
    case "unknown":
      return { name: key, type: unknownType(input.spec), input, widget: false };
    case "combo":
      if (input.forceInput === true) return { name: key, type: "COMBO", input, widget: false };
      return input.socketless ? undefined : { name: key, type: "COMBO", input, widget: true };
    case "int":
    case "float":
    case "string":
    case "boolean":
    case "value":
      return input.socketless
        ? undefined
        : { name: key, type: typeText(input.type), input, widget: true };
    case "dynamicCombo":
      return { name: key, type: "COMFY_DYNAMICCOMBO_V3", input, widget: true };
    case "autogrow":
    case "dynamicGroup":
      return undefined;
  }
}

/**
 * Whether the frontend saves a value widget's value (`widget.serialize`): IMAGECOMPARE and the
 * preview widgets hold state, not settings.
 */
export function persistsValue(widget: string): boolean {
  return !NOT_PERSISTED.has(widget);
}

const NOT_PERSISTED: ReadonlySet<string> = new Set([
  "IMAGECOMPARE",
  "RESOLUTION_PREVIEW",
  "CAMERA_INFO_STATE",
]);

/** An INT's control: as stated, or on by default for inputs named `seed` or `noise_seed`. */
function intControl(input: Extract<InputDef, { kind: "int" }>): boolean | string {
  return input.control ?? (input.name === "seed" || input.name === "noise_seed");
}

/**
 * The control widget after a value (`addValueControlWidget`): named after the option when it is
 * a string, valued after it too, else `randomize`.
 */
function controlWidget(control: true | string): FrontendWidget {
  return {
    name: control === true ? "control_after_generate" : control,
    persisted: true,
    initial: control === true ? "randomize" : control,
  };
}

/**
 * The `upload` button the upload extensions add (`uploadImage.ts`, `uploadAudio.ts`): for the
 * first required combo that uploads images or videos, or a required `audio` combo that uploads
 * audio. Saved (`"image"`, or `""` for audio), never sent.
 */
function uploadWidget(definition: NodeDef): FrontendWidget | undefined {
  const required = definition.inputs.filter((input) => input.required);
  const media = required.some((input) =>
    uploads(input).some(
      (kind) => kind === "image" || kind === "video" || kind === "animated_image",
    ),
  );
  if (media) return { name: "upload", persisted: true, initial: "image" };
  const audio = required.some(
    (input) => input.name === "audio" && uploads(input).includes("audio"),
  );
  return audio ? { name: "upload", persisted: true, initial: "" } : undefined;
}

function uploads(input: InputDef): readonly string[] {
  return input.kind === "combo" ? (input.uploads ?? []) : [];
}

/** The value a widget is created with (`default ?? 0`, `""`, `false`, the first option, …). */
export function initialValue(
  input: Extract<InputDef, { kind: "int" | "float" | "string" | "boolean" | "combo" | "value" }>,
): JsonValue {
  switch (input.kind) {
    case "int":
      return input.default ?? 0;
    case "float":
      return input.default ?? 0;
    case "string":
      return input.default ?? "";
    case "boolean":
      return input.default ?? false;
    case "combo":
      return input.default ?? input.options[0] ?? null;
    case "value":
      return input.default ?? null;
  }
}

function templateType(template: InputDef): string {
  if (template.kind === "socket") return typeText(template.type);
  if (template.kind === "matchType") return typeText(template.allowed);
  return "*";
}

function typeText(type: SocketType): string {
  switch (type.kind) {
    case "any":
      return "*";
    case "named":
      return type.name;
    case "union":
      return type.names.join(",");
  }
}

function unknownType(spec: JsonValue): string {
  const head = isList(spec) ? spec[0] : undefined;
  return typeof head === "string" ? head : "*";
}

function isList(value: JsonValue): value is readonly JsonValue[] {
  return Array.isArray(value);
}
