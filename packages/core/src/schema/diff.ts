import { stringify } from "../json/stringify.ts";
import type { ComboOption, InputDef, NodeDef, Schema } from "./types.ts";

/** How one input differs between two schemas. */
export interface InputChange {
  /** The input's name (a top-level input; nested changes count as `specChanged`). */
  readonly name: string;
  /** For combos on both sides: the options only one side has. Empty for other changes. */
  readonly optionsAdded: readonly ComboOption[];
  /** Options the old side has and the new one doesn't. */
  readonly optionsRemoved: readonly ComboOption[];
  /** Something besides the options changed: the kind, a bound, a default, nested inputs, …. */
  readonly specChanged: boolean;
}

/** How one node differs between two schemas. */
export interface NodeChange {
  readonly classType: string;
  /** Inputs only the new side has, in its order. */
  readonly inputsAdded: readonly string[];
  /** Inputs only the old side has, in its order. */
  readonly inputsRemoved: readonly string[];
  /** Inputs both sides have that differ, in the new side's order. */
  readonly inputsChanged: readonly InputChange[];
  /** Any output slot differs: its type, name, list flag, tooltip or template. */
  readonly outputsChanged: boolean;
  /** Display name, category, description, flags or input order. */
  readonly detailsChanged: boolean;
}

/** What changed from one schema to another, by class type in code-unit order. */
export interface SchemaDiff {
  /** Class types only the new schema has. */
  readonly added: readonly string[];
  /** Class types only the old schema has. */
  readonly removed: readonly string[];
  /** Nodes both have that differ. */
  readonly changed: readonly NodeChange[];
}

/**
 * The differences between two schemas (docs/plan.md §9 `check`): nodes added, removed and
 * changed, and per changed node its inputs, combo options and outputs. Empty when both hash
 * the same.
 */
export function diffSchemas(before: Schema, after: Schema): SchemaDiff {
  const classTypes = [
    ...new Set([...Object.keys(before.nodes), ...Object.keys(after.nodes)]),
  ].toSorted();
  const added: string[] = [];
  const removed: string[] = [];
  const changed: NodeChange[] = [];
  for (const classType of classTypes) {
    const old = Object.hasOwn(before.nodes, classType) ? before.nodes[classType] : undefined;
    const now = Object.hasOwn(after.nodes, classType) ? after.nodes[classType] : undefined;
    if (old === undefined && now !== undefined) added.push(classType);
    else if (old !== undefined && now === undefined) removed.push(classType);
    else if (old !== undefined && now !== undefined && stringify(old) !== stringify(now)) {
      changed.push(diffNode(old, now));
    }
  }
  return { added, removed, changed };
}

function diffNode(before: NodeDef, after: NodeDef): NodeChange {
  const oldInputs = new Map(before.inputs.map((input) => [input.name, input]));
  const newInputs = new Map(after.inputs.map((input) => [input.name, input]));
  const inputsChanged: InputChange[] = [];
  for (const [name, input] of newInputs) {
    const old = oldInputs.get(name);
    if (old !== undefined && stringify(old) !== stringify(input)) {
      inputsChanged.push(diffInput(old, input));
    }
  }
  const { inputs: oldList, outputs: oldOutputs, ...oldDetails } = before;
  const { inputs: newList, outputs: newOutputs, ...newDetails } = after;
  return {
    classType: after.classType,
    inputsAdded: [...newInputs.keys()].filter((name) => !oldInputs.has(name)),
    inputsRemoved: [...oldInputs.keys()].filter((name) => !newInputs.has(name)),
    inputsChanged,
    outputsChanged: stringify(oldOutputs) !== stringify(newOutputs),
    detailsChanged:
      stringify(oldDetails) !== stringify(newDetails) ||
      order(oldList.filter((input) => newInputs.has(input.name))) !==
        order(newList.filter((input) => oldInputs.has(input.name))),
  };
}

/** The input names in order, for telling a reordering apart. */
function order(inputs: readonly InputDef[]): string {
  return inputs.map((input) => input.name).join("\n");
}

function diffInput(before: InputDef, after: InputDef): InputChange {
  if (before.kind !== "combo" || after.kind !== "combo") {
    return { name: after.name, optionsAdded: [], optionsRemoved: [], specChanged: true };
  }
  const { options: oldOptions, ...oldRest } = before;
  const { options: newOptions, ...newRest } = after;
  return {
    name: after.name,
    optionsAdded: newOptions.filter((option) => !oldOptions.includes(option)),
    optionsRemoved: oldOptions.filter((option) => !newOptions.includes(option)),
    specChanged:
      stringify(oldRest) !== stringify(newRest) ||
      stringify(oldOptions.filter((option) => newOptions.includes(option))) !==
        stringify(newOptions.filter((option) => oldOptions.includes(option))),
  };
}
