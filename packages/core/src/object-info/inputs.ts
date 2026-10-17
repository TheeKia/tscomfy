import type { DiagnosticPath } from "../diagnostic/diagnostic.ts";
import type { JsonObject, JsonValue } from "../json/value.ts";
import type {
  AutogrowInput,
  ComboInput,
  ComboOption,
  DynamicComboInput,
  DynamicComboOption,
  DynamicGroupInput,
  InputDef,
  MatchTypeInput,
  SocketType,
  UnknownInput,
} from "../schema/types.ts";
import {
  type Context,
  describe,
  isArray,
  isBoolean,
  isObject,
  isString,
  preview,
  readOptional,
  report,
} from "./context.ts";
import {
  AUTOGROW,
  DYNAMIC_COMBO,
  DYNAMIC_GROUP,
  isPrimitiveWidget,
  isV3DynamicType,
  isValueWidget,
  MATCH_TYPE,
  type PrimitiveWidget,
} from "./frontend-widgets.ts";
import { toFloat, toFloatBound, toIntBound, toIntValue } from "./numbers.ts";
import { parseSocketType } from "./socket-type.ts";

/** How a spec is read. */
interface SpecMode {
  /** The backend turns widget inputs into sockets here (Autogrow templates). */
  readonly forceSocket: boolean;
}

const NORMAL: SpecMode = { forceSocket: false };

/** Backend defaults (`comfy_api/latest/_io.py`) for fields a server may leave out. */
const AUTOGROW_DEFAULT_MIN = 1;
const AUTOGROW_DEFAULT_MAX = 10;
const AUTOGROW_MAX_SLOTS = 100;
const DYNAMIC_GROUP_MAX_ROWS = 20;

const UPLOAD_FLAGS = ["image_upload", "video_upload", "audio_upload", "file_upload"] as const;

/**
 * Reads a node's `input` field into ordered inputs. Returns `undefined` when the node can't be
 * used (no readable `input` or `required` section); that has been reported.
 */
export function readNodeInputs(
  context: Context,
  node: JsonObject,
  path: DiagnosticPath,
): InputDef[] | undefined {
  const input = node["input"];
  if (input === undefined || !isObject(input)) {
    report(
      context,
      "E_INVALID_NODE",
      [...path, "input"],
      `Expected input to be an object, got ${describe(input)}; dropping the node.`,
    );
    return undefined;
  }
  const required = input["required"] ?? {};
  if (!isObject(required)) {
    report(
      context,
      "E_INVALID_NODE",
      [...path, "input", "required"],
      `Expected input.required to be an object, got ${describe(required)}; dropping the node.`,
    );
    return undefined;
  }
  let optional = input["optional"] ?? {};
  if (!isObject(optional)) {
    report(
      context,
      "E_INVALID_INPUT_SECTION",
      [...path, "input", "optional"],
      `Expected input.optional to be an object, got ${describe(optional)}; dropping its inputs.`,
    );
    optional = {};
  }
  const order = readInputOrder(context, node, path);
  const inputs: InputDef[] = [];
  const sections = [
    ["required", required],
    ["optional", optional],
  ] as const;
  for (const [section, specs] of sections) {
    const names = orderedNames(context, specs, order?.[section], [...path, "input_order", section]);
    for (const name of names) {
      addInput(
        context,
        inputs,
        name,
        specs[name],
        section,
        [...path, "input", section, name],
        NORMAL,
      );
    }
  }
  return inputs;
}

/** `input_order`: the order the frontend creates inputs in. Optional on older servers. */
function readInputOrder(
  context: Context,
  node: JsonObject,
  path: DiagnosticPath,
): { readonly required?: readonly string[]; readonly optional?: readonly string[] } | undefined {
  const order = readOptional(
    context,
    node,
    "input_order",
    path,
    "W_INVALID_NODE_FIELD",
    "an object",
    isObject,
  );
  if (order === undefined) return undefined;
  const result: { required?: readonly string[]; optional?: readonly string[] } = {};
  for (const section of ["required", "optional"] as const) {
    const names = readOptional(
      context,
      order,
      section,
      [...path, "input_order"],
      "W_INVALID_NODE_FIELD",
      "a list of names",
      isStringArray,
    );
    if (names !== undefined) result[section] = names;
  }
  return result;
}

