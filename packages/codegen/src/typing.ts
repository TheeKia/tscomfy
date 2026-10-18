// Whether the generated types can express a node (docs/plan.md §10), decided by the rules
// `emit-types.ts` types inputs with (§6.2, §6.3): link atoms per output, legacy combos taking `*`,
// socketless widgets, MatchType's inferring position and parameter defaults, Autogrow and
// DynamicGroup bounds, and the forced row field.

import {
  type GraphNode,
  type InputDef,
  type InputValue,
  isOutputRef,
  type NodeDef,
  type NodeId,
  type OutputDef,
  type SocketType,
  sendsInputValue,
  type Workflow,
} from "@tscomfy/core";
import { forcedRowField, isObjectMember, isRequired } from "./rules.ts";
import { isList, isPlainObject } from "./values.ts";

/** How a node is written: `typed` as `n.Class(…)`, `raw` as `raw(…)` with its wire keys. */
export type WriteMode = "typed" | "raw";

/**
 * Whether the generated types can express a node's inputs, by the rules `emit-types.ts` types
 * them with. Returns why not, or `undefined`.
 */
export class Typing {
  readonly #workflow: Workflow;
  /** How each node is written: `undefined` while undecided, or for a node left out. */
  readonly #mode: (id: NodeId) => WriteMode | undefined;
  /** Resolved MatchType parameters by node and template. */
  readonly #parameters = new Map<string, Atom>();

  constructor(workflow: Workflow, mode: (id: NodeId) => WriteMode | undefined) {
    this.#workflow = workflow;
    this.#mode = mode;
  }

  /**
   * Why the types can't express a node, or `undefined` when they can. Nodes are asked in
   * dependency order, so their sources are decided; a typed node's MatchType parameters are then
   * resolved at once, so later nodes look them up rather than recurse through long chains.
   */
  problem(node: GraphNode, definition: NodeDef): string | undefined {
    const scope: Scope = { node, definition };
    const problem = this.#inputs(scope, definition.inputs, node.inputs, undefined, node.classType);
    if (problem === undefined) {
      for (const output of definition.outputs) {
        if (output.matchTemplate !== undefined) {
          this.#parameter(node, definition, output.matchTemplate);
        }
      }
    }
    return problem;
  }

