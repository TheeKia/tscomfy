// Workflow → TypeScript (docs/plan.md §10): the builder code that rebuilds a workflow over the
// generated types. Nodes the types can express become `n.Class(…)` calls; the rest become
// `raw(…)` with their wire keys, so the program always rebuilds the same prompt.
//
// Whether the types can express a node is decided by the same rules `emit-types.ts` writes the
// types with (`typing.ts`, §6.2, §6.3), so the output compiles: a test type-checks it for every
// mock and for the corpus. The layout is oxfmt's (`expressions.ts`).

import {
  createDiagnostic,
  type Diagnostic,
  exportApi,
  type GraphNode,
  type InputDef,
  type InputValue,
  isOutputRef,
  type JsonValue,
  type NodeDef,
  type NodeId,
  stringify,
  type Workflow,
} from "@tscomfy/core";
import { type Doc, hardline, indent, join, print, PRINT_WIDTH, textWidth } from "./doc.ts";
import { exportNameProblem, isExportName, TRANSPILED_MODULE_NAMES } from "./export-name.ts";
import {
  arrayDoc,
  breaksArray,
  callDoc,
  declarationDoc,
  declarationLayout,
  declarationLeft,
  isNumberList,
  jsonDoc,
  type Layout,
  numbersDoc,
  objectDoc,
  objectKey,
  propertyDoc,
  scalarDoc,
  STATEMENT_INDENT,
  statementDoc,
} from "./expressions.ts";
import { CODEGEN_VERSION } from "./generate.ts";
import { headerLines, NameRegistry, quote } from "./names.ts";
import { hasDefault, isRequired } from "./rules.ts";
import { Typing, type WriteMode } from "./typing.ts";
import { isList, isPlainObject, references } from "./values.ts";

/** Options for {@link transpile}. */
export interface TranspileOptions {
  /** The exported constant holding the workflow, e.g. `txt2img`. */
  readonly name: string;
  /** Where the generated schema is imported from, e.g. `./comfy/local/index.js`. */
  readonly schemaModule: string;
  /** The schema module's export, e.g. `local`. */
  readonly schemaName: string;
  /** Inline a node used once into its use, unless that node inlines another. Default `true`. */
  readonly inline?: boolean;
  /** Extra header lines, e.g. the command that transpiled the file. */
  readonly header?: readonly string[];
}

/** What {@link transpile} returns. */
export interface TranspileResult {
  /** The module source, formatted as oxfmt formats it. */
  readonly code: string;
  readonly diagnostics: readonly Diagnostic[];
}

/**
 * Builder code for `workflow`: an ES module exporting the workflow, built with
 * the generated types over `options.schemaName`. Nodes keep their ids and titles and come in
 * dependency order; inputs equal to their default are left out, since the exporter fills them
 * in. Running it and exporting gives the same prompt as `toApi(workflow)`, except that ids that
 * aren't integers (`40:31`) come in dependency order, where the workflow lists one before a node
 * it depends on. Pure and deterministic.
 *
 * Reports `W_TRANSPILED_AS_RAW` for a node the types can't express, which is written as
 * `raw(…)`, and `E_DEPENDENCY_CYCLE` and `E_DANGLING_LINK` for what no program can build: those
 * nodes, or links, are left out.
 */
export function transpile(workflow: Workflow, options: TranspileOptions): TranspileResult {
  const problem = transpileNameProblem(options);
  if (problem !== undefined) throw new TypeError(`transpile: ${problem}`);
  return new Transpiler(workflow, options).run();
}

/**
 * Why {@link transpile} refuses these names, or `undefined` when it takes them: each must pass
 * `exportNameProblem`, they must differ, and the declaration
 * `export const <name>: Workflow<NodesOf<typeof <schemaName>>> =` must fit on one line.
 */
export function transpileNameProblem(
  options: Pick<TranspileOptions, "name" | "schemaName">,
): string | undefined {
  for (const [label, value] of [
    ["name", options.name],
    ["schema name", options.schemaName],
  ] as const) {
    const problem = exportNameProblem(value);
    if (problem !== undefined) return `the ${label} ${JSON.stringify(value)} won't do: ${problem}`;
  }
  if (options.name === options.schemaName) {
    return `the name and the schema name are both ${JSON.stringify(options.name)}`;
  }
  const left = declarationLeft(options);
  // Export names are ASCII, so their length is their width.
  if (textWidth(left) > PRINT_WIDTH) {
    return `the declaration \`${left}\` is wider than ${String(PRINT_WIDTH)} columns`;
  }
  return undefined;
}

