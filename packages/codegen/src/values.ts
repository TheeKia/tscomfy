// Structured input values (the graph's `InputValue`): lists, plain objects and the output
// references inside them, as the transpiler and its typing walk them.

import { type InputValue, isOutputRef, type JsonValue, type NodeId } from "@tscomfy/core";

/** Every output reference in a node's inputs, depth-first. */
export function references(
  value: InputValue | { readonly [name: string]: InputValue },
): { readonly node: NodeId; readonly slot: number }[] {
  if (isOutputRef(value)) return [{ node: value.node, slot: value.slot }];
  if (isList(value)) return value.flatMap(references);
  if (typeof value === "object" && value !== null) return Object.values(value).flatMap(references);
  return [];
}

/** Whether a value is a plain object: not a list and not an output reference. */
export function isPlainObject(
  value: InputValue | undefined,
): value is { readonly [key: string]: InputValue } {
  return typeof value === "object" && value !== null && !isList(value) && !isOutputRef(value);
}

/** Whether a value is a list. */
export function isList<T extends InputValue | JsonValue>(
  value: T | undefined,
): value is Extract<T, readonly unknown[]> {
  return Array.isArray(value);
}
