// Reading a node's inputs from /object_info (docs/plan.md §5.1): the sections and their order,
// and the kind of each input (docs/plan.md D16); `spec-reader.ts` reads each kind's options.

import type { DiagnosticPath } from "../diagnostic/diagnostic.ts";
import { isPrimitiveWidget, isValueWidget } from "../frontend/widgets.ts";
import { isJsonArray, type JsonObject, type JsonValue } from "../json/value.ts";
import type { InputDef } from "../schema/types.ts";
import { type Context, describe, isObject, readOptional, report } from "./context.ts";
import {
  AUTOGROW,
  DYNAMIC_COMBO,
  DYNAMIC_GROUP,
  isV3DynamicType,
  MATCH_TYPE,
} from "./frontend-widgets.ts";
import { parseSocketType } from "./socket-type.ts";
import { isStringArray, SpecReader, unknown } from "./spec-reader.ts";

type Section = "required" | "optional";

/**
 * Reads a node's `input` field into ordered inputs. Returns `undefined` when the node can't be
 * used (no readable `input` or `required` section); that has been reported.
 */
export function readNodeInputs(
  context: Context,
  node: JsonObject,
  path: DiagnosticPath,
): InputDef[] | undefined {
  const input = node["input"];
  if (input === undefined || !isObject(input)) {
    report(
      context,
      "E_INVALID_NODE",
      [...path, "input"],
      `Expected input to be an object, got ${describe(input)}; dropping the node.`,
    );
    return undefined;
  }
  const required = input["required"] ?? {};
  if (!isObject(required)) {
    report(
      context,
      "E_INVALID_NODE",
      [...path, "input", "required"],
      `Expected input.required to be an object, got ${describe(required)}; dropping the node.`,
    );
    return undefined;
  }
  let optional = input["optional"] ?? {};
  if (!isObject(optional)) {
    report(
      context,
      "E_INVALID_INPUT_SECTION",
      [...path, "input", "optional"],
      `Expected input.optional to be an object, got ${describe(optional)}; dropping its inputs.`,
    );
    optional = {};
  }
  // The backend looks a name up in `required` first, so a duplicate in `optional` is dead.
  const optionalNames = Object.keys(optional).filter((name) => {
    if (!Object.hasOwn(required, name)) return true;
    report(
      context,
      "E_DUPLICATE_INPUT",
      [...path, "input", "optional", name],
      `Input ${name} is also required; dropping the optional one.`,
    );
    return false;
  });
  const specs = { required, optional };
  const declared = new Set([...Object.keys(required), ...Object.keys(optional)]);
  return orderInputs(context, node, Object.keys(required), optionalNames, declared, path).map(
    ({ name, section }) =>
      readInput(
        context,
        name,
        specs[section][name],
        section === "required",
        [...path, "input", section, name],
        false,
      ),
  );
}

/**
 * The frontend's input order (ComfyUI_frontend 1.55.17 `getOrderedInputSpecs`): the required
 * inputs `input_order` lists, then the optional ones it lists, then every other input, required
 * before optional. Without `input_order`, key order.
 */
function orderInputs(
  context: Context,
  node: JsonObject,
  requiredNames: readonly string[],
  optionalNames: readonly string[],
  declared: ReadonlySet<string>,
  path: DiagnosticPath,
): { readonly name: string; readonly section: Section }[] {
  const all = [
    ...requiredNames.map((name) => ({ name, section: "required" as const })),
    ...optionalNames.map((name) => ({ name, section: "optional" as const })),
  ];
  const order = readOptional(
    context,
    node,
    "input_order",
    path,
    "W_INVALID_NODE_FIELD",
    "an object",
    isObject,
  );
  if (order === undefined) return all;
  const listed = (section: Section, names: readonly string[]) => {
    const unique = new Set(
      readOptional(
        context,
        order,
        section,
        [...path, "input_order"],
        "W_INVALID_NODE_FIELD",
        "a list of names",
        isStringArray,
      ),
    );
    // A name listed under the other section is skipped here and placed with the rest.
    return {
      known: [...unique].filter((name) => names.includes(name)),
      undeclared: [...unique].filter((name) => !declared.has(name)),
    };
  };
  const listedRequired = listed("required", requiredNames);
  const listedOptional = listed("optional", optionalNames);
  const first = [
    ...listedRequired.known.map((name) => ({ name, section: "required" as const })),
    ...listedOptional.known.map((name) => ({ name, section: "optional" as const })),
  ];
  const rest = all.filter(
    ({ name, section }) =>
      !(section === "required" ? listedRequired : listedOptional).known.includes(name),
  );
  const undeclared = [...listedRequired.undeclared, ...listedOptional.undeclared];
  if (undeclared.length > 0 || rest.length > 0) {
    const parts = [
      undeclared.length > 0 ? `names ${undeclared.join(", ")}, which the node doesn't declare` : "",
      rest.length > 0 ? `leaves out ${rest.map(({ name }) => name).join(", ")}, placed last` : "",
    ].filter((part) => part !== "");
    report(
      context,
      "W_INPUT_ORDER_MISMATCH",
      [...path, "input_order"],
      `input_order ${parts.join("; it ")}.`,
    );
  }
  return [...first, ...rest];
}

