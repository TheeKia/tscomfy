// Workflow → UI workflow (docs/plan.md §11): the JSON the ComfyUI frontend loads, so a workflow
// built in code can be opened, inspected and run there. Format 0.4 with tuple links, which is what
// the frontend writes; every slot listed in the frontend's order and every saved widget value
// written, so loading reproduces the prompt `toApi` builds.

import { exportApi } from "../api/export.ts";
import { isApiLink } from "../api/prompt.ts";
import { unwrapWire } from "../api/wire.ts";
import {
  createDiagnostic,
  type Diagnostic,
  type DiagnosticCode,
} from "../diagnostic/diagnostic.ts";
import {
  type FrontendWidget,
  frontendSlots,
  frontendWidgets,
  SCRIPTED_WIDGETS,
  uncreatable,
} from "../frontend/node.ts";
import { replacesText, SAVE_NODES } from "../frontend/text.ts";
import type { GraphNode, Workflow } from "../graph/graph.ts";
import type { NodeId } from "../graph/types.ts";
import { sha256Hex, utf8 } from "../hash/sha256.ts";
import { stringify } from "../json/stringify.ts";
import { isJsonArray, isJsonObject, type JsonObject, type JsonValue } from "../json/value.ts";
import { definitionOf } from "../schema/lookup.ts";
import { outputTypeText } from "../schema/type-text.ts";
import type { AutogrowInput, NodeDef, OutputDef } from "../schema/types.ts";
import { modeNumber, SEARCH_NAME_PROPERTY } from "./format.ts";

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
  /** What the format can't carry, so the frontend's prompt would differ (see {@link toUi}). */
  readonly diagnostics: readonly Diagnostic[];
}

/**
 * The workflow as a UI workflow the frontend loads, deterministic. Node ids that are integers stay;
 * others (`ckpt`, `40:31`) get the next free numbers, in graph order. Bypassed and muted nodes keep
 * their mode.
 *
 * Loading the file in the frontend queues what `toApi` builds, apart from what the format can't
 * carry, which is reported: `W_UI_VALUE_LOST` for a value with no widget to hold it (DynamicGroup
 * rows, widgets the frontend doesn't save or send) or a link to a node the workflow doesn't have,
 * `W_UNKNOWN_UI_CLASS` for a node of a class the schema doesn't have or the frontend can't create
 * (written with its links and its values by name), `W_EXTENSION_WIDGETS` for a node whose widgets
 * frontend JavaScript builds, `W_UNSAFE_INTEGER` for an integer the frontend's parser would round,
 * and `W_QUEUE_TIME_VALUE` for a file name the frontend rewrites when it queues (`%date:…%`,
 * `%Node.widget%`) or a value it computes then (a 3D scene, a webcam frame, a recording). Optional
 * widgets and dynamic combos left out are sent by the frontend with their initial values, as for a
 * node added by hand.
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

/** A node's saved widget values, by position and by name, and how many widgets it draws. */
interface SavedWidgets {
  readonly values: readonly JsonValue[];
  readonly named: JsonObject;
  readonly drawn: number;
}