/** The section's input names in `input_order`, then any it doesn't list, in key order. */
function orderedNames(
  context: Context,
  specs: JsonObject,
  listed: readonly string[] | undefined,
  orderPath: DiagnosticPath,
): string[] {
  const keys = Object.keys(specs);
  if (listed === undefined) return keys;
  const known = listed.filter((name) => Object.hasOwn(specs, name));
  const undeclared = listed.filter((name) => !Object.hasOwn(specs, name));
  const unlisted = keys.filter((name) => !listed.includes(name));
  if (undeclared.length > 0 || unlisted.length > 0) {
    const parts = [
      undeclared.length > 0 ? `lists unknown inputs ${undeclared.join(", ")}` : "",
      unlisted.length > 0 ? `misses ${unlisted.join(", ")}, which go last` : "",
    ].filter((part) => part !== "");
    report(context, "W_INPUT_ORDER_MISMATCH", orderPath, `input_order ${parts.join(" and ")}.`);
  }
  return [...new Set([...known, ...unlisted])];
}

/** Reads `{ required?, optional? }` sections nested in a dynamic input. */
function readNestedSections(
  context: Context,
  sections: JsonObject,
  path: DiagnosticPath,
  mode: SpecMode,
): InputDef[] {
  const inputs: InputDef[] = [];
  for (const section of ["required", "optional"] as const) {
    const specs = sections[section];
    if (specs === undefined) continue;
    if (!isObject(specs)) {
      report(
        context,
        "W_INVALID_INPUT_OPTION",
        [...path, section],
        `Expected ${section} to be an object, got ${describe(specs)}; ignoring it.`,
      );
      continue;
    }
    for (const [name, spec] of Object.entries(specs)) {
      addInput(context, inputs, name, spec, section, [...path, section, name], mode);
    }
  }
  return inputs;
}

/** Reads one input into `inputs`, unless an earlier section already declared its name. */
function addInput(
  context: Context,
  inputs: InputDef[],
  name: string,
  spec: JsonValue | undefined,
  section: "required" | "optional",
  path: DiagnosticPath,
  mode: SpecMode,
): void {
  if (inputs.some((existing) => existing.name === name)) {
    report(
      context,
      "E_DUPLICATE_INPUT",
      path,
      `Input ${name} is declared twice; keeping the first.`,
    );
    return;
  }
  inputs.push(readInput(context, name, spec, section === "required", path, mode));
}

/**
 * Reads one `[type, options?]` spec. Never fails: a spec it can't interpret becomes an
 * {@link UnknownInput} with a diagnostic.
 */
