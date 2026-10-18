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
 * Throws a `TypeError` for a non-finite number, which has no JSON form: passing one is a
 * programmer error.
 */
export function stringify(value: JsonValue): string {
  if (typeof value === "bigint") return value.toString();
  if (typeof value === "number") {
    if (!Number.isFinite(value)) {
      throw new TypeError(`stringify: ${String(value)} is not a JSON number`);
    }
    if (Number.isInteger(value) && !Number.isSafeInteger(value)) return value.toExponential();
  }
  if (typeof value !== "object" || value === null) return JSON.stringify(value);
  if (isJsonArray(value)) return `[${value.map(stringify).join(",")}]`;
  const members = Object.entries(value).map(
    ([key, item]) => `${JSON.stringify(key)}:${stringify(item)}`,
  );
  return `{${members.join(",")}}`;
}
