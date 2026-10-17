import type { Schema } from "./types.ts";

/**
 * Makes a schema immutable: drops the prototype of `nodes`, so a class named "constructor" or
 * "toString" can't resolve to an inherited member, and freezes everything deeply. Build `nodes`
 * with `Object.fromEntries`, which defines keys as own data properties, so even "__proto__" is
 * safe before this.
 */
export function freezeSchema(schema: Schema): Schema {
  Object.setPrototypeOf(schema.nodes, null);
  return deepFreeze(schema);
}

function deepFreeze<T>(value: T): T {
  if (typeof value === "object" && value !== null && !Object.isFrozen(value)) {
    const children: unknown[] = Object.values(value);
    for (const child of children) deepFreeze(child);
    Object.freeze(value);
  }
  return value;
}
