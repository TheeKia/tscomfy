import type { DiagnosticPath } from "../diagnostic/diagnostic.ts";
import { isJsonArray, type JsonObject, type JsonValue } from "../json/value.ts";
import { isComboOption } from "../schema/combo.ts";
import type { ComboOption, OutputDef, OutputType } from "../schema/types.ts";
import { type Context, describe, isBoolean, isString, preview, report } from "./context.ts";
import { MATCH_TYPE } from "./frontend-widgets.ts";
import { parseSocketType } from "./socket-type.ts";

/**
 * Reads a node's outputs from the parallel `output*` arrays. Slots are never dropped, because
 * links address them by index. Returns `undefined` when a slot's type is unreadable, which makes
 * the node unusable; that has been reported.
 */
export function readOutputs(
  context: Context,
  node: JsonObject,
  path: DiagnosticPath,
): OutputDef[] | undefined {
  const types = node["output"];
  if (!isJsonArray(types)) {
    report(
      context,
      "E_INVALID_NODE",
      [...path, "output"],
      `Expected output to be a list of types, got ${describe(types)}; dropping the node.`,
    );
    return undefined;
  }
  const count = types.length;
  const names = readParallel(context, node, "output_name", count, path, isString);
  const lists = readParallel(context, node, "output_is_list", count, path, isBoolean);
  const tooltips = readParallel(context, node, "output_tooltips", count, path, isString);
  const templates = readParallel(context, node, "output_matchtypes", count, path, isString);

  const outputs: OutputDef[] = [];
  for (const [index, raw] of types.entries()) {
    const typePath = [...path, "output", index];
    const template = templates?.[index];
    const type = readOutputType(context, raw, typePath);
    if (type === undefined) return undefined;
    if (raw === MATCH_TYPE && template === undefined) {
      report(
        context,
        "W_INVALID_NODE_FIELD",
        templates === undefined ? typePath : [...path, "output_matchtypes", index],
        "A MatchType output names no template; it connects like *.",
      );
    }
    const name = names?.[index] ?? (typeof raw === "string" ? raw : "COMBO");
    const tooltip = tooltips?.[index];
    outputs.push({
      index,
      name,
      type,
      isList: lists?.[index] ?? false,
      ...(tooltip === undefined ? {} : { tooltip }),
      ...(raw === MATCH_TYPE && template !== undefined ? { matchTemplate: template } : {}),
    });
  }
  return outputs;
}

function readOutputType(
  context: Context,
  raw: JsonValue,
  path: DiagnosticPath,
): OutputType | undefined {
  // The frontend treats a MatchType output as `*` until a link narrows it; so does the backend.
  if (raw === MATCH_TYPE) return { kind: "any" };
  if (typeof raw === "string") {
    const type = parseSocketType(raw);
    if (type === undefined) {
      report(context, "E_INVALID_NODE", path, "An output type is empty; dropping the node.");
    }
    return type;
  }
  if (isJsonArray(raw)) {
    // A legacy combo input matches this list in full (§5.2), so it can't be kept partially.
    const options: ComboOption[] = [];
    for (const [index, option] of raw.entries()) {
      if (!isComboOption(option)) {
        report(
          context,
          "E_INVALID_NODE",
          [...path, index],
          `Expected an option to be a string, a number or a boolean, got ${preview(option)}; dropping the node.`,
        );
        return undefined;
      }
      options.push(option);
    }
    return { kind: "combo", options };
  }
  report(
    context,
    "E_INVALID_NODE",
    path,
    `Expected an output type to be a string or an option list, got ${describe(raw)}; dropping the node.`,
  );
  return undefined;
}

/**
 * Reads an optional array parallel to `output`. Entries that are missing, `null` (unset) or of the
 * wrong type come back `undefined`, so callers fall back per slot; wrong types are reported.
 */
function readParallel<T extends JsonValue>(
  context: Context,
  node: JsonObject,
  key: string,
  count: number,
  path: DiagnosticPath,
  guard: (value: JsonValue) => value is T,
): readonly (T | undefined)[] | undefined {
  const raw = node[key];
  if (raw === undefined || raw === null) return undefined;
  if (!isJsonArray(raw)) {
    report(
      context,
      "W_INVALID_NODE_FIELD",
      [...path, key],
      `Expected ${key} to be a list, got ${describe(raw)}; ignoring it.`,
    );
    return undefined;
  }
  if (raw.length !== count) {
    const extra = raw.length > count;
    report(
      context,
      "W_INVALID_NODE_FIELD",
      [...path, key],
      `${key} has ${String(raw.length)} entries for ${String(count)} outputs; ${extra ? "ignoring the extra ones" : "missing entries use defaults"}.`,
    );
  }
  return raw.slice(0, count).map((value, index) => {
    if (value === null) return undefined;
    if (guard(value)) return value;
    report(
      context,
      "W_INVALID_NODE_FIELD",
      [...path, key, index],
      `Unexpected ${describe(value)} in ${key}; using the default.`,
    );
    return undefined;
  });
}
