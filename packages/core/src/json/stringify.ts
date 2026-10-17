import type { JsonValue } from "./value.ts";

/**
 * Serializes a JSON value as compact JSON: keys in insertion order, `bigint` written as a plain
 * integer literal, everything else exactly as `JSON.stringify` writes it (docs/plan.md §7.5).
 * The output for a given value is the same in every runtime.
 *
 * Throws a `TypeError` for a non-finite number, which has no JSON form: passing one is a
 * programmer error.
 */
export function stringify(value: JsonValue): string {
  if (typeof value === "bigint") return value.toString();
  if (typeof value === "number" && !Number.isFinite(value)) {
    throw new TypeError(`stringify: ${String(value)} is not a JSON number`);
  }
  if (typeof value !== "object" || value === null) return JSON.stringify(value);
  if (isArray(value)) return `[${value.map(stringify).join(",")}]`;
  const members = Object.entries(value).map(
    ([key, item]) => `${JSON.stringify(key)}:${stringify(item)}`,
  );
  return `{${members.join(",")}}`;
}

// `Array.isArray` doesn't narrow readonly arrays out of a union.
function isArray(value: JsonValue): value is readonly JsonValue[] {
  return Array.isArray(value);
}
