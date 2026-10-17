/**
 * A JSON value as tscomfy reads and writes it: like `JSON.parse` output, except that integers
 * outside the safe range (beyond ±(2^53 − 1)) are `bigint`, so they stay exact (docs/plan.md D10).
 */
export type JsonValue =
  | null
  | boolean
  | number
  | bigint
  | string
  | readonly JsonValue[]
  | { readonly [key: string]: JsonValue };

/** A JSON object, as {@link JsonValue} represents it. */
export type JsonObject = { readonly [key: string]: JsonValue };

/** Whether `value` is a JSON object: not null and not an array. */
export function isJsonObject(value: JsonValue | undefined): value is JsonObject {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
