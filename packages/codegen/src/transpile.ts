// Workflow → TypeScript (docs/plan.md §10): the builder code that rebuilds a workflow over the
// generated types. Nodes the types can express become `n.Class(…)` calls; the rest become
// `raw(…)` with their wire keys, so the program always rebuilds the same prompt.
//
// Whether the types can express a node is decided here by the same rules `emit-types.ts` writes
// the types with (§6.2, §6.3), so the output compiles: a test type-checks it for every mock and
// for the corpus.

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
  type OutputDef,
  type SocketType,
  sendsValue,
  stringify,
  type Workflow,
} from "@tscomfy/core";
import {
  type Doc,
  group,
  groupId,
  hardline,
  ifBreak,
  indent,
  indentIfBreak,
  join,
  line,
  print,
  softline,
  textWidth,
} from "./doc.ts";
import { isExportName } from "./emit-schema-module.ts";
import { forcedRowField, hasDefault, headerLines, isRequired, PRINT_WIDTH } from "./emit-types.ts";
import { CODEGEN_VERSION } from "./generate.ts";
import { NameRegistry, propertyKey, quote } from "./names.ts";

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
 * Builder code for `workflow` (docs/plan.md §10): an ES module exporting the workflow, built with
 * the generated types over `options.schemaName`. Nodes keep their ids and titles and come in
 * dependency order; inputs equal to their default are left out, since the exporter fills them
 * in. Running it and exporting gives the same prompt as `toApi(workflow)`, except that ids that
 * aren't integers may come in another order. Pure and deterministic.
 *
 * Reports `W_TRANSPILED_AS_RAW` for a node the types can't express, which is written as
 * `raw(…)`, and `E_DEPENDENCY_CYCLE` and `E_DANGLING_LINK` for what no program can build: those
 * nodes, or links, are left out.
 */
export function transpile(workflow: Workflow, options: TranspileOptions): TranspileResult {
  for (const [option, value] of [
    ["name", options.name],
    ["schemaName", options.schemaName],
  ] as const) {
    if (!isExportName(value)) {
      throw new TypeError(
        `transpile: options.${option} ${JSON.stringify(value)} is not an identifier`,
      );
    }
  }
  if (options.name === options.schemaName) {
    throw new TypeError("transpile: options.name and options.schemaName must differ");
  }
  return new Transpiler(workflow, options).run();
}

/** How one node is written. */
interface Plan {
  readonly node: GraphNode;
  readonly definition: NodeDef | undefined;
  /** `typed`: `n.Class(…)`; `raw`: `raw(…)` with wire keys. */
  readonly mode: "typed" | "raw";
  /** Wire inputs, for raw nodes; links are `[id, slot]`. */
  readonly wire: { readonly [key: string]: JsonValue };
}

/** How a link's source output is referred to. */
type Reference = Doc;

class Transpiler {
  readonly #workflow: Workflow;
  readonly #options: TranspileOptions;
  readonly #diagnostics: Diagnostic[] = [];
  readonly #plans = new Map<NodeId, Plan>();
  readonly #references = new Map<string, Reference>();
  readonly #inlined = new Map<NodeId, Doc>();
  readonly #usedSlots = new Map<NodeId, Set<number>>();
  readonly #names: NameRegistry;
  #usesN = false;
  #usesRaw = false;

  constructor(workflow: Workflow, options: TranspileOptions) {
    this.#workflow = workflow;
    this.#options = options;
    this.#names = new NameRegistry(["n", "raw", "workflow", options.name, options.schemaName]);
  }

