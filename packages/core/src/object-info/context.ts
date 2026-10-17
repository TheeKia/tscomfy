import {
  createDiagnostic,
  type Diagnostic,
  type DiagnosticCode,
  type DiagnosticPath,
} from "../diagnostic/diagnostic.ts";
import { stringify } from "../json/stringify.ts";
import { isJsonObject, type JsonObject, type JsonValue } from "../json/value.ts";

/** Collects the diagnostics of one normalizer run. */
export interface Context {
  readonly diagnostics: Diagnostic[];
  /**
   * The parser had no source-text access and reported possible precision loss, so integers
   * beyond 2^53 may be rounded; bounds then move inward to stay safe.
   */
  readonly inexact: boolean;
}

/** Records a diagnostic. */
export function report(
  context: Context,
  code: DiagnosticCode,
  path: DiagnosticPath,
  message: string,
): void {
  context.diagnostics.push(createDiagnostic(code, path, message));
}

/**
 * Reads an optional field, reporting a wrong type and treating it as absent. `null` is absent
 * too: Python servers send `None` for fields they leave unset.
 */
export function readOptional<T extends JsonValue>(
  context: Context,
  object: JsonObject,
  key: string,
  path: DiagnosticPath,
  code: DiagnosticCode,
  expected: string,
  guard: (value: JsonValue) => value is T,
): T | undefined {
  if (!Object.hasOwn(object, key)) return undefined;
  const value = object[key];
  if (value === undefined || value === null) return undefined;
  if (guard(value)) return value;
  report(
    context,
    code,
    [...path, key],
    `Expected ${key} to be ${expected}, got ${preview(value)}; ignoring it.`,
  );
  return undefined;
}

/** Type guard for strings. */
export function isString(value: JsonValue): value is string {
  return typeof value === "string";
}

/** Type guard for booleans. */
export function isBoolean(value: JsonValue): value is boolean {
  return typeof value === "boolean";
}

/** Type guard for JSON objects. */
export function isObject(value: JsonValue): value is JsonObject {
  return isJsonObject(value);
}

/** Type guard for arrays. */
export function isArray(value: JsonValue): value is readonly JsonValue[] {
  return Array.isArray(value);
}

const PREVIEW_LENGTH = 60;

/** A short JSON rendering for messages. Total on `parse` output, which is always finite. */
export function preview(value: JsonValue): string {
  const text = stringify(value);
  return text.length > PREVIEW_LENGTH ? `${text.slice(0, PREVIEW_LENGTH)}…` : text;
}

/** Describes a JSON value's shape for messages. */
export function describe(value: JsonValue | undefined): string {
  if (value === undefined) return "missing";
  if (value === null) return "null";
  if (Array.isArray(value)) return "an array";
  return typeof value === "object" ? "an object" : `a ${typeof value}`;
}
