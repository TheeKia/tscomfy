import type { Diagnostic, DiagnosticPath } from "../diagnostic/diagnostic.ts";
import { parse } from "../json/parse.ts";
import { isJsonObject } from "../json/value.ts";
import type { JsonObject, JsonValue } from "../json/value.ts";
import { freezeSchema } from "../schema/freeze.ts";
import type { NodeDef, Schema } from "../schema/types.ts";
import { type Context, describe, isBoolean, isString, readOptional, report } from "./context.ts";
import { readNodeInputs } from "./inputs.ts";
import { readOutputs } from "./outputs.ts";

/** Options for {@link normalizeObjectInfo}. */
export interface NormalizeOptions {
  /** The server's ComfyUI version (from `/system_stats`), stored as schema metadata. */
  readonly comfyVersion?: string;
}

/** The result of {@link normalizeObjectInfo}. */
export interface NormalizeResult {
  /** Every node that could be read. Frozen. */
  readonly schema: Schema;
  /** What was dropped, degraded or defaulted, in node order. */
  readonly diagnostics: readonly Diagnostic[];
}

/**
 * Normalizes the raw text of a ComfyUI `/object_info` response into a {@link Schema}. Pass the
 * response text, not a parsed value: integers beyond 2^53 only survive our own parser.
 *
 * Lenient and total: it never throws for bad data. A node it can't use is dropped with an `E_`
 * diagnostic; an input spec it can't interpret is kept as an `unknown` input with a `W_`
 * diagnostic. Nodes are built in code-unit order of class type, so the result doesn't depend on the
 * server's load order, and the same text always gives the same result.
 */
export function normalizeObjectInfo(text: string, options: NormalizeOptions = {}): NormalizeResult {
  const parsed = parse(text);
  const context: Context = {
    diagnostics: [...parsed.diagnostics],
    inexact: parsed.diagnostics.some((diagnostic) => diagnostic.code === "W_PRECISION_LOSS"),
  };
  const entries: [string, NodeDef][] = [];
  const root = parsed.value;
  if (root !== undefined) {
    if (isJsonObject(root)) {
      // No comparator: code-unit order, the same in every runtime and locale (D15).
      for (const classType of Object.keys(root).toSorted()) {
        const node = readNode(context, classType, root[classType]);
        if (node !== undefined) entries.push([classType, node]);
      }
    } else {
      report(
        context,
        "E_INVALID_OBJECT_INFO",
        [],
        `Expected /object_info to be an object of node definitions, got ${describe(root)}.`,
      );
    }
  }
  const schema = freezeSchema({
    formatVersion: 1,
    ...(options.comfyVersion === undefined ? {} : { comfyVersion: options.comfyVersion }),
    nodes: Object.fromEntries(entries),
  });
  return { schema, diagnostics: Object.freeze(context.diagnostics) };
}

function readNode(
  context: Context,
  classType: string,
  value: JsonValue | undefined,
): NodeDef | undefined {
  const path: DiagnosticPath = [classType];
  if (!isJsonObject(value)) {
    report(
      context,
      "E_INVALID_NODE",
      path,
      `Expected a node definition object, got ${describe(value)}; dropping the node.`,
    );
    return undefined;
  }
  // Read everything before deciding, so one run reports every problem of the node.
  const inputs = readNodeInputs(context, value, path);
  const outputs = readOutputs(context, value, path);
  const name = readOptional(
    context,
    value,
    "name",
    path,
    "W_INVALID_NODE_FIELD",
    "a string",
    isString,
  );
  if (name !== undefined && name !== classType) {
    report(
      context,
      "W_NODE_NAME_MISMATCH",
      [...path, "name"],
      `name is ${JSON.stringify(name)}, but the node is listed as ${JSON.stringify(classType)}; prompts use the listed name.`,
    );
  }
  const displayName = readExpected(context, value, "display_name", path, "a string", isString);
  const category = readExpected(context, value, "category", path, "a string", isString);
  const pythonModule = readExpected(context, value, "python_module", path, "a string", isString);
  const outputNode = readExpected(context, value, "output_node", path, "a boolean", isBoolean);
  const description = readOptional(
    context,
    value,
    "description",
    path,
    "W_INVALID_NODE_FIELD",
    "a string",
    isString,
  );
  const flag = (key: string): boolean =>
    readOptional(context, value, key, path, "W_INVALID_NODE_FIELD", "a boolean", isBoolean) ??
    false;
  const isInputList = flag("is_input_list");
  const deprecated = flag("deprecated");
  const experimental = flag("experimental");
  if (inputs === undefined || outputs === undefined) return undefined;
  return {
    classType,
    displayName: displayName === undefined || displayName === "" ? classType : displayName,
    category: category ?? "",
    pythonModule: pythonModule ?? "",
    ...(description === undefined || description === "" ? {} : { description }),
    outputNode: outputNode ?? false,
    isInputList,
    deprecated,
    experimental,
    inputs,
    outputs,
  };
}

/** A field every server sends; missing or mistyped, it is reported and the caller falls back. */
function readExpected<T extends JsonValue>(
  context: Context,
  node: JsonObject,
  key: string,
  path: DiagnosticPath,
  expected: string,
  guard: (value: JsonValue) => value is T,
): T | undefined {
  if (!Object.hasOwn(node, key)) {
    report(context, "W_INVALID_NODE_FIELD", [...path, key], `${key} is missing; using a default.`);
    return undefined;
  }
  return readOptional(context, node, key, path, "W_INVALID_NODE_FIELD", expected, guard);
}