  run(): TranspileResult {
    const nodes = [...this.#workflow.graph.nodes.values()];
    const wire = exportApi(this.#workflow, { validate: false, meta: false }).prompt;
    const typing = new Typing(this.#workflow);
    // A link to an output a node doesn't have can only be written as raw(…).output(slot).
    const missing = new Map<NodeId, number>();
    for (const node of nodes) {
      for (const ref of references(node.inputs)) {
        const source = this.#workflow.graph.nodes.get(ref.node);
        const outputs =
          source === undefined ? undefined : this.#workflow.schema.nodes[source.classType]?.outputs;
        if (outputs !== undefined && outputs[ref.slot] === undefined)
          missing.set(ref.node, ref.slot);
      }
    }
    for (const node of nodes) {
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
        wire: wire[node.id]?.inputs ?? {},
      });
    }
    const order = this.#order(nodes);
    const uses = this.#uses(order);
    const statements: Doc[] = [];
    for (const plan of order) {
      const statement = this.#statement(plan, uses);
      if (statement !== undefined) statements.push(statement);
    }
    return { code: this.#module(statements), diagnostics: this.#diagnostics };
  }

  /**
   * Dependency order, ties broken by graph order. Nodes in a cycle can't be built by any
   * program; they are reported and left out.
   */
  #order(nodes: readonly GraphNode[]): Plan[] {
    const index = new Map(nodes.map((node, position) => [node.id, position]));
    const dependents = new Map<NodeId, NodeId[]>();
    const waiting = new Map<NodeId, number>();
    for (const node of nodes) {
      const sources = new Set(
        references(node.inputs).flatMap((ref) => (index.has(ref.node) ? [ref.node] : [])),
      );
      waiting.set(node.id, sources.size);
      for (const source of sources)
        dependents.set(source, [...(dependents.get(source) ?? []), node.id]);
    }
    // A min-heap would do; the ready list stays short in real graphs, so insertion sort is fine.
    const ready = nodes.filter((node) => waiting.get(node.id) === 0).map((node) => node.id);
    const order: Plan[] = [];
    while (ready.length > 0) {
      const id = ready.shift();
      if (id === undefined) break;
      const plan = this.#plans.get(id);
      if (plan !== undefined) order.push(plan);
      for (const dependent of dependents.get(id) ?? []) {
        const left = (waiting.get(dependent) ?? 0) - 1;
        waiting.set(dependent, left);
        if (left === 0) {
          const at = index.get(dependent) ?? 0;
          const position = ready.findIndex((each) => (index.get(each) ?? 0) > at);
          ready.splice(position === -1 ? ready.length : position, 0, dependent);
        }
      }
    }
    for (const node of nodes) {
      if ((waiting.get(node.id) ?? 0) > 0) {
        this.#diagnostics.push(
          createDiagnostic(
            "E_DEPENDENCY_CYCLE",
            [node.id],
            `Node ${node.id} (${node.classType}) depends on itself through its links; leaving it out.`,
          ),
        );
      }
    }
    return order;
  }

