// Bypass and mute (docs/plan.md §12), applied to an exported prompt as the frontend applies them
// when it builds one (ComfyUI_frontend 1.55.17 `ExecutableNodeDTO.ts`: `resolveInput`,
// `resolveOutput`, `_getBypassSlotIndex`; `executionUtil.ts` `graphToPrompt`; LiteGraph
// `isValidConnection`; read in the bundle the server ships):
// - neither kind of node is sent;
// - a link from a muted node resolves to nothing;
// - a link from a bypassed node is followed through one of its inputs, chosen by the output's
//   slot and the type the link must have, and resolved again from there; an input that isn't
//   linked resolves to nothing;
// - an input whose link resolves to nothing is left out, unless it is a widget: the frontend
//   writes widget values first and a link only replaces one, so the widget's value is sent.
//
// Slots are those of a node as the frontend creates it (`frontend/node.ts`), with MatchType types
// narrowed by the node's links as the frontend narrows them once a graph is loaded.

import { createDiagnostic, type Diagnostic } from "../diagnostic/diagnostic.ts";
import { bypassSlot, commonType } from "../frontend/links.ts";
import { type FrontendSlot, frontendSlots } from "../frontend/node.ts";
import type { NodeId, NodeMode } from "../graph/types.ts";
import type { JsonValue } from "../json/value.ts";
import { outputTypeText, typeText } from "../schema/type-text.ts";
import type { NodeDef } from "../schema/types.ts";
import { type ApiNode, isApiLink } from "./prompt.ts";
import { defaultWire } from "./wire.ts";

/** One node of a prompt before modes apply: its wire inputs, definition and mode. */
export interface ModalNode {
  readonly id: NodeId;
  readonly node: ApiNode;
  readonly definition: NodeDef | undefined;
  readonly mode: NodeMode | undefined;
}

/** An input slot as the frontend lists it. */
interface Slot {
  readonly key: string;
  /** The type the frontend gives it, before MatchType narrowing. */
  readonly type: string;
  /** The MatchType template it belongs to, whose links narrow its type. */
  readonly template?: string;
  /** The allowed types of that template. */
  readonly allowed?: string;
  /** For a widget: what the frontend sends when no link replaces its value. */
  readonly widget?: { readonly value: JsonValue | undefined };
}

/** A node's slots and types, as the frontend has them after loading. */
interface Shape {
  readonly slots: readonly Slot[];
  /** Input types by wire key, MatchType narrowed. */
  readonly types: ReadonlyMap<string, string>;
  /** Output types by slot, MatchType narrowed. */
  readonly outputs: readonly string[];
}

/**
 * The prompt with bypass and mute applied: bypassed and muted nodes left out, links through
 * them resolved, and `W_LINK_DROPPED` for every link that resolves to nothing.
 */
export function applyModes(
  nodes: readonly ModalNode[],
  diagnostics: Diagnostic[],
): [NodeId, ApiNode][] {
  const resolver = new Resolver(nodes);
  const entries: [NodeId, ApiNode][] = [];
  for (const node of nodes) {
    if (node.mode !== undefined) continue;
    const shape = resolver.shape(node);
    const widgets = new Map(
      shape.slots.flatMap((slot): [string, Slot["widget"]][] =>
        slot.widget === undefined ? [] : [[slot.key, slot.widget]],
      ),
    );
    const inputs: [string, JsonValue][] = [];
    for (const [key, value] of Object.entries(node.node.inputs)) {
      if (!isApiLink(value)) {
        inputs.push([key, value]);
        continue;
      }
      const resolved = resolver.resolve(value, shape.types.get(key) ?? "*");
      if (typeof resolved !== "string") {
        inputs.push([key, resolved]);
        continue;
      }
      const fallback = widgets.get(key)?.value;
      diagnostics.push(
        createDiagnostic(
          "W_LINK_DROPPED",
          [node.id, "inputs", key],
          fallback === undefined
            ? `Input ${key} of node ${node.id} is left out: ${resolved}.`
            : `Input ${key} of node ${node.id} sends its widget's value instead: ${resolved}.`,
        ),
      );
      if (fallback !== undefined) inputs.push([key, fallback]);
    }
    entries.push([node.id, { ...node.node, inputs: Object.fromEntries(inputs) }]);
  }
  return entries;
}

/** Follows links through bypassed and muted nodes, remembering every step it resolves. */
class Resolver {
  readonly #nodes: ReadonlyMap<NodeId, ModalNode>;
  readonly #shapes = new Map<NodeId, Shape>();
  /** Resolved steps by node, slot and type: chains of bypassed nodes are followed once. */
  readonly #resolved = new Map<string, readonly [NodeId, number] | string>();

  constructor(nodes: readonly ModalNode[]) {
    this.#nodes = new Map(nodes.map((node) => [node.id, node]));
  }

  /**
   * A node's slots and types. MatchType types depend on the outputs linked in, so those
   * sources are shaped first, iteratively, as chains can be long; a cycle reads as `*`.
   */
  shape(start: ModalNode): Shape {
    const pending: ModalNode[] = [start];
    const opened = new Set<NodeId>();
    for (let node = pending.at(-1); node !== undefined; node = pending.at(-1)) {
      if (this.#shapes.has(node.id)) {
        pending.pop();
        continue;
      }
      const slots = inputSlots(node);
      if (!opened.has(node.id)) {
        opened.add(node.id);
        const sources = slots.flatMap((slot) => {
          const value = node.node.inputs[slot.key];
          if (slot.template === undefined || value === undefined || !isApiLink(value)) return [];
          const source = this.#nodes.get(value[0]);
          return source === undefined || this.#shapes.has(source.id) || opened.has(source.id)
            ? []
            : [source];
        });
        if (sources.length > 0) {
          pending.push(...sources);
          continue;
        }
      }
      pending.pop();
      this.#shapes.set(node.id, this.#narrow(node, slots));
    }
    return this.#shapes.get(start.id) ?? { slots: [], types: new Map(), outputs: [] };
  }

