// Emits `nodes.ts`: the `Nodes` interface and every type it refers to (docs/plan.md §6).
//
// Layout rules keep every type expression a union of short atoms, so the printed code matches
// oxfmt: combo option lists, socket-type unions, dynamic-combo options, Autogrow name sets,
// DynamicGroup rows and multi-output results all get named declarations.
//
// Soundness (plan §1): every link type is a subset of what `accepts()` allows, and every value
// type a subset of what the backend's validation accepts. Where the two can't be matched
// exactly, the types are the stricter side.

import {
  type ComboInput,
  type ComboOption,
  createDiagnostic,
  type Diagnostic,
  type InputDef,
  namedOutputs,
  type NodeDef,
  type OutputDef,
  type Schema,
  sendsValue,
  type SocketType,
  stringify,
} from "@tscomfy/core";
import {
  assignment,
  type Doc,
  group,
  hardline,
  ifBreak,
  indent,
  join,
  line,
  print,
  softline,
} from "./doc.ts";
import { commentLines, commentText, NameRegistry, pascal, propertyKey, quote } from "./names.ts";

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

/** `//` comment lines; line terminators in the text can't end the comment early. */
export function headerLines(header: readonly string[]): string[] {
  return header.map((text) => `// ${commentText(text)}`);
}

/** Names the generated file imports from @tscomfy/core. */
const CORE_TYPES = [
  "Bounded",
  "In",
  "JsonValue",
  "Match",
  "NodeHandle",
  "NodeOptions",
  "OptionList",
  "Out",
] as const;
type CoreType = (typeof CORE_TYPES)[number];

/** Names generated declarations must not take: imports, globals the output uses, `Nodes`. */
const RESERVED = [...CORE_TYPES, "NoInfer", "Nodes"];

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

const NO_TEMPLATES: ReadonlySet<string> = new Set();

