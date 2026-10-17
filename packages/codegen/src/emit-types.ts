// Emits `nodes.ts`: the `Nodes` interface and every type it refers to (docs/plan.md §6).
//
// Layout rules keep every type expression a union of short atoms, so the printed code matches
// oxfmt: combo option lists, socket-type unions, dynamic-combo options, Autogrow name sets,
// DynamicGroup rows and multi-output results all get named declarations.

import {
  type ComboInput,
  type ComboOption,
  createDiagnostic,
  type Diagnostic,
  type InputDef,
  type NodeDef,
  type OutputDef,
  type Schema,
  type SocketType,
  stringify,
} from "@tscomfy/core";
import { type Doc, group, hardline, ifBreak, indent, join, line, print, softline } from "./doc.ts";
import { NameRegistry, pascal, propertyKey } from "./names.ts";

/** Columns the generated code is laid out for: oxfmt's default, and this repo's setting. */
export const PRINT_WIDTH = 100;

/** The result of {@link emitTypes}. */
export interface EmitTypesResult {
  /** The contents of `nodes.ts`. */
  readonly contents: string;
  /** `W_EMPTY_COMBO` and `W_UNTYPED_INPUT`, in node order. */
  readonly diagnostics: readonly Diagnostic[];
}

/**
 * Emits the types-only `nodes.ts` for a schema: one function type per node on the `Nodes`
 * interface, with input interfaces and shared aliases. `header` lines become `//` comments at the
 * top. Pure and deterministic.
 */
export function emitTypes(schema: Schema, header: readonly string[] = []): EmitTypesResult {
  return new TypesEmitter(schema).emit(header);
}

/** Names the generated file imports from @tscomfy/core, or declares itself. */
const CORE_TYPES = ["In", "JsonValue", "Match", "NodeHandle", "NodeOptions", "Out"] as const;
type CoreType = (typeof CORE_TYPES)[number];

/** Names generated declarations must not take: imports, globals the output uses, `Nodes`. */
const RESERVED = [...CORE_TYPES, "NoInfer", "Nodes"];

/**
 * Output names that can't become named members of a multi-output result: members of
 * `NodeHandle` and `Out`, of arrays (the result is a tuple) and of `Object.prototype`. A fixed
 * list, so the output doesn't depend on the runtime's built-ins.
 */
const RESERVED_OUTPUT_NAMES: ReadonlySet<string> = new Set([
  "id",
  "node",
  "slot",
  "length",
  "at",
  "concat",
  "entries",
  "every",
  "filter",
  "find",
  "findIndex",
  "findLast",
  "findLastIndex",
  "flat",
  "flatMap",
  "forEach",
  "includes",
  "indexOf",
  "join",
  "keys",
  "lastIndexOf",
  "map",
  "reduce",
  "reduceRight",
  "slice",
  "some",
  "toLocaleString",
  "toReversed",
  "toSorted",
  "toSpliced",
  "toString",
  "values",
  "with",
  "constructor",
  "hasOwnProperty",
  "isPrototypeOf",
  "propertyIsEnumerable",
  "valueOf",
  "__proto__",
  "__defineGetter__",
  "__defineSetter__",
  "__lookupGetter__",
  "__lookupSetter__",
]);

/** A type expression: a union of atoms. */
type Atoms = readonly Doc[];

/** A built type, and the MatchType templates it mentions. */
interface Built {
  readonly atoms: Atoms;
  readonly templates: ReadonlySet<string>;
}

/** The MatchType templates of one node, in input order. */
interface Template {
  readonly id: string;
  /** The type parameter's name. */
  readonly parameter: string;
  /** The constraint and default, e.g. `string` and `"*"`. */
  readonly constraint: string;
  readonly fallback: string;
}

/** Per-node state while emitting. */
interface NodeScope {
  readonly node: NodeDef;
  /** Prefix of the node's declaration names, e.g. `KSampler`. */
  readonly base: string;
  readonly templates: ReadonlyMap<string, Template>;
  /** Templates whose inferring (first) input has been emitted. */
  readonly inferred: Set<string>;
  readonly declarations: Doc[];
  /** The node's declaration names, so nested ones can't clash with `$In`, `$Out`, …. */
  readonly names: NameRegistry;
}