  /**
   * Where a link ends up once bypassed nodes are followed (`resolveOutput`): a link to a node
   * that runs, or why there is none. `type` is the type the link must have: the consumer's input,
   * then at each bypassed node the input passed through (`resolveInput` passes no type on).
   */
  resolve(link: readonly [NodeId, number], type: string): readonly [NodeId, number] | string {
    const steps: string[] = [];
    const seen = new Set<string>();
    let current = link;
    let target = type;
    let result: readonly [NodeId, number] | string;
    for (;;) {
      const [id, slot] = current;
      const step = `${id}\u0000${String(slot)}\u0000${target}`;
      const known = this.#resolved.get(step);
      if (known !== undefined) {
        result = known;
        break;
      }
      const source = this.#nodes.get(id);
      // A node the prompt doesn't have, one that runs, or an output the node doesn't have
      // (where the frontend throws): the link stays, for validation to judge.
      if (source?.mode === undefined || !hasOutput(source, slot)) {
        result = current;
        break;
      }
      if (source.mode === "mute") {
        result = `it is linked to node ${id}, which is muted`;
        break;
      }
      // The frontend throws on this (and on any second visit of an output).
      if (seen.has(step)) {
        result = `the bypassed nodes it is linked through form a cycle at node ${id}`;
        break;
      }
      seen.add(step);
      steps.push(step);
      const shape = this.shape(source);
      const index = bypassSlot(shape.slots, shape.outputs[slot] ?? "*", slot, target);
      const input = index === -1 ? undefined : shape.slots[index];
      if (input === undefined) {
        // With no input at all, the frontend throws instead of building the prompt.
        result = `it is linked to bypassed node ${id}, which has no input for type ${target || "*"}`;
        break;
      }
      const value = source.node.inputs[input.key];
      if (value === undefined || !isApiLink(value)) {
        result = `it is linked to bypassed node ${id}, whose input ${input.key} isn't linked`;
        break;
      }
      current = value;
      target = shape.types.get(input.key) ?? input.type;
    }
    for (const step of steps) this.#resolved.set(step, result);
    return result;
  }

  /**
   * MatchType narrowing (`withComfyMatchType`): each input of a template takes the common type
   * of the other inputs' links and the allowed types, and the template's outputs the common type
   * of all its links. Unlinked inputs count as `*`.
   */
  #narrow(node: ModalNode, slots: readonly Slot[]): Shape {
    const types = new Map(slots.map((slot) => [slot.key, slot.type]));
    const definitions = node.definition?.outputs ?? [];
    const outputs = definitions.map((output) =>
      output.matchTemplate === undefined ? outputTypeText(output.type) : "*",
    );
    const templates = new Map<string, Slot[]>();
    for (const slot of slots) {
      if (slot.template === undefined) continue;
      const members = templates.get(slot.template);
      if (members === undefined) templates.set(slot.template, [slot]);
      else members.push(slot);
    }
    for (const [template, members] of templates) {
      const linked = members.map((slot) => {
        const value = node.node.inputs[slot.key];
        if (value === undefined || !isApiLink(value)) return "*";
        return this.#shapes.get(value[0])?.outputs[value[1]] ?? "*";
      });
      members.forEach((slot, index) => {
        const others = linked.filter((_, other) => other !== index);
        const narrowed = commonType([...others, slot.allowed ?? "*"]);
        // The frontend refuses a link that would leave no common type; the type stays.
        if (narrowed !== undefined) types.set(slot.key, narrowed);
      });
      const common = commonType(linked);
      if (common === undefined) continue;
      definitions.forEach((output, index) => {
        if (output.matchTemplate === template) outputs[index] = common;
      });
    }
    return { slots, types, outputs };
  }
}

/**
 * A node's input slots in the order the frontend creates them (`frontend/node.ts`), with what
 * bypass needs: MatchType templates, and for a widget's slot what the exporter sends when no link
 * replaces its value. Where the frontend's slots depend on more than a prompt records: an Autogrow
 * lists the slots the prompt gives (the frontend adds one empty slot more, and keeps saved slots
 * in the order a workflow file lists them); a dynamic combo the prompt leaves out lists no option
 * slots (the frontend lists its first option's, which no link of the prompt targets); a node
 * created anew lists a dynamic combo's first option inputs before the combo's own slot;
 * DynamicGroup fields have no slots (no frontend handler). A node of an unknown class lists its
 * wire keys, typed `*`.
 */
function inputSlots({ node, definition }: ModalNode): Slot[] {
  const wire = node.inputs;
  if (definition === undefined) return Object.keys(wire).map((key) => ({ key, type: "*" }));
  const slots = frontendSlots(definition, {
    chosen: (key) => wire[key],
    autogrow: (key, input) => input.slots.filter((slot) => Object.hasOwn(wire, `${key}.${slot}`)),
    unset: "none",
  });
  return slots.map(toSlot);
}

/** A slot with what bypass needs: its MatchType template, and a widget's fallback value. */
function toSlot({ name, type, input, widget }: FrontendSlot): Slot {
  const template =
    input?.kind === "matchType"
      ? { template: input.templateId, allowed: typeText(input.allowed) }
      : {};
  const fallback = widget
    ? { widget: { value: input === undefined ? undefined : defaultWire(input) } }
    : {};
  return { key: name, type, ...template, ...fallback };
}

function hasOutput(source: ModalNode, slot: number): boolean {
  return source.definition === undefined || source.definition.outputs[slot] !== undefined;
}