class TypesEmitter {
  readonly #schema: Schema;
  /** Shared aliases and type parameters. Node-derived names contain `$`, so never clash. */
  readonly #names = new NameRegistry(RESERVED);
  readonly #bases = new NameRegistry();
  /** Every type parameter name in use; shared aliases avoid them, since parameters shadow. */
  readonly #parameterNames = new Set<string>();
  readonly #comboAliases = new Map<string, string>();
  readonly #socketAliases = new Map<string, string>();
  readonly #lengthAliases = new Map<string, string>();
  readonly #shared: { readonly name: string; readonly doc: Doc }[] = [];
  readonly #imports = new Set<CoreType>();
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
    const body = [
      ...(imports.length === 0
        ? []
        : [
            group([
              "import type {",
              indent([line, join([",", line], imports)]),
              ifBreak(","),
              line,
              '} from "@tscomfy/core";',
            ]),
          ]),
      nodes,
      ...declarations,
      ...shared,
    ];
    const doc: Doc[] = [
      ...headerLines(header).flatMap((text) => [text, hardline]),
      header.length > 0 ? hardline : "",
      join([hardline, hardline], body),
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
    this.#imports.add("NodeOptions");
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
      inlineComment(`The outputs of \`${scope.node.classType}\`, by slot.`),
      hardline,
      assignment(
        ["export type ", tupleName, typeParameters(parameters)],
        [tuple(built.map((output) => output.atom)), ";"],
      ),
    ]);
    const named = [...namedOutputs(outputs)].map(([outputName, slot]) => [
      "readonly ",
      propertyKey(outputName),
      ": ",
      built[slot]?.atom ?? "never",
      ";",
    ]);
    const name = `${scope.base}$Out`;
    scope.declarations.push([
      inlineComment(
        `What \`${scope.node.classType}\` returns: its outputs by slot, and by name where unique.`,
      ),
      hardline,
      interfaceDoc(name, parameters, [reference(tupleName, args), "NodeHandle"], named),
    ]);
    return { reference: reference(name, args), templates };
  }

  /**
   * What an output is typed as (§6.2). Whatever isn't a plain named type gets an atom that only
   * connects where `accepts()` agrees for every input: option lists their own name, and outputs
   * whose comma list contains `*` without being exactly `*` the stricter types.
   */
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
      return { atom: 'Out<"*">', templates: NO_TEMPLATES };
    }
    const type = output.type;
    switch (type.kind) {
      case "combo":
        this.#imports.add("OptionList");
        return { atom: "Out<OptionList>", templates: NO_TEMPLATES };
      case "any":
        return { atom: 'Out<"*">', templates: NO_TEMPLATES };
      case "named":
        // A padded `*` passes into string-typed inputs only, so it fits only `*` inputs here.
        return {
          atom: type.name === "*" ? "Out<string>" : `Out<${quote(type.name)}>`,
          templates: NO_TEMPLATES,
        };
      case "union": {
        // `*` in a list passes into string-typed inputs only; typed as the other members.
        const names = type.names.filter((name) => name !== "*");
        return { atom: `Out<${this.#socketNames(names, output.name)}>`, templates: NO_TEMPLATES };
      }
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
    sendsSomething = false,
  ): {
    readonly reference: Doc;
    readonly optional: boolean;
    readonly templates: ReadonlySet<string>;
  } {
    const members: Doc[] = [];
    const templates = new Set<string>();
    let optional = true;
    const forced = sendsSomething ? forcedRowField(inputs) : undefined;
    for (const input of inputs) {
      // The frontend never sends display-only widgets, so they take no value (§7.4).
      if (input.kind === "value" && !sendsValue(input.widget)) continue;
      const built = this.#inputType(scope, input, `${prefix}$${pascal(input.name, "Input")}`, [
        ...path,
        input.name,
      ]);
      for (const template of built.templates) templates.add(template);
      const required = isRequired(input) || input === forced;
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
      inlineComment(`Inputs of \`${path.join(" › ")}\`.`),
      hardline,
      interfaceDoc(name, parameters, [], members),
    ]);
    return {
      reference: reference(name, this.#arguments(scope, templates)),
      optional,
      templates,
    };
  }

  /**
   * The type of one input's value. `name` is the candidate name for declarations it needs,
   * claimed only when one is emitted.
   */
  #inputType(scope: NodeScope, input: InputDef, name: string, path: readonly string[]): Built {
    switch (input.kind) {
      case "socket":
        return { atoms: this.#link(input.type, input.name), templates: NO_TEMPLATES };
      case "int":
        return {
          atoms: [
            "number",
            "bigint",
            ...this.#widgetLink(input.type, input.socketless, input.name),
          ],
          templates: NO_TEMPLATES,
        };
      case "float":
        return {
          atoms: ["number", ...this.#widgetLink(input.type, input.socketless, input.name)],
          templates: NO_TEMPLATES,
        };
      case "string":
        return {
          atoms: ["string", ...this.#widgetLink(input.type, input.socketless, input.name)],
          templates: NO_TEMPLATES,
        };
      case "boolean":
        return {
          atoms: ["boolean", ...this.#widgetLink(input.type, input.socketless, input.name)],
          templates: NO_TEMPLATES,
        };
      case "combo":
        return { atoms: this.#combo(input, path), templates: NO_TEMPLATES };
      case "value":
        this.#imports.add("JsonValue");
        return {
          atoms: ["JsonValue", ...this.#widgetLink(input.type, input.socketless, input.name)],
          templates: NO_TEMPLATES,
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
          true,
        );
        return {
          atoms: [this.#repeated(row.reference, row.reference, input.min, input.max)],
          templates: row.templates,
        };
      }
      case "matchType": {
        const template = scope.templates.get(input.templateId);
        this.#imports.add("Out");
        if (template === undefined) return { atoms: ["Out<string>"], templates: NO_TEMPLATES };
        return { atoms: [this.#matchAtom(scope, template)], templates: new Set([template.id]) };
      }
      case "unknown":
        this.#diagnostics.push(
          createDiagnostic(
            "W_UNTYPED_INPUT",
            path,
            `The normalizer couldn't read input ${input.name}; its value is typed as unknown.`,
          ),
        );
        return { atoms: ["unknown"], templates: NO_TEMPLATES };
    }
  }

  /**
   * A MatchType position: the first one of a template infers it (`Out<T | "*">`), the others
   * must agree with it (§6.3).
   */
  #matchAtom(scope: NodeScope, template: Template): string {
    if (!scope.inferred.has(template.id)) {
      scope.inferred.add(template.id);
      return `Out<${template.parameter} | "*">`;
    }
    this.#imports.add("Match");
    return `Out<Match<NoInfer<${template.parameter}>>>`;
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
    return [...values, ...this.#link(input.type, input.name)];
  }

  #autogrow(
    scope: NodeScope,
    input: Extract<InputDef, { kind: "autogrow" }>,
    name: string,
    path: readonly string[],
  ): Built {
    const { template } = input;
    // A MatchType template: the first slot infers it and the others must agree, so a list of
    // mixed types can't infer a union (§6.3).
    let first: Doc;
    let rest: Doc;
    let templates: ReadonlySet<string>;
    const matched =
      template.kind === "matchType" ? scope.templates.get(template.templateId) : undefined;
    if (matched !== undefined) {
      this.#imports.add("Out");
      first = this.#matchAtom(scope, matched);
      rest = this.#matchAtom(scope, matched);
      templates = new Set([matched.id]);
    } else {
      const slot = this.#inputType(scope, template, `${name}$Slot`, path);
      first =
        slot.atoms.length === 1 ? (slot.atoms[0] ?? "never") : ["(", join(" | ", slot.atoms), ")"];
      rest = first;
      templates = slot.templates;
    }
    // The backend has exactly `slots.length` slots; those before `min` are required when the
    // template is, whatever section the Autogrow itself is in.
    const required = template.required ? Math.min(input.min, input.slots.length) : 0;
    if (input.form === "prefix") {
      return { atoms: [this.#repeated(first, rest, required, input.slots.length)], templates };
    }
    const members = input.slots.map((slotName, index) => [
      "readonly ",
      propertyKey(slotName),
      index < required ? ": " : "?: ",
      index === 0 ? first : rest,
      ";",
    ]);
    const slots = scope.names.claim(name);
    const parameters = this.#parameters(scope, templates);
    scope.declarations.push([
      inlineComment(`Slots of \`${path.join(" › ")}\`.`),
      hardline,
      interfaceDoc(slots, parameters, [], members),
    ]);
    return { atoms: [reference(slots, this.#arguments(scope, templates))], templates };
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
        members.push(quote(option.key));
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
        inlineComment(`Option ${quote(option.key)} of \`${path.join(" › ")}\`.`),
        hardline,
        interfaceDoc(
          optionName,
          parameters,
          [],
          [
            ["readonly option: ", quote(option.key), ";"],
            [inputs.optional ? "readonly inputs?: " : "readonly inputs: ", inputs.reference, ";"],
          ],
        ),
      ]);
      const optionReference = reference(optionName, this.#arguments(scope, inputs.templates));
      // An option whose inputs may all be left out can also be given by its key alone.
      members.push(...(inputs.optional ? [quote(option.key), optionReference] : [optionReference]));
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
    return { atoms: [reference(choices, this.#arguments(scope, templates))], templates };
  }

  /** The link part of a widget, unless it has no socket. */
  #widgetLink(type: SocketType, socketless: boolean, context: string): Atoms {
    return socketless ? [] : this.#link(type, context);
  }

  /**
   * What a socket of `type` accepts (§6.2, §5.2): outputs of the type or `*`. Exactly `COMBO`
   * also takes option lists, and exactly `*` takes everything. A `*` inside a comma list passes
   * strings only, so such a union is typed by its other members: stricter, and never letting an
   * option list in.
   */
  #link(type: SocketType, context: string): Atoms {
    switch (type.kind) {
      case "any":
        this.#imports.add("Out");
        return ["Out<string>"];
      case "named":
        this.#imports.add("In");
        if (type.name !== "COMBO") return [`In<${quote(type.name)}>`];
        this.#imports.add("Out");
        this.#imports.add("OptionList");
        return ['In<"COMBO">', "Out<OptionList>"];
      case "union": {
        this.#imports.add("In");
        const names = type.names.filter((name) => name !== "*");
        return [`In<${this.#socketNames(names, context)}>`];
      }
    }
  }

  /**
   * A list of `minimum` to `maximum` elements (§6.2): the backend reads no more slots or rows
   * than exist, so neither may the types. `first` types the first element and `rest` the others,
   * so a MatchType slot list infers from its first only. The length is bounded with a shared
   * `Length<min>To<max>` alias rather than a long tuple, which costs far more to type-check.
   */
  #repeated(first: Doc, rest: Doc, minimum: number, maximum: number): Doc {
    const elements: Doc[] =
      minimum === 0
        ? first === rest
          ? []
          : [[first, "?"]]
        : [first, ...Array.from({ length: minimum - 1 }, () => rest)];
    const list: Doc =
      elements.length === 0 ? ["readonly ", rest, "[]"] : tuple([...elements, ["...", rest, "[]"]]);
    this.#imports.add("Bounded");
    return reference("Bounded", [list, this.#lengths(minimum, maximum)]);
  }

  /** A shared alias for the lengths `minimum` to `maximum`. */
  #lengths(minimum: number, maximum: number): string {
    const key = `${String(minimum)}-${String(maximum)}`;
    const existing = this.#lengthAliases.get(key);
    if (existing !== undefined) return existing;
    const name = this.#claimShared(`Length${String(minimum)}To${String(maximum)}`);
    this.#lengthAliases.set(key, name);
    const lengths = Array.from({ length: maximum - minimum + 1 }, (_, index) =>
      String(minimum + index),
    );
    this.#shared.push({ name, doc: aliasDoc(name, [], lengths, "Allowed list lengths.") });
    return name;
  }

  /** A MatchType template's constraint. */
  #allowed(type: SocketType, templateId: string): string {
    switch (type.kind) {
      case "any":
        return "string";
      case "named":
        return type.name === "*" ? "string" : quote(type.name);
      case "union":
        return type.names.includes("*") ? "string" : this.#socketNames(type.names, templateId);
    }
  }

  /** Socket type names as a type argument: one literal, or a shared alias for a union. */
  #socketNames(names: readonly string[], context: string): string {
    const [first] = names;
    if (first === undefined) return "never";
    if (names.length === 1) return quote(first);
    const key = names.join(",");
    const existing = this.#socketAliases.get(key);
    if (existing !== undefined) return existing;
    const name = this.#claimShared(`${pascal(context, "Socket")}Types`);
    this.#socketAliases.set(key, name);
    this.#shared.push({ name, doc: aliasDoc(name, [], names.map(quote), "Socket types.") });
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

  /** `TA extends …` for the templates a declaration uses, in node order. */
  #parameters(scope: NodeScope, used: ReadonlySet<string>): readonly string[] {
    return [...scope.templates.values()]
      .filter((template) => used.has(template.id))
      .map((template) => `${template.parameter} extends ${template.constraint}`);
  }

  /** The type arguments that reference a declaration using those templates. */
  #arguments(scope: NodeScope, used: ReadonlySet<string>): readonly string[] {
    return [...scope.templates.values()]
      .filter((template) => used.has(template.id))
      .map((template) => template.parameter);
  }
}

/** Members of TypeScript's `Object` interface, which every object type has. */
const OBJECT_MEMBERS: ReadonlySet<string> = new Set([
  "constructor",
  "toString",
  "toLocaleString",
  "valueOf",
  "hasOwnProperty",
  "isPrototypeOf",
  "propertyIsEnumerable",
]);

/**
 * The field a DynamicGroup row's type requires beyond the required ones (§7.2): a row is counted
 * only when one of its keys is sent, so when no field is required or has a default, the first
 * one must be given, or `{}` would send no row at all.
 */
export function forcedRowField(fields: readonly InputDef[]): InputDef | undefined {
  const sendable = fields.filter((field) => field.kind !== "value" || sendsValue(field.widget));
  return sendable.some((field) => isRequired(field) || hasDefault(field)) ? undefined : sendable[0];
}

/**
 * Whether an input must be given: the backend requires it and no default fills it in.
 * Autogrow and DynamicGroup are required by their minimum alone: the backend enforces it even
 * when the input itself is optional. An input named after a member of `Object` is always
 * required: TypeScript checks an optional property against the member every object literal
 * has (`constructor: Function`), so leaving it out would fail to compile. Shared with the
 * transpiler.
 */
export function isRequired(input: InputDef): boolean {
  if (OBJECT_MEMBERS.has(input.name)) return true;
  switch (input.kind) {
    case "autogrow":
      return input.template.required && input.min > 0 && input.slots.length > 0;
    case "dynamicGroup":
      return input.min > 0;
    case "int":
    case "float":
    case "string":
    case "boolean":
    case "combo":
    case "value":
      return input.required && input.default === undefined;
    case "socket":
    case "dynamicCombo":
    case "matchType":
    case "unknown":
      return input.required;
  }
}

/** Whether the exporter sends a value for the input when none is given. */
export function hasDefault(input: InputDef): boolean {
  switch (input.kind) {
    case "int":
    case "float":
    case "string":
    case "boolean":
    case "combo":
    case "value":
      return input.default !== undefined;
    case "socket":
    case "autogrow":
    case "dynamicCombo":
    case "dynamicGroup":
    case "matchType":
    case "unknown":
      return false;
  }
}

function literal(option: ComboOption): string {
  return typeof option === "string" ? quote(option) : String(option);
}

/** `Name` or `Name<A, B>`, breaking the arguments the way oxfmt does when they don't fit. */
function reference(name: string, args: readonly Doc[]): Doc {
  if (args.length === 0) return name;
  return group([name, "<", indent([softline, join([",", line], args)]), softline, ">"]);
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

/** A union after a `:`: flat, or one `| atom` per line. */
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
  const left = ["export type ", name, typeParameters(parameters)];
  // One member is an assignment; a union breaks into `| member` lines.
  const declaration =
    atoms.length === 1
      ? assignment(left, [atoms[0] ?? "never", ";"])
      : group([left, " =", unionDoc(atoms), ";"]);
  return [inlineComment(comment), hardline, declaration];
}

function interfaceDoc(
  name: string,
  parameters: readonly string[],
  parents: readonly Doc[],
  members: readonly Doc[],
): Doc {
  const heading = group([
    "export interface ",
    name,
    typeParameters(parameters),
    parents.length > 0
      ? group(indent([line, "extends", group(indent([line, join([",", line], parents)]))]))
      : "",
    " {",
  ]);
  if (members.length === 0) return [heading, "}"];
  return [heading, indent([hardline, join(hardline, members)]), hardline, "}"];
}

/** A one-line doc comment holding server text. */
function inlineComment(text: string): string {
  return `/** ${commentText(text)} */`;
}

/** A JSDoc comment from text lines; nothing when there are none. */
function docComment(lines: readonly string[]): Doc {
  const text = lines.flatMap(commentLines);
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
  if (node.description !== undefined) lines.push("", node.description);
  const lists = node.outputs.filter((output) => output.isList).map((output) => output.name);
  if (lists.length > 0) {
    lines.push("", `List outputs (run what they feed once per item): ${lists.join(", ")}.`);
  }
  if (node.experimental) lines.push("", "Experimental.");
  if (node.deprecated) lines.push("", "@deprecated");
  return lines;
}

function inputDocLines(input: InputDef): string[] {
  const lines = input.tooltip === undefined ? [] : [input.tooltip];
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
  if (input.name === "__proto__") {
    // An object literal's `__proto__: x` sets the prototype instead of a property.
    facts.push('Pass it as `["__proto__"]: value`; a plain `__proto__:` key sets the prototype.');
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