class TypesEmitter {
  readonly #schema: Schema;
  /** Shared aliases and type parameters. Node-derived names contain `$`, so never clash. */
  readonly #names = new NameRegistry(RESERVED);
  readonly #bases = new NameRegistry();
  /** Every type parameter name in use; shared aliases avoid them, since parameters shadow. */
  readonly #parameterNames = new Set<string>();
  readonly #comboAliases = new Map<string, string>();
  readonly #socketAliases = new Map<string, string>();
  readonly #shared: { readonly name: string; readonly doc: Doc }[] = [];
  readonly #imports = new Set<CoreType>(["NodeOptions"]);
  readonly #diagnostics: Diagnostic[] = [];

  constructor(schema: Schema) {
    this.#schema = schema;
  }

  emit(header: readonly string[]): EmitTypesResult {
    const members: Doc[] = [];
    const declarations: Doc[] = [];
    for (const node of Object.values(this.#schema.nodes)) {
      const scope = this.#scope(node);
      members.push(this.#nodeMember(scope));
      declarations.push(...scope.declarations);
    }
    const nodes = [
      "/** Every node of the schema, by class type. Use through a typed schema's builder. */",
      hardline,
      interfaceDoc("Nodes", [], [], members),
    ];
    const shared = this.#shared
      .toSorted((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))
      .map((declaration) => declaration.doc);
    const imports = CORE_TYPES.filter((name) => this.#imports.has(name));
    const doc: Doc[] = [
      ...header.flatMap((text) => [`// ${text}`, hardline]),
      header.length > 0 ? hardline : "",
      group([
        "import type {",
        indent([line, join([",", line], imports)]),
        ifBreak(","),
        line,
        '} from "@tscomfy/core";',
      ]),
      ...[nodes, ...declarations, ...shared].flatMap((declaration) => [
        hardline,
        hardline,
        declaration,
      ]),
      hardline,
    ];
    return { contents: print(doc, PRINT_WIDTH), diagnostics: this.#diagnostics };
  }

  #scope(node: NodeDef): NodeScope {
    const templates = new Map<string, Template>();
    const parameters = new NameRegistry();
    const collect = (input: InputDef): void => {
      switch (input.kind) {
        case "matchType":
          if (!templates.has(input.templateId)) {
            // Type parameters shadow top-level names, so they must not equal any of them.
            let parameter = parameters.claim(`T${pascal(input.templateId, "Template")}`);
            while (this.#names.has(parameter)) parameter = parameters.claim(parameter);
            this.#parameterNames.add(parameter);
            const constraint = this.#allowed(input.allowed, input.templateId);
            templates.set(input.templateId, {
              id: input.templateId,
              parameter,
              constraint,
              fallback: constraint === "string" ? '"*"' : constraint,
            });
          }
          break;
        case "dynamicCombo":
          for (const option of input.options) option.inputs.forEach(collect);
          break;
        case "autogrow":
          collect(input.template);
          break;
        case "dynamicGroup":
          input.fields.forEach(collect);
          break;
        case "socket":
        case "int":
        case "float":
        case "string":
        case "boolean":
        case "combo":
        case "value":
        case "unknown":
          break;
      }
    };
    node.inputs.forEach(collect);
    const base = this.#bases.claim(pascal(node.classType, "Node"));
    return {
      node,
      base,
      templates,
      inferred: new Set(),
      declarations: [],
      names: new NameRegistry([`${base}$In`, `${base}$Out`, `${base}$Outputs`]),
    };
  }

  /** The node's member of `Nodes`, after emitting its declarations into the scope. */
  #nodeMember(scope: NodeScope): Doc {
    const { node, base } = scope;
    const inputs = this.#inputsInterface(scope, `${base}$In`, base, node.inputs, [node.classType]);
    const result = this.#result(scope);
    const all = new Set([...inputs.templates, ...result.templates]);
    const parameters = [...scope.templates.values()]
      .filter((template) => all.has(template.id))
      .map(
        (template) => `${template.parameter} extends ${template.constraint} = ${template.fallback}`,
      );
    return [
      docComment(nodeDocLines(node)),
      group([
        "readonly ",
        propertyKey(node.classType),
        ": ",
        typeParameters(parameters),
        "(",
        indent([
          softline,
          inputs.optional ? "inputs?: " : "inputs: ",
          inputs.reference,
          ",",
          line,
          "options?: NodeOptions",
        ]),
        ifBreak(","),
        softline,
        ") => ",
        result.reference,
        ";",
      ]),
    ];
  }

  /** The node's return type: a handle, one output, or a tuple with named members. */
  #result(scope: NodeScope): { readonly reference: Doc; readonly templates: ReadonlySet<string> } {
    const { outputs } = scope.node;
    const built = outputs.map((output) => this.#outputAtom(scope, output));
    const templates = new Set(built.flatMap((output) => [...output.templates]));
    const [only] = built;
    if (only === undefined) {
      this.#imports.add("NodeHandle");
      return { reference: "NodeHandle", templates };
    }
    if (built.length === 1) return { reference: only.atom, templates };

    this.#imports.add("NodeHandle");
    const args = this.#arguments(scope, templates);
    const parameters = this.#parameters(scope, templates);
    const tupleName = `${scope.base}$Outputs`;
    scope.declarations.push([
      `/** The outputs of \`${scope.node.classType}\`, by slot. */`,
      hardline,
      "export type ",
      tupleName,
      typeParameters(parameters),
      " = ",
      tuple(built.map((output) => output.atom)),
      ";",
    ]);
    const counts = new Map<string, number>();
    for (const output of outputs) counts.set(output.name, (counts.get(output.name) ?? 0) + 1);
    const named = outputs.flatMap((output, index) =>
      counts.get(output.name) === 1 &&
      !RESERVED_OUTPUT_NAMES.has(output.name) &&
      !/^\d+$/.test(output.name)
        ? [["readonly ", propertyKey(output.name), ": ", built[index]?.atom ?? "never", ";"]]
        : [],
    );
    const name = `${scope.base}$Out`;
    scope.declarations.push([
      `/** What \`${scope.node.classType}\` returns: its outputs by slot, and by name where unique. */`,
      hardline,
      interfaceDoc(name, parameters, [`${tupleName}${args}`, "NodeHandle"], named),
    ]);
    return { reference: `${name}${args}`, templates };
  }

  #outputAtom(
    scope: NodeScope,
    output: OutputDef,
  ): { readonly atom: string; readonly templates: ReadonlySet<string> } {
    this.#imports.add("Out");
    if (output.matchTemplate !== undefined) {
      const template = scope.templates.get(output.matchTemplate);
      if (template !== undefined) {
        return { atom: `Out<${template.parameter}>`, templates: new Set([template.id]) };
      }
      return { atom: 'Out<"*">', templates: new Set() };
    }
    const type = output.type;
    switch (type.kind) {
      case "combo":
        return { atom: 'Out<"COMBO">', templates: new Set() };
      case "any":
        return { atom: 'Out<"*">', templates: new Set() };
      case "named":
        return { atom: `Out<${JSON.stringify(type.name)}>`, templates: new Set() };
      case "union":
        return {
          atom: type.names.includes("*")
            ? 'Out<"*">'
            : `Out<${this.#socketAlias(type.names, output.name)}>`,
          templates: new Set(),
        };
    }
  }

  /**
   * An interface of inputs, emitted into the scope. Declarations the inputs need are named
   * `<prefix>$<Input>`. `optional` is true when every input may be left out, so the object
   * itself may be too.
   */
  #inputsInterface(
    scope: NodeScope,
    name: string,
    prefix: string,
    inputs: readonly InputDef[],
    path: readonly string[],
  ): {
    readonly reference: string;
    readonly optional: boolean;
    readonly templates: ReadonlySet<string>;
  } {
    const members: Doc[] = [];
    const templates = new Set<string>();
    let optional = true;
    for (const input of inputs) {
      const built = this.#inputType(scope, input, `${prefix}$${pascal(input.name, "Input")}`, [
        ...path,
        input.name,
      ]);
      for (const template of built.templates) templates.add(template);
      const required = isRequired(input);
      if (required) optional = false;
      members.push([
        docComment(inputDocLines(input)),
        "readonly ",
        propertyKey(input.name),
        required ? ":" : "?:",
        unionDoc(built.atoms),
        ";",
      ]);
    }
    if (members.length === 0) {
      // No inputs: reject every key rather than accept anything, as `{}` would.
      members.push("readonly [key: string]: never;");
    }
    const parameters = this.#parameters(scope, templates);
    scope.declarations.push([
      `/** Inputs of \`${path.join(" › ")}\`. */`,
      hardline,
      interfaceDoc(name, parameters, [], members),
    ]);
    return { reference: `${name}${this.#arguments(scope, templates)}`, optional, templates };
  }

  /**
   * The type of one input's value. `name` is the candidate name for declarations it needs,
   * claimed only when one is emitted.
   */
  #inputType(scope: NodeScope, input: InputDef, name: string, path: readonly string[]): Built {
    const none = new Set<string>();
    switch (input.kind) {
      case "socket":
        return { atoms: [this.#link(input.type, input.name)], templates: none };
      case "int":
        return {
          atoms: [
            "number",
            "bigint",
            ...(Array.isArray(input.default) ? ["readonly (number | bigint)[]"] : []),
            ...this.#widgetLink(input.type, input.socketless, input.name),
          ],
          templates: none,
        };
      case "float":
        return {
          atoms: [
            "number",
            ...(Array.isArray(input.default) ? ["readonly number[]"] : []),
            ...this.#widgetLink(input.type, input.socketless, input.name),
          ],
          templates: none,
        };
      case "string":
        return {
          atoms: ["string", ...this.#widgetLink(input.type, input.socketless, input.name)],
          templates: none,
        };
      case "boolean":
        return {
          atoms: ["boolean", ...this.#widgetLink(input.type, input.socketless, input.name)],
          templates: none,
        };
      case "combo":
        return { atoms: this.#combo(input, path), templates: none };
      case "value":
        this.#imports.add("JsonValue");
        return {
          atoms: ["JsonValue", ...this.#widgetLink(input.type, input.socketless, input.name)],
          templates: none,
        };
      case "autogrow":
        return this.#autogrow(scope, input, name, path);
      case "dynamicCombo":
        return this.#dynamicCombo(scope, input, name, path);
      case "dynamicGroup": {
        const rows = scope.names.claim(name);
        const row = this.#inputsInterface(
          scope,
          scope.names.claim(`${rows}$Row`),
          rows,
          input.fields,
          path,
        );
        return { atoms: [repeated(row.reference, input.min)], templates: row.templates };
      }
      case "matchType": {
        const template = scope.templates.get(input.templateId);
        this.#imports.add("Out");
        if (template === undefined) return { atoms: ["Out<string>"], templates: none };
        // The first input of a template infers it; the others must agree (§6.3).
        if (!scope.inferred.has(template.id)) {
          scope.inferred.add(template.id);
          return { atoms: [`Out<${template.parameter} | "*">`], templates: new Set([template.id]) };
        }
        this.#imports.add("Match");
        return {
          atoms: [`Out<Match<NoInfer<${template.parameter}>>>`],
          templates: new Set([template.id]),
        };
      }
      case "unknown":
        this.#diagnostics.push(
          createDiagnostic(
            "W_UNTYPED_INPUT",
            path,
            `The normalizer couldn't read input ${input.name}; its value is typed as unknown.`,
          ),
        );
        return { atoms: ["unknown"], templates: none };
    }
  }

  #combo(input: ComboInput, path: readonly string[]): Atoms {
    const open = input.upload || input.remote;
    let element: string;
    if (input.options.length === 0) {
      if (!input.remote) {
        this.#diagnostics.push(
          createDiagnostic(
            "W_EMPTY_COMBO",
            path,
            `Combo ${input.name} lists no options; its values are typed as string.`,
          ),
        );
      }
      element = "string";
    } else {
      element = this.#comboAlias(input.options, input.name);
    }
    const widened = open && element !== "string";
    const values = input.multiselect
      ? [widened ? `readonly (${element} | (string & {}))[]` : `readonly ${element}[]`]
      : widened
        ? [element, "(string & {})"]
        : [element];
    if (input.socketless) return values;
    // A legacy combo's links must match its whole option list; only `*` is sure to (§5.2).
    if (input.form === "legacy") {
      this.#imports.add("Out");
      return [...values, 'Out<"*">'];
    }
    return [...values, this.#link(input.type, input.name)];
  }

  #autogrow(
    scope: NodeScope,
    input: Extract<InputDef, { kind: "autogrow" }>,
    name: string,
    path: readonly string[],
  ): Built {
    const slot = this.#inputType(scope, input.template, `${name}$Slot`, path);
    const atom =
      slot.atoms.length === 1 ? (slot.atoms[0] ?? "never") : ["(", join(" | ", slot.atoms), ")"];
    const required = input.template.required ? input.min : 0;
    if (input.form === "prefix") {
      return { atoms: [repeated(atom, required)], templates: slot.templates };
    }
    const members = input.slots.map((slotName, index) => [
      "readonly ",
      propertyKey(slotName),
      index < required ? ": " : "?: ",
      atom,
      ";",
    ]);
    const slots = scope.names.claim(name);
    const parameters = this.#parameters(scope, slot.templates);
    scope.declarations.push([
      `/** Slots of \`${path.join(" › ")}\`. */`,
      hardline,
      interfaceDoc(slots, parameters, [], members),
    ]);
    return {
      atoms: [`${slots}${this.#arguments(scope, slot.templates)}`],
      templates: slot.templates,
    };
  }

  #dynamicCombo(
    scope: NodeScope,
    input: Extract<InputDef, { kind: "dynamicCombo" }>,
    name: string,
    path: readonly string[],
  ): Built {
    const choices = scope.names.claim(name);
    const members: Doc[] = [];
    const templates = new Set<string>();
    for (const option of input.options) {
      if (option.inputs.length === 0) {
        members.push(JSON.stringify(option.key));
        continue;
      }
      const optionName = scope.names.claim(`${choices}$${pascal(option.key, "Option")}`);
      const inputs = this.#inputsInterface(
        scope,
        scope.names.claim(`${optionName}$Inputs`),
        optionName,
        option.inputs,
        [...path, option.key],
      );
      for (const template of inputs.templates) templates.add(template);
      const parameters = this.#parameters(scope, inputs.templates);
      scope.declarations.push([
        `/** Option ${JSON.stringify(option.key)} of \`${path.join(" › ")}\`. */`,
        hardline,
        interfaceDoc(
          optionName,
          parameters,
          [],
          [
            ["readonly option: ", JSON.stringify(option.key), ";"],
            [inputs.optional ? "readonly inputs?: " : "readonly inputs: ", inputs.reference, ";"],
          ],
        ),
      ]);
      const reference = `${optionName}${this.#arguments(scope, inputs.templates)}`;
      // An option whose inputs may all be left out can also be given by its key alone.
      members.push(...(inputs.optional ? [JSON.stringify(option.key), reference] : [reference]));
    }
    const parameters = this.#parameters(scope, templates);
    scope.declarations.push(
      aliasDoc(
        choices,
        parameters,
        members.length > 0 ? members : ["never"],
        `The choices of \`${path.join(" › ")}\`.`,
      ),
    );
    return { atoms: [`${choices}${this.#arguments(scope, templates)}`], templates };
  }

  /** The link part of a widget, unless it has no socket. */
  #widgetLink(type: SocketType, socketless: boolean, context: string): Atoms {
    return socketless ? [] : [this.#link(type, context)];
  }

  /** What a socket of `type` accepts (§6.2). */
  #link(type: SocketType, context: string): string {
    switch (type.kind) {
      case "any":
        this.#imports.add("Out");
        return "Out<string>";
      case "named":
        this.#imports.add("In");
        return `In<${JSON.stringify(type.name)}>`;
      case "union":
        // A `*` member lets any output in, as a bare `*` does (§5.2).
        if (type.names.includes("*")) {
          this.#imports.add("Out");
          return "Out<string>";
        }
        this.#imports.add("In");
        return `In<${this.#socketAlias(type.names, context)}>`;
    }
  }

  /** A MatchType template's constraint. */
  #allowed(type: SocketType, templateId: string): string {
    switch (type.kind) {
      case "any":
        return "string";
      case "named":
        return type.name === "*" ? "string" : JSON.stringify(type.name);
      case "union":
        return type.names.includes("*") ? "string" : this.#socketAlias(type.names, templateId);
    }
  }

  /** A shared alias for a union of socket type names. */
  #socketAlias(names: readonly string[], context: string): string {
    const key = names.join(",");
    const existing = this.#socketAliases.get(key);
    if (existing !== undefined) return existing;
    const name = this.#claimShared(`${pascal(context, "Socket")}Types`);
    this.#socketAliases.set(key, name);
    this.#shared.push({
      name,
      doc: aliasDoc(
        name,
        [],
        names.map((each) => JSON.stringify(each)),
        "Socket types.",
      ),
    });
    return name;
  }

  /** A shared alias for a combo's option list; identical lists share one. */
  #comboAlias(options: readonly ComboOption[], context: string): string {
    const key = stringify(options);
    const existing = this.#comboAliases.get(key);
    if (existing !== undefined) return existing;
    const name = this.#claimShared(pascal(context, "Combo"));
    this.#comboAliases.set(key, name);
    const literals = [...new Set(options.map(literal))];
    this.#shared.push({ name, doc: aliasDoc(name, [], literals, "Combo options.") });
    return name;
  }

  /** A name for a shared alias, clear of every type parameter. */
  #claimShared(base: string): string {
    let name = this.#names.claim(base);
    while (this.#parameterNames.has(name)) name = this.#names.claim(base);
    return name;
  }

  /** `<TA extends …, TB extends …>` for the templates a declaration uses, in node order. */
  #parameters(scope: NodeScope, used: ReadonlySet<string>): readonly string[] {
    return [...scope.templates.values()]
      .filter((template) => used.has(template.id))
      .map((template) => `${template.parameter} extends ${template.constraint}`);
  }

  /** `<TA, TB>` to reference a declaration that uses those templates. */
  #arguments(scope: NodeScope, used: ReadonlySet<string>): string {
    const names = [...scope.templates.values()]
      .filter((template) => used.has(template.id))
      .map((template) => template.parameter);
    return names.length === 0 ? "" : `<${names.join(", ")}>`;
  }
}

