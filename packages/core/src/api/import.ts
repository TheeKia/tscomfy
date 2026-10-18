// API-format prompt → Workflow (docs/plan.md §10): the exporter in reverse. Wire keys are
// folded back into structured inputs by the schema, `__value__` lists unwrapped, links turned into
// output references. Re-exporting a prompt the frontend wrote gives it back byte for byte.

import { createDiagnostic, type Diagnostic } from "../diagnostic/diagnostic.ts";
import { sendsInputValue } from "../frontend/widgets.ts";
import type { InputValue, Workflow } from "../graph/graph.ts";
import type { NodeId, NodeMode, Out } from "../graph/types.ts";
import { assembleWorkflow, type AssembledNode } from "../graph/workflow.ts";
import { parse } from "../json/parse.ts";
import { isJsonArray, isJsonObject, type JsonObject, type JsonValue } from "../json/value.ts";
import { definitionOf } from "../schema/lookup.ts";
import type { TypedSchema } from "../schema/typed.ts";
import type { InputDef, NodeDef } from "../schema/types.ts";
import { isWellFormedLink } from "./prompt.ts";
import { groupKey } from "./wire.ts";

/** What {@link importApi} returns. */
export interface ApiImportResult<N> {
  /** The prompt as a workflow over `schema`; nodes it couldn't read are left out. */
  readonly workflow: Workflow<N>;
  /** Problems reading the prompt. Validation (`validate`) is separate. */
  readonly diagnostics: readonly Diagnostic[];
}

/**
 * Reads an API-format prompt (the JSON `POST /prompt` takes as `prompt`, or the frontend's
 * "Export (API)") into a workflow over `schema`. Takes raw text, so big integers stay exact.
 *
 * Nodes keep their ids and titles. A node whose class the schema has gets structured inputs, as
 * the builder records them; a node of an unknown class, or one whose keys don't fold back (a
 * DynamicGroup with row gaps, keys under a dynamic combo's unknown option), is kept as a raw node
 * with its wire keys, so it still exports as it came.
 */
export function importApi<N>(text: string, schema: TypedSchema<N>): ApiImportResult<N> {
  const diagnostics: Diagnostic[] = [];
  const parsed = parse(text);
  diagnostics.push(...parsed.diagnostics);
  const nodes: AssembledNode[] = [];
  const workflow = assembleWorkflow(schema, (link) => {
    if (parsed.value === undefined) return [];
    if (!isJsonObject(parsed.value)) {
      diagnostics.push(
        createDiagnostic("E_INVALID_PROMPT", [], "Expected a prompt: an object of nodes by id."),
      );
      return [];
    }
    for (const [id, raw] of Object.entries(parsed.value)) {
      const node = readNode(id, raw, schema, link, diagnostics);
      if (node !== undefined) nodes.push(node);
    }
    return nodes;
  });
  return { workflow, diagnostics };
}

/** Makes an output reference of the workflow being built. */
export type Link = (node: NodeId, slot: number) => Out<string>;

function readNode(
  id: NodeId,
  value: JsonValue,
  schema: TypedSchema<unknown>,
  link: Link,
  diagnostics: Diagnostic[],
): AssembledNode | undefined {
  const invalid = (path: readonly (string | number)[], message: string): undefined => {
    diagnostics.push(createDiagnostic("E_INVALID_PROMPT", [id, ...path], message));
    return undefined;
  };
  if (id === "") return invalid([], "A node has an empty id; dropping it.");
  if (!isJsonObject(value)) return invalid([], `Node ${id} isn't an object; dropping it.`);
  const classType = value["class_type"];
  const inputs = value["inputs"] ?? {};
  if (typeof classType !== "string") {
    return invalid(["class_type"], `Node ${id} has no class_type string; dropping it.`);
  }
  if (!isJsonObject(inputs))
    return invalid(["inputs"], `Node ${id}'s inputs aren't an object; dropping it.`);
  const meta = value["_meta"];
  const title = isJsonObject(meta) && typeof meta["title"] === "string" ? meta["title"] : undefined;
  return wireNode(
    { id, classType, inputs, ...(title === undefined ? {} : { title }) },
    schema,
    link,
    diagnostics,
  );
}