function readInput(
  context: Context,
  name: string,
  spec: JsonValue | undefined,
  required: boolean,
  path: DiagnosticPath,
  mode: SpecMode,
): InputDef {
  if (spec === undefined || !isArray(spec) || spec.length === 0) {
    return unknown(
      context,
      name,
      required,
      spec,
      path,
      `Expected an input spec [type, options?], got ${describe(spec)}.`,
    );
  }
  const [head, rawOptions] = spec;
  const optionsPath = [...path, 1];
  let options: JsonObject = {};
  if (rawOptions !== undefined) {
    if (isObject(rawOptions)) options = rawOptions;
    else
      report(
        context,
        "W_INVALID_INPUT_OPTION",
        optionsPath,
        `Expected the options to be an object, got ${describe(rawOptions)}; ignoring them.`,
      );
  }
  const reader = new SpecReader(context, name, required, options, optionsPath);

  // Legacy combos ignore forceInput: their links only match an identical option list (§5.2),
  // which a COMBO socket would not express.
  if (head !== undefined && isArray(head)) return reader.combo("legacy", head, [...path, 0]);
  if (typeof head !== "string") {
    return unknown(
      context,
      name,
      required,
      spec,
      path,
      `Expected the input type to be a string or an option list, got ${describe(head)}.`,
    );
  }
  switch (head) {
    case AUTOGROW:
      return reader.autogrow() ?? unknown(context, name, required, spec, path);
    case DYNAMIC_COMBO:
      return reader.dynamicCombo() ?? unknown(context, name, required, spec, path);
    case DYNAMIC_GROUP:
      return reader.dynamicGroup() ?? unknown(context, name, required, spec, path);
    case MATCH_TYPE:
      return reader.matchType() ?? unknown(context, name, required, spec, path);
  }
  if (isV3DynamicType(head)) {
    report(
      context,
      "W_UNSUPPORTED_INPUT_TYPE",
      [...path, 0],
      `${head} is a dynamic input type this version doesn't know; keeping the input as unknown.`,
    );
    return unknown(context, name, required, spec, path);
  }
  const type = parseSocketType(head);
  if (type === undefined) {
    return unknown(context, name, required, spec, path, "The input type is empty.");
  }
  const widgetType = reader.string("widgetType");
  const forced = mode.forceSocket || reader.flag("forceInput");
  if (!forced) {
    const widget = widgetType ?? head;
    if (isPrimitiveWidget(widget)) return reader.primitive(widget, type, widgetType);
    if (isValueWidget(widget)) return reader.value(widget, type);
    // A widget registered by a pack in the browser: the value still has the head's type.
    if (isPrimitiveWidget(head)) return reader.primitive(head, type, widgetType);
  }
  return { kind: "socket", ...reader.base(), type };
}

/** Reads the options of one spec, reporting fields it has to ignore. */
class SpecReader {
  readonly #context: Context;
  readonly #name: string;
  readonly #required: boolean;
  readonly #options: JsonObject;
  readonly #path: DiagnosticPath;

  constructor(
    context: Context,
    name: string,
    required: boolean,
    options: JsonObject,
    path: DiagnosticPath,
  ) {
    this.#context = context;
    this.#name = name;
    this.#required = required;
    this.#options = options;
    this.#path = path;
  }

  /** The fields every input shares, in their fixed order. */
  base(): {
    readonly name: string;
    readonly required: boolean;
    readonly tooltip?: string;
    readonly lazy: boolean;
    readonly rawLink: boolean;
  } {
    const tooltip = this.string("tooltip");
    return {
      name: this.#name,
      required: this.#required,
      ...(tooltip === undefined ? {} : { tooltip }),
      lazy: this.flag("lazy"),
      rawLink: this.flag("rawLink"),
    };
  }