/** Whether an input must be given: the backend requires it and no default fills it in. */
function isRequired(input: InputDef): boolean {
  if (!input.required) return false;
  switch (input.kind) {
    case "int":
    case "float":
    case "string":
    case "boolean":
    case "combo":
    case "value":
      return input.default === undefined;
    case "autogrow":
      return input.template.required && input.min > 0;
    case "dynamicGroup":
      return input.min > 0;
    case "socket":
    case "dynamicCombo":
    case "matchType":
    case "unknown":
      return true;
  }
}

function literal(option: ComboOption): string {
  return typeof option === "string" ? JSON.stringify(option) : String(option);
}

/** `readonly T[]`, with the first `minimum` elements required. */
function repeated(element: Doc, minimum: number): Doc {
  if (minimum === 0) return ["readonly ", element, "[]"];
  return tuple([...Array.from({ length: minimum }, () => element), ["...", element, "[]"]]);
}

function tuple(elements: readonly Doc[]): Doc {
  return group([
    "readonly [",
    indent([softline, join([",", line], elements)]),
    ifBreak(","),
    softline,
    "]",
  ]);
}

/** A union after a `:` or `=`: flat, or one `| atom` per line. */
function unionDoc(atoms: Atoms): Doc {
  if (atoms.length === 1) return [" ", atoms[0] ?? "never"];
  return group(indent([line, ifBreak("| "), join([line, "| "], atoms)]));
}

