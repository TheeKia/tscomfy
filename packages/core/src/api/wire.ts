import { isJsonObject, type JsonValue } from "../json/value.ts";

/**
 * A wire value as the backend reads it and a widget holds it: `{"__value__": …}`, which carries
 * lists and CURVE values (docs/plan.md §7.5), unwrapped.
 */
export function unwrapWire(value: JsonValue): JsonValue {
  return isJsonObject(value) && Object.hasOwn(value, "__value__")
    ? (value["__value__"] ?? null)
    : value;
}
