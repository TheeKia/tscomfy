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
import { sendsInputValue } from "../frontend/widgets.ts";
import type { GraphNode, InputValue, Workflow } from "../graph/graph.ts";
import { isOutputRef } from "../graph/output-ref.ts";
import type { NodeId } from "../graph/types.ts";
import type { JsonValue } from "../json/value.ts";
import type { InputDef, NodeDef } from "../schema/types.ts";
import { validateApi } from "../validate/validate-api.ts";
import { applyModes, type ModalNode } from "./modes.ts";
import type { ApiNode, ApiPrompt } from "./prompt.ts";
import { defaultWire, widgetWire } from "./wire.ts";

/** Options for {@link toApi} and {@link exportApi}. */
export interface ToApiOptions {
  /** Emit `_meta.title`, as the frontend does. Default `true`. */
  readonly meta?: boolean;
  /**
   * Validate the prompt against the schema, as {@link validateApi} does. Default `true`.
   * Problems building the prompt itself are reported either way.
   */
  readonly validate?: boolean;
  /**
   * Apply bypass and mute. Default `true`. With `false`, every node is sent
   * as if it ran, as a tool that rewrites workflows needs (the transpiler).
   */
  readonly modes?: boolean;
}

/** What {@link exportApi} returns. */
export interface ApiExportResult {
  /** The prompt, built even when there are errors: whatever could be sent. */
  readonly prompt: ApiPrompt;
  /** Problems building the prompt, then, unless `validate` is `false`, validating it. */
  readonly diagnostics: readonly Diagnostic[];
}

/**
 * Converts a workflow into an API-format prompt: explicit schema
 * defaults filled in, dynamic inputs flattened to their wire keys, list values wrapped, keys in
 * the frontend's order. Serialize it with `stringify`, which keeps big integers exact.
 *
 * Throws a {@link ValidationError}, carrying every diagnostic, when there is an error: the
 * prompt can't be built faithfully (`E_INPUT_KEY_COLLISION`, `E_TOO_MANY_DYNAMIC_INPUTS`), or,
 * unless `validate` is `false`, the backend would reject it. Warnings don't throw; use
 * {@link exportApi} to see them. Throws a `TypeError` for an output reference nested inside a
 * JSON value, which no input can carry.
 */
export function toApi(workflow: Workflow, options: ToApiOptions = {}): ApiPrompt {
  const { prompt, diagnostics } = exportApi(workflow, options);
  if (diagnostics.some((diagnostic) => diagnostic.severity === "error")) {
    throw new ValidationError(diagnostics);
  }
  return prompt;
}

/**
 * {@link toApi} without throwing: the prompt, and what went wrong building and validating it.
 */
export function exportApi(workflow: Workflow, options: ToApiOptions = {}): ApiExportResult {
  const diagnostics: Diagnostic[] = [];
  const entries: [NodeId, ApiNode][] = [];
  const modal: ModalNode[] = [];
  for (const node of workflow.graph.nodes.values()) {
    const definition = Object.hasOwn(workflow.schema.nodes, node.classType)
      ? workflow.schema.nodes[node.classType]
      : undefined;
    const inputs =
      node.raw || definition === undefined
        ? rawInputs(node)
        : new NodeExport(node, definition, diagnostics).inputs();
    const title = node.title ?? definition?.displayName ?? node.classType;
    const exported: ApiNode = {
      inputs,
      class_type: node.classType,
      ...(options.meta === false ? {} : { _meta: { title } }),
    };
    entries.push([node.id, exported]);
    modal.push({ id: node.id, node: exported, definition, mode: node.mode });
  }
  // Bypassed and muted nodes aren't sent; links through them are resolved as the frontend does.
  const prompt: ApiPrompt = Object.fromEntries(
    options.modes !== false && modal.some((node) => node.mode !== undefined)
      ? applyModes(modal, diagnostics)
      : entries,
  );
  if (options.validate !== false) diagnostics.push(...validateApi(prompt, workflow.schema));
  return { prompt, diagnostics };
}

/**
 * Every problem with a workflow: the errors {@link toApi} would throw for, and
 * the warnings, which don't stop the backend (a value outside an upload combo's listed files, for
 * example). Empty for a workflow the backend accepts with nothing to report. Throws a `TypeError`
 * where {@link toApi} does.
 */