  /** How often each output (`id`, `slot`) is used, over the nodes that will be written. */
  #uses(order: readonly Plan[]): Map<string, number> {
    const uses = new Map<string, number>();
    for (const plan of order) {
      for (const ref of references(plan.node.inputs)) {
        const key = slotKey(ref.node, ref.slot);
        uses.set(key, (uses.get(key) ?? 0) + 1);
        const slots = this.#usedSlots.get(ref.node) ?? new Set<number>();
        slots.add(ref.slot);
        this.#usedSlots.set(ref.node, slots);
      }
    }
    return uses;
  }

  /** The statement for one node, or `undefined` when it is inlined into its only use. */
  #statement(plan: Plan, uses: ReadonlyMap<string, number>): Doc | undefined {
    const { node, definition } = plan;
    const options = this.#nodeOptions(node);
    if (plan.mode === "raw" || definition === undefined) {
      this.#usesRaw = true;
      const call = callDoc("raw", [quote(node.classType), this.#wireObject(plan), options]);
      const slots = this.#usedSlots.get(node.id);
      if (slots === undefined) return [call, ";"];
      const name = this.#claim(camel(node.classType, "node"));
      for (const slot of [...slots].toSorted((a, b) => a - b)) {
        this.#references.set(slotKey(node.id, slot), [name, ".output(", String(slot), ")"]);
      }
      return statementDoc(`const ${name}`, call);
    }
    this.#usesN = true;
    const callee =
      isExportName(node.classType) || /^[A-Za-z_$][\w$]*$/.test(node.classType)
        ? `n.${node.classType}`
        : `n[${quote(node.classType)}]`;
    const call = callDoc(callee, [this.#inputsObject(definition.inputs, node.inputs).doc, options]);
    const { outputs } = definition;
    const used = outputs.filter((output) => (uses.get(slotKey(node.id, output.index)) ?? 0) > 0);
    if (used.length === 0) return [call, ";"];
    if (outputs.length === 1) {
      const key = slotKey(node.id, 0);
      // Used once, by a node written later, and inlining nothing itself: written in place.
      if (
        this.#options.inline !== false &&
        uses.get(key) === 1 &&
        references(node.inputs).every((ref) => !this.#inlined.has(ref.node))
      ) {
        this.#inlined.set(node.id, call);
        this.#references.set(key, call);
        return undefined;
      }
      const name = this.#claim(camel(outputs[0]?.name ?? node.classType, "output"));
      this.#references.set(key, name);
      return statementDoc(`const ${name}`, call);
    }
    // Several outputs: destructure the ones used, by their names.
    const last = Math.max(...used.map((output) => output.index));
    const bindings = outputs.slice(0, last + 1).map((output) => {
      if (!used.includes(output)) return "";
      const name = this.#claim(camel(output.name, "output"));
      this.#references.set(slotKey(node.id, output.index), name);
      return name;
    });
    return statementDoc(`const [${bindings.join(", ")}]`, call);
  }

  #claim(base: string): string {
    return this.#names.claim(isExportName(base) ? base : `${base}Node`);
  }

  /** `{ id: "5" }`, and the title if there is one. */
  #nodeOptions(node: GraphNode): Doc {
    return objectDoc([
      propertyDoc("id", quote(node.id)),
      ...(node.title === undefined ? [] : [propertyDoc("title", quote(node.title))]),
    ]);
  }

  /**
   * A typed node's inputs as an object literal, in schema order; at the top level, inputs equal
   * to their default are left out (`omitDefaults`), as the exporter fills them back in.
   */
  #inputsObject(
    definitions: readonly InputDef[],
    inputs: { readonly [name: string]: InputValue },
  ): { readonly doc: Doc; readonly count: number } {
    const known = new Map(definitions.map((input) => [input.name, input]));
    const properties: Doc[] = [];
    for (const [name, value] of Object.entries(inputs)) {
      const definition = known.get(name);
      if (definition !== undefined && equalsDefault(definition, value)) continue;
      const key = propertyKey(name);
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
      if (definition?.kind === "autogrow") {
        return objectDoc(
          Object.entries(value).map(([slot, item]) =>
            propertyDoc(propertyKey(slot), this.#value(item, definition.template)),
          ),
        );
      }
      return objectDoc(
        Object.entries(value).map(([key, item]) =>
          propertyDoc(propertyKey(key), this.#value(item, undefined)),
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
          return [propertyDoc(propertyKey(key), this.#reference(node, slot))];
        }
        const unwrapped = isWrappedList(value) ? value["__value__"] : value;
        return [propertyDoc(propertyKey(key), jsonDoc(unwrapped ?? null))];
      }),
    );
  }

  #reference(node: NodeId, slot: number): Doc {
    return this.#references.get(slotKey(node, slot)) ?? "undefined";
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

  #module(statements: readonly Doc[]): string {
    const context = [...(this.#usesN ? ["n"] : []), ...(this.#usesRaw ? ["raw"] : [])];
    const header = [
      `Transpiled by @tscomfy/codegen ${CODEGEN_VERSION}.`,
      ...(this.#options.header ?? []),
    ];
    const { name, schemaName } = this.#options;
    const left = `export const ${name}: Workflow<NodesOf<typeof ${schemaName}>> = workflow(`;
    const build = `(${context.length === 0 ? "" : `{ ${context.join(", ")} }`}) =>`;
    const block: Doc =
      statements.length === 0
        ? "{}"
        : ["{", indent([hardline, join(hardline, statements)]), hardline, "}"];
    // The build function hugs the call while its first line fits; otherwise each argument
    // takes a line of its own, as Prettier lays out a last-argument function.
    const hugged = textWidth(`${left}${schemaName}, ${build} {`) <= PRINT_WIDTH;
    const body: Doc = hugged
      ? [left, schemaName, ", ", build, " ", block, ");"]
      : [
          left,
          indent([hardline, schemaName, ",", hardline, build, " ", block, ","]),
          hardline,
          ");",
        ];
    return [
      ...headerLines(header),
      "",
      'import { type NodesOf, type Workflow, workflow } from "@tscomfy/core";',
      `import { ${this.#options.schemaName} } from ${quote(this.#options.schemaModule)};`,
      "",
      print(body, PRINT_WIDTH),
      "",
    ].join("\n");
  }
}

/**
 * Whether the generated types can express a node's inputs, by the rules `emit-types.ts` types
 * them with. Returns why not, or `undefined`.
 */
class Typing {
  readonly #workflow: Workflow;
  /** Resolved MatchType parameters by node and template. */
  readonly #parameters = new Map<string, Atom>();

  constructor(workflow: Workflow) {
    this.#workflow = workflow;
  }

  problem(node: GraphNode, definition: NodeDef): string | undefined {
    const scope: Scope = { node, definition };
    return this.#inputs(scope, definition.inputs, node.inputs, undefined, node.classType);
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
    const members = definitions.filter(
      (input) => input.kind !== "value" || sendsValue(input.widget),
    );
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
        if (index < required) return `${where} needs ${slot}`;
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
    if (node === undefined) return undefined;
    const definition = Object.hasOwn(this.#workflow.schema.nodes, node.classType)
      ? this.#workflow.schema.nodes[node.classType]
      : undefined;
    if (node.raw || definition === undefined) return STAR;
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

/** Every output reference in a node's inputs, depth-first. */
function references(
  value: InputValue | { readonly [name: string]: InputValue },
): { readonly node: NodeId; readonly slot: number }[] {
  if (isOutputRef(value)) return [{ node: value.node, slot: value.slot }];
  if (isList(value)) return value.flatMap(references);
  if (typeof value === "object" && value !== null) return Object.values(value).flatMap(references);
  return [];
}

function slotKey(node: NodeId, slot: number): string {
  return `${node}\u0000${String(slot)}`;
}

function isPlainObject(
  value: InputValue | undefined,
): value is { readonly [key: string]: InputValue } {
  return typeof value === "object" && value !== null && !isList(value) && !isOutputRef(value);
}

function isLink(value: JsonValue): value is readonly [string, number] {
  return (
    isList(value) &&
    value.length === 2 &&
    typeof value[0] === "string" &&
    typeof value[1] === "number"
  );
}

function isList<T extends InputValue | JsonValue>(
  value: T | undefined,
): value is Extract<T, readonly unknown[]> {
  return Array.isArray(value);
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

// Expression layout, as oxfmt prints it (Prettier's rules for calls, objects and arrays).

/** A call: arguments on one line, or one per line. */
function callDoc(callee: string, args: readonly Doc[]): Doc {
  return group([
    callee,
    "(",
    indent([softline, join([",", line], args)]),
    ifBreak(","),
    softline,
    ")",
  ]);
}

/** `const x = …;`, breaking inside the call rather than after `=`. */
function statementDoc(left: string, call: Doc): Doc {
  const id = groupId("statement");
  return group([left, " =", group(indent(line), id), indentIfBreak([call, ";"], id)]);
}

function objectDoc(properties: readonly Doc[]): Doc {
  if (properties.length === 0) return "{}";
  return group(["{", indent([line, join([",", line], properties)]), ifBreak(","), line, "}"]);
}

/**
 * An array. Prettier always breaks an array of two or more objects or arrays that each have
 * more than one element.
 */
function arrayDoc(items: readonly Doc[], breaks = false): Doc {
  if (items.length === 0) return "[]";
  if (breaks) return ["[", indent([hardline, join([",", hardline], items)]), ",", hardline, "]"];
  return group(["[", indent([softline, join([",", line], items)]), ifBreak(","), softline, "]"]);
}

/** `key: value`; a scalar stays on the key's line, anything else may move below it. */
function propertyDoc(key: string, value: Doc): Doc {
  if (typeof value === "string" && !value.startsWith('"') && !value.startsWith("'")) {
    return [key, ": ", value];
  }
  const id = groupId("property");
  return group([key, ":", group(indent(line), id), indentIfBreak(value, id)]);
}

function scalarDoc(value: string | number | bigint | boolean | null): Doc {
  if (typeof value === "string") return quote(value);
  if (typeof value === "bigint") return `${String(value)}n`;
  if (typeof value === "number") return Object.is(value, -0) ? "-0" : String(value);
  return String(value);
}

/**
 * Whether Prettier breaks an array whatever its width: two or more elements, all objects with
 * more than one key or all arrays with more than one element.
 */
/** "object" or "array" for an element with more than one entry. */
function many(item: InputValue | JsonValue): "object" | "array" | undefined {
  if (isList(item)) return item.length > 1 ? "array" : undefined;
  if (typeof item === "object" && item !== null && !isOutputRef(item)) {
    return Object.keys(item).length > 1 ? "object" : undefined;
  }
  return undefined;
}

function breaksArray(items: readonly (InputValue | JsonValue)[]): boolean {
  const first = items[0] === undefined ? undefined : many(items[0]);
  return items.length > 1 && first !== undefined && items.every((item) => many(item) === first);
}

/** A JSON value as an expression. */
function jsonDoc(value: JsonValue): Doc {
  if (isList(value)) return arrayDoc(value.map(jsonDoc), breaksArray(value));
  if (typeof value === "object" && value !== null) {
    return objectDoc(
      Object.entries(value).map(([key, item]) => propertyDoc(propertyKey(key), jsonDoc(item))),
    );
  }
  return scalarDoc(value);
}
