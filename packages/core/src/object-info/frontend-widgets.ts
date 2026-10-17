// What the official frontend renders as a widget (docs/plan.md D16). The frontend looks up
// `widgetType ?? type` in its widget registry; an input whose key is registered gets a widget
// (and so sends a value), anything else is a plain socket. Source: ComfyUI_frontend 1.55.17,
// `src/scripts/widgets.ts` (`ComfyWidgets`) and `src/services/litegraphService.ts`
// (`addInputSocket`, `addInputWidget`). Packs can register more widgets in the browser; those
// are invisible in /object_info.

import type { JsonObject, JsonValue } from "../json/value.ts";

/** Widgets tscomfy models with their own input kind. */
export type PrimitiveWidget = "INT" | "FLOAT" | "STRING" | "BOOLEAN" | "COMBO";

const PRIMITIVE_WIDGETS: ReadonlySet<string> = new Set<PrimitiveWidget>([
  "INT",
  "FLOAT",
  "STRING",
  "BOOLEAN",
  "COMBO",
]);

/** The other widgets of the frontend's core registry: their values are arbitrary JSON. */
const VALUE_WIDGETS: ReadonlySet<string> = new Set([
  "MARKDOWN",
  "IMAGEUPLOAD",
  "COLOR",
  "IMAGECOMPARE",
  "BOUNDING_BOX",
  "CHART",
  "GALLERIA",
  "PAINTER",
  "COMPOSITOR",
  "TEXTAREA",
  "CURVE",
  "RANGE",
  "VIDEO_EDIT",
  "RESOLUTION_PREVIEW",
  "BOUNDING_BOXES",
  "COLORS",
]);

/** Whether `type` is one of the primitive widgets. */
export function isPrimitiveWidget(type: string): type is PrimitiveWidget {
  return PRIMITIVE_WIDGETS.has(type);
}

/** Whether `type` is a core frontend widget with a JSON value. */
export function isValueWidget(type: string): boolean {
  return VALUE_WIDGETS.has(type);
}

/**
 * The value the frontend gives a value widget when none is given, which is what the exporter
 * fills in. Most widgets start at the server's default; a few ignore it (1.55.17 composables):
 * IMAGECOMPARE starts at `["", ""]`, GALLERIA at the spec's `images`, CHART at its `data`.
 */
export function initialValue(widget: string, options: JsonObject): JsonValue | undefined {
  switch (widget) {
    case "IMAGECOMPARE":
      return ["", ""];
    case "GALLERIA":
      return options["images"] ?? [];
    case "CHART":
      return options["data"] ?? {};
    default:
      return options["default"] ?? undefined;
  }
}

/** The V3 dynamic input types this normalizer understands. */
export const AUTOGROW = "COMFY_AUTOGROW_V3";
/** See {@link AUTOGROW}. */
export const DYNAMIC_COMBO = "COMFY_DYNAMICCOMBO_V3";
/** See {@link AUTOGROW}. */
export const DYNAMIC_GROUP = "COMFY_DYNAMICGROUP_V3";
/** See {@link AUTOGROW}. */
export const MATCH_TYPE = "COMFY_MATCHTYPE_V3";

/** Whether `type` looks like a V3 dynamic input type (`COMFY_…_V3`). */
export function isV3DynamicType(type: string): boolean {
  return type.startsWith("COMFY_") && type.endsWith("_V3");
}
