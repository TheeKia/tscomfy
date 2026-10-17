// Bypass and mute (docs/plan.md §12), applied to an exported prompt as the frontend applies them
// when it builds one (ComfyUI_frontend 1.55.17 `ExecutableNodeDTO.ts`: `resolveInput`,
// `resolveOutput`, `_getBypassSlotIndex`; LiteGraph `isValidConnection`):
// - neither kind of node is sent;
// - a link from a muted node resolves to nothing, so the input is left out;
// - a link from a bypassed node is followed through one of its inputs, chosen by the output's
//   slot and the type the link must have, and resolved again from there; an input that isn't
//   linked resolves to nothing.
// The input slots are in the frontend's order: socket inputs first, then the sockets of widgets
// (`litegraphService.ts` `addInputs`), then the inputs of chosen dynamic-combo options.

import { createDiagnostic, type Diagnostic } from "../diagnostic/diagnostic.ts";
import type { NodeId, NodeMode } from "../graph/types.ts";
import type { JsonValue } from "../json/value.ts";
import type { InputDef, NodeDef, SocketType } from "../schema/types.ts";
import type { ApiNode } from "./prompt.ts";

/** One node of a prompt before modes apply: its wire inputs, definition and mode. */
export interface ModalNode {
  readonly id: NodeId;
  readonly node: ApiNode;
  readonly definition: NodeDef | undefined;
  readonly mode: NodeMode | undefined;
}

/** An input slot as the frontend lists it: the wire key, and the type the frontend gives it. */
interface Slot {
  readonly key: string;
  readonly type: string;
}

/**
 * The prompt with bypass and mute applied: bypassed and muted nodes left out, links through
 * them resolved, links that resolve to nothing left out with `W_LINK_DROPPED`.
 */
export function applyModes(
  nodes: readonly ModalNode[],
  diagnostics: Diagnostic[],
): [NodeId, ApiNode][] {
  const byId = new Map(nodes.map((node) => [node.id, node]));
  const slots = new Map<NodeId, readonly Slot[]>();
  const slotsOf = (node: ModalNode): readonly Slot[] => {
    let found = slots.get(node.id);
    if (found === undefined) {
      found = inputSlots(node);
      slots.set(node.id, found);
    }
    return found;
  };
  const entries: [NodeId, ApiNode][] = [];
  for (const node of nodes) {
    if (node.mode !== undefined) continue;
    const types = new Map(slotsOf(node).map((slot) => [slot.key, slot.type]));
    const inputs: [string, JsonValue][] = [];
    for (const [key, value] of Object.entries(node.node.inputs)) {
      if (!isLink(value)) {
        inputs.push([key, value]);
        continue;
      }
      const resolved = resolve(value, types.get(key) ?? "*", byId, slotsOf);
      if (typeof resolved === "string") {
        diagnostics.push(
          createDiagnostic(
            "W_LINK_DROPPED",
            [node.id, "inputs", key],
            `Input ${key} of node ${node.id} is left out: ${resolved}.`,
          ),
        );
      } else {
        inputs.push([key, resolved]);
      }
    }
    entries.push([node.id, { ...node.node, inputs: Object.fromEntries(inputs) }]);
  }
  return entries;
}

/**
 * Where a link ends up once bypassed nodes are followed (`resolveOutput`): a link to a node that
 * runs, or why there is none. `type` is the type the link must have: the consumer's input, then
 * at each bypassed node the input followed.
 */
function resolve(
  link: readonly [NodeId, number],
  type: string,
  nodes: ReadonlyMap<NodeId, ModalNode>,
  slotsOf: (node: ModalNode) => readonly Slot[],
): readonly [NodeId, number] | string {
  let current = link;
  let target = type;
  const seen = new Set<string>();
  for (;;) {
    const [id, slot] = current;
    const source = nodes.get(id);
    // A node the prompt doesn't have, or one that runs: the link stays, for validation to judge.
    if (source?.mode === undefined) return current;
    if (source.mode === "mute") return `it is linked to node ${id}, which is muted`;
    const step = `${id}:${String(slot)}:${target}`;
    if (seen.has(step)) return `the bypassed nodes it is linked through form a cycle at node ${id}`;
    seen.add(step);
    const inputs = slotsOf(source);
    const index = bypassSlot(inputs, outputType(source, slot), slot, target);
    const input = index === -1 ? undefined : inputs[index];
    if (input === undefined) {
      return `it is linked to bypassed node ${id}, which has no input for type ${target || "*"}`;
    }
    const value = source.node.inputs[input.key];
    if (value === undefined || !isLink(value)) {
      return `it is linked to bypassed node ${id}, whose input ${input.key} isn't linked`;
    }
    current = value;
    target = input.type;
  }
}

