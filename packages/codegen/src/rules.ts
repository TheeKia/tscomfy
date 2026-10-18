// Input rules the generated types are written with (docs/plan.md §6.2, §7.2), shared by the type
// emitter, which writes them, and the transpiler, which must decide by the same rules whether
// the types can express a node.

import { type InputDef, sendsInputValue } from "@tscomfy/core";

/**
 * Whether a property named `name` must be required: TypeScript checks an optional property
 * against the `Object` member of that name, which every object literal has.
 */
export function isObjectMember(name: string): boolean {
  return OBJECT_MEMBERS.has(name);
}

/** Members of TypeScript's `Object` interface, which every object type has. */
const OBJECT_MEMBERS: ReadonlySet<string> = new Set([
  "constructor",
  "toString",
  "toLocaleString",
  "valueOf",
  "hasOwnProperty",
  "isPrototypeOf",
  "propertyIsEnumerable",
]);

/**
 * The field a DynamicGroup row's type requires beyond the required ones (§7.2): a row is counted
 * only when one of its keys is sent, so when no field is required or has a default, the first
 * one must be given, or `{}` would send no row at all.
 */
export function forcedRowField(fields: readonly InputDef[]): InputDef | undefined {
  const sendable = fields.filter(sendsInputValue);
  return sendable.some((field) => isRequired(field) || hasDefault(field)) ? undefined : sendable[0];
}

/**
 * Whether an input must be given: the backend requires it and no default fills it in.
 * Autogrow and DynamicGroup are required by their minimum alone: the backend enforces it even
 * when the input itself is optional. An input named after a member of `Object` is always
 * required: TypeScript checks an optional property against the member every object literal
 * has (`constructor: Function`), so leaving it out would fail to compile.
 */
export function isRequired(input: InputDef): boolean {
  if (isObjectMember(input.name)) return true;
  switch (input.kind) {
    case "autogrow":
      return input.template.required && input.min > 0 && input.slots.length > 0;
    case "dynamicGroup":
      return input.min > 0;
    case "combo":
      // A forceInput combo has no widget, so nothing fills its default in.
      return input.required && (input.default === undefined || input.forceInput === true);
    case "int":
    case "float":
    case "string":
    case "boolean":
    case "value":
      return input.required && input.default === undefined;
    case "socket":
    case "dynamicCombo":
    case "matchType":
    case "unknown":
      return input.required;
  }
}

/** Whether the exporter sends a value for the input when none is given. */
export function hasDefault(input: InputDef): boolean {
  switch (input.kind) {
    case "combo":
      return input.default !== undefined && input.forceInput !== true;
    case "int":
    case "float":
    case "string":
    case "boolean":
    case "value":
      return input.default !== undefined;
    case "socket":
    case "autogrow":
    case "dynamicCombo":
    case "dynamicGroup":
    case "matchType":
    case "unknown":
      return false;
  }
}