/** How one node is written. */
interface Plan {
  readonly node: GraphNode;
  readonly definition: NodeDef | undefined;
  readonly mode: WriteMode;
  /** The node's exported inputs, which a raw node is written with; links are `[id, slot]`. */
  readonly wire: { readonly [key: string]: JsonValue };
}

class Transpiler {
  readonly #workflow: Workflow;
  readonly #options: TranspileOptions;
  readonly #diagnostics: Diagnostic[] = [];
  readonly #plans = new Map<NodeId, Plan>();
  readonly #references = new Map<string, Doc>();
  readonly #inlined = new Set<NodeId>();
  readonly #usedSlots = new Map<NodeId, Set<number>>();
  readonly #names: NameRegistry;
  #usesN = false;
  #usesRaw = false;
  #layout: Layout = "hug";

  constructor(workflow: Workflow, options: TranspileOptions) {
    this.#workflow = workflow;
    this.#options = options;
    this.#names = new NameRegistry([...TRANSPILED_MODULE_NAMES, options.name, options.schemaName]);
  }

  run(): TranspileResult {
    const nodes = [...this.#workflow.graph.nodes.values()];
    // Before modes: a bypassed or muted raw node is written with its own inputs.
    const exported = exportApi(this.#workflow, { validate: false, meta: false, modes: false });
    // What the exporter can't send, the program can't build either.
    this.#diagnostics.push(...exported.diagnostics);
    const order = this.#order(nodes);
    // A link to an output a node doesn't have can only be written as raw(…).output(slot).
    const missing = new Map<NodeId, number>();
    for (const node of nodes) {
      for (const ref of references(node.inputs)) {
        const source = this.#workflow.graph.nodes.get(ref.node);
        const outputs =
          source === undefined ? undefined : this.#workflow.schema.nodes[source.classType]?.outputs;
        if (outputs !== undefined && outputs[ref.slot] === undefined) {
          missing.set(ref.node, ref.slot);
        }
      }
    }
    // In dependency order, so a node's sources are decided first: a raw source is `Out<"*">`.
    const typing = new Typing(this.#workflow, (id) => this.#plans.get(id)?.mode);
    for (const node of order) {
      const definition = Object.hasOwn(this.#workflow.schema.nodes, node.classType)
        ? this.#workflow.schema.nodes[node.classType]
        : undefined;
      const slot = missing.get(node.id);
      const reason =
        node.raw || definition === undefined
          ? undefined
          : slot === undefined
            ? typing.problem(node, definition)
            : `output ${String(slot)} is linked, but it has no such output`;
      if (reason !== undefined) {
        this.#diagnostics.push(
          createDiagnostic(
            "W_TRANSPILED_AS_RAW",
            [node.id],
            `Node ${node.id} (${node.classType}) is written as raw(…): ${reason}.`,
          ),
        );
      }
      this.#plans.set(node.id, {
        node,
        definition,
        mode: node.raw || definition === undefined || reason !== undefined ? "raw" : "typed",
        wire: exported.prompt[node.id]?.inputs ?? {},
      });
    }
    const plans = order.flatMap((node) => this.#plans.get(node.id) ?? []);
    this.#usesN = plans.some((plan) => plan.mode === "typed");
    this.#usesRaw = plans.some((plan) => plan.mode === "raw");
    // Known before any statement: how deep the statements sit decides their layout.
    this.#layout = declarationLayout(this.#options, this.#build(), plans.length === 0);
    const uses = this.#uses(plans);
    const statements: Doc[] = [];
    for (const plan of plans) {
      const statement = this.#statement(plan, uses);
      if (statement !== undefined) statements.push(statement);
    }
    return { code: this.#module(statements), diagnostics: this.#diagnostics };
  }

  /**
   * Dependency order, ties broken by graph order. No program can build a cycle, or a node that
   * depends on one: they are reported and left out.
   */
  #order(nodes: readonly GraphNode[]): GraphNode[] {
    const index = new Map(nodes.map((node, position) => [node.id, position]));
    const dependents = new Map<NodeId, NodeId[]>();
    const waiting = new Map<NodeId, number>();
    for (const node of nodes) {
      const sources = new Set(
        references(node.inputs).flatMap((ref) => (index.has(ref.node) ? [ref.node] : [])),
      );
      waiting.set(node.id, sources.size);
      for (const source of sources) {
        const list = dependents.get(source);
        if (list === undefined) dependents.set(source, [node.id]);
        else list.push(node.id);
      }
    }
    const ready = new MinHeap();
    for (const node of nodes) if (waiting.get(node.id) === 0) ready.push(index.get(node.id) ?? 0);
    const order: GraphNode[] = [];
    for (let at = ready.pop(); at !== undefined; at = ready.pop()) {
      const node = nodes[at];
      if (node === undefined) continue;
      order.push(node);
      for (const dependent of dependents.get(node.id) ?? []) {
        const left = (waiting.get(dependent) ?? 0) - 1;
        waiting.set(dependent, left);
        if (left === 0) ready.push(index.get(dependent) ?? 0);
      }
    }
    const left = nodes.filter((node) => (waiting.get(node.id) ?? 0) > 0);
    const cyclic = inCycles(left);
    for (const node of left) {
      this.#diagnostics.push(
        createDiagnostic(
          "E_DEPENDENCY_CYCLE",
          [node.id],
          cyclic.has(node.id)
            ? `Node ${node.id} (${node.classType}) depends on itself through its links; leaving it out.`
            : `Node ${node.id} (${node.classType}) depends on nodes in a cycle; leaving it out.`,
        ),
      );
    }
    return order;
  }

  /** How often each output (`id`, `slot`) is used by what will be printed. */
  #uses(plans: readonly Plan[]): Map<string, number> {
    const uses = new Map<string, number>();
    for (const plan of plans) {
      // A raw node prints its exported inputs, which may drop what the exporter can't send.
      const refs =
        plan.mode === "raw"
          ? Object.values(plan.wire).flatMap((value) =>
              isLink(value) ? [{ node: value[0], slot: value[1] }] : [],
            )
          : references(plan.node.inputs);
      for (const ref of refs) {
        const key = slotKey(ref.node, ref.slot);
        uses.set(key, (uses.get(key) ?? 0) + 1);
        const slots = this.#usedSlots.get(ref.node);
        if (slots === undefined) this.#usedSlots.set(ref.node, new Set([ref.slot]));
        else slots.add(ref.slot);
      }
    }
    return uses;
  }

