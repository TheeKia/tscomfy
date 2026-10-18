// Workflow → UI workflow (docs/plan.md §11): the JSON the ComfyUI frontend loads, so a workflow
// built in code can be opened, inspected and run there. Format 0.4 with tuple links, which is what
// the frontend writes; every slot listed in the frontend's order and every saved widget value
// written, so loading reproduces the prompt `toApi` builds.

import { exportApi } from "../api/export.ts";
import { createDiagnostic, type Diagnostic } from "../diagnostic/diagnostic.ts";
import type { GraphNode, Workflow } from "../graph/graph.ts";
import type { NodeId } from "../graph/types.ts";
import { sha256Hex, utf8 } from "../hash/sha256.ts";
import { stringify } from "../json/stringify.ts";
import { isJsonObject, type JsonObject, type JsonValue } from "../json/value.ts";
import type { InputDef, NodeDef, OutputDef } from "../schema/types.ts";
import {
  frontendSlots,
  frontendWidgets,
  initialValue,
  replacesText,
  SAVE_NODES,
} from "./frontend.ts";

/** Options for {@link toUi}. */
export interface ToUiOptions {
  /**
   * Where each node goes: its top-left corner. `@tscomfy/layout` computes a readable layout;
   * nodes without a position are stacked in one column.
   */
  readonly positions?: ReadonlyMap<NodeId, readonly [x: number, y: number]>;
}

/** What {@link toUi} returns. */
export interface ToUiResult {
  /** The UI workflow: serialize it with `stringify`. */
  readonly workflow: JsonObject;
  /** The UI node id each node got. */
  readonly ids: ReadonlyMap<NodeId, number>;
  readonly diagnostics: readonly Diagnostic[];
}

/**
 * The workflow as a UI workflow the frontend loads (docs/plan.md §11), deterministic. Node ids
 * that are integers stay; others (`ckpt`, `40:31`) get the next free numbers, in graph order.
 * Bypassed and muted nodes keep their mode.
 *
 * Loading the file in the frontend queues what `toApi` builds, apart from what the format can't
 * carry, which is reported: `W_UI_VALUE_LOST` for a value with no widget to hold it (DynamicGroup
 * rows, widgets the frontend doesn't save), `W_UNKNOWN_UI_CLASS` for a node of a class the schema
 * doesn't have (written with its links and its values by name) and `W_UNSAFE_INTEGER` for an
 * integer the frontend's parser would round, `W_QUEUE_TIME_VALUE` for a file name the frontend
 * rewrites when it queues (`%date:…%`, `%Node.widget%`). Optional widgets and dynamic combos
 * left out are sent by the frontend with their initial values, as for a node added by hand.
 */
export function toUi(workflow: Workflow, options: ToUiOptions = {}): ToUiResult {
  return new UiWriter(workflow, options).write();
}

/**
 * The size {@link toUi} gives each node: room for its slots and widgets, about what the frontend
 * draws for a node of a core class, so a layout built from it (`@tscomfy/layout`) doesn't
 * overlap. Nodes whose pack JavaScript adds widgets come out larger in the frontend.
 */
export function uiNodeSizes(workflow: Workflow): ReadonlyMap<NodeId, readonly [number, number]> {
  const writer = new UiWriter(workflow, {});
  writer.write();
  return writer.sizes;
}

/** One link of the file being written. */
interface Link {
  readonly id: number;
  readonly origin: number;
  readonly originSlot: number;
  readonly target: number;
  readonly targetSlot: number;
  readonly type: string;
}

class UiWriter {
  readonly #workflow: Workflow;
  readonly #options: ToUiOptions;
  readonly #diagnostics: Diagnostic[] = [];
  readonly #ids = new Map<NodeId, number>();
  readonly #sizes = new Map<NodeId, readonly [number, number]>();

  get sizes(): ReadonlyMap<NodeId, readonly [number, number]> {
    return this.#sizes;
  }

  constructor(workflow: Workflow, options: ToUiOptions) {
    this.#workflow = workflow;
    this.#options = options;
  }