/**
 * The input of a bypassed node that output `slot` passes through (`_getBypassSlotIndex`):
 * 1. for a target typed `*` or untyped, the input at the same index, else the first;
 * 2. the input at the same index, if it is valid for both the output's type and the target's;
 * 3. the first input whose type is exactly the target's;
 * 4. the first input valid for both; else none (`-1`).
 */
export function bypassSlot(
  inputs: readonly { readonly type: string }[],
  output: string,
  slot: number,
  target: string,
): number {
  if (target === "*" || target === "") return inputs.length > slot ? slot : 0;
  const same = inputs[slot];
  if (
    same !== undefined &&
    validConnection(same.type, output) &&
    validConnection(same.type, target)
  ) {
    return slot;
  }
  const exact = inputs.findIndex((input) => input.type === target);
  if (exact !== -1) return exact;
  return inputs.findIndex(
    (input) => validConnection(input.type, output) && validConnection(input.type, target),
  );
}

/**
 * LiteGraph's `isValidConnection`: `*` and the empty type match anything; otherwise the types
 * match ignoring case, or, for comma lists, when any member of one matches any of the other.
 */
export function validConnection(a: string, b: string): boolean {
  if (a === "" || a === "*" || b === "" || b === "*" || a === b) return true;
  const x = a.toLowerCase();
  const y = b.toLowerCase();
  if (!x.includes(",") && !y.includes(",")) return x === y;
  return x.split(",").some((one) => y.split(",").some((other) => validConnection(one, other)));
}

/**
 * A node's input slots in the frontend's order (`addInputs`, `dynamicWidgets.ts`): sockets, then
 * widgets with a socket; a chosen dynamic-combo option's inputs (its sockets, then its widgets)
 * follow the combo's own slot. Autogrow contributes the slots the prompt gives (the frontend also
 * shows one empty slot, which a prompt can't record). A node of an unknown class lists its wire
 * keys, typed `*`.
 */
function inputSlots({ node, definition }: ModalNode): Slot[] {
  const wire = node.inputs;
  if (definition === undefined) return Object.keys(wire).map((key) => ({ key, type: "*" }));
  const visit = (inputs: readonly InputDef[], prefix: string): Slot[] => {
    const sockets: Slot[] = [];
    const widgets: Slot[] = [];
    for (const input of inputs) {
      const key = `${prefix}${input.name}`;
      switch (input.kind) {
        case "socket":
          sockets.push({ key, type: typeText(input.type) });
          break;
        case "matchType":
          sockets.push({ key, type: typeText(input.allowed) });
          break;
        case "unknown":
          sockets.push({ key, type: unknownType(input.spec) });
          break;
        case "autogrow": {
          const type = templateType(input.template);
          for (const slot of input.slots) {
            const slotKey = `${key}.${slot}`;
            if (Object.hasOwn(wire, slotKey)) sockets.push({ key: slotKey, type });
          }
          break;
        }
        case "int":
        case "float":
        case "string":
        case "boolean":
        case "combo":
        case "value":
          if (!input.socketless) widgets.push({ key, type: typeText(input.type) });
          break;
        case "dynamicCombo": {
          widgets.push({ key, type: "COMFY_DYNAMICCOMBO_V3" });
          const chosen = input.options.find((option) => option.key === wire[key]);
          if (chosen !== undefined) widgets.push(...visit(chosen.inputs, `${key}.`));
          break;
        }
        case "dynamicGroup":
          // The frontend has no DynamicGroup handler, so its fields get no slots.
          break;
      }
    }
    return [...sockets, ...widgets];
  };
  return visit(definition.inputs, "");
}

/** An output's type as the frontend shows it: `*` for MatchType (until linked), COMBO for lists. */
function outputType(source: ModalNode, slot: number): string {
  const output = source.definition?.outputs[slot];
  if (output === undefined || output.matchTemplate !== undefined) return "*";
  return output.type.kind === "combo" ? "COMBO" : typeText(output.type);
}

function templateType(template: InputDef): string {
  if (template.kind === "socket") return typeText(template.type);
  if (template.kind === "matchType") return typeText(template.allowed);
  return "*";
}

function typeText(type: SocketType): string {
  switch (type.kind) {
    case "any":
      return "*";
    case "named":
      return type.name;
    case "union":
      return type.names.join(",");
  }
}

function unknownType(spec: JsonValue): string {
  const head = Array.isArray(spec) ? (spec as readonly JsonValue[])[0] : undefined;
  return typeof head === "string" ? head : "*";
}

function isLink(value: JsonValue): value is readonly [NodeId, number] {
  return (
    Array.isArray(value) &&
    value.length === 2 &&
    typeof value[0] === "string" &&
    typeof value[1] === "number"
  );
}