  primitive(widget: PrimitiveWidget, type: SocketType, widgetType: string | undefined): InputDef {
    const widgetFields = {
      type,
      socketless: this.flag("socketless"),
      ...(widgetType === undefined || widgetType === widget ? {} : { widgetType }),
    };
    switch (widget) {
      case "INT": {
        const value = this.#read("default", "an integer or a list of integers", (raw) =>
          isArray(raw) ? listOf(raw, toIntValue) : toIntValue(raw),
        );
        const min = this.#read("min", "an integer", (raw) => toIntBound(raw, "min"));
        const max = this.#read("max", "an integer", (raw) => toIntBound(raw, "max"));
        const step = this.#number("step");
        return {
          kind: "int",
          ...this.base(),
          ...widgetFields,
          ...(value === undefined ? {} : { default: value }),
          ...(min === undefined ? {} : { min }),
          ...(max === undefined ? {} : { max }),
          ...(step === undefined ? {} : { step }),
        };
      }
      case "FLOAT": {
        const value = this.#read("default", "a number or a list of numbers", (raw) =>
          isArray(raw) ? listOf(raw, toFloat) : toFloat(raw),
        );
        const min = this.#read("min", "a number", (raw) => toFloatBound(raw, "min"));
        const max = this.#read("max", "a number", (raw) => toFloatBound(raw, "max"));
        const step = this.#number("step");
        const round = this.#read("round", "a number or false", (raw) =>
          raw === false || (typeof raw === "number" && Number.isFinite(raw)) ? raw : undefined,
        );
        return {
          kind: "float",
          ...this.base(),
          ...widgetFields,
          ...(value === undefined ? {} : { default: value }),
          ...(min === undefined ? {} : { min }),
          ...(max === undefined ? {} : { max }),
          ...(step === undefined ? {} : { step }),
          ...(round === undefined ? {} : { round }),
        };
      }
      case "STRING": {
        const value = this.string("default");
        return {
          kind: "string",
          ...this.base(),
          ...widgetFields,
          ...(value === undefined ? {} : { default: value }),
          multiline: this.flag("multiline"),
          dynamicPrompts: this.flag("dynamicPrompts"),
        };
      }
      case "BOOLEAN": {
        const value = this.#read("default", "a boolean", (raw) =>
          typeof raw === "boolean" ? raw : undefined,
        );
        return {
          kind: "boolean",
          ...this.base(),
          ...widgetFields,
          ...(value === undefined ? {} : { default: value }),
        };
      }
      case "COMBO":
        return this.combo("combo", this.#options["options"], [...this.#path, "options"]);
    }
  }

  value(widget: string, type: SocketType): InputDef {
    const value = this.#options["default"] ?? undefined;
    return {
      kind: "value",
      ...this.base(),
      type,
      socketless: this.flag("socketless"),
      widget,
      ...(value === undefined ? {} : { default: value }),
    };
  }

  combo(
    form: ComboInput["form"],
    rawOptions: JsonValue | undefined,
    optionsPath: DiagnosticPath,
  ): ComboInput {
    const options: ComboOption[] = [];
    if (rawOptions !== undefined) {
      if (isArray(rawOptions)) {
        rawOptions.forEach((option, index) => {
          if (isComboOption(option)) options.push(option);
          else
            report(
              this.#context,
              "W_INVALID_INPUT_OPTION",
              [...optionsPath, index],
              `Expected a combo option to be a string, a number or a boolean, got ${describe(option)}; dropping it.`,
            );
        });
      } else {
        report(
          this.#context,
          "W_INVALID_INPUT_OPTION",
          optionsPath,
          `Expected the combo options to be a list, got ${describe(rawOptions)}; using none.`,
        );
      }
    }
    const multiselect = this.flag("multiselect");
    // A default the backend would reject is dropped rather than filled in later.
    const isMember = (value: JsonValue): value is ComboOption =>
      isComboOption(value) && (options.length === 0 || options.includes(value));
    const value = this.#read(
      "default",
      multiselect ? "a list of the options" : "one of the options",
      (raw): ComboOption | readonly ComboOption[] | undefined => {
        if (!multiselect) return isMember(raw) ? raw : undefined;
        return isArray(raw) && raw.every(isMember) ? raw : undefined;
      },
    );
    return {
      kind: "combo",
      ...this.base(),
      form,
      options,
      ...(value === undefined ? {} : { default: value }),
      multiselect,
      upload: UPLOAD_FLAGS.some((flag) => this.flag(flag)),
      remote: this.#object("remote") !== undefined,
      socketless: this.flag("socketless"),
    };
  }

  autogrow(): AutogrowInput | undefined {
    const template = this.#object("template");
    const templatePath = [...this.#path, "template"];
    const input = template === undefined ? undefined : template["input"];
    if (template === undefined || input === undefined || !isObject(input)) {
      return this.#invalid("Autogrow needs a template with an input.");
    }
    // The backend takes the first input of the first non-empty section, in key order.
    const first = Object.entries(input)
      .filter(([section]) => section === "required" || section === "optional")
      .flatMap(([section, specs]) =>
        isObject(specs)
          ? Object.entries(specs).map(([name, value]) => ({ section, name, value }))
          : [],
      )[0];
    if (first === undefined) return this.#invalid("Autogrow's template has no input.");

    const min = readCount(this.#context, template, "min", templatePath, AUTOGROW_DEFAULT_MIN, 0);
    let form: AutogrowInput["form"];
    let slots: string[];
    if (Object.hasOwn(template, "names")) {
      const names = template["names"];
      if (names === undefined || !isStringArray(names)) {
        return this.#invalid("Autogrow's template.names must be a list of strings.");
      }
      form = "names";
      slots = names.slice(0, AUTOGROW_MAX_SLOTS);
    } else if (Object.hasOwn(template, "prefix")) {
      const prefix = template["prefix"];
      if (typeof prefix !== "string") {
        return this.#invalid("Autogrow's template.prefix must be a string.");
      }
      const max = Math.min(
        readCount(this.#context, template, "max", templatePath, AUTOGROW_DEFAULT_MAX, 1),
        AUTOGROW_MAX_SLOTS,
      );
      form = "prefix";
      slots = Array.from({ length: max }, (_, index) => `${prefix}${index}`);
    } else {
      return this.#invalid("Autogrow's template needs either names or a prefix.");
    }
    return {
      kind: "autogrow",
      ...this.base(),
      form,
      slots,
      min,
      template: readInput(
        this.#context,
        first.name,
        first.value,
        first.section === "required",
        [...templatePath, "input", first.section, first.name],
        { forceSocket: true },
      ),
    };
  }

  dynamicCombo(): DynamicComboInput | undefined {
    const rawOptions = this.#options["options"];
    if (rawOptions === undefined || !isArray(rawOptions)) {
      return this.#invalid("A dynamic combo needs a list of options.");
    }
    const options: DynamicComboOption[] = [];
    rawOptions.forEach((option, index) => {
      const optionPath = [...this.#path, "options", index];
      const key = isObject(option) ? option["key"] : undefined;
      if (!isObject(option) || typeof key !== "string") {
        report(
          this.#context,
          "W_INVALID_INPUT_OPTION",
          optionPath,
          "Expected a dynamic combo option { key, inputs }; dropping it.",
        );
        return;
      }
      if (options.some((existing) => existing.key === key)) {
        report(
          this.#context,
          "W_INVALID_INPUT_OPTION",
          [...optionPath, "key"],
          `Option ${key} appears twice; keeping the first.`,
        );
        return;
      }
      const inputs = option["inputs"];
      let children: InputDef[] = [];
      if (inputs !== undefined && isObject(inputs)) {
        children = readNestedSections(this.#context, inputs, [...optionPath, "inputs"], NORMAL);
      } else {
        report(
          this.#context,
          "W_INVALID_INPUT_OPTION",
          [...optionPath, "inputs"],
          `Expected option inputs to be an object, got ${describe(inputs)}; the option gets none.`,
        );
      }
      options.push({ key, inputs: children });
    });
    return { kind: "dynamicCombo", ...this.base(), options };
  }

  dynamicGroup(): DynamicGroupInput | undefined {
    const template = this.#object("template");
    if (template === undefined) return this.#invalid("A dynamic group needs a template.");
    const max = Math.min(
      readCount(this.#context, this.#options, "max", this.#path, DYNAMIC_GROUP_MAX_ROWS, 1),
      DYNAMIC_GROUP_MAX_ROWS,
    );
    const min = Math.min(readCount(this.#context, this.#options, "min", this.#path, 0, 0), max);
    const groupName = this.string("group_name");
    return {
      kind: "dynamicGroup",
      ...this.base(),
      fields: readNestedSections(this.#context, template, [...this.#path, "template"], NORMAL),
      min,
      max,
      ...(groupName === undefined ? {} : { groupName }),
    };
  }

  matchType(): MatchTypeInput | undefined {
    const template = this.#object("template");
    const templateId = template?.["template_id"];
    if (template === undefined || typeof templateId !== "string") {
      return this.#invalid("A MatchType input needs a template with a template_id.");
    }
    const allowedText = template["allowed_types"] ?? "*";
    let allowed: SocketType | undefined =
      typeof allowedText === "string" ? parseSocketType(allowedText) : undefined;
    if (allowed === undefined) {
      report(
        this.#context,
        "W_INVALID_INPUT_OPTION",
        [...this.#path, "template", "allowed_types"],
        "Expected allowed_types to name at least one type; allowing any.",
      );
      allowed = { kind: "any" };
    }
    return { kind: "matchType", ...this.base(), templateId, allowed };
  }

  /** A boolean flag; absent means false. */
  flag(key: string): boolean {
    return (
      readOptional(
        this.#context,
        this.#options,
        key,
        this.#path,
        "W_INVALID_INPUT_OPTION",
        "a boolean",
        isBoolean,
      ) ?? false
    );
  }

  /** An optional string field. */
  string(key: string): string | undefined {
    return readOptional(
      this.#context,
      this.#options,
      key,
      this.#path,
      "W_INVALID_INPUT_OPTION",
      "a string",
      isString,
    );
  }

  #number(key: string): number | undefined {
    return this.#read(key, "a number", (raw) =>
      typeof raw === "number" && Number.isFinite(raw) ? raw : undefined,
    );
  }

  #object(key: string): JsonObject | undefined {
    return readOptional(
      this.#context,
      this.#options,
      key,
      this.#path,
      "W_INVALID_INPUT_OPTION",
      "an object",
      isObject,
    );
  }

  /** Reads and converts a field; a value `convert` rejects is reported and ignored. */
  #read<T>(
    key: string,
    expected: string,
    convert: (raw: JsonValue) => T | undefined,
  ): T | undefined {
    if (!Object.hasOwn(this.#options, key)) return undefined;
    const raw = this.#options[key];
    if (raw === undefined || raw === null) return undefined;
    const value = convert(raw);
    if (value === undefined) {
      report(
        this.#context,
        "W_INVALID_INPUT_OPTION",
        [...this.#path, key],
        `Expected ${key} to be ${expected}, got ${preview(raw)}; ignoring it.`,
      );
    }
    return value;
  }

  #invalid(message: string): undefined {
    report(
      this.#context,
      "W_INVALID_INPUT_SPEC",
      this.#path,
      `${message} Keeping the input as unknown.`,
    );
    return undefined;
  }
}

function unknown(
  context: Context,
  name: string,
  required: boolean,
  spec: JsonValue | undefined,
  path: DiagnosticPath,
  message?: string,
): UnknownInput {
  if (message !== undefined) {
    report(context, "W_INVALID_INPUT_SPEC", path, `${message} Keeping the input as unknown.`);
  }
  return { kind: "unknown", name, required, lazy: false, rawLink: false, spec: spec ?? null };
}

/** An integer count with a backend default; missing or out of range, the default is used. */
function readCount(
  context: Context,
  object: JsonObject,
  key: string,
  path: DiagnosticPath,
  fallback: number,
  least: number,
): number {
  const raw = object[key];
  if (raw === undefined || raw === null) return fallback;
  if (typeof raw === "number" && Number.isSafeInteger(raw) && raw >= least) return raw;
  report(
    context,
    "W_INVALID_INPUT_OPTION",
    [...path, key],
    `Expected ${key} to be an integer of at least ${String(least)}, got ${preview(raw)}; using ${String(fallback)}.`,
  );
  return fallback;
}

function listOf<T>(
  values: readonly JsonValue[],
  convert: (raw: JsonValue) => T | undefined,
): T[] | undefined {
  const result: T[] = [];
  for (const raw of values) {
    const value = convert(raw);
    if (value === undefined) return undefined;
    result.push(value);
  }
  return result;
}

function isComboOption(value: JsonValue): value is ComboOption {
  return (
    typeof value === "string" ||
    typeof value === "boolean" ||
    (typeof value === "number" && Number.isFinite(value))
  );
}

function isStringArray(value: JsonValue): value is readonly string[] {
  return isArray(value) && value.every((item) => typeof item === "string");
}