  write(): ToUiResult {
    const nodes = [...this.#workflow.graph.nodes.values()];
    this.#assignIds(nodes);
    // Wire inputs before modes: every node is written, with what it would send if it ran.
    const wire = exportApi(this.#workflow, { validate: false, meta: false, modes: false }).prompt;
    const links: Link[] = [];
    const outputs = new Map<number, Map<number, number[]>>();
    const written: JsonObject[] = [];
    let y = 0;
    for (const [order, node] of nodes.entries()) {
      const id = this.#ids.get(node.id) ?? 0;
      const definition = this.#definition(node.classType);
      const inputs = wire[node.id]?.inputs ?? {};
      const { slots, widgets } = this.#layout(node, definition, inputs, links, outputs);
      const size = nodeSize(definition, slots, widgets.drawn);
      this.#sizes.set(node.id, size);
      const position = this.#options.positions?.get(node.id) ?? [0, y];
      y += size[1] + 40;
      written.push({
        id,
        type: node.classType,
        pos: [position[0], position[1]],
        size: [size[0], size[1]],
        flags: {},
        order,
        mode: node.mode === "mute" ? 2 : node.mode === "bypass" ? 4 : 0,
        inputs: slots,
        outputs: [],
        ...(node.title === undefined ? {} : { title: node.title }),
        properties: { "Node name for S&R": node.classType },
        ...(widgets.values.length === 0
          ? {}
          : { widgets_values: widgets.values, widgets_values_named: widgets.named }),
      });
    }
    // Outputs last, once every link into them is known.
    for (const [index, node] of nodes.entries()) {
      const id = this.#ids.get(node.id) ?? 0;
      const definition = this.#definition(node.classType);
      const linked = outputs.get(id) ?? new Map<number, number[]>();
      const count = Math.max(
        definition?.outputs.length ?? 0,
        ...[...linked.keys()].map((slot) => slot + 1),
      );
      const entry = written[index];
      if (entry === undefined) continue;
      written[index] = {
        ...entry,
        outputs: Array.from({ length: count }, (_, slot) => {
          const output = definition?.outputs[slot];
          const ids = linked.get(slot);
          return {
            name: output?.name ?? `output ${String(slot)}`,
            type: output === undefined ? "*" : outputType(output),
            links: ids ?? null,
            slot_index: slot,
          };
        }),
      };
    }
    const body: JsonObject = {
      last_node_id: largest(this.#ids.values()),
      last_link_id: links.length,
      nodes: written,
      links: links.map((link) => [
        link.id,
        link.origin,
        link.originSlot,
        link.target,
        link.targetSlot,
        link.type,
      ]),
      groups: [],
      config: {},
      extra: {},
      version: 0.4,
    };
    return {
      workflow: { id: uuid(stringify(body)), revision: 0, ...body },
      ids: this.#ids,
      diagnostics: this.#diagnostics,
    };
  }

  /** Integer ids stay; the others get the next free numbers, in graph order. */
  #assignIds(nodes: readonly GraphNode[]): void {
    const taken = new Set<number>();
    for (const node of nodes) {
      if (/^(?:0|[1-9][0-9]*)$/.test(node.id) && Number.isSafeInteger(Number(node.id))) {
        this.#ids.set(node.id, Number(node.id));
        taken.add(Number(node.id));
      }
    }
    let next = largest(taken) + 1;
    for (const node of nodes) {
      if (this.#ids.has(node.id)) continue;
      while (taken.has(next)) next++;
      this.#ids.set(node.id, next);
      taken.add(next++);
    }
  }

  /** A node's input slots, linked, and its widget values. */
  #layout(
    node: GraphNode,
    definition: NodeDef | undefined,
    inputs: JsonObject,
    links: Link[],
    outputs: Map<number, Map<number, number[]>>,
  ): {
    readonly slots: JsonObject[];
    /** Saved values, by position and by name, and how many widgets the frontend draws. */
    readonly widgets: {
      readonly values: JsonValue[];
      readonly named: JsonObject;
      readonly drawn: number;
    };
  } {
    const id = this.#ids.get(node.id) ?? 0;
    const slots: JsonObject[] = [];
    const link = (value: JsonValue, type: string): number | null => {
      if (!isLinkValue(value)) return null;
      const origin = this.#ids.get(value[0]);
      if (origin === undefined) return null;
      const linkId = links.length + 1;
      links.push({
        id: linkId,
        origin,
        originSlot: value[1],
        target: id,
        targetSlot: slots.length,
        type: this.#sourceType(value) ?? type,
      });
      const byOutput = outputs.get(origin) ?? new Map<number, number[]>();
      const ids = byOutput.get(value[1]);
      if (ids === undefined) byOutput.set(value[1], [linkId]);
      else ids.push(linkId);
      outputs.set(origin, byOutput);
      return linkId;
    };
    const values: JsonValue[] = [];
    const named: [string, JsonValue][] = [];
    const save = (key: string, value: JsonValue): void => {
      if (
        typeof value === "bigint" ||
        (typeof value === "number" && !Number.isSafeInteger(value) && Number.isInteger(value))
      ) {
        this.#diagnostics.push(
          createDiagnostic(
            "W_UNSAFE_INTEGER",
            [node.id, "inputs", key],
            `Input ${key} of node ${node.id} is ${String(value)}, beyond 2^53: the frontend's JSON parser will round it.`,
          ),
        );
      }
      values.push(value);
      named.push([key, value]);
    };
    if (definition === undefined) {
      this.#diagnostics.push(
        createDiagnostic(
          "W_UNKNOWN_UI_CLASS",
          [node.id],
          `Node ${node.id} has class ${node.classType}, which the schema doesn't have: its links and its values by name are written; the frontend shows it as missing.`,
        ),
      );
      // Every key by name, in order, a linked one as a null its link replaces: the importer
      // rebuilds the inputs in that order (the frontend restores no names, only positions).
      for (const [name, value] of Object.entries(inputs)) {
        if (isLinkValue(value)) {
          slots.push({ name, type: "*", link: link(value, "*") });
          named.push([name, null]);
        } else {
          save(name, unwrap(value));
        }
      }
      return { slots, widgets: { values, named: Object.fromEntries(named), drawn: values.length } };
    }
    const chosen = (key: string): JsonValue | undefined => {
      const value = inputs[key];
      return isLinkValue(value) ? undefined : value;
    };
    // Autogrow: the slots up to the last one given, and one more, as the frontend shows them.
    const autogrow = (key: string, input: Extract<InputDef, { kind: "autogrow" }>): number => {
      let last = -1;
      input.slots.forEach((slot, index) => {
        if (Object.hasOwn(inputs, `${key}.${slot}`)) last = index;
      });
      return Math.min(input.slots.length, Math.max(last + 2, input.min + 1, 1));
    };
    for (const slot of frontendSlots(definition, chosen, autogrow)) {
      const value = inputs[slot.name];
      slots.push({
        name: slot.name,
        type: slot.type,
        ...(slot.widget ? { widget: { name: slot.name } } : {}),
        link: value === undefined ? null : link(value, slot.type),
      });
    }
    // Links into inputs the definition doesn't declare (a pack's JavaScript adds them): extra
    // slots, typed as what feeds them, which the frontend keeps when it loads the node.
    const listed = new Set(slots.map((slot) => slot["name"]));
    for (const [name, value] of Object.entries(inputs)) {
      if (isLinkValue(value) && !listed.has(name)) {
        const type = this.#sourceType(value) ?? "*";
        slots.push({ name, type, link: link(value, type) });
      }
    }
    /** Wire keys the file carries: a linked slot, or a saved widget value. */
    const carried = new Set<string>();
    for (const slot of slots) {
      if (slot["link"] !== null && typeof slot["name"] === "string") carried.add(slot["name"]);
    }
    const all = frontendWidgets(definition, chosen);
    for (const widget of all) {
      if (!widget.persisted) continue;
      if (widget.key === undefined || widget.input === undefined) {
        // A control: fixed, so the frontend doesn't change the value after queueing.
        save(
          widget.name,
          widget.name === "upload"
            ? widget.initial
            : widget.name === "control_filter_list"
              ? ""
              : "fixed",
        );
        continue;
      }
      const given = inputs[widget.key];
      if (given !== undefined && !isLinkValue(given)) carried.add(widget.key);
      // A linked widget keeps a value under its link; the frontend's own initial one.
      save(
        widget.key,
        given === undefined || isLinkValue(given)
          ? fallback(widget.input, widget.initial)
          : unwrap(given),
      );
    }
    const prefix = inputs["filename_prefix"];
    if (SAVE_NODES.has(node.classType) && typeof prefix === "string" && replacesText(prefix)) {
      this.#diagnostics.push(
        createDiagnostic(
          "W_QUEUE_TIME_VALUE",
          [node.id, "inputs", "filename_prefix"],
          `Input filename_prefix of node ${node.id} holds %…%, which the frontend replaces (with the time, or another node's widget value) when it queues the prompt.`,
        ),
      );
    }
    for (const key of Object.keys(inputs)) {
      if (carried.has(key)) continue;
      this.#diagnostics.push(
        createDiagnostic(
          "W_UI_VALUE_LOST",
          [node.id, "inputs", key],
          `Input ${key} of node ${node.id} has nowhere to go in a UI workflow (a DynamicGroup row, or a widget the frontend doesn't save): the frontend will send its own value instead.`,
        ),
      );
    }
    return { slots, widgets: { values, named: Object.fromEntries(named), drawn: all.length } };
  }

  /** The declared type of the output a link comes from, when it has one. */
  #sourceType(value: readonly [NodeId, number]): string | undefined {
    const source = this.#workflow.graph.nodes.get(value[0]);
    const output =
      source === undefined ? undefined : this.#definition(source.classType)?.outputs[value[1]];
    return output === undefined || output.matchTemplate !== undefined || output.type.kind === "any"
      ? undefined
      : outputType(output);
  }

  #definition(classType: string): NodeDef | undefined {
    return Object.hasOwn(this.#workflow.schema.nodes, classType)
      ? this.#workflow.schema.nodes[classType]
      : undefined;
  }
}