  /**
   * An inputs interface: no unknown keys, every required member, every value fitting. `forced`
   * is a DynamicGroup row's extra required field.
   */
  #inputs(
    scope: Scope,
    definitions: readonly InputDef[],
    values: { readonly [name: string]: InputValue },
    forced: InputDef | undefined,
    where: string,
  ): string | undefined {
    const members = definitions.filter(sendsInputValue);
    const names = new Set(members.map((input) => input.name));
    const excess = Object.keys(values).find((key) => !names.has(key));
    if (excess !== undefined) return `${where} has no input ${excess}`;
    for (const input of members) {
      const value = Object.hasOwn(values, input.name) ? values[input.name] : undefined;
      if (value === undefined) {
        if (isRequired(input) || input === forced) return `${where} needs ${input.name}`;
        continue;
      }
      const problem = this.#input(scope, input, value, `${where} › ${input.name}`);
      if (problem !== undefined) return problem;
    }
    return undefined;
  }

  /** One input's value; `slot` is the index within an Autogrow, for its template. */
  #input(
    scope: Scope,
    input: InputDef,
    value: InputValue,
    where: string,
    slot?: number,
  ): string | undefined {
    switch (input.kind) {
      case "unknown":
        return undefined;
      case "socket":
        return this.#link(value, linkAccepts(input.type), where);
      case "int":
        return typeof value === "number" || typeof value === "bigint"
          ? undefined
          : this.#widgetLink(input.type, input.socketless, value, where, "an integer");
      case "float":
        return typeof value === "number"
          ? undefined
          : this.#widgetLink(input.type, input.socketless, value, where, "a number");
      case "string":
        return typeof value === "string"
          ? undefined
          : this.#widgetLink(input.type, input.socketless, value, where, "a string");
      case "boolean":
        return typeof value === "boolean"
          ? undefined
          : this.#widgetLink(input.type, input.socketless, value, where, "a boolean");
      case "value":
        return isOutputRef(value)
          ? this.#widgetLink(input.type, input.socketless, value, where, "JSON")
          : undefined;
      case "combo":
        return this.#combo(input, value, where);
      case "matchType":
        return this.#match(scope, input, slot, value, where);
      case "autogrow":
        return this.#autogrow(scope, input, value, where);
      case "dynamicCombo": {
        if (typeof value === "string") {
          const option = input.options.find((each) => each.key === value);
          if (option === undefined) return `${where} has no option ${value}`;
          // An option whose inputs may all be left out can be given by its key alone.
          return option.inputs.every((child) => !isRequired(child))
            ? undefined
            : `${where} option ${value} needs its inputs`;
        }
        if (!isPlainObject(value) || typeof value["option"] !== "string") {
          return `${where} takes an option`;
        }
        const option = input.options.find((each) => each.key === value["option"]);
        if (option === undefined || option.inputs.length === 0) {
          return `${where} has no option ${value["option"]} with inputs`;
        }
        if (Object.keys(value).some((key) => key !== "option" && key !== "inputs")) {
          return `${where} has keys besides option and inputs`;
        }
        const children = value["inputs"] ?? {};
        if (!isPlainObject(children)) return `${where} inputs aren't an object`;
        return this.#inputs(scope, option.inputs, children, undefined, where);
      }
      case "dynamicGroup": {
        if (!isList(value)) return `${where} takes a list of rows`;
        if (value.length < input.min || value.length > input.max) {
          return `${where} has ${String(value.length)} rows, outside ${String(input.min)} to ${String(input.max)}`;
        }
        const forced = forcedRowField(input.fields);
        for (const row of value) {
          if (!isPlainObject(row)) return `${where} rows are objects`;
          const problem = this.#inputs(scope, input.fields, row, forced, where);
          if (problem !== undefined) return problem;
        }
        return undefined;
      }
    }
  }

  #widgetLink(
    type: SocketType,
    socketless: boolean,
    value: InputValue,
    where: string,
    expected: string,
  ): string | undefined {
    if (!isOutputRef(value)) return `${where} takes ${expected}`;
    if (socketless) return `${where} has no socket`;
    return this.#link(value, linkAccepts(type), where);
  }

  #link(value: InputValue, accepts: (atom: Atom) => boolean, where: string): string | undefined {
    if (!isOutputRef(value)) return `${where} takes a link`;
    const atom = this.#atom(value.node, value.slot);
    if (atom === undefined) return `${where} links to an output that doesn't exist`;
    return accepts(atom) ? undefined : `${where} can't take ${describe(atom)}`;
  }

  #combo(
    input: Extract<InputDef, { kind: "combo" }>,
    value: InputValue,
    where: string,
  ): string | undefined {
    if (isOutputRef(value)) {
      if (input.socketless) return `${where} has no socket`;
      // A legacy combo takes `*` links only (§5.2); the COMBO form takes its type or option lists.
      return input.form === "legacy"
        ? this.#link(value, (atom) => atom.kind === "star", where)
        : this.#link(value, linkAccepts(input.type), where);
    }
    const open = input.upload || input.remote;
    const fits = (option: InputValue): boolean =>
      input.options.length === 0
        ? typeof option === "string"
        : (open && typeof option === "string") || input.options.some((each) => each === option);
    if (input.multiselect) {
      return isList(value) && value.every(fits)
        ? undefined
        : `${where} takes a list of its options`;
    }
    return fits(value) ? undefined : `${where} isn't one of its options`;
  }

  #autogrow(
    scope: Scope,
    input: Extract<InputDef, { kind: "autogrow" }>,
    value: InputValue,
    where: string,
  ): string | undefined {
    const required = input.template.required ? Math.min(input.min, input.slots.length) : 0;
    if (input.form === "prefix") {
      if (!isList(value)) return `${where} takes a list`;
      const items = value;
      if (items.length < required || items.length > input.slots.length) {
        return `${where} has ${String(items.length)} slots, outside ${String(required)} to ${String(input.slots.length)}`;
      }
      for (const [index, item] of items.entries()) {
        const problem = this.#input(scope, input.template, item, where, index);
        if (problem !== undefined) return problem;
      }
      return undefined;
    }
    if (!isPlainObject(value)) return `${where} takes slots by name`;
    const excess = Object.keys(value).find((key) => !input.slots.includes(key));
    if (excess !== undefined) return `${where} has no slot ${excess}`;
    for (const [index, slot] of input.slots.entries()) {
      const item = Object.hasOwn(value, slot) ? value[slot] : undefined;
      if (item === undefined) {
        if (index < required || isObjectMember(slot)) return `${where} needs ${slot}`;
        continue;
      }
      const problem = this.#input(scope, input.template, item, where, index);
      if (problem !== undefined) return problem;
    }
    return undefined;
  }

  /**
   * A MatchType position. The template's inferring position (the first one typed, §6.3) takes
   * `Out<T | "*">` with `T` within its allowed types; the others `Match<NoInfer<T>>`.
   */
  #match(
    scope: Scope,
    input: Extract<InputDef, { kind: "matchType" }>,
    slot: number | undefined,
    value: InputValue,
    where: string,
  ): string | undefined {
    const { templateId } = input;
    const position = inferringPosition(scope.definition, templateId);
    if (position?.input === input && (slot === undefined || slot === 0)) {
      const constraint = allowedAtom(input.allowed);
      return this.#link(value, (atom) => atom.kind === "star" || within(atom, constraint), where);
    }
    const parameter = this.#parameter(scope.node, scope.definition, templateId);
    return this.#link(value, (atom) => matchAccepts(parameter, atom), where);
  }

  /**
   * What a link from (`node`, `slot`) is typed as in builder code (emit-types `#outputAtom`):
   * `undefined` when the node or slot doesn't exist. A raw node's outputs are `Out<"*">`.
   */
  #atom(id: NodeId, slot: number): Atom | undefined {
    const node = this.#workflow.graph.nodes.get(id);
    const mode = this.#mode(id);
    if (node === undefined || mode === undefined) return undefined;
    const definition = Object.hasOwn(this.#workflow.schema.nodes, node.classType)
      ? this.#workflow.schema.nodes[node.classType]
      : undefined;
    // Whatever is written as raw(…), known class or not, has `Out<"*">` outputs.
    if (mode === "raw" || definition === undefined) return STAR;
    const output = definition.outputs[slot];
    if (output === undefined) return undefined;
    return outputAtom(output, (template) => this.#parameter(node, definition, template));
  }

  /**
   * A typed node's MatchType parameter: what its inferring position is linked to, or the
   * parameter's default (`"*"`, or the allowed types) when that position is empty or `*`.
   */
  #parameter(node: GraphNode, definition: NodeDef, templateId: string): Atom {
    const key = `${node.id}\u0000${templateId}`;
    const cached = this.#parameters.get(key);
    if (cached !== undefined) return cached;
    // Guard against cycles while resolving: they can't be written anyway.
    this.#parameters.set(key, STAR);
    const position = inferringPosition(definition, templateId);
    const fallback = position === undefined ? STAR : allowedDefault(position.allowed);
    const value = position === undefined ? undefined : position.read(node.inputs);
    const linked =
      value !== undefined && isOutputRef(value) ? this.#atom(value.node, value.slot) : undefined;
    const resolved = linked === undefined || linked.kind === "star" ? fallback : linked;
    this.#parameters.set(key, resolved);
    return resolved;
  }
}

