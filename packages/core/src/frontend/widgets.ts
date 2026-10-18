// The frontend's widget registry (docs/plan.md D16) and what each widget does with its value.
// The frontend looks up `widgetType ?? type` in its registry: the core widgets of `widgets.ts`
// (`ComfyWidgets`) and those its own core extensions register (`getCustomWidgets` in
// `src/extensions/core/`). An input whose key is registered gets a widget, anything else a plain
// socket. Widgets a pack registers in the browser are invisible in /object_info.
//
// A widget's value is saved in a UI workflow unless `widget.serialize === false`
// (`LGraphNode.serialize`), and sent in a prompt unless `widget.options.serialize === false`
// (`graphToPrompt`); an extension may compute what is sent when the prompt is queued
// (`serializeValue`). ComfyUI_frontend 1.55.17, read as a specification and checked by creating a
// node of every type in the running frontend (docs/research/ui-format.md).

import type { InputDef } from "../schema/types.ts";

/** Widgets tscomfy models with their own input kind. */
export type PrimitiveWidget = "INT" | "FLOAT" | "STRING" | "BOOLEAN" | "COMBO";

const PRIMITIVE_WIDGETS: ReadonlySet<string> = new Set<PrimitiveWidget>([
  "INT",
  "FLOAT",
  "STRING",
  "BOOLEAN",
  "COMBO",
]);

/** What the frontend sends for a widget: its value, nothing, or a value computed at queue time. */
export type WidgetSending = "value" | "never" | "queue";

/** Whether the frontend saves a widget's value, and what it sends for it. */
export interface WidgetPersistence {
  /** Saved in `widgets_values` (`widget.serialize !== false`). */
  readonly saved: boolean;
  /** Sent in a prompt (`widget.options.serialize !== false`), and how. */
  readonly sent: WidgetSending;
}

const SAVED_AND_SENT: WidgetPersistence = { saved: true, sent: "value" };
const SAVED_NOT_SENT: WidgetPersistence = { saved: true, sent: "never" };
const NEITHER: WidgetPersistence = { saved: false, sent: "never" };
/** A DOM widget saved as `""` whose prompt value an extension computes when it queues. */
const COMPUTED: WidgetPersistence = { saved: true, sent: "queue" };

/**
 * The registry's widgets other than the primitives, with their persistence. Their values are
 * arbitrary JSON. Each was created in the running frontend:
 * - IMAGECOMPARE holds images to compare, so it isn't saved, but it is sent;
 * - RESOLUTION_PREVIEW, AUDIO_UI (an audio player) and CAMERA_INFO_STATE only display;
 * - IMAGEUPLOAD and AUDIOUPLOAD are the upload buttons beside a file combo, saved and never sent;
 *   CAMERA_ANGLE_VIEW saves its view mode and isn't sent;
 * - LOAD_3D, LOAD_3D_ADVANCED (3D scene captures), WEBCAM (a camera frame) and AUDIO_RECORD (a
 *   recording) are sent as what the core extensions upload or capture when the prompt is queued;
 *   PREVIEW_3D is sent as it is saved, `""`.
 */
const VALUE_WIDGETS: ReadonlyMap<string, WidgetPersistence> = new Map([
  // Core registry (`ComfyWidgets`).
  ["MARKDOWN", SAVED_AND_SENT],
  ["IMAGEUPLOAD", SAVED_NOT_SENT],
  ["COLOR", SAVED_AND_SENT],
  ["IMAGECOMPARE", { saved: false, sent: "value" }],
  ["BOUNDING_BOX", SAVED_AND_SENT],
  ["CHART", SAVED_AND_SENT],
  ["GALLERIA", SAVED_AND_SENT],
  ["PAINTER", SAVED_AND_SENT],
  ["COMPOSITOR", SAVED_AND_SENT],
  ["TEXTAREA", SAVED_AND_SENT],
  ["CURVE", SAVED_AND_SENT],
  ["RANGE", SAVED_AND_SENT],
  ["VIDEO_EDIT", SAVED_AND_SENT],
  ["RESOLUTION_PREVIEW", NEITHER],
  ["BOUNDING_BOXES", SAVED_AND_SENT],
  ["COLORS", SAVED_AND_SENT],
  // Core extensions (`getCustomWidgets`).
  ["AUDIO_RECORD", COMPUTED],
  ["AUDIO_UI", NEITHER],
  ["AUDIOUPLOAD", SAVED_NOT_SENT],
  ["CAMERA_ANGLE_VIEW", SAVED_NOT_SENT],
  ["CAMERA_INFO_STATE", NEITHER],
  ["LOAD_3D", COMPUTED],
  ["LOAD_3D_ADVANCED", COMPUTED],
  ["PREVIEW_3D", SAVED_AND_SENT],
  ["WEBCAM", COMPUTED],
]);

/** Whether `type` is one of the primitive widgets. */
export function isPrimitiveWidget(type: string): type is PrimitiveWidget {
  return PRIMITIVE_WIDGETS.has(type);
}

/** Whether `type` is a widget of the frontend's registry other than a primitive: a JSON value. */
export function isValueWidget(type: string): boolean {
  return VALUE_WIDGETS.has(type);
}

/**
 * Whether the frontend saves a widget's value and sends it. Primitives and widgets the registry
 * doesn't know (a pack's, named by `widgetType` on a primitive input) are taken to do both.
 */
export function widgetPersistence(widget: string): WidgetPersistence {
  return VALUE_WIDGETS.get(widget) ?? SAVED_AND_SENT;
}

/**
 * Whether the frontend sends a value widget's value in a prompt (`options.serialize !== false`):
 * not for the widgets that only display (RESOLUTION_PREVIEW, CAMERA_INFO_STATE, an audio player)
 * or are upload buttons (IMAGEUPLOAD, AUDIOUPLOAD) or a view mode (CAMERA_ANGLE_VIEW).
 */
export function sendsValue(widget: string): boolean {
  return widgetPersistence(widget).sent !== "never";
}

/**
 * Whether the exporter sends a value for an input it would otherwise fill from its widget:
 * not for a value widget the frontend never sends, nor for an optional primitive whose
 * `widgetType` names one (CameraAngle's `view`). A required one is still sent, since the backend
 * rejects a prompt without it: there the exporter departs from the frontend.
 */
export function sendsInputValue(input: InputDef): boolean {
  switch (input.kind) {
    case "value":
      return sendsValue(input.widget);
    case "int":
    case "float":
    case "string":
    case "boolean":
    case "combo":
      return input.required || input.widgetType === undefined || sendsValue(input.widgetType);
    case "socket":
    case "autogrow":
    case "dynamicCombo":
    case "dynamicGroup":
    case "matchType":
    case "unknown":
      return true;
  }
}