/** A node as the wire carries it: class, wire keys (links as `[id, slot]`), title and mode. */
export interface WireNode {
  readonly id: NodeId;
  readonly classType: string;
  readonly inputs: JsonObject;
  /** The title shown, if any; one equal to the display name isn't kept. */
  readonly title?: string;
  readonly mode?: NodeMode;
}

/**
 * A node of the wire, folded into structured inputs by the schema (the API and UI importers
 * share it). Raw when the class is unknown or its keys don't fold back.
 */
export function wireNode(
  node: WireNode,
  schema: TypedSchema<unknown>,
  link: Link,
  diagnostics: Diagnostic[],
): AssembledNode {
  const { id, classType, inputs } = node;
  const definition = definitionOf(schema, classType);
  // The exporter writes the display name when there is no title, so only a different one is kept.
  const title = node.title === (definition?.displayName ?? classType) ? undefined : node.title;

  const decoded: [string, InputValue][] = [];
  for (const [key, wire] of Object.entries(inputs)) {
    const decodedValue = decode(wire, link);
    if (decodedValue === undefined) {
      diagnostics.push(
        createDiagnostic(
          "E_INVALID_LINK",
          [id, "inputs", key],
          `Input ${key} of node ${id} is a list, which reads as a link, but not [node id, output slot]; dropping it.`,
        ),
      );
      continue;
    }
    decoded.push([key, decodedValue]);
  }
  const wireInputs = Object.fromEntries(decoded);
  const base = {
    id,
    classType,
    ...(title === undefined ? {} : { title }),
    ...(node.mode === undefined ? {} : { mode: node.mode }),
  };
  if (definition === undefined) return { ...base, inputs: wireInputs, raw: true };
  const folded = fold(definition, wireInputs);
  if (typeof folded === "string") {
    diagnostics.push(
      createDiagnostic(
        "W_IMPORTED_AS_RAW",
        [id],
        `Node ${id} (${classType}) is kept as a raw node: ${folded}.`,
      ),
    );
    return { ...base, inputs: wireInputs, raw: true };
  }
  return { ...base, inputs: folded, raw: false };
}

/**
 * A wire value as the builder holds it: a link as an output reference, `{"__value__": [...]}` as
 * the list. `undefined` for a list that isn't a link.
 */
function decode(value: JsonValue, link: Link): InputValue | undefined {
  if (isJsonArray(value)) return isWellFormedLink(value) ? link(value[0], value[1]) : undefined;
  const wrapped = isJsonObject(value) ? value["__value__"] : undefined;
  if (isJsonObject(value) && Object.keys(value).length === 1 && isJsonArray(wrapped))
    return wrapped;
  return value;
}

/**
 * Wire keys folded into structured inputs by the definition, mirroring the exporter; a string
 * saying why when they don't fold back faithfully.
 */