export function validate(workflow: Workflow): readonly Diagnostic[] {
  return exportApi(workflow).diagnostics;
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
    this.#unknown(given, known, "", false);
    return Object.fromEntries([...this.#widgets, ...this.#sockets, ...this.#optionSockets]);
  }

  /** Adds one input at `key`; `inOption` is true inside a dynamic-combo option. */
  #input(input: InputDef, value: InputValue | undefined, key: string, inOption: boolean): void {
    switch (input.kind) {
      case "int":
      case "float":
      case "string":
      case "boolean":
      case "combo":
      case "value":
        // No widget (a forceInput combo), or one the frontend never sends (a display-only widget,
        // CameraAngle's optional `view`): nothing is filled in, and a value given passes through.
        if ((input.kind === "combo" && input.forceInput === true) || !sendsInputValue(input)) {
          if (value !== undefined) this.#passThrough(key, value, inOption);
          return;
        }
        this.#widget(input, value, key, inOption);
        return;
      case "socket":
      case "matchType":
      case "unknown":
        if (value !== undefined) this.#passThrough(key, value, inOption);
        return;
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

  /**
   * A widget: its value, as the frontend sends it, or its default (§7.2) when none is given. A
   * linked widget keeps its widget's position.
   */
  #widget(input: InputDef, value: InputValue | undefined, key: string, inOption: boolean): void {
    // `null` is a value; only a missing input takes the default.
    const sent =
      value === undefined
        ? defaultWire(input)
        : isOutputRef(value)
          ? encode(value)
          : widgetWire(input, encodedValue(value));
    if (sent !== undefined) this.#add("widget", key, sent, inOption);
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
    // A bare key, or `{ option, inputs? }`. Anything else passes through for validation.
    const chosen = typeof value === "string" ? value : optionOf(value);
    if (chosen === undefined) {
      this.#add("widget", key, encode(value), inOption);
      return;
    }
    const children = isRecord(value) && isRecord(value["inputs"]) ? value["inputs"] : {};
    this.#add("widget", key, chosen, inOption);
    const option = input.options.find((each) => each.key === chosen);
    const known = new Set<string>();
    for (const child of option?.inputs ?? []) {
      known.add(child.name);
      this.#input(
        child,
        Object.hasOwn(children, child.name) ? children[child.name] : undefined,
        `${key}.${child.name}`,
        true,
      );
    }
    this.#unknown(children, known, `${key}.`, true);
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
      if (value.length > input.slots.length) this.#tooMany(key, value.length, input.slots.length);
      input.slots.slice(0, value.length).forEach((slot, index) => {
        this.#input(input.template, value[index], `${key}.${slot}`, inOption);
      });
    } else if (isRecord(value)) {
      for (const slot of input.slots) {
        if (Object.hasOwn(value, slot)) {
          this.#input(input.template, value[slot], `${key}.${slot}`, inOption);
        }
      }
      this.#unknown(value, new Set(input.slots), `${key}.`, inOption);
    } else {
      this.#passThrough(key, value, inOption);
    }
  }

  #dynamicGroup(
    input: Extract<InputDef, { kind: "dynamicGroup" }>,
    value: InputValue | undefined,
    key: string,
    inOption: boolean,
  ): void {
    if (value === undefined) return;
    if (!isList(value)) {
      this.#passThrough(key, value, inOption);
      return;
    }
    if (value.length > input.max) this.#tooMany(key, value.length, input.max);
    const names = new Set(input.fields.map((field) => field.name));
    value.slice(0, input.max).forEach((row, index) => {
      const prefix = `${key}.${String(index)}`;
      if (!isRecord(row)) {
        this.#passThrough(prefix, row, inOption);
        return;
      }
      const fields = row;
      for (const field of input.fields) {
        this.#input(
          field,
          Object.hasOwn(fields, field.name) ? fields[field.name] : undefined,
          `${prefix}.${field.name}`,
          inOption,
        );
      }
      this.#unknown(fields, names, `${prefix}.`, inOption);
    });
  }

  /**
   * Keys the schema doesn't know, of the node or inside a structured value: passed through after
   * the known ones; validation flags them.
   */
  #unknown(
    values: { readonly [key: string]: InputValue },
    known: ReadonlySet<string>,
    prefix: string,
    inOption: boolean,
  ): void {
    for (const [name, value] of Object.entries(values)) {
      if (!known.has(name)) this.#passThrough(`${prefix}${name}`, value, inOption);
    }
  }

  /** A value whose shape its input can't take: sent under `key` as given, for validation. */
  #passThrough(key: string, value: InputValue, inOption: boolean): void {
    this.#add(isOutputRef(value) ? "socket" : "widget", key, encode(value), inOption);
  }

  /** More slots or rows than the backend reads: the rest can't be sent. */
  #tooMany(key: string, given: number, most: number): void {
    this.#diagnostics.push(
      createDiagnostic(
        "E_TOO_MANY_DYNAMIC_INPUTS",
        [this.#node.id, "inputs", key],
        `Input ${key} of node ${this.#node.id} has ${String(given)} entries, but at most ${String(most)} can be sent; dropping the rest.`,
      ),
    );
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

/** The option a `{ option, inputs? }` value chooses, or `undefined` for any other shape. */
function optionOf(value: InputValue): string | undefined {
  if (!isRecord(value) || typeof value["option"] !== "string") return undefined;
  const keys = Object.keys(value);
  const inputs = value["inputs"];
  const shaped =
    keys.every((each) => each === "option" || each === "inputs") &&
    (inputs === undefined || isRecord(inputs));
  return shaped ? value["option"] : undefined;
}

function isList(value: InputValue): value is readonly InputValue[] {
  return Array.isArray(value);
}

function isRecord(value: InputValue | undefined): value is { readonly [key: string]: InputValue } {
  return (
    typeof value === "object" && value !== null && !Array.isArray(value) && !isOutputRef(value)
  );
}