function typeParameters(parameters: readonly string[]): Doc {
  if (parameters.length === 0) return "";
  return group([
    "<",
    indent([softline, join([",", line], parameters)]),
    ifBreak(","),
    softline,
    ">",
  ]);
}

function aliasDoc(name: string, parameters: readonly string[], atoms: Atoms, comment: string): Doc {
  // One member breaks after `=` when it doesn't fit; a union breaks into `| member` lines.
  const value = atoms.length === 1 ? group(indent([line, atoms[0] ?? "never"])) : unionDoc(atoms);
  return [
    `/** ${comment} */`,
    hardline,
    group(["export type ", name, typeParameters(parameters), " =", value, ";"]),
  ];
}

function interfaceDoc(
  name: string,
  parameters: readonly string[],
  parents: readonly string[],
  members: readonly Doc[],
): Doc {
  const heading = group([
    "export interface ",
    name,
    typeParameters(parameters),
    parents.length > 0 ? group(indent([line, "extends ", join(", ", parents)])) : "",
    " {",
  ]);
  if (members.length === 0) return [heading, "}"];
  return [heading, indent([hardline, join(hardline, members)]), hardline, "}"];
}

/** A JSDoc comment from text lines; nothing when there are none. */
function docComment(lines: readonly string[]): Doc {
  const text = lines.map((each) => each.replaceAll("*/", "*\\/").trimEnd());
  if (text.length === 0) return "";
  if (text.length === 1) return [`/** ${text[0] ?? ""} */`, hardline];
  return [
    "/**",
    ...text.flatMap((each) => [hardline, each === "" ? " *" : ` * ${each}`]),
    hardline,
    " */",
    hardline,
  ];
}