/**
 * Reads one `[type, options?]` spec. Never fails: a spec it can't interpret becomes an
 * unknown input (`kind: "unknown"`) with a diagnostic.
 *
 * Widget or socket follows the frontend (docs/plan.md D16): it looks up `widgetType ?? type` in
 * its widget registry. The kind follows the type when the type is primitive, because the backend
 * coerces and validates by the type; otherwise it follows the widget.
 */
function readInput(
  context: Context,
  name: string,
  spec: JsonValue | undefined,
  required: boolean,
  path: DiagnosticPath,
  forceSocket: boolean,
): InputDef {
  if (spec === undefined || !isJsonArray(spec) || spec.length === 0) {
    return unknown(
      context,
      name,
      required,
      spec,
      path,
      `Expected an input spec [type, options?], got ${describe(spec)}.`,
    );
  }
  const [head, rawOptions] = spec;
  const optionsPath = [...path, 1];
  let options: JsonObject = {};
  if (rawOptions !== undefined && rawOptions !== null) {
    if (isObject(rawOptions)) options = rawOptions;
    else
      report(
        context,
        "W_INVALID_INPUT_OPTION",
        optionsPath,
        `Expected the options to be an object, got ${describe(rawOptions)}; ignoring them.`,
      );
  }
  const reader = new SpecReader(context, name, required, options, optionsPath, readInput);

  // Legacy combos stay combos under forceInput: their links only match an identical option list
  // (§5.2), which a COMBO socket would not express. They record the flag, since the frontend
  // then draws a socket and no widget.
  if (head !== undefined && isJsonArray(head)) {
    return reader.legacyCombo(head, [...path, 0]) ?? unknown(context, name, required, spec, path);
  }
  if (typeof head !== "string") {
    return unknown(
      context,
      name,
      required,
      spec,
      path,
      `Expected the input type to be a string or an option list, got ${describe(head)}.`,
    );
  }
  switch (head) {
    case AUTOGROW:
      return reader.autogrow() ?? unknown(context, name, required, spec, path);
    case DYNAMIC_COMBO:
      return reader.dynamicCombo() ?? unknown(context, name, required, spec, path);
    case DYNAMIC_GROUP:
      return reader.dynamicGroup() ?? unknown(context, name, required, spec, path);
    case MATCH_TYPE:
      return reader.matchType() ?? unknown(context, name, required, spec, path);
  }
  if (isV3DynamicType(head)) {
    report(
      context,
      "W_UNSUPPORTED_INPUT_TYPE",
      [...path, 0],
      `${head} is a dynamic input type this version doesn't know; keeping the input as unknown.`,
    );
    return unknown(context, name, required, spec, path);
  }
  const type = parseSocketType(head);
  if (type === undefined) {
    return unknown(context, name, required, spec, path, "The input type is empty.");
  }
  const widgetType = reader.string("widgetType");
  const forced = forceSocket || reader.flag("forceInput");
  if (!forced) {
    if (isPrimitiveWidget(head)) return reader.primitive(head, type, widgetType);
    const widget = widgetType ?? head;
    if (isPrimitiveWidget(widget)) return reader.primitive(widget, type, widgetType);
    if (isValueWidget(widget)) return reader.value(widget, type);
  }
  return { kind: "socket", ...reader.base(), type, ...(forced ? reader.forced() : {}) };
}