class UiWriter {
  readonly #workflow: Workflow;
  readonly #options: ToUiOptions;
  readonly #diagnostics: Diagnostic[] = [];
  readonly #ids = new Map<NodeId, number>();
  readonly #sizes = new Map<NodeId, readonly [number, number]>();
  readonly #links: Link[] = [];
  /** Link ids by origin node and output slot. */
  readonly #outputs = new Map<number, Map<number, number[]>>();

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
    const written: JsonObject[] = [];
    let y = 0;
    for (const [order, node] of nodes.entries()) {
      const id = this.#id(node.id);
      const definition = definitionOf(this.#workflow.schema, node.classType);
      const inputs = wire[node.id]?.inputs ?? {};
      const reason = definition === undefined ? undefined : uncreatable(definition);
      const laidOut =
        definition === undefined || reason !== undefined
          ? this.#byName(node, inputs, reason)
          : this.#laidOut(node, definition, inputs);
      const size = nodeSize(definition, laidOut.slots, laidOut.widgets.drawn);
      this.#sizes.set(node.id, size);
      const position = this.#options.positions?.get(node.id) ?? [0, y];
      y += size[1] + 40;
      const { values, named } = laidOut.widgets;
      written.push({
        id,
        type: node.classType,
        pos: [position[0], position[1]],
        size: [size[0], size[1]],
        flags: {},
        order,
        mode: modeNumber(node.mode),
        inputs: laidOut.slots,
        outputs: [],
        ...(node.title === undefined ? {} : { title: node.title }),
        properties: { [SEARCH_NAME_PROPERTY]: node.classType },
        ...(values.length === 0 ? {} : { widgets_values: values, widgets_values_named: named }),
      });
    }
    // Outputs last, once every link into them is known.
    for (const [index, node] of nodes.entries()) {
      const entry = written[index];
      if (entry === undefined) continue;
      written[index] = { ...entry, outputs: this.#outputsOf(node) };
    }
    const body: JsonObject = {
      last_node_id: largest(this.#ids.values()),
      last_link_id: this.#links.length,
      nodes: written,
      links: this.#links.map((link) => [
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

  /**
   * A node of a class the frontend lays out: its slots, linked, then its saved widget values,
   * then what the file can't carry.
   */
  #laidOut(
    node: GraphNode,
    definition: NodeDef,
    inputs: JsonObject,
  ): { readonly slots: JsonObject[]; readonly widgets: SavedWidgets } {
    if (SCRIPTED_WIDGETS.has(node.classType)) {
      this.#report(
        "W_EXTENSION_WIDGETS",
        [node.id],
        `Node ${node.id} (${node.classType}) gets widgets from frontend JavaScript that the schema doesn't describe; only the ones it declares are written, so the frontend may send other values for them.`,
      );
    }
    const chosen = (key: string): JsonValue | undefined => {
      const value = Object.hasOwn(inputs, key) ? inputs[key] : undefined;
      return isApiLink(value) ? undefined : value;
    };
    const slots = this.#slots(node, definition, inputs, chosen);
    const widgets = frontendWidgets(definition, chosen);
    const saved = this.#savedWidgets(node, widgets, inputs);
    this.#lostInputs(node, inputs, slots, widgets);
    return { slots, widgets: saved };
  }

  /**
   * Every slot in the frontend's order with its link, the Autogrow slots up to the last one given
   * and one more, as the frontend shows them; then links into inputs the definition doesn't
   * declare (a pack's JavaScript adds them), as extra slots typed as what feeds them, which the
   * frontend keeps when it loads the node.
   */
  #slots(
    node: GraphNode,
    definition: NodeDef,
    inputs: JsonObject,
    chosen: (key: string) => JsonValue | undefined,
  ): JsonObject[] {
    const slots: JsonObject[] = [];
    const autogrow = (key: string, input: AutogrowInput): readonly string[] => {
      let last = -1;
      input.slots.forEach((slot, index) => {
        if (Object.hasOwn(inputs, `${key}.${slot}`)) last = index;
      });
      return input.slots.slice(0, Math.max(last + 2, input.min + 1, 1));
    };
    for (const slot of frontendSlots(definition, { chosen, autogrow })) {
      const value = Object.hasOwn(inputs, slot.name) ? inputs[slot.name] : undefined;
      slots.push({
        name: slot.name,
        type: slot.type,
        ...(slot.widget ? { widget: { name: slot.name } } : {}),
        link: this.#link(node, slot.name, value, slots.length, slot.type),
      });
    }
    const listed = new Set(slots.map((slot) => slot["name"]));
    for (const [name, value] of Object.entries(inputs)) {
      if (isApiLink(value) && !listed.has(name)) {
        const type = this.#sourceType(value) ?? "*";
        slots.push({ name, type, link: this.#link(node, name, value, slots.length, type) });
      }
    }
    return slots;
  }

  /**
   * The values the frontend saves, in widget order: each input's own (a linked widget keeps the
   * frontend's initial value under its link), controls `fixed`, so the frontend doesn't change a
   * value after queueing, a BOUNDING_BOX's fields from the box, the rest as created.
   */
  #savedWidgets(
    node: GraphNode,
    widgets: readonly FrontendWidget[],
    inputs: JsonObject,
  ): SavedWidgets {
    const values: JsonValue[] = [];
    const named: [string, JsonValue][] = [];
    let box: JsonValue | undefined;
    for (const widget of widgets) {
      if (!widget.saved) continue;
      let value: JsonValue;
      switch (widget.role) {
        case "value": {
          const given =
            widget.key !== undefined && Object.hasOwn(inputs, widget.key)
              ? inputs[widget.key]
              : undefined;
          value = given === undefined || isApiLink(given) ? widget.initial : unwrapWire(given);
          box = value;
          break;
        }
        case "control":
          value = "fixed";
          break;
        case "filter":
          value = "";
          break;
        case "part":
          value =
            widget.field !== undefined && isJsonObject(box)
              ? (box[widget.field] ?? widget.initial)
              : widget.initial;
          break;
      }
      if (hasUnsafeInteger(value)) {
        this.#report(
          "W_UNSAFE_INTEGER",
          [node.id, "inputs", widget.key ?? widget.name],
          `Widget ${widget.name} of node ${node.id} holds an integer beyond 2^53: the frontend's JSON parser will round it.`,
        );
      }
      values.push(value);
      named.push([widget.name, value]);
    }
    return { values, named: Object.fromEntries(named), drawn: widgets.length };
  }

  /**
   * Reports the wire keys the frontend won't send as given: no linked slot or sent widget carries
   * them (a DynamicGroup row, a widget the frontend doesn't save or send, one it sends under
   * another name), its widget's value is computed when the frontend queues, or the file name has
   * `%…%` patterns the frontend replaces.
   */
  #lostInputs(
    node: GraphNode,
    inputs: JsonObject,
    slots: readonly JsonObject[],
    widgets: readonly FrontendWidget[],
  ): void {
    const carried = new Set<string>();
    for (const slot of slots) {
      if (slot["link"] !== null && typeof slot["name"] === "string") carried.add(slot["name"]);
    }
    const computed = new Set<string>();
    for (const widget of widgets) {
      if (widget.key === undefined || !widget.saved) continue;
      if (widget.sent === "queue") computed.add(widget.key);
      if (widget.sent === "value" && widget.name === widget.key) carried.add(widget.key);
    }
    const prefix = inputs["filename_prefix"];
    if (SAVE_NODES.has(node.classType) && typeof prefix === "string" && replacesText(prefix)) {
      this.#report(
        "W_QUEUE_TIME_VALUE",
        [node.id, "inputs", "filename_prefix"],
        `Input filename_prefix of node ${node.id} holds %…%, which the frontend replaces (with the time, or another node's widget value) when it queues the prompt.`,
      );
    }
    for (const [key, value] of Object.entries(inputs)) {
      if (carried.has(key) || isApiLink(value)) continue;
      if (computed.has(key)) {
        this.#report(
          "W_QUEUE_TIME_VALUE",
          [node.id, "inputs", key],
          `Input ${key} of node ${node.id} is a widget whose value the frontend computes when it queues the prompt (a 3D scene, a webcam frame, a recording); the value given isn't sent.`,
        );
        continue;
      }
      this.#report(
        "W_UI_VALUE_LOST",
        [node.id, "inputs", key],
        `Input ${key} of node ${node.id} has nowhere to go in a UI workflow (a DynamicGroup row, or a widget the frontend doesn't save, doesn't send or sends under another name): the frontend will send its own value instead.`,
      );
    }
  }

  /**
   * A node the frontend can't lay out: of a class the schema doesn't have, or one it can't
   * create. Every key by name, in order, a linked one as a null its link replaces: the importer
   * rebuilds the inputs in that order (the frontend restores no names, only positions).
   */
  #byName(
    node: GraphNode,
    inputs: JsonObject,
    reason: string | undefined,
  ): { readonly slots: JsonObject[]; readonly widgets: SavedWidgets } {
    this.#report(
      "W_UNKNOWN_UI_CLASS",
      [node.id],
      reason === undefined
        ? `Node ${node.id} has class ${node.classType}, which the schema doesn't have: its links and its values by name are written; the frontend shows it as missing.`
        : `Node ${node.id} has class ${node.classType}, which the frontend can't create: ${reason}. Its links and its values by name are written; the frontend shows it as missing.`,
    );
    const slots: JsonObject[] = [];
    const values: JsonValue[] = [];
    const named: [string, JsonValue][] = [];
    for (const [name, value] of Object.entries(inputs)) {
      if (isApiLink(value)) {
        slots.push({ name, type: "*", link: this.#link(node, name, value, slots.length, "*") });
        named.push([name, null]);
        continue;
      }
      const unwrapped = unwrapWire(value);
      if (hasUnsafeInteger(unwrapped)) {
        this.#report(
          "W_UNSAFE_INTEGER",
          [node.id, "inputs", name],
          `Input ${name} of node ${node.id} holds an integer beyond 2^53: the frontend's JSON parser will round it.`,
        );
      }
      values.push(unwrapped);
      named.push([name, unwrapped]);
    }
    return {
      slots,
      widgets: { values, named: Object.fromEntries(named), drawn: values.length },
    };
  }

  /**
   * Writes a link into slot `targetSlot` of `node`, if `value` links a node of the workflow. A
   * link to a node the workflow doesn't have (from an imported prompt) has nothing to point at:
   * reported, since `toApi` sends it and the frontend won't.
   */
  #link(
    node: GraphNode,
    key: string,
    value: JsonValue | undefined,
    targetSlot: number,
    type: string,
  ): number | null {
    if (!isApiLink(value)) return null;
    const origin = this.#ids.get(value[0]);
    if (origin === undefined) {
      this.#report(
        "W_UI_VALUE_LOST",
        [node.id, "inputs", key],
        `Input ${key} of node ${node.id} links node ${value[0]}, which isn't in the workflow: a UI workflow can't hold the link, so the frontend won't send it.`,
      );
      return null;
    }
    const id = this.#links.length + 1;
    this.#links.push({
      id,
      origin,
      originSlot: value[1],
      target: this.#id(node.id),
      targetSlot,
      type: this.#sourceType(value) ?? type,
    });
    const byOutput = this.#outputs.get(origin) ?? new Map<number, number[]>();
    const ids = byOutput.get(value[1]);
    if (ids === undefined) byOutput.set(value[1], [id]);
    else ids.push(id);
    this.#outputs.set(origin, byOutput);
    return id;
  }

  /** A node's outputs: those its definition declares, and any a link uses beyond them. */
  #outputsOf(node: GraphNode): JsonObject[] {
    const definition = definitionOf(this.#workflow.schema, node.classType);
    const linked = this.#outputs.get(this.#id(node.id)) ?? new Map<number, number[]>();
    let count = definition?.outputs.length ?? 0;
    for (const slot of linked.keys()) count = Math.max(count, slot + 1);
    return Array.from({ length: count }, (_, slot) => {
      const output = definition?.outputs[slot];
      return {
        name: output?.name ?? `output ${String(slot)}`,
        type: output === undefined ? "*" : outputTypeText(output.type),
        links: linked.get(slot) ?? null,
        slot_index: slot,
      };
    });
  }

  /** The declared type of the output a link comes from, when it has one. */
  #sourceType(value: readonly [NodeId, number]): string | undefined {
    const source = this.#workflow.graph.nodes.get(value[0]);
    const output: OutputDef | undefined =
      source === undefined
        ? undefined
        : definitionOf(this.#workflow.schema, source.classType)?.outputs[value[1]];
    return output === undefined || output.matchTemplate !== undefined || output.type.kind === "any"
      ? undefined
      : outputTypeText(output.type);
  }

  #id(node: NodeId): number {
    return this.#ids.get(node) ?? 0;
  }

  #report(code: DiagnosticCode, path: readonly (string | number)[], message: string): void {
    this.#diagnostics.push(createDiagnostic(code, path, message));
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

/**
 * Whether a value holds an integer the frontend's `JSON.parse` rounds: a bigint, which tscomfy
 * uses for integers outside ±(2^53 − 1). A `number`, even a large one, round-trips exactly.
 */
function hasUnsafeInteger(value: JsonValue): boolean {
  if (typeof value === "bigint") return value > MAX_SAFE || value < -MAX_SAFE;
  if (isJsonArray(value)) return value.some(hasUnsafeInteger);
  if (isJsonObject(value)) return Object.values(value).some(hasUnsafeInteger);
  return false;
}

const MAX_SAFE = BigInt(Number.MAX_SAFE_INTEGER);

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
