// Validation of API-format prompts (docs/plan.md §8). It works on the prompt, keyed by wire keys,
// because that is what the backend validates: dynamic inputs are expanded the way the backend's
// `get_finalized_class_inputs` (comfy_api/latest/_io.py) expands them, and each position is then
// checked the way `validate_inputs` (execution.py) checks it.
//
// Severity follows the soundness ordering (AGENTS.md): a check is an error when the generated
// types reject the same thing, or when they can't express it and the backend rejects it. Where
// the types accept a value the backend still takes (a fractional INT, an upload combo's unlisted
// file), it is a warning, so whatever compiles passes validation.

import type { ApiPrompt } from "../api/prompt.ts";
import { unwrapWire } from "../api/wire.ts";
import {
  createDiagnostic,
  type Diagnostic,
  type DiagnosticCode,
} from "../diagnostic/diagnostic.ts";
import type { NodeId } from "../graph/types.ts";
import { stringify } from "../json/stringify.ts";
import { isJsonArray, type JsonObject, type JsonValue } from "../json/value.ts";
import { acceptsType, socketAccepts } from "../schema/accepts.ts";
import { isComboOption } from "../schema/combo.ts";
import { definitionOf } from "../schema/lookup.ts";
import { typeText } from "../schema/type-text.ts";
import type {
  ComboInput,
  DynamicComboInput,
  InputDef,
  IntValue,
  NodeDef,
  OutputType,
  Schema,
  SocketType,
} from "../schema/types.ts";

/**
 * Checks a prompt against a schema the way the backend would, and stricter where the generated
 * types are. Diagnostics come node by node in prompt order (its class, its keys
 * as they expand, then each input in input order), then for the prompt as a whole (no output
 * node, cycles). Paths point into the prompt: `[id, "inputs", key]`, `[id, "class_type"]`, `[id]`
 * for a node or a cycle through it, and `[]` for the whole prompt.
 *
 * Takes any JSON as well, such as a prompt read with `parse`: what isn't a prompt node is
 * reported (`E_INVALID_PROMPT`), never thrown.
 */
export function validateApi(prompt: ApiPrompt | JsonValue, schema: Schema): readonly Diagnostic[] {
  if (typeof prompt !== "object" || prompt === null || isJsonArray(prompt)) {
    return [createDiagnostic("E_INVALID_PROMPT", [], "A prompt is an object of nodes by id.")];
  }
  return new PromptValidator(prompt, schema).run();
}

/** One input position after dynamic inputs are expanded: what the backend validates. */
interface Position {
  /** The wire key. */
  readonly key: string;
  /** The input at this position: never an Autogrow or DynamicGroup, which expand into others. */
  readonly input: InputDef;
  readonly required: boolean;
  readonly value: JsonValue | undefined;
}

/** A node of the prompt with a known class, expanded. */
interface Expanded {
  readonly id: NodeId;
  readonly definition: NodeDef;
  readonly positions: readonly Position[];
  readonly byKey: ReadonlyMap<string, Position>;
  /** Problems found while expanding: unknown keys, bad group keys and row counts. */
  readonly diagnostics: readonly Diagnostic[];
}

/** Where a valid link points. */
interface Located {
  readonly node: Expanded;
  readonly slot: number;
}

/** A link's source, once checked: the node and its output's type, MatchType resolved. */
interface Source {
  readonly node: NodeId;
  readonly type: OutputType;
}

type LinkProblem = "shape" | "node" | "slot";

const ANY: SocketType = { kind: "any" };

/** A prompt's nodes, not yet known to be prompt nodes. */
type Nodes = { readonly [id: NodeId]: unknown };

class PromptValidator {
  readonly #prompt: Nodes;
  readonly #schema: Schema;
  readonly #expanded = new Map<NodeId, Expanded>();
  /** Resolved MatchType templates, by node id and template id. */
  readonly #templates = new Map<string, OutputType>();