function fold(
  node: NodeDef,
  wire: { readonly [key: string]: InputValue },
): { readonly [name: string]: InputValue } | string {
  const claimed = new Set<string>();
  let problem: string | undefined;
  const take = (key: string): InputValue | undefined => {
    if (!Object.hasOwn(wire, key)) return undefined;
    // Two inputs would send the same key; the exporter would report a collision.
    if (claimed.has(key)) {
      problem = `${key} belongs to two inputs`;
      return undefined;
    }
    claimed.add(key);
    return wire[key];
  };

  const input = (definition: InputDef, key: string): InputValue | undefined => {
    switch (definition.kind) {
      case "autogrow": {
        const present = definition.slots.filter((slot) => Object.hasOwn(wire, `${key}.${slot}`));
        if (present.length === 0) return undefined;
        const values = present.map((slot) => take(`${key}.${slot}`) ?? null);
        // Prefix form: a list when the slots are the first ones, in order. Otherwise by slot name.
        const contiguous = present.every((slot, index) => slot === definition.slots[index]);
        if (definition.form === "prefix" && contiguous) return values;
        return Object.fromEntries(present.map((slot, index) => [slot, values[index] ?? null]));
      }
      case "dynamicCombo": {
        const chosen = take(key);
        if (typeof chosen !== "string") return chosen;
        const option = definition.options.find((each) => each.key === chosen);
        const prefix = `${key}.`;
        if (option === undefined) {
          if (Object.keys(wire).some((each) => each.startsWith(prefix))) {
            problem = `${key} is ${JSON.stringify(chosen)}, which isn't an option, and has inputs`;
          }
          return chosen;
        }
        const children: [string, InputValue][] = [];
        for (const child of option.inputs) {
          const value = input(child, `${prefix}${child.name}`);
          if (value !== undefined) children.push([child.name, value]);
        }
        return children.length === 0
          ? chosen
          : { option: chosen, inputs: Object.fromEntries(children) };
      }
      case "dynamicGroup": {
        const prefix = `${key}.`;
        const rows = new Map<number, [string, InputValue][]>();
        for (const wireKey of Object.keys(wire)) {
          if (!wireKey.startsWith(prefix)) continue;
          const at = groupKey(wireKey.slice(prefix.length));
          const field = definition.fields.find((each) => each.name === at?.field);
          if (at === undefined || field === undefined) {
            problem = `${wireKey} isn't a field of group ${key}`;
            continue;
          }
          // Checked before any list is built: a row past `max` can't be sent anyway.
          if (at.row >= definition.max) {
            problem = `${wireKey} is in a row past the group's ${String(definition.max)}`;
            continue;
          }
          const row = rows.get(at.row) ?? [];
          row.push([field.name, input(field, wireKey) ?? null]);
          rows.set(at.row, row);
        }
        if (rows.size === 0) return undefined;
        const count = Math.max(...rows.keys()) + 1;
        if (count !== rows.size) problem = `group ${key} has rows missing in between`;
        return Array.from({ length: count }, (_, index) => {
          // Fields in the definition's order, as the exporter writes them.
          const row = new Map(rows.get(index) ?? []);
          return Object.fromEntries(
            definition.fields.flatMap((field): [string, InputValue][] => {
              const value = row.get(field.name);
              return value === undefined ? [] : [[field.name, value]];
            }),
          );
        });
      }
      case "value":
        // The frontend never sends a display-only widget, so the types have no input for it: a
        // value given for one can only be kept raw.
        if (!sendsInputValue(definition) && Object.hasOwn(wire, key)) {
          problem = `${key} is a display-only widget, which the frontend never sends and the types have no input for`;
          return undefined;
        }
        return unwrapCurve(definition.widget, take(key));
      case "int":
      case "float":
      case "string":
      case "boolean":
      case "combo":
        // Nor for an optional input on a widget it never sends (CameraAngle's `view`).
        if (!sendsInputValue(definition) && Object.hasOwn(wire, key)) {
          problem = `${key} is a widget the frontend doesn't send, which the types have no input for`;
          return undefined;
        }
        return take(key);
      case "socket":
      case "matchType":
      case "unknown":
        return take(key);
    }
  };

  const structured: [string, InputValue][] = [];
  for (const each of node.inputs) {
    const value = input(each, each.name);
    if (value !== undefined) structured.push([each.name, value]);
  }
  if (problem !== undefined) return problem;
  // Keys the schema doesn't know pass through as they are; validation reports them.
  for (const [key, value] of Object.entries(wire)) {
    if (!claimed.has(key)) structured.push([key, value]);
  }
  return Object.fromEntries(structured);
}

/** The exporter marks CURVE values `{"__type__": "CURVE", "__value__": …}`. */
function unwrapCurve(widget: string, value: InputValue | undefined): InputValue | undefined {
  if (widget !== "CURVE" || !isPlain(value)) return value;
  const keys = Object.keys(value);
  return keys.length === 2 && value["__type__"] === "CURVE" && Object.hasOwn(value, "__value__")
    ? (value["__value__"] ?? null)
    : value;
}

function isPlain(value: InputValue | undefined): value is { readonly [key: string]: InputValue } {
  return (
    typeof value === "object" &&
    value !== null &&
    !Array.isArray(value) &&
    Object.getPrototypeOf(value) === Object.prototype
  );
}