/** The node being checked. */
interface Scope {
  readonly node: GraphNode;
  readonly definition: NodeDef;
}

/**
 * What an output reference is typed as: `Out<"*">` (fits every input), `Out<string>` (fits
 * only `*` inputs), `Out<OptionList>`, or `Out<"A" | "B">`.
 */
type Atom =
  | { readonly kind: "star" }
  | { readonly kind: "string" }
  | { readonly kind: "optionList" }
  | { readonly kind: "names"; readonly names: readonly string[] };

const STAR: Atom = { kind: "star" };
const STRING: Atom = { kind: "string" };

function outputAtom(output: OutputDef, parameter: (template: string) => Atom): Atom {
  if (output.matchTemplate !== undefined) return parameter(output.matchTemplate);
  const { type } = output;
  switch (type.kind) {
    case "combo":
      return { kind: "optionList" };
    case "any":
      return STAR;
    case "named":
      return type.name === "*" ? STRING : { kind: "names", names: [type.name] };
    case "union":
      return { kind: "names", names: type.names.filter((name) => name !== "*") };
  }
}

/** emit-types `#link`: what a socket of `type` takes. */
function linkAccepts(type: SocketType): (atom: Atom) => boolean {
  switch (type.kind) {
    case "any":
      return () => true;
    case "named":
      return (atom) =>
        atom.kind === "star" ||
        (atom.kind === "names" && atom.names.every((name) => name === type.name)) ||
        (atom.kind === "optionList" && type.name === "COMBO");
    case "union": {
      const names = new Set(type.names.filter((name) => name !== "*"));
      return (atom) =>
        atom.kind === "star" ||
        (atom.kind === "names" && atom.names.every((name) => names.has(name)));
    }
  }
}

