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
import {
  createDiagnostic,
  type Diagnostic,
  type DiagnosticCode,
} from "../diagnostic/diagnostic.ts";
import type { NodeId } from "../graph/types.ts";
import { stringify } from "../json/stringify.ts";
import { isJsonObject, type JsonObject, type JsonValue } from "../json/value.ts";
import { acceptsType, socketAccepts } from "../schema/accepts.ts";
import type {
  ComboInput,
  ComboOption,
  InputDef,
  IntValue,
  NodeDef,
  OutputType,
  Schema,
  SocketType,
} from "../schema/types.ts";

/**
 * Checks a prompt against a schema the way the backend would, and stricter where the generated
 * types are (docs/plan.md §8). Diagnostics come in prompt order, then input order; paths point
 * into the prompt: `[id, "inputs", key]`, `[id, "class_type"]`, `[id]` for a cycle and `[]` for
 * the whole prompt.
 */
export function validateApi(prompt: ApiPrompt, schema: Schema): readonly Diagnostic[] {
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
  /**
   * Which declared input the position came from, in declaration order: every slot of one
   * Autogrow shares it. MatchType consistency is decided by the first declared input.
   */
  readonly declared: number;
}

/** A node of the prompt with a known class, expanded. */
interface Expanded {
  readonly id: NodeId;
  readonly definition: NodeDef;
  readonly positions: readonly Position[];
  /** Problems found while expanding: unknown keys, bad group keys and row counts. */
  readonly diagnostics: readonly Diagnostic[];
}

/** A link's target, once checked: the source node and its resolved output type. */
interface Source {
  readonly node: NodeId;
  readonly type: OutputType;
}

const ANY: SocketType = { kind: "any" };

class PromptValidator {
  readonly #prompt: ApiPrompt;
  readonly #schema: Schema;
  readonly #expanded = new Map<NodeId, Expanded>();
  /** Resolved MatchType templates per node, `undefined` while being resolved (a cycle). */
  readonly #templates = new Map<string, OutputType | undefined>();

  constructor(prompt: ApiPrompt, schema: Schema) {
    this.#prompt = prompt;
    this.#schema = schema;
  }

