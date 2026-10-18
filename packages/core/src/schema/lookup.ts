import type { NodeDef, Schema } from "./types.ts";

/**
 * The definition of a class, or `undefined` when the schema doesn't have it. Class names come
 * from user data, so an inherited key (`constructor`, `__proto__`) is never a class.
 */
export function definitionOf(schema: Schema, classType: string): NodeDef | undefined {
  return Object.hasOwn(schema.nodes, classType) ? schema.nodes[classType] : undefined;
}
