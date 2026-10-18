import { isJsonArray, type JsonValue } from "./value.ts";

/**
 * Serializes a JSON value as compact JSON: keys in JavaScript's enumeration order (integer-like
 * keys first in numeric order, then insertion order, as `JSON.stringify` and the ComfyUI frontend
 * use), `bigint` written as a plain integer literal, everything else exactly as `JSON.stringify`
 * writes it, with one exception: an integer-valued `number` beyond 2^53 is
 * written in exponent form (`1.844674407370955e+19`). `JSON.stringify` would print it as an
 * integer literal, which `parse` reads back as a `bigint` of a different value; in exponent form
 * it round-trips as the same `number`, and Python reads it as a float too.
 * The output for a given value is the same in every runtime.
 *
 * Throws a `TypeError` for what has no JSON form: a non-finite number, and `undefined` (a member
 * set to it, an array hole), which the types rule out but code without
 * `exactOptionalPropertyTypes` can still pass. Passing one is a programmer error.
 */
export function stringify(value: JsonValue): string {
  switch (typeof value) {
    case "bigint":
      return value.toString();
    case "number":
      if (!Number.isFinite(value)) {
        throw new TypeError(`stringify: ${String(value)} is not a JSON number`);
      }
      return Number.isInteger(value) && !Number.isSafeInteger(value)
        ? value.toExponential()
        : JSON.stringify(value);
    case "string":
    case "boolean":
      return JSON.stringify(value);
    case "object": {
      if (value === null) return "null";
      // Array.from visits holes, which map skips.
      if (isJsonArray(value)) return `[${Array.from(value, stringify).join(",")}]`;
      const members = Object.entries(value).map(
        ([key, item]) => `${JSON.stringify(key)}:${stringify(item)}`,
      );
      return `{${members.join(",")}}`;
    }
    case "undefined":
    case "function":
    case "symbol":
      throw new TypeError(`stringify: ${typeof value} is not a JSON value`);
  }
}
