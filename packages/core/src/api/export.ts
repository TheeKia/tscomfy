// Graph → API-format prompt (docs/plan.md §7.4), byte for byte what the ComfyUI frontend sends
// for the same graph. The frontend's rules (ComfyUI_frontend 1.55.17 `executionUtil.ts`
// `graphToPrompt`, `litegraphService.ts`, `dynamicWidgets.ts`):
// - every widget value is sent, in widget order; a linked widget keeps its widget's position;
// - then every connected socket that isn't a widget, in input order;
// - a dynamic combo's option widgets follow it depth-first; its option sockets come after the
//   node's own sockets;
// - arrays are wrapped as `{"__value__": [...]}`, CURVE values as `{"__type__": "CURVE", …}`;
// - `_meta.title` is always present.

import { createDiagnostic, type Diagnostic } from "../diagnostic/diagnostic.ts";
import { ValidationError } from "../diagnostic/validation-error.ts";
import type { GraphNode, InputValue, Workflow } from "../graph/graph.ts";
import { isOutputRef } from "../graph/output-ref.ts";
import type { NodeId } from "../graph/types.ts";
import type { JsonValue } from "../json/value.ts";
import { sendsValue } from "../schema/frontend.ts";
import type { InputDef, NodeDef } from "../schema/types.ts";

/** A link in a prompt: the source node's id and output slot. */
export type ApiLink = readonly [NodeId, number];

/** One node of an API-format prompt. */
export type ApiNode = {
  readonly inputs: { readonly [key: string]: JsonValue };
  readonly class_type: string;
  readonly _meta?: { readonly title: string };
};

/** An API-format prompt: what `POST /prompt` takes as `prompt`. May hold bigint; see `stringify`. */
export type ApiPrompt = { readonly [id: NodeId]: ApiNode };

/** Options for {@link toApi}. */
export interface ToApiOptions {
  /** Emit `_meta.title`, as the frontend does. Default `true`. */
  readonly meta?: boolean;
}

/**
 * Converts a workflow into an API-format prompt (docs/plan.md §7.4, §7.5): explicit schema
 * defaults filled in, dynamic inputs flattened to their wire keys, list values wrapped, keys in
 * the frontend's order. Serialize it with `stringify`, which keeps big integers exact.
 *
 * Throws a {@link ValidationError} when the prompt can't be built faithfully: a flattened
 * dynamic key that collides with another input of the node (`E_INPUT_KEY_COLLISION`).
 */
export function toApi(workflow: Workflow, options: ToApiOptions = {}): ApiPrompt {
  const { prompt, diagnostics } = exportApi(workflow, options);
  if (diagnostics.some((diagnostic) => diagnostic.severity === "error")) {
    throw new ValidationError(diagnostics);
  }
  return prompt;
}

/** {@link toApi} without throwing: the prompt and what went wrong building it. */
export function exportApi(
  workflow: Workflow,
  options: ToApiOptions = {},
): { readonly prompt: ApiPrompt; readonly diagnostics: readonly Diagnostic[] } {
  const diagnostics: Diagnostic[] = [];
  const entries: [NodeId, ApiNode][] = [];
  for (const node of workflow.graph.nodes.values()) {
    const definition = Object.hasOwn(workflow.schema.nodes, node.classType)
      ? workflow.schema.nodes[node.classType]
      : undefined;
    const inputs =
      node.raw || definition === undefined
        ? rawInputs(node)
        : new NodeExport(node, definition, diagnostics).inputs();
    const title = node.title ?? definition?.displayName ?? node.classType;
    entries.push([
      node.id,
      {
        inputs,
        class_type: node.classType,
        ...(options.meta === false ? {} : { _meta: { title } }),
      },
    ]);
  }
  return { prompt: Object.fromEntries(entries), diagnostics };
}

/** The inputs of one node, gathered in the frontend's three groups. */
class NodeExport {
  readonly #node: GraphNode;
  readonly #definition: NodeDef;
  readonly #diagnostics: Diagnostic[];
  readonly #widgets: [string, JsonValue][] = [];
  readonly #sockets: [string, JsonValue][] = [];
  readonly #optionSockets: [string, JsonValue][] = [];
  readonly #keys = new Set<string>();

  constructor(node: GraphNode, definition: NodeDef, diagnostics: Diagnostic[]) {
    this.#node = node;
    this.#definition = definition;
    this.#diagnostics = diagnostics;
  }