  constructor(prompt: Nodes, schema: Schema) {
    this.#prompt = prompt;
    this.#schema = schema;
  }

  run(): readonly Diagnostic[] {
    // Node problems first, in prompt order, so links to every node can be followed after.
    const nodeProblems = new Map<NodeId, Diagnostic>();
    let outputs = 0;
    for (const [id, node] of Object.entries(this.#prompt)) {
      const read = readNode(node);
      if (read === undefined) {
        nodeProblems.set(id, unreadable(id));
        continue;
      }
      const definition = definitionOf(this.#schema, read.classType);
      if (definition === undefined) {
        nodeProblems.set(id, unknownClass(id, read.classType));
        continue;
      }
      if (definition.outputNode) outputs++;
      this.#expanded.set(id, expand(id, definition, read.inputs));
    }
    const diagnostics: Diagnostic[] = [];
    for (const id of Object.keys(this.#prompt)) {
      const problem = nodeProblems.get(id);
      const node = this.#expanded.get(id);
      if (problem !== undefined) diagnostics.push(problem);
      if (node === undefined) continue;
      diagnostics.push(...node.diagnostics);
      for (const position of node.positions) diagnostics.push(...this.#check(node, position));
    }
    if (outputs === 0) {
      diagnostics.push(
        createDiagnostic(
          "E_NO_OUTPUT_NODE",
          [],
          "The prompt has no output node (save, preview, …), so the backend would run nothing.",
        ),
      );
    }
    diagnostics.push(...this.#cycles());
    return diagnostics;
  }

  /** The checks of one position, in order: presence, then the link or the value. */
  #check(node: Expanded, position: Position): Diagnostic[] {
    const { key, input, value } = position;
    const report = (code: DiagnosticCode, message: string): Diagnostic[] => [
      createDiagnostic(code, [node.id, "inputs", key], message),
    ];
    const where = `Input ${key} of node ${node.id} (${node.definition.classType})`;
    if (value === undefined) {
      return position.required ? report("E_MISSING_INPUT", `${where} is required.`) : [];
    }
    // The backend reads a dynamic combo's choice as it is: anything but a key drops the input.
    if (input.kind === "dynamicCombo") return dynamicCombo(input, value, report, where);
    if (!isJsonArray(value)) return this.#constant(input, unwrapWire(value), report, where);
    const source = this.#source(value);
    if (typeof source === "string") {
      return report(
        source === "shape" ? "E_INVALID_LINK" : "E_DANGLING_LINK",
        `${where} ${linkProblem(source, value)}.`,
      );
    }
    // A source of an unknown class is reported already; an unreadable input can't be typed.
    if (source === undefined || input.kind === "unknown") return [];
    if (input.kind !== "matchType") {
      return acceptsType(input, source.type)
        ? []
        : report(
            "E_TYPE_MISMATCH",
            `${where} takes ${describeInput(input)}, but is linked to ${describeOutput(source.type)} from node ${source.node}.`,
          );
    }
    if (!socketAccepts(input.allowed, source.type)) {
      return report(
        "E_TYPE_MISMATCH",
        `${where} takes ${describeInput(input)}, but is linked to ${describeOutput(source.type)} from node ${source.node}.`,
      );
    }
    // MatchType consistency (§6.3), as the generated types check it: the inferring position
    // fixes the template's type, and every other position must agree with it.
    const inferring = inferringKey(node.definition, input.templateId);
    if (inferring === undefined || inferring === key) return [];
    const inferred = this.#linkedType(node.byKey.get(inferring));
    if (inferred === undefined || isAnyType(inferred) || agree(inferred, source.type)) return [];
    return report(
      "E_MATCH_TYPE_MISMATCH",
      `${where} is linked to ${describeOutput(source.type)}, but its template follows ${inferring}, which is linked to ${describeOutput(inferred)}.`,
    );
  }

  /** The checks of a value that isn't a link. */
  #constant(
    input: InputDef,
    value: JsonValue,
    report: (code: DiagnosticCode, message: string) => Diagnostic[],
    where: string,
  ): Diagnostic[] {
    switch (input.kind) {
      case "socket":
      case "matchType":
      case "autogrow":
      case "dynamicGroup":
        return report("E_NOT_A_LINK", `${where} takes a link, not a value.`);
      case "unknown":
      case "value":
      case "dynamicCombo":
        return [];
      case "int": {
        if (typeof value !== "number" && typeof value !== "bigint") {
          return report(
            "E_INVALID_VALUE",
            `${where} takes an integer, not ${describeValue(value)}.`,
          );
        }
        if (typeof value === "number" && !Number.isFinite(value)) {
          return report(
            "E_INVALID_VALUE",
            `${where} is ${String(value)}, which no JSON number can be.`,
          );
        }
        // The backend's int() applies to inputs typed exactly INT; it truncates, then checks
        // the bounds. Other types (an INT widget on a custom type) are compared as they are.
        if (!isNamed(input.type, "INT") || typeof value === "bigint" || Number.isInteger(value)) {
          return range(value, input.min, input.max, report, where);
        }
        const truncated = Math.trunc(value);
        return [
          ...report(
            "W_NON_INTEGER_VALUE",
            `${where} is ${String(value)}; the backend truncates it to ${String(truncated)}.`,
          ),
          ...range(truncated, input.min, input.max, report, where),
        ];
      }
      case "float":
        // A bigint is an integer literal beyond 2^53, which float() reads, unless it rounds to
        // infinity (an OverflowError in Python, which rounds as JavaScript does).
        if (typeof value !== "number" && typeof value !== "bigint") {
          return report("E_INVALID_VALUE", `${where} takes a number, not ${describeValue(value)}.`);
        }
        if (!Number.isFinite(Number(value))) {
          return report(
            "E_INVALID_VALUE",
            typeof value === "bigint"
              ? `${where} is an integer too large for a float, which the backend can't read.`
              : `${where} is ${String(value)}, which no JSON number can be.`,
          );
        }
        return range(value, input.min, input.max, report, where);
      case "string":
        return typeof value === "string"
          ? []
          : report("E_INVALID_VALUE", `${where} takes a string, not ${describeValue(value)}.`);
      case "boolean":
        return typeof value === "boolean"
          ? []
          : report("E_INVALID_VALUE", `${where} takes a boolean, not ${describeValue(value)}.`);
      case "combo":
        return combo(input, value, report, where);
    }
  }

  /** Where a link points, or what is wrong with it; `undefined` for a node of unknown class. */
  #locate(link: readonly JsonValue[]): Located | LinkProblem | undefined {
    const [node, slot] = link;
    if (link.length !== 2 || typeof node !== "string" || typeof slot !== "number") return "shape";
    if (!Number.isSafeInteger(slot) || slot < 0) return "shape";
    if (!Object.hasOwn(this.#prompt, node)) return "node";
    const source = this.#expanded.get(node);
    if (source === undefined) return undefined;
    if (source.definition.outputs[slot] === undefined) return "slot";
    return { node: source, slot };
  }

  /** {@link #locate}, with the output's type: a MatchType output's resolved template. */
  #source(link: readonly JsonValue[]): Source | LinkProblem | undefined {
    const located = this.#locate(link);
    if (typeof located !== "object") return located;
    return { node: located.node.id, type: this.#outputType(located) };
  }

  #outputType({ node, slot }: Located): OutputType {
    const output = node.definition.outputs[slot];
    if (output === undefined) return ANY;
    return output.matchTemplate === undefined
      ? output.type
      : this.#template(node, output.matchTemplate);
  }

  /**
   * The type a node's MatchType template resolves to, as the generated types infer it: the type
   * linked at the template's inferring position, or `*` when that position is empty (the type
   * parameter's default). Followed iteratively through chains of MatchType nodes, which can be
   * as long as a prompt; a cycle resolves to `*`.
   */
  #template(start: Expanded, startTemplate: string): OutputType {
    const chain = new Set<string>();
    let node = start;
    let template = startTemplate;
    let resolved: OutputType = ANY;
    for (;;) {
      const cacheKey = `${node.id}\u0000${template}`;
      const cached = this.#templates.get(cacheKey);
      if (cached !== undefined) {
        resolved = cached;
        break;
      }
      if (chain.has(cacheKey)) break;
      chain.add(cacheKey);
      const key = inferringKey(node.definition, template);
      const value = key === undefined ? undefined : node.byKey.get(key)?.value;
      const located = isJsonArray(value) ? this.#locate(value) : undefined;
      if (typeof located !== "object") break;
      const output = located.node.definition.outputs[located.slot];
      if (output === undefined) break;
      if (output.matchTemplate === undefined) {
        resolved = output.type;
        break;
      }
      node = located.node;
      template = output.matchTemplate;
    }
    for (const key of chain) this.#templates.set(key, resolved);
    return resolved;
  }

  /** The resolved type of a position's link, if it is a valid one. */
  #linkedType(position: Position | undefined): OutputType | undefined {
    if (!isJsonArray(position?.value)) return undefined;
    const source = this.#source(position.value);
    return typeof source === "object" ? source.type : undefined;
  }

  /**
   * Dependency cycles, which the backend rejects. One diagnostic per back edge found, at the node
   * it returns to, in prompt order.
   */
  #cycles(): Diagnostic[] {
    const diagnostics: Diagnostic[] = [];
    const state = new Map<NodeId, "open" | "done">();
    // Each source once: two inputs linked to one node are one dependency.
    const edges = (id: NodeId): NodeId[] => [
      ...new Set(
        (this.#expanded.get(id)?.positions ?? []).flatMap((position) => {
          if (!isJsonArray(position.value)) return [];
          const located = this.#locate(position.value);
          return typeof located === "object" ? [located.node.id] : [];
        }),
      ),
    ];
    for (const start of this.#expanded.keys()) {
      if (state.has(start)) continue;
      // Iterative depth-first search: prompts can be long chains.
      const stack: { readonly id: NodeId; readonly next: NodeId[] }[] = [
        { id: start, next: edges(start) },
      ];
      state.set(start, "open");
      while (stack.length > 0) {
        const top = stack.at(-1);
        if (top === undefined) break;
        const next = top.next.pop();
        if (next === undefined) {
          state.set(top.id, "done");
          stack.pop();
          continue;
        }
        const seen = state.get(next);
        if (seen === "open") {
          const ids = stack.map((frame) => frame.id);
          const cycle = [...ids.slice(ids.indexOf(next)), next];
          diagnostics.push(
            createDiagnostic(
              "E_DEPENDENCY_CYCLE",
              [next],
              `Nodes depend on each other in a cycle: ${cycle.map((id) => `${id} (${this.#expanded.get(id)?.definition.classType ?? "?"})`).join(" → ")}.`,
            ),
          );
        } else if (seen === undefined) {
          state.set(next, "open");
          stack.push({ id: next, next: edges(next) });
        }
      }
    }
    return diagnostics;
  }
}

/** A prompt node's class and inputs, if it has both. */
function readNode(
  node: unknown,
): { readonly classType: string; readonly inputs: JsonObject } | undefined {
  if (typeof node !== "object" || node === null) return undefined;
  const classType: unknown = Reflect.get(node, "class_type");
  const inputs: unknown = Reflect.get(node, "inputs");
  if (typeof classType !== "string") return undefined;
  if (typeof inputs !== "object" || inputs === null || Array.isArray(inputs)) return undefined;
  // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- an ApiPrompt's inputs are JSON
  return { classType, inputs: inputs as JsonObject };
}

function unreadable(id: NodeId): Diagnostic {
  return createDiagnostic(
    "E_INVALID_PROMPT",
    [id],
    `Node ${id} isn't a prompt node: an object with a class_type string and an inputs object.`,
  );
}

function unknownClass(id: NodeId, classType: string): Diagnostic {
  // The backend rejects the whole prompt for this, before validating anything else.
  return createDiagnostic(
    "E_UNKNOWN_CLASS_TYPE",
    [id, "class_type"],
    `Node ${id} has class type ${JSON.stringify(classType)}, which the schema doesn't have.`,
  );
}

/** The inferring positions of a definition's templates, computed once per definition. */
const inferring = new WeakMap<NodeDef, ReadonlyMap<string, string>>();

/**
 * The wire key whose link fixes a MatchType template's type, as the generated types choose it
 * (codegen `#matchAtom`): the template's first position in declaration order, depth-first through
 * every dynamic-combo option, and slot 0 of an Autogrow. It may sit in an option not chosen.
 */
function inferringKey(definition: NodeDef, templateId: string): string | undefined {
  let keys = inferring.get(definition);
  if (keys === undefined) {
    const found = new Map<string, string>();
    const visit = (input: InputDef, prefix: string): void => {
      const key = `${prefix}${input.name}`;
      if (input.kind === "matchType" && !found.has(input.templateId)) {
        found.set(input.templateId, key);
      } else if (input.kind === "autogrow" && input.template.kind === "matchType") {
        const [first] = input.slots;
        if (first !== undefined && !found.has(input.template.templateId)) {
          found.set(input.template.templateId, `${key}.${first}`);
        }
      } else if (input.kind === "dynamicCombo") {
        for (const option of input.options) {
          for (const child of option.inputs) visit(child, `${key}.`);
        }
      }
    };
    for (const input of definition.inputs) visit(input, "");
    keys = found;
    inferring.set(definition, keys);
  }
  return keys.get(templateId);
}

/** A choice of a dynamic combo: exactly one of its keys, as the backend compares it. */
function dynamicCombo(
  input: DynamicComboInput,
  value: JsonValue,
  report: (code: DiagnosticCode, message: string) => Diagnostic[],
  where: string,
): Diagnostic[] {
  if (typeof value !== "string") {
    return report(
      "E_INVALID_VALUE",
      `${where} takes one of its option keys, not ${isJsonArray(value) ? "a link" : describeValue(value)}; the backend would drop it and its options' inputs.`,
    );
  }
  return input.options.some((option) => option.key === value)
    ? []
    : report(
        "E_UNKNOWN_DYNAMIC_OPTION",
        `${where} is ${JSON.stringify(value)}, which isn't one of its options (${list(input.options.map((option) => option.key))}).`,
      );
}

/**
 * A node's input positions, expanded from its wire keys as the backend expands them, and the
 * keys nothing claims.
 */
function expand(id: NodeId, definition: NodeDef, inputs: JsonObject): Expanded {
  const positions: Position[] = [];
  const diagnostics: Diagnostic[] = [];
  const claimed = new Set<string>();
  /** Prefixes whose keys are reported by the input that owns them, not as unknown keys. */
  const owned: string[] = [];
  const where = (key: string): string => `Input ${key} of node ${id} (${definition.classType})`;

  const add = (input: InputDef, key: string, required: boolean): void => {
    claimed.add(key);
    positions.push({
      key,
      input,
      required,
      value: Object.hasOwn(inputs, key) ? inputs[key] : undefined,
    });
  };

  const visit = (input: InputDef, prefix: string): void => {
    const key = `${prefix}${input.name}`;
    switch (input.kind) {
      case "autogrow":
        // Slots before `min` are required when the template is, even in an optional Autogrow.
        input.slots.forEach((slot, index) => {
          add(input.template, `${key}.${slot}`, index < input.min && input.template.required);
        });
        return;
      case "dynamicCombo": {
        add(input, key, input.required);
        const chosen = Object.hasOwn(inputs, key) ? inputs[key] : undefined;
        const option = input.options.find((each) => each.key === chosen);
        if (option === undefined) {
          // An unknown option is reported on the combo; its inputs can't be told apart.
          if (chosen !== undefined) owned.push(`${key}.`);
          return;
        }
        for (const child of option.inputs) visit(child, `${key}.`);
        return;
      }
      case "dynamicGroup":
        diagnostics.push(...expandGroup(input, key));
        return;
      case "socket":
      case "int":
      case "float":
      case "string":
      case "boolean":
      case "combo":
      case "value":
      case "matchType":
      case "unknown":
        add(input, key, input.required);
    }
  };

  /** A DynamicGroup's keys `<key>.<row>.<field>`: rows are counted, and their fields expanded. */
  const expandGroup = (
    input: Extract<InputDef, { kind: "dynamicGroup" }>,
    key: string,
  ): Diagnostic[] => {
    const found: Diagnostic[] = [];
    const prefix = `${key}.`;
    owned.push(prefix);
    const fields = new Set(input.fields.map((field) => field.name));
    const rows = new Set<number>();
    for (const wire of Object.keys(inputs)) {
      if (!wire.startsWith(prefix)) continue;
      claimed.add(wire);
      const rest = wire.slice(prefix.length);
      const dot = rest.indexOf(".");
      const index = dot === -1 ? "" : rest.slice(0, dot);
      const field = rest.slice(dot + 1);
      if (dot === -1 || !/^(?:0|[1-9][0-9]*)$/.test(index) || !fields.has(field)) {
        found.push(
          createDiagnostic(
            "E_UNKNOWN_INPUT",
            [id, "inputs", wire],
            `${where(wire)} isn't a field of group ${key}; group keys are ${key}.<row>.<field>.`,
          ),
        );
        continue;
      }
      const row = Number(index);
      if (row >= input.max) {
        found.push(
          createDiagnostic(
            "E_TOO_MANY_DYNAMIC_INPUTS",
            [id, "inputs", wire],
            `${where(wire)} is in row ${index}, but group ${key} has at most ${String(input.max)} rows.`,
          ),
        );
        continue;
      }
      rows.add(row);
    }
    if (rows.size < input.min) {
      found.push(
        createDiagnostic(
          "E_TOO_FEW_DYNAMIC_INPUTS",
          [id, "inputs", key],
          `${where(key)} has ${String(rows.size)} rows, but needs at least ${String(input.min)}.`,
        ),
      );
    }
    for (const row of [...rows].toSorted((a, b) => a - b)) {
      for (const field of input.fields) {
        add(field, `${prefix}${String(row)}.${field.name}`, field.required);
      }
    }
    return found;
  };

  for (const input of definition.inputs) visit(input, "");
  for (const key of Object.keys(inputs)) {
    if (claimed.has(key) || owned.some((prefix) => key.startsWith(prefix))) continue;
    diagnostics.push(
      createDiagnostic(
        "E_UNKNOWN_INPUT",
        [id, "inputs", key],
        `${where(key)} isn't an input of ${definition.classType}.`,
      ),
    );
  }
  return {
    id,
    definition,
    positions,
    byKey: new Map(positions.map((position) => [position.key, position])),
    diagnostics,
  };
}

function combo(
  input: ComboInput,
  value: JsonValue,
  report: (code: DiagnosticCode, message: string) => Diagnostic[],
  where: string,
): Diagnostic[] {
  const values = isJsonArray(value) ? value : [value];
  if (isJsonArray(value) && !input.multiselect) {
    return report("E_INVALID_VALUE", `${where} takes one option, not a list.`);
  }
  const invalid = values.find((each) => !isComboOption(each));
  if (invalid !== undefined) {
    return report("E_INVALID_VALUE", `${where} takes options, not ${describeValue(invalid)}.`);
  }
  const unlisted = values.filter(isComboOption).filter((each) => !input.options.includes(each));
  if (unlisted.length === 0) return [];
  const shown = list(unlisted.map((each) => JSON.stringify(each)));
  // Upload and remote combos change at runtime, and an empty one is a folder without files yet.
  if (input.upload || input.remote || input.options.length === 0) {
    return report(
      "W_UNLISTED_COMBO_VALUE",
      `${where} is ${shown}, which the schema doesn't list; it may exist on the server by now.`,
    );
  }
  return report("E_NOT_IN_COMBO", `${where} is ${shown}, which isn't one of its options.`);
}

/** The bound check, after coercion; INT bounds may be bigint, so the comparison is exact. */
function range(
  value: IntValue,
  min: IntValue | undefined,
  max: IntValue | undefined,
  report: (code: DiagnosticCode, message: string) => Diagnostic[],
  where: string,
): Diagnostic[] {
  if (min !== undefined && compare(value, min) < 0) {
    return report(
      "E_OUT_OF_RANGE",
      `${where} is ${String(value)}, below its minimum ${String(min)}.`,
    );
  }
  if (max !== undefined && compare(value, max) > 0) {
    return report(
      "E_OUT_OF_RANGE",
      `${where} is ${String(value)}, above its maximum ${String(max)}.`,
    );
  }
  return [];
}

/** Compares two numbers exactly, whether number or bigint. */
function compare(a: IntValue, b: IntValue): number {
  if (typeof a === "number") return typeof b === "number" ? a - b : compareMixed(a, b);
  if (typeof b === "number") return -compareMixed(b, a);
  return a < b ? -1 : a > b ? 1 : 0;
}

/** A finite number against a bigint, exactly: by its floor, then by its fraction. */
function compareMixed(value: number, big: bigint): number {
  const floor = Math.floor(value);
  const whole = BigInt(floor);
  if (whole !== big) return whole < big ? -1 : 1;
  return value === floor ? 0 : 1;
}

/** Whether two linked types of one MatchType template agree: they share a type, or one is `*`. */
function agree(a: OutputType, b: OutputType): boolean {
  return socketAccepts(asSocket(a), b) || socketAccepts(asSocket(b), a);
}

function asSocket(type: OutputType): SocketType {
  return type.kind === "combo" ? { kind: "named", name: "COMBO" } : type;
}

function isNamed(type: SocketType, name: string): boolean {
  return type.kind === "named" && type.name === name;
}

/** `*`, alone or in a comma list: the generated types infer nothing narrower from it. */
function isAnyType(type: OutputType): boolean {
  return type.kind === "any" || (type.kind !== "combo" && typeText(type).split(",").includes("*"));
}

function linkProblem(problem: "shape" | "node" | "slot", link: readonly JsonValue[]): string {
  switch (problem) {
    case "shape":
      return "is a list, which the backend reads as a link, but not [node id, output slot]";
    case "node":
      return `links to node ${stringify(link[0] ?? null)}, which the prompt doesn't have`;
    case "slot":
      return `links to output ${stringify(link[1] ?? null)} of node ${stringify(link[0] ?? null)}, which it doesn't have`;
  }
}

function describeInput(input: InputDef): string {
  if (input.kind === "matchType") return typeText(input.allowed);
  if ("type" in input) return typeText(input.type);
  return input.kind;
}

function describeOutput(type: OutputType): string {
  return type.kind === "combo" ? "an option list" : typeText(type);
}

function describeValue(value: JsonValue): string {
  if (value === null) return "null";
  if (isJsonArray(value)) return "a list";
  if (typeof value === "object") return "an object";
  return `${typeof value === "string" ? "the string" : `the ${typeof value}`} ${typeof value === "string" ? JSON.stringify(value) : String(value)}`;
}

/** At most a few items, for messages. */
function list(items: readonly string[]): string {
  const shown = items.slice(0, 5).join(", ");
  return items.length > 5 ? `${shown}, … ${String(items.length - 5)} more` : shown;
}