function nodeDocLines(node: NodeDef): string[] {
  const lines = [
    node.category === "" ? node.displayName : `${node.displayName} · ${node.category}`,
  ];
  if (node.description !== undefined) lines.push("", ...node.description.split(/\r?\n/));
  const lists = node.outputs.filter((output) => output.isList).map((output) => output.name);
  if (lists.length > 0) {
    lines.push("", `List outputs (run what they feed once per item): ${lists.join(", ")}.`);
  }
  if (node.experimental) lines.push("", "Experimental.");
  if (node.deprecated) lines.push("", "@deprecated");
  return lines;
}

function inputDocLines(input: InputDef): string[] {
  const lines = input.tooltip === undefined ? [] : input.tooltip.split(/\r?\n/);
  const facts: string[] = [];
  if ("default" in input) {
    facts.push(`Default: \`${stringify(input.default)}\`.`);
  }
  if (input.kind === "int" || input.kind === "float") {
    if (input.min !== undefined && input.max !== undefined) {
      facts.push(`Range: \`${numberText(input.min)}\` to \`${numberText(input.max)}\`.`);
    } else if (input.min !== undefined) {
      facts.push(`Minimum: \`${numberText(input.min)}\`.`);
    } else if (input.max !== undefined) {
      facts.push(`Maximum: \`${numberText(input.max)}\`.`);
    }
    if (input.step !== undefined) facts.push(`Step: \`${String(input.step)}\`.`);
  }
  if (facts.length > 0) {
    if (lines.length > 0) lines.push("");
    lines.push(facts.join(" "));
  }
  return lines;
}

/** A number as written in docs: integers beyond 2^53 in full, not JavaScript's short form. */
function numberText(value: number | bigint): string {
  return typeof value === "number" && Number.isInteger(value) && !Number.isSafeInteger(value)
    ? BigInt(value).toString()
    : String(value);
}