  /** The statement for one node, or `undefined` when it is inlined into its only use. */
  #statement(plan: Plan, uses: ReadonlyMap<string, number>): Doc | undefined {
    const { node, definition } = plan;
    const options = this.#nodeOptions(node);
    if (plan.mode === "raw" || definition === undefined) {
      const call = callDoc("raw", [quote(node.classType), this.#wireObject(plan), options]);
      const slots = this.#usedSlots.get(node.id);
      if (slots === undefined) return [call, ";"];
      const name = this.#claim(camel(node.classType, "node"));
      for (const slot of slots) {
        this.#references.set(slotKey(node.id, slot), [name, ".output(", String(slot), ")"]);
      }
      return statementDoc(`const ${name}`, call);
    }
    const callee = /^[A-Za-z_$][\w$]*$/.test(node.classType)
      ? `n.${node.classType}`
      : `n[${quote(node.classType)}]`;
    const call = callDoc(callee, [this.#inputsObject(definition.inputs, node.inputs).doc, options]);
    const { outputs } = definition;
    const used = outputs.filter((output) => (uses.get(slotKey(node.id, output.index)) ?? 0) > 0);
    if (used.length === 0) return [call, ";"];
    if (outputs.length === 1) {
      const key = slotKey(node.id, 0);
      // Used once, by a node written later, and inlining nothing itself: written in place. Not
      // with an id that isn't an array index: such keys keep the order nodes are created in.
      if (
        this.#options.inline !== false &&
        isArrayIndex(node.id) &&
        uses.get(key) === 1 &&
        references(node.inputs).every((ref) => !this.#inlined.has(ref.node))
      ) {
        this.#inlined.add(node.id);
        this.#references.set(key, call);
        return undefined;
      }
      const name = this.#claim(camel(outputs[0]?.name ?? node.classType, "output"));
      this.#references.set(key, name);
      return statementDoc(`const ${name}`, call);
    }
    // Several outputs: destructure the ones used, by their names, while the pattern fits on its
    // line (Prettier would break a longer one); otherwise index one variable.
    const last = Math.max(...used.map((output) => output.index));
    const bindings = outputs
      .slice(0, last + 1)
      .map((output) => (used.includes(output) ? this.#claim(camel(output.name, "output")) : ""));
    const pattern = `const [${bindings.join(", ")}] =`;
    if (STATEMENT_INDENT[this.#layout] + textWidth(pattern) <= PRINT_WIDTH) {
      for (const [index, binding] of bindings.entries()) {
        if (binding !== "") this.#references.set(slotKey(node.id, index), binding);
      }
      return statementDoc(`const [${bindings.join(", ")}]`, call);
    }
    const name = this.#claim(camel(node.classType, "node"));
    for (const output of used) {
      this.#references.set(slotKey(node.id, output.index), [name, "[", String(output.index), "]"]);
    }
    return statementDoc(`const ${name}`, call);
  }

  #claim(base: string): string {
    // A word no export may be gets a suffix, except the module's own names, which the registry
    // holds: those get a number, like any other taken name.
    const usable = isExportName(base) || TRANSPILED_MODULE_NAMES.includes(base);
    return this.#names.claim(usable ? base : `${base}Node`);
  }

  /** `{ id: "5" }`, and the title and mode if there are. */
  #nodeOptions(node: GraphNode): Doc {
    return objectDoc([
      propertyDoc("id", quote(node.id)),
      ...(node.title === undefined ? [] : [propertyDoc("title", quote(node.title))]),
      ...(node.mode === undefined ? [] : [propertyDoc("mode", quote(node.mode))]),
    ]);
  }

  /**
   * Inputs as an object literal, in the order given (the exporter orders them by the schema).
   * Values equal to their default are left out at every level, as the exporter fills them in.
   * Also returns how many properties were written.
   */
  #inputsObject(
    definitions: readonly InputDef[],
    inputs: { readonly [name: string]: InputValue },
  ): { readonly doc: Doc; readonly count: number } {
    const known = new Map(definitions.map((input) => [input.name, input]));
    const properties: Doc[] = [];
    for (const [name, value] of Object.entries(inputs)) {
      const definition = known.get(name);
      // The exporter fills defaults in; but what the types require must be written.
      if (definition !== undefined && !isRequired(definition) && equalsDefault(definition, value)) {
        continue;
      }
      const key = objectKey(name);
      const doc = this.#value(value, definition);
      // `{ model }` rather than `{ model: model }`.
      properties.push(doc === key ? key : propertyDoc(key, doc));
    }
    return { doc: objectDoc(properties), count: properties.length };
  }

  /** A structured value as an expression. */
  #value(value: InputValue, definition: InputDef | undefined): Doc {
    if (isOutputRef(value)) return this.#reference(value.node, value.slot);
    if (isList(value)) {
      if (definition?.kind === "dynamicGroup") {
        const rows = value.map((row) =>
          isPlainObject(row)
            ? this.#inputsObject(definition.fields, row)
            : { doc: this.#value(row, undefined), count: 0 },
        );
        // Rows as printed, defaults left out, decide whether the list must break.
        const breaks = rows.length > 1 && rows.every((row) => row.count > 1);
        return arrayDoc(
          rows.map((row) => row.doc),
          breaks,
        );
      }
      const element = definition?.kind === "autogrow" ? definition.template : undefined;
      if (isNumberList(value)) return numbersDoc(value);
      return arrayDoc(
        value.map((item: InputValue) => this.#value(item, element)),
        breaksArray(value),
      );
    }
    if (isPlainObject(value)) {
      if (definition?.kind === "dynamicCombo" && typeof value["option"] === "string") {
        const key = value["option"];
        const chosen = definition.options.find((option) => option.key === key);
        const children = value["inputs"];
        const inputs = isPlainObject(children)
          ? this.#inputsObject(chosen?.inputs ?? [], children)
          : undefined;
        // With every option input at its default, the key alone says the same.
        if (inputs === undefined || inputs.count === 0) return quote(key);
        return objectDoc([propertyDoc("option", quote(key)), propertyDoc("inputs", inputs.doc)]);
      }
      const element = definition?.kind === "autogrow" ? definition.template : undefined;
      return objectDoc(
        Object.entries(value).map(([key, item]) =>
          propertyDoc(objectKey(key), this.#value(item, element)),
        ),
      );
    }
    return scalarDoc(value);
  }

  /** A raw node's inputs: wire keys, links as references, lists unwrapped (raw wraps them). */
  #wireObject(plan: Plan): Doc {
    return objectDoc(
      Object.entries(plan.wire).flatMap(([key, value]): Doc[] => {
        if (isLink(value)) {
          const [node, slot] = value;
          if (!this.#workflow.graph.nodes.has(node)) {
            this.#dangling(plan.node.id, key, node);
            return [];
          }
          return [propertyDoc(objectKey(key), this.#reference(node, slot))];
        }
        const unwrapped = isWrappedList(value) ? value["__value__"] : value;
        return [propertyDoc(objectKey(key), jsonDoc(unwrapped ?? null))];
      }),
    );
  }

  #reference(node: NodeId, slot: number): Doc {
    const reference = this.#references.get(slotKey(node, slot));
    // Sources are written before their uses, and left-out nodes have no uses written.
    if (reference === undefined)
      throw new Error(`transpile: no reference for ${node}:${String(slot)}`);
    return reference;
  }

  #dangling(id: NodeId, key: string, node: NodeId): void {
    this.#diagnostics.push(
      createDiagnostic(
        "E_DANGLING_LINK",
        [id, "inputs", key],
        `Input ${key} of node ${id} links to node ${node}, which the workflow doesn't have; leaving it out.`,
      ),
    );
  }

  /** The build function's head: `({ n, raw }) =>` with what the statements use. */
  #build(): string {
    const context = [...(this.#usesN ? ["n"] : []), ...(this.#usesRaw ? ["raw"] : [])];
    return `(${context.length === 0 ? "" : `{ ${context.join(", ")} }`}) =>`;
  }

  #module(statements: readonly Doc[]): string {
    const header = [
      `Transpiled by @tscomfy/codegen ${CODEGEN_VERSION}.`,
      ...(this.#options.header ?? []),
    ];
    const { schemaName } = this.#options;
    const block: Doc =
      statements.length === 0
        ? "{}"
        : ["{", indent([hardline, join(hardline, statements)]), hardline, "}"];
    return [
      ...headerLines(header),
      "",
      'import { type NodesOf, type Workflow, workflow } from "@tscomfy/core";',
      `import { ${schemaName} } from ${quote(this.#options.schemaModule)};`,
      "",
      print(declarationDoc(this.#options, this.#build(), block, this.#layout), PRINT_WIDTH),
      "",
    ].join("\n");
  }
}

/** The nodes of `nodes` that lie on a cycle among them (Tarjan's algorithm, iteratively). */
function inCycles(nodes: readonly GraphNode[]): Set<NodeId> {
  const ids = new Set(nodes.map((node) => node.id));
  const edges = new Map(
    nodes.map((node) => [
      node.id,
      [...new Set(references(node.inputs).map((ref) => ref.node))].filter((id) => ids.has(id)),
    ]),
  );
  const order = new Map<NodeId, number>();
  const low = new Map<NodeId, number>();
  const stack: NodeId[] = [];
  const onStack = new Set<NodeId>();
  const cyclic = new Set<NodeId>();
  let counter = 0;
  for (const start of ids) {
    if (order.has(start)) continue;
    const frames: { readonly id: NodeId; next: number }[] = [{ id: start, next: 0 }];
    order.set(start, counter);
    low.set(start, counter++);
    stack.push(start);
    onStack.add(start);
    while (frames.length > 0) {
      const frame = frames.at(-1);
      if (frame === undefined) break;
      const targets = edges.get(frame.id) ?? [];
      const target = targets[frame.next++];
      if (target !== undefined) {
        if (!order.has(target)) {
          order.set(target, counter);
          low.set(target, counter++);
          stack.push(target);
          onStack.add(target);
          frames.push({ id: target, next: 0 });
        } else if (onStack.has(target)) {
          low.set(frame.id, Math.min(low.get(frame.id) ?? 0, order.get(target) ?? 0));
        }
        continue;
      }
      frames.pop();
      const parent = frames.at(-1);
      if (parent !== undefined) {
        low.set(parent.id, Math.min(low.get(parent.id) ?? 0, low.get(frame.id) ?? 0));
      }
      if (low.get(frame.id) !== order.get(frame.id)) continue;
      const component: NodeId[] = [];
      for (let id = stack.pop(); id !== undefined; id = stack.pop()) {
        onStack.delete(id);
        component.push(id);
        if (id === frame.id) break;
      }
      const self = (edges.get(frame.id) ?? []).includes(frame.id);
      if (component.length > 1 || self) for (const id of component) cyclic.add(id);
    }
  }
  return cyclic;
}

/** Whether a key is an array index, which objects order numerically rather than by creation. */
function isArrayIndex(key: string): boolean {
  return /^(?:0|[1-9][0-9]{0,9})$/.test(key) && Number(key) < 2 ** 32 - 1;
}

/** A binary min-heap of graph positions, for the dependency order's ready list. */
class MinHeap {
  readonly #items: number[] = [];

  push(value: number): void {
    const items = this.#items;
    items.push(value);
    for (let at = items.length - 1; at > 0;) {
      const parent = (at - 1) >> 1;
      const [up, down] = [items[at] ?? 0, items[parent] ?? 0];
      if (down <= up) break;
      items[at] = down;
      items[parent] = up;
      at = parent;
    }
  }

  pop(): number | undefined {
    const items = this.#items;
    const top = items[0];
    const last = items.pop();
    if (top === undefined || last === undefined || items.length === 0) return top;
    items[0] = last;
    for (let at = 0; ;) {
      const [left, right] = [2 * at + 1, 2 * at + 2];
      let smallest = at;
      if (left < items.length && (items[left] ?? 0) < (items[smallest] ?? 0)) smallest = left;
      if (right < items.length && (items[right] ?? 0) < (items[smallest] ?? 0)) smallest = right;
      if (smallest === at) break;
      const [a, b] = [items[at] ?? 0, items[smallest] ?? 0];
      items[at] = b;
      items[smallest] = a;
      at = smallest;
    }
    return top;
  }
}

/** Whether a value equals what the exporter would send for the input when left out. */
function equalsDefault(input: InputDef, value: InputValue): boolean {
  if (!hasDefault(input) || isOutputRef(value)) return false;
  const fallback = "default" in input ? input.default : undefined;
  return fallback !== undefined && stringify(fallback) === stringify(toJson(value));
}

/** A structured value without references, as JSON; references compare as `null`. */
function toJson(value: InputValue): JsonValue {
  if (isOutputRef(value)) return null;
  if (isList(value)) return value.map(toJson);
  if (isPlainObject(value)) {
    return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, toJson(item)]));
  }
  return value;
}

function slotKey(node: NodeId, slot: number): string {
  return `${node}\u0000${String(slot)}`;
}

function isLink(value: JsonValue): value is readonly [string, number] {
  return (
    isList(value) &&
    value.length === 2 &&
    typeof value[0] === "string" &&
    typeof value[1] === "number"
  );
}

function isWrappedList(value: JsonValue): value is { readonly __value__: readonly JsonValue[] } {
  return (
    typeof value === "object" &&
    value !== null &&
    !isList(value) &&
    Object.keys(value).length === 1 &&
    isList(value["__value__"])
  );
}

/**
 * A camelCase variable name from a ComfyUI name, split at case changes: `LATENT` → `latent`,
 * `VAEDecode` → `vaeDecode`, `CLIP_VISION` → `clipVision`. Never empty, never a leading digit.
 */
function camel(name: string, fallback: string): string {
  const words = name.match(/[A-Z]+(?![a-z])|[A-Z]?[a-z]+|[0-9]+/g) ?? [];
  const joined = words
    .map((word, index) => {
      const lower = word.toLowerCase();
      return index === 0 ? lower : lower.charAt(0).toUpperCase() + lower.slice(1);
    })
    .join("");
  if (joined === "") return fallback;
  return /^[0-9]/.test(joined) ? `${fallback}${joined}` : joined;
}
