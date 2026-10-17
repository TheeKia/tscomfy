import type { JsonValue } from "@tscomfy/core";

/** Whether a JSON value is an object (not null, not an array). */
export function isRecord(value: JsonValue): value is { readonly [key: string]: JsonValue } {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** A word for a POSIX shell, quoted only when it has to be: `out dir` → `'out dir'`. */
export function shellQuote(word: string): string {
  return /^[\w@%+=:,./-]+$/.test(word) ? word : `'${word.replaceAll("'", "'\\''")}'`;
}