  inputs(): { readonly [key: string]: JsonValue } {
    const given = this.#node.inputs;
    const known = new Set<string>();
    for (const input of this.#definition.inputs) {
      known.add(input.name);
      this.#input(
        input,
        Object.hasOwn(given, input.name) ? given[input.name] : undefined,
        input.name,
        false,
      );
    }
    // Inputs the schema doesn't know are passed through after the rest; validation flags them.
    for (const [name, value] of Object.entries(given)) {
      if (!known.has(name))
        this.#add(isOutputRef(value) ? "socket" : "widget", name, encode(value), false);
    }
    return Object.fromEntries([...this.#widgets, ...this.#sockets, ...this.#optionSockets]);
  }

  /** Adds one input at `key`; `inOption` is true inside a dynamic-combo option. */
  #input(input: InputDef, value: InputValue | undefined, key: string, inOption: boolean): void {
    switch (input.kind) {
      case "socket":
      case "matchType":
      case "unknown":
        if (value !== undefined) {
          this.#add(isOutputRef(value) ? "socket" : "widget", key, encode(value), inOption);
        }
        return;
      case "int":
      case "float":
      case "string":
      case "boolean": {
        const sent = value ?? input.default;
        if (sent !== undefined) this.#add("widget", key, encode(sent), inOption);
        return;
      }
      case "combo": {
        const sent = value ?? comboDefault(input);
        if (sent !== undefined) this.#add("widget", key, encode(sent), inOption);
        return;
      }
      case "value": {
        if (!sendsValue(input.widget)) return;
        const sent = value ?? input.default;
        if (sent === undefined) return;
        const encoded = encode(sent);
        // The frontend marks CURVE values with their type; other objects pass as they are.
        this.#add(
          "widget",
          key,
          input.widget === "CURVE" && sent !== null && !isOutputRef(sent)
            ? { __type__: "CURVE", __value__: encodedValue(sent) }
            : encoded,
          inOption,
        );
        return;
      }
      case "dynamicCombo":
        this.#dynamicCombo(input, value, key, inOption);
        return;
      case "autogrow":
        this.#autogrow(input, value, key, inOption);
        return;
      case "dynamicGroup":
        this.#dynamicGroup(input, value, key, inOption);
        return;
    }
  }

  #dynamicCombo(
    input: Extract<InputDef, { kind: "dynamicCombo" }>,
    value: InputValue | undefined,
    key: string,
    inOption: boolean,
  ): void {
    if (value === undefined) return;
    if (isOutputRef(value)) {
      this.#add("widget", key, encode(value), inOption);
      return;
    }
    // A bare key, or `{ option, inputs }`.
    const chosen =
      typeof value === "string" ? value : isRecord(value) ? value["option"] : undefined;
    const children = isRecord(value) && isRecord(value["inputs"]) ? value["inputs"] : {};
    if (typeof chosen !== "string") {
      this.#add("widget", key, encode(value), inOption);
      return;
    }
    this.#add("widget", key, chosen, inOption);
    const option = input.options.find((each) => each.key === chosen);
    for (const child of option?.inputs ?? []) {
      this.#input(
        child,
        Object.hasOwn(children, child.name) ? children[child.name] : undefined,
        `${key}.${child.name}`,
        true,
      );
    }
  }

  #autogrow(
    input: Extract<InputDef, { kind: "autogrow" }>,
    value: InputValue | undefined,
    key: string,
    inOption: boolean,
  ): void {
    if (value === undefined) return;
    // Only given (connected) slots are sent, in slot order.
    if (isList(value)) {
      value.forEach((item, index) => {
        const slot = input.slots[index] ?? String(index);
        this.#input(input.template, item, `${key}.${slot}`, inOption);
      });
    } else if (isRecord(value)) {
      for (const slot of input.slots) {
        if (Object.hasOwn(value, slot))
          this.#input(input.template, value[slot], `${key}.${slot}`, inOption);
      }
    }
  }

  #dynamicGroup(
    input: Extract<InputDef, { kind: "dynamicGroup" }>,
    value: InputValue | undefined,
    key: string,
    inOption: boolean,
  ): void {
    if (value === undefined || !isList(value)) return;
    value.forEach((row, index) => {
      const fields = isRecord(row) ? row : {};
      for (const field of input.fields) {
        this.#input(
          field,
          Object.hasOwn(fields, field.name) ? fields[field.name] : undefined,
          `${key}.${String(index)}.${field.name}`,
          inOption,
        );
      }
    });
  }

  /** Places a key in its group; a key already taken is a collision. */
  #add(group: "widget" | "socket", key: string, value: JsonValue, inOption: boolean): void {
    if (this.#keys.has(key)) {
      this.#diagnostics.push(
        createDiagnostic(
          "E_INPUT_KEY_COLLISION",
          [this.#node.id, "inputs", key],
          `Two inputs of node ${this.#node.id} (${this.#node.classType}) both send the key ${JSON.stringify(key)}; keeping the first.`,
        ),
      );
      return;
    }
    this.#keys.add(key);
    const target =
      group === "widget" ? this.#widgets : inOption ? this.#optionSockets : this.#sockets;
    target.push([key, value]);
  }
}

/**
 * The value the frontend gives a combo it wasn't given one for (`useComboWidget.ts`): a
 * multi-select starts empty whatever the default; a single combo takes its default unless that
 * is falsy, then its first option.
 */
function comboDefault(input: Extract<InputDef, { kind: "combo" }>): InputValue | undefined {
  if (input.multiselect) return [];
  if (input.default === undefined) return undefined;
  return input.default === "" || input.default === 0 || input.default === false
    ? (input.options[0] ?? input.default)
    : input.default;
}

/** Inputs of a raw node, or of a class the schema doesn't know: passed through as given. */
function rawInputs(node: GraphNode): { readonly [key: string]: JsonValue } {
  return Object.fromEntries(
    Object.entries(node.inputs).map(([key, value]) => [key, encode(value)]),
  );
}

/**
 * A value as the prompt carries it: a link as `[id, slot]`; a list wrapped in
 * `{"__value__": [...]}`, because the backend reads a bare list as a link.
 */
function encode(value: InputValue): JsonValue {
  if (isOutputRef(value)) return [value.node, value.slot];
  if (isList(value)) return { __value__: encodedValue(value) };
  return encodedValue(value);
}

/** A plain JSON value; output references can only stand for a whole input. */
function encodedValue(value: InputValue): JsonValue {
  if (isOutputRef(value)) {
    throw new TypeError("toApi: an output reference can only be the whole value of an input");
  }
  if (isList(value)) return value.map(encodedValue);
  if (isRecord(value)) {
    return Object.fromEntries(
      Object.entries(value).map(([key, item]) => [key, encodedValue(item)]),
    );
  }
  return value;
}

function isList(value: InputValue): value is readonly InputValue[] {
  return Array.isArray(value);
}

function isRecord(value: InputValue | undefined): value is { readonly [key: string]: InputValue } {
  return (
    typeof value === "object" && value !== null && !Array.isArray(value) && !isOutputRef(value)
  );
}