/** A MatchType constraint (emit-types `#allowed`): `undefined` for `string`, else its names. */
function allowedAtom(type: SocketType): readonly string[] | undefined {
  switch (type.kind) {
    case "any":
      return undefined;
    case "named":
      return type.name === "*" ? undefined : [type.name];
    case "union":
      return type.names.includes("*") ? undefined : type.names;
  }
}

/** A MatchType parameter's default: `"*"` when unconstrained, else the allowed types. */
function allowedDefault(type: SocketType): Atom {
  const names = allowedAtom(type);
  return names === undefined ? STAR : { kind: "names", names };
}

/** Whether a link typed `atom` infers a parameter within `constraint`. */
function within(atom: Atom, constraint: readonly string[] | undefined): boolean {
  if (constraint === undefined) return true;
  return atom.kind === "names" && atom.names.every((name) => constraint.includes(name));
}

/** `Out<Match<T>>`: anything when `T` is `"*"` or `string`, else `T` or `*`. */
function matchAccepts(parameter: Atom, atom: Atom): boolean {
  if (parameter.kind === "star" || parameter.kind === "string" || atom.kind === "star") return true;
  if (parameter.kind === "optionList") return atom.kind === "optionList";
  return atom.kind === "names" && atom.names.every((name) => parameter.names.includes(name));
}

function describe(atom: Atom): string {
  switch (atom.kind) {
    case "star":
      return "*";
    case "string":
      return "a padded *";
    case "optionList":
      return "an option list";
    case "names":
      return atom.names.join(" | ") || "never";
  }
}

/**
 * The position a template is inferred at (emit-types `#matchAtom`): its first MatchType position
 * in declaration order, depth-first through every dynamic-combo option, and slot 0 of an
 * Autogrow. `read` finds its value in a node's structured inputs.
 */
function inferringPosition(
  definition: NodeDef,
  templateId: string,
):
  | {
      readonly input: InputDef;
      readonly allowed: SocketType;
      readonly read: (inputs: { readonly [name: string]: InputValue }) => InputValue | undefined;
    }
  | undefined {
  type Reader = (inputs: { readonly [name: string]: InputValue }) => InputValue | undefined;
  type Found = { readonly input: InputDef; readonly allowed: SocketType; readonly read: Reader };
  const visit = (input: InputDef, read: Reader): Found | undefined => {
    if (input.kind === "matchType" && input.templateId === templateId) {
      return { input, allowed: input.allowed, read };
    }
    if (input.kind === "autogrow" && input.template.kind === "matchType") {
      if (input.template.templateId !== templateId) return undefined;
      const first = input.slots[0];
      return {
        input: input.template,
        allowed: input.template.allowed,
        read: (inputs) => {
          const value = read(inputs);
          if (isList(value)) return value[0];
          return isPlainObject(value) && first !== undefined ? value[first] : undefined;
        },
      };
    }
    if (input.kind === "dynamicCombo") {
      for (const option of input.options) {
        for (const child of option.inputs) {
          const found = visit(child, (inputs) => {
            const value = read(inputs);
            if (!isPlainObject(value) || value["option"] !== option.key) return undefined;
            const children = value["inputs"];
            return isPlainObject(children) && Object.hasOwn(children, child.name)
              ? children[child.name]
              : undefined;
          });
          if (found !== undefined) return found;
        }
      }
    }
    return undefined;
  };
  for (const input of definition.inputs) {
    const found = visit(input, (inputs) =>
      Object.hasOwn(inputs, input.name) ? inputs[input.name] : undefined,
    );
    if (found !== undefined) return found;
  }
  return undefined;
}
