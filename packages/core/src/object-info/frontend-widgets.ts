// What the /object_info format says about frontend widgets: the V3 dynamic input types, and the
// value a value widget starts from, which some widgets read from their own spec fields rather
// than `default`. Which types are widgets at all is the frontend's registry
// (`frontend/widgets.ts`, docs/plan.md D16).

import type { JsonObject, JsonValue } from "../json/value.ts";

/**
 * The value the frontend gives a value widget when none is given, which is what the exporter
 * fills in. Most widgets start at the server's default; a few ignore it (1.55.17 composables):
 * IMAGECOMPARE starts at `["", ""]`, GALLERIA at the spec's `images`, CHART at its `data`.
 */
export function widgetDefault(widget: string, options: JsonObject): JsonValue | undefined {
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