/**
 * A node's size: a title, a row per socket or output (whichever there are more of) and per
 * widget, and a text box for each multiline string; rounded up to the frontend's 10 px grid.
 */
function nodeSize(
  definition: NodeDef | undefined,
  slots: readonly JsonObject[],
  widgets: number,
): readonly [number, number] {
  const sockets = slots.filter((slot) => slot["widget"] === undefined).length;
  const boxes = (definition?.inputs ?? []).filter(
    (input) => input.kind === "string" && input.multiline,
  ).length;
  const rows = Math.max(sockets, definition?.outputs.length ?? 0) + widgets + boxes * 4;
  return [definition === undefined ? 240 : 320, Math.ceil((46 + rows * 24) / 10) * 10];
}

/** The frontend's initial value for a widget without one of ours. */
function fallback(input: InputDef, initial: JsonValue): JsonValue {
  switch (input.kind) {
    case "int":
    case "float":
    case "string":
    case "boolean":
    case "combo":
    case "value":
      return initialValue(input);
    case "socket":
    case "matchType":
    case "dynamicCombo":
    case "autogrow":
    case "dynamicGroup":
    case "unknown":
      return initial;
  }
}

/** A wire value as a widget holds it: lists and CURVE values unwrapped. */
function unwrap(value: JsonValue): JsonValue {
  if (isJsonObject(value) && Object.hasOwn(value, "__value__")) return value["__value__"] ?? null;
  return value;
}

function outputType(output: OutputDef): string {
  const { type } = output;
  switch (type.kind) {
    case "combo":
      return "COMBO";
    case "any":
      return "*";
    case "named":
      return type.name;
    case "union":
      return type.names.join(",");
  }
}

function isLinkValue(value: JsonValue | undefined): value is readonly [NodeId, number] {
  return (
    Array.isArray(value) &&
    value.length === 2 &&
    typeof value[0] === "string" &&
    typeof value[1] === "number"
  );
}

/** The largest of some numbers, or 0; without spreading them into one call. */
function largest(numbers: Iterable<number>): number {
  let most = 0;
  for (const number of numbers) if (number > most) most = number;
  return most;
}

/** A version-4-shaped uuid from a hash of the content: the same workflow, the same id. */
function uuid(content: string): string {
  const hex = sha256Hex(utf8(content));
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-4${hex.slice(13, 16)}-${((Number.parseInt(hex.slice(16, 18), 16) & 0x3f) | 0x80).toString(16)}${hex.slice(18, 20)}-${hex.slice(20, 32)}`;
}