  run(): readonly Diagnostic[] {
    const diagnostics: Diagnostic[] = [];
    let outputs = 0;
    for (const [id, node] of Object.entries(this.#prompt)) {
      const definition = Object.hasOwn(this.#schema.nodes, node.class_type)
        ? this.#schema.nodes[node.class_type]
        : undefined;
      if (definition === undefined) {
        // The backend rejects the whole prompt for this, before validating anything else.
        diagnostics.push(
          createDiagnostic(
            "E_UNKNOWN_CLASS_TYPE",
            [id, "class_type"],
            `Node ${id} has class type ${JSON.stringify(node.class_type)}, which the schema doesn't have.`,
          ),
        );
        continue;
      }
      if (definition.outputNode) outputs++;
      this.#expanded.set(id, expand(id, definition, node.inputs));
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
    for (const node of this.#expanded.values()) {
      diagnostics.push(...node.diagnostics);
      for (const position of node.positions) diagnostics.push(...this.#check(node, position));
      diagnostics.push(...this.#matchTypes(node));
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
    if (input.kind === "unknown") return [];
    if (isList(value)) {
      const source = this.#source(value);
      if (typeof source === "string")
        return report(
          source === "shape" ? "E_INVALID_LINK" : "E_DANGLING_LINK",
          `${where} ${linkProblem(source, value)}.`,
        );
      if (source === undefined) return [];
      const fits =
        input.kind === "matchType"
          ? socketAccepts(input.allowed, source.type)
          : acceptsType(input, source.type);
      return fits
        ? []
        : report(
            "E_TYPE_MISMATCH",
            `${where} takes ${describeInput(input)}, but is linked to ${describeOutput(source.type)} from node ${source.node}.`,
          );
    }
    return this.#constant(input, unwrap(value), report, where);
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
        return [];
      case "int": {
        if (typeof value !== "number" && typeof value !== "bigint") {
          return report(
            "E_INVALID_VALUE",
            `${where} takes an integer, not ${describeValue(value)}.`,
          );
        }
        const fraction =
          typeof value === "number" && !Number.isInteger(value)
            ? report(
                "W_NON_INTEGER_VALUE",
                `${where} is ${String(value)}; the backend truncates it to ${String(Math.trunc(value))}.`,
              )
            : [];
        // The backend checks the bounds after its int() truncation.
        const integer = typeof value === "number" ? Math.trunc(value) : value;
        return [...fraction, ...range(integer, input.min, input.max, report, where)];
      }
      case "float":
        if (typeof value !== "number") {
          return report("E_INVALID_VALUE", `${where} takes a number, not ${describeValue(value)}.`);
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
      case "dynamicCombo":
        if (typeof value !== "string") {
          return report(
            "E_INVALID_VALUE",
            `${where} takes an option key, not ${describeValue(value)}.`,
          );
        }
        return input.options.some((option) => option.key === value)
          ? []
          : report(
              "E_UNKNOWN_DYNAMIC_OPTION",
              `${where} is ${JSON.stringify(value)}, which isn't one of its options (${list(input.options.map((option) => option.key))}).`,
            );
    }
  }

  /**
   * Where a link points, with the output's type resolved; a string naming what is wrong with
   * it; or `undefined` when its source has a class the schema doesn't know (reported already).
   */
  #source(link: readonly JsonValue[]): Source | "shape" | "node" | "slot" | undefined {
    const [node, slot] = link;
    if (link.length !== 2 || typeof node !== "string" || typeof slot !== "number") return "shape";
    if (!Number.isSafeInteger(slot) || slot < 0) return "shape";
    if (!Object.hasOwn(this.#prompt, node)) return "node";
    const source = this.#expanded.get(node);
    if (source === undefined) return undefined;
    const output = source.definition.outputs[slot];
    if (output === undefined) return "slot";
    return { node, type: this.#outputType(source, slot) };
  }

  /** An output's type: a MatchType output has the type its template resolves to. */
  #outputType(node: Expanded, slot: number): OutputType {
    const output = node.definition.outputs[slot];
    if (output === undefined) return ANY;
    if (output.matchTemplate === undefined) return output.type;
    return this.#template(node, output.matchTemplate) ?? ANY;
  }

  /**
   * The type a node's MatchType template resolves to: the first linked position of the template
   * whose source has a type, as the frontend narrows it. `undefined` when nothing narrows it.
   */
  #template(node: Expanded, templateId: string): OutputType | undefined {
    const cacheKey = `${node.id}\u0000${templateId}`;
    if (this.#templates.has(cacheKey)) return this.#templates.get(cacheKey);
    // Guard against cycles: while resolving, the template counts as unresolved.
    this.#templates.set(cacheKey, undefined);
    let resolved: OutputType | undefined;
    for (const position of node.positions) {
      if (position.input.kind !== "matchType" || position.input.templateId !== templateId) continue;
      if (!isList(position.value)) continue;
      const source = this.#source(position.value);
      if (typeof source === "object" && source.type.kind !== "any") {
        resolved = source.type;
        break;
      }
    }
    this.#templates.set(cacheKey, resolved);
    return resolved;
  }

  /**
   * MatchType consistency (§6.3): once the first declared input of a template is linked to a
   * typed output, every other position of the template must agree with it. The generated types
   * check exactly this (`Match<NoInfer<T>>`); the backend checks nothing.
   */
  #matchTypes(node: Expanded): Diagnostic[] {
    const diagnostics: Diagnostic[] = [];
    const byTemplate = new Map<string, Position[]>();
    for (const position of node.positions) {
      if (position.input.kind !== "matchType") continue;
      const group = byTemplate.get(position.input.templateId) ?? [];
      group.push(position);
      byTemplate.set(position.input.templateId, group);
    }
    for (const positions of byTemplate.values()) {
      const first = positions[0]?.declared;
      const inferred = positions
        .filter((position) => position.declared === first)
        .map((position) => this.#linkedType(position));
      // Unlinked or `*`: the types infer nothing, so anything goes.
      if (
        inferred.length === 0 ||
        inferred.some((type) => type === undefined || type.kind === "any")
      )
        continue;
      for (const position of positions) {
        if (position.declared === first) continue;
        const type = this.#linkedType(position);
        if (type === undefined || inferred.some((each) => each !== undefined && agree(each, type)))
          continue;
        diagnostics.push(
          createDiagnostic(
            "E_MATCH_TYPE_MISMATCH",
            [node.id, "inputs", position.key],
            `Input ${position.key} of node ${node.id} (${node.definition.classType}) is linked to ${describeOutput(type)}, but its template follows ${list(inferred.flatMap((each) => (each === undefined ? [] : [describeOutput(each)])))}.`,
          ),
        );
      }
    }
    return diagnostics;
  }

  /** The resolved type of a position's link, if it is a valid one. */
  #linkedType(position: Position): OutputType | undefined {
    if (!isList(position.value)) return undefined;
    const source = this.#source(position.value);
    return typeof source === "object" ? source.type : undefined;
  }

  /** Dependency cycles, which the backend rejects. One diagnostic per cycle found, in prompt order. */
  #cycles(): Diagnostic[] {
    const diagnostics: Diagnostic[] = [];
    const state = new Map<NodeId, "open" | "done">();
    const edges = (id: NodeId): NodeId[] =>
      (this.#expanded.get(id)?.positions ?? []).flatMap((position) => {
        if (!isList(position.value)) return [];
        const source = this.#source(position.value);
        return typeof source === "object" ? [source.node] : [];
      });
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
        const next = top.next.shift();
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
  let declared = 0;
  const where = (key: string): string => `Input ${key} of node ${id} (${definition.classType})`;

  const add = (input: InputDef, key: string, required: boolean, group: number): void => {
    claimed.add(key);
    positions.push({
      key,
      input,
      required,
      value: Object.hasOwn(inputs, key) ? inputs[key] : undefined,
      declared: group,
    });
  };

  const visit = (input: InputDef, prefix: string): void => {
    const key = `${prefix}${input.name}`;
    const group = declared++;
    switch (input.kind) {
      case "autogrow":
        // Slots before `min` are required when the template is, even in an optional Autogrow.
        input.slots.forEach((slot, index) => {
          add(
            input.template,
            `${key}.${slot}`,
            index < input.min && input.template.required,
            group,
          );
        });
        return;
      case "dynamicCombo": {
        add(input, key, input.required, group);
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
        add(input, key, input.required, group);
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
      const rowGroup = declared++;
      for (const field of input.fields)
        add(field, `${prefix}${String(row)}.${field.name}`, field.required, rowGroup);
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
  return { id, definition, positions, diagnostics };
}

function combo(
  input: ComboInput,
  value: JsonValue,
  report: (code: DiagnosticCode, message: string) => Diagnostic[],
  where: string,
): Diagnostic[] {
  const values = isList(value) ? value : [value];
  if (isList(value) && !input.multiselect) {
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

/** Compares two numbers exactly: bigints with each other or with integer-valued numbers. */
function compare(a: IntValue, b: IntValue): number {
  if (typeof a === "number" && typeof b === "number") return a - b;
  const x = typeof a === "bigint" ? a : BigInt(a);
  const y = typeof b === "bigint" ? b : BigInt(b);
  return x < y ? -1 : x > y ? 1 : 0;
}

/** Whether two linked types of one MatchType template agree: they share a type, or one is `*`. */
function agree(a: OutputType, b: OutputType): boolean {
  return socketAccepts(asSocket(a), b) || socketAccepts(asSocket(b), a);
}

function asSocket(type: OutputType): SocketType {
  return type.kind === "combo" ? { kind: "named", name: "COMBO" } : type;
}

/** The backend unwraps `{"__value__": …}`, which carries list values (§7.5). */
function unwrap(value: JsonValue): JsonValue {
  return isJsonObject(value) && Object.hasOwn(value, "__value__")
    ? (value["__value__"] ?? null)
    : value;
}

function isList(value: JsonValue | undefined): value is readonly JsonValue[] {
  return Array.isArray(value);
}

function isComboOption(value: JsonValue): value is ComboOption {
  return typeof value === "string" || typeof value === "number" || typeof value === "boolean";
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
  if (input.kind === "matchType") return describeSocket(input.allowed);
  if ("type" in input) return describeSocket(input.type);
  return input.kind;
}

function describeOutput(type: OutputType): string {
  return type.kind === "combo" ? "an option list" : describeSocket(type);
}

function describeSocket(type: SocketType): string {
  switch (type.kind) {
    case "any":
      return "*";
    case "named":
      return type.name;
    case "union":
      return type.names.join(",");
  }
}

function describeValue(value: JsonValue): string {
  if (value === null) return "null";
  if (isList(value)) return "a list";
  if (typeof value === "object") return "an object";
  return `${typeof value === "string" ? "the string" : `the ${typeof value}`} ${typeof value === "string" ? JSON.stringify(value) : String(value)}`;
}

/** At most a few items, for messages. */
function list(items: readonly string[]): string {
  const shown = items.slice(0, 5).join(", ");
  return items.length > 5 ? `${shown}, … ${String(items.length - 5)} more` : shown;
}
