import { sendsInputValue } from "../frontend/widgets.ts";
import { isJsonArray, isJsonObject, type JsonValue } from "../json/value.ts";
import type { InputDef } from "../schema/types.ts";

/**
 * A wire value as the backend reads it and a widget holds it: `{"__value__": …}`, which carries
 * lists and CURVE values (docs/plan.md §7.5), unwrapped.
 */
export function unwrapWire(value: JsonValue): JsonValue {
  return isJsonObject(value) && Object.hasOwn(value, "__value__")
    ? (value["__value__"] ?? null)
    : value;
}

/** A value for the wire: a list wrapped as `{"__value__": [...]}`, since a bare list is a link. */
export function wrapList(value: JsonValue): JsonValue {
  return isJsonArray(value) ? { __value__: value } : value;
}

/**
 * A widget's value as the frontend sends it (`graphToPrompt`): a CURVE value marked as
 * `{"__type__": "CURVE", "__value__": …}`, a list wrapped, anything else as it is.
 */
export function widgetWire(input: InputDef, value: JsonValue): JsonValue {
  return input.kind === "value" && input.widget === "CURVE" && value !== null
    ? { __type__: "CURVE", __value__: value }
    : wrapList(value);
}

/**
 * What the exporter sends for an input left without a value: its widget's default (docs/plan.md
 * §7.2), as the frontend sends it. Nothing for an input without a default or a widget, or one
 * whose widget the frontend never sends.
 */
export function defaultWire(input: InputDef): JsonValue | undefined {
  switch (input.kind) {
    case "int":
    case "float":
    case "string":
    case "boolean":
    case "combo":
    case "value":
      return input.default === undefined || !sendsInputValue(input)
        ? undefined
        : widgetWire(input, input.default);
    case "socket":
    case "matchType":
    case "unknown":
    case "autogrow":
    case "dynamicCombo":
    case "dynamicGroup":
      return undefined;
  }
}

/**
 * The row and field of a DynamicGroup wire key after its `<group>.` prefix (`3.strength`), as the
 * backend expands them; `undefined` when it isn't `<row>.<field>` with a row number.
 */
export function groupKey(
  rest: string,
): { readonly row: number; readonly field: string } | undefined {
  const dot = rest.indexOf(".");
  const index = rest.slice(0, dot);
  if (dot === -1 || !/^(?:0|[1-9][0-9]*)$/.test(index)) return undefined;
  return { row: Number(index), field: rest.slice(dot + 1) };
}
