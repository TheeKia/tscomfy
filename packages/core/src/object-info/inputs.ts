import type { DiagnosticPath } from "../diagnostic/diagnostic.ts";
import type { JsonObject, JsonValue } from "../json/value.ts";
import { sendsValue } from "../schema/frontend.ts";
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
  initialValue,
  isPrimitiveWidget,
  isV3DynamicType,
  isValueWidget,
  MATCH_TYPE,
  type PrimitiveWidget,
} from "./frontend-widgets.ts";
import { toFloat, toFloatBound, toIntBound, toIntValue, withinBounds } from "./numbers.ts";
import { parseSocketType } from "./socket-type.ts";

/** How a spec is read. */
interface SpecMode {
  /** The backend turns widget inputs into sockets here (Autogrow templates). */
  readonly forceSocket: boolean;
}

const NORMAL: SpecMode = { forceSocket: false };

/** Backend limits and defaults (`comfy_api/latest/_io.py`) for fields a server may leave out. */
const AUTOGROW_DEFAULT_MIN = 1;
const AUTOGROW_DEFAULT_MAX = 10;
const AUTOGROW_MAX_SLOTS = 100;
const DYNAMIC_GROUP_MAX_ROWS = 20;

/** The kinds a DynamicGroup field may have: widgets (the backend forbids sockets and dynamics). */
const GROUP_FIELD_KINDS: ReadonlySet<InputDef["kind"]> = new Set([
  "int",
  "float",
  "string",
  "boolean",
  "combo",
  "value",
]);

const UPLOAD_FLAGS = ["image_upload", "video_upload", "audio_upload", "file_upload"] as const;

type Section = "required" | "optional";

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
  // The backend looks a name up in `required` first, so a duplicate in `optional` is dead.
  const optionalNames = Object.keys(optional).filter((name) => {
    if (!Object.hasOwn(required, name)) return true;
    report(
      context,
      "E_DUPLICATE_INPUT",
      [...path, "input", "optional", name],
      `Input ${name} is also required; dropping the optional one.`,
    );
    return false;
  });
  const specs = { required, optional };
  const declared = new Set([...Object.keys(required), ...Object.keys(optional)]);
  return orderInputs(context, node, Object.keys(required), optionalNames, declared, path).map(
    ({ name, section }) =>
      readInput(
        context,
        name,
        specs[section][name],
        section === "required",
        [...path, "input", section, name],
        NORMAL,
      ),
  );
}

/**
 * The frontend's input order (ComfyUI_frontend 1.55.17 `getOrderedInputSpecs`): the required
 * inputs `input_order` lists, then the optional ones it lists, then every other input, required
 * before optional. Without `input_order`, key order.
 */
function orderInputs(
  context: Context,
  node: JsonObject,
  requiredNames: readonly string[],
  optionalNames: readonly string[],
  declared: ReadonlySet<string>,
  path: DiagnosticPath,
): { readonly name: string; readonly section: Section }[] {
  const all = [
    ...requiredNames.map((name) => ({ name, section: "required" as const })),
    ...optionalNames.map((name) => ({ name, section: "optional" as const })),
  ];
  const order = readOptional(
    context,
    node,
    "input_order",
    path,
    "W_INVALID_NODE_FIELD",
    "an object",
    isObject,
  );
  if (order === undefined) return all;
  const listed = (section: Section, names: readonly string[]) => {
    const unique = new Set(
      readOptional(
        context,
        order,
        section,
        [...path, "input_order"],
        "W_INVALID_NODE_FIELD",
        "a list of names",
        isStringArray,
      ),
    );
    // A name listed under the other section is skipped here and placed with the rest.
    return {
      known: [...unique].filter((name) => names.includes(name)),
      undeclared: [...unique].filter((name) => !declared.has(name)),
    };
  };
  const listedRequired = listed("required", requiredNames);
  const listedOptional = listed("optional", optionalNames);
  const first = [
    ...listedRequired.known.map((name) => ({ name, section: "required" as const })),
    ...listedOptional.known.map((name) => ({ name, section: "optional" as const })),
  ];
  const rest = all.filter(
    ({ name, section }) =>
      !(section === "required" ? listedRequired : listedOptional).known.includes(name),
  );
  const undeclared = [...listedRequired.undeclared, ...listedOptional.undeclared];
  if (undeclared.length > 0 || rest.length > 0) {
    const parts = [
      undeclared.length > 0 ? `names ${undeclared.join(", ")}, which the node doesn't declare` : "",
      rest.length > 0 ? `leaves out ${rest.map(({ name }) => name).join(", ")}, placed last` : "",
    ].filter((part) => part !== "");
    report(
      context,
      "W_INPUT_ORDER_MISMATCH",
      [...path, "input_order"],
      `input_order ${parts.join("; it ")}.`,
    );
  }
  return [...first, ...rest];
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
    if (specs === undefined || specs === null) continue;
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
      const specPath = [...path, section, name];
      if (inputs.some((existing) => existing.name === name)) {
        report(
          context,
          "E_DUPLICATE_INPUT",
          specPath,
          `Input ${name} is declared twice; keeping the first.`,
        );
        continue;
      }
      inputs.push(readInput(context, name, spec, section === "required", specPath, mode));
    }
  }
  return inputs;
}

/**
 * Reads one `[type, options?]` spec. Never fails: a spec it can't interpret becomes an
 * {@link UnknownInput} with a diagnostic.
 *
 * Widget or socket follows the frontend (docs/plan.md D16): it looks up `widgetType ?? type` in
 * its widget registry. The kind follows the type when the type is primitive, because the backend
 * coerces and validates by the type; otherwise it follows the widget.
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
  if (rawOptions !== undefined && rawOptions !== null) {
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
  if (head !== undefined && isArray(head)) {
    return reader.legacyCombo(head, [...path, 0]) ?? unknown(context, name, required, spec, path);
  }
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
    if (isPrimitiveWidget(head)) return reader.primitive(head, type, widgetType);
    const widget = widgetType ?? head;
    if (isPrimitiveWidget(widget)) return reader.primitive(widget, type, widgetType);
    if (isValueWidget(widget)) return reader.value(widget, type);
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
        const inexact = this.#context.inexact;
        const min = this.#read("min", "an integer", (raw) => toIntBound(raw, "min", inexact));
        const max = this.#read("max", "an integer", (raw) => toIntBound(raw, "max", inexact));
        // The backend coerces INT values with int(), so a list default can't pass.
        const value = this.#default("an integer", min, max, toIntValue);
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
        const inexact = this.#context.inexact;
        const min = this.#read("min", "a number", (raw) => toFloatBound(raw, "min", inexact));
        const max = this.#read("max", "a number", (raw) => toFloatBound(raw, "max", inexact));
        // The backend coerces FLOAT values with float(), so a list default can't pass.
        const value = this.#default("a number", min, max, toFloat);
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
      case "COMBO": {
        const options = this.#comboOptions(this.#options["options"], [...this.#path, "options"]);
        return this.#combo("combo", options, widgetFields);
      }
    }
  }

  /**
   * A legacy `[[…]]` combo. The backend compares links against the full option list, so an
   * option we can't represent makes the spec unknown rather than silently shorter.
   */
  legacyCombo(rawOptions: readonly JsonValue[], optionsPath: DiagnosticPath): InputDef | undefined {
    const invalid = rawOptions.findIndex((option) => !isComboOption(option));
    if (invalid !== -1) {
      return this.#invalid(
        `Legacy combo option ${String(invalid)} is ${preview(rawOptions[invalid] ?? null)}, not a string, number or boolean; links match the full list, so it can't be dropped.`,
        optionsPath,
      );
    }
    return this.#combo("legacy", [...rawOptions].filter(isComboOption), {
      type: { kind: "named", name: "COMBO" },
      socketless: this.flag("socketless"),
    });
  }

  value(widget: string, type: SocketType): InputDef {
    const value = initialValue(widget, this.#options);
    return {
      kind: "value",
      ...this.base(),
      type,
      socketless: this.flag("socketless"),
      widget,
      ...(value === undefined ? {} : { default: value }),
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

    const min = count(template, "min", AUTOGROW_DEFAULT_MIN, 0, Number.MAX_SAFE_INTEGER);
    if (min === undefined) return this.#invalid("Autogrow's template.min must be an integer ≥ 0.");
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
      const max = count(template, "max", AUTOGROW_DEFAULT_MAX, 1, AUTOGROW_MAX_SLOTS);
      if (max === undefined) {
        return this.#invalid(
          `Autogrow's template.max must be an integer from 1 to ${String(AUTOGROW_MAX_SLOTS)}.`,
        );
      }
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
          `Option ${key} appears twice; keeping the first, as the backend does.`,
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
    const max = count(this.#options, "max", DYNAMIC_GROUP_MAX_ROWS, 1, DYNAMIC_GROUP_MAX_ROWS);
    const min = max === undefined ? undefined : count(this.#options, "min", 0, 0, max);
    if (max === undefined || min === undefined) {
      return this.#invalid(
        `A dynamic group needs 0 ≤ min ≤ max ≤ ${String(DYNAMIC_GROUP_MAX_ROWS)}, with max ≥ 1.`,
      );
    }
    const groupName = this.string("group_name");
    const fields = readNestedSections(this.#context, template, [...this.#path, "template"], NORMAL);
    // The backend's DynamicGroup takes only widget fields, without forceInput or dots in their
    // names; and a row must have a field it sends, or no row could ever be counted.
    if (
      !fields.every((field) => GROUP_FIELD_KINDS.has(field.kind) && !field.name.includes(".")) ||
      !fields.some((field) => field.kind !== "value" || sendsValue(field.widget))
    ) {
      return this.#invalid(
        "A dynamic group's fields must be widgets that are sent, without forceInput or dots in their names.",
      );
    }
    return {
      kind: "dynamicGroup",
      ...this.base(),
      fields,
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

  #combo(
    form: ComboInput["form"],
    options: readonly ComboOption[],
    widgetFields: {
      readonly type: SocketType;
      readonly socketless: boolean;
      readonly widgetType?: string;
    },
  ): ComboInput {
    // `multiselect` is what the backend validates by; `multi_select` is what makes the frontend
    // draw a multi-select widget. V3 multi-selects send both.
    const multiselect = this.flag("multiselect");
    const frontendMultiselect = this.#options["multi_select"] ?? undefined;
    // A default the backend would reject is dropped rather than filled in later. With no options
    // listed (remote and upload combos, empty folders) membership can't be checked here.
    const isMember = (value: JsonValue): value is ComboOption =>
      isComboOption(value) && (options.length === 0 || options.includes(value));
    const read = this.#read(
      "default",
      multiselect ? "one or a list of the options" : "one of the options",
      (raw): ComboOption | readonly ComboOption[] | undefined => {
        if (isMember(raw)) return raw;
        return multiselect && isArray(raw) && raw.every(isMember) ? raw : undefined;
      },
    );
    const value = comboInitialValue(
      read,
      options,
      multiselect && frontendMultiselect !== undefined && frontendMultiselect !== false,
    );
    return {
      kind: "combo",
      ...this.base(),
      ...widgetFields,
      form,
      options,
      ...(value === undefined ? {} : { default: value }),
      multiselect,
      upload: UPLOAD_FLAGS.some((flag) => this.flag(flag)),
      remote: this.#object("remote") !== undefined,
    };
  }

  /**
   * The options of a `COMBO`-form combo, dropping (and reporting) any that aren't a string,
   * number or boolean. Dropping is safe here: links into this form don't compare option lists.
   */
  #comboOptions(rawOptions: JsonValue | undefined, optionsPath: DiagnosticPath): ComboOption[] {
    if (rawOptions === undefined || rawOptions === null) return [];
    if (!isArray(rawOptions)) {
      report(
        this.#context,
        "W_INVALID_INPUT_OPTION",
        optionsPath,
        `Expected the combo options to be a list, got ${describe(rawOptions)}; using none.`,
      );
      return [];
    }
    const options: ComboOption[] = [];
    rawOptions.forEach((option, index) => {
      if (isComboOption(option)) {
        options.push(option);
        return;
      }
      report(
        this.#context,
        "W_INVALID_INPUT_OPTION",
        [...optionsPath, index],
        `Expected a combo option to be a string, a number or a boolean, got ${preview(option)}; dropping it.`,
      );
    });
    return options;
  }

  /**
   * A numeric default. One outside the bounds is dropped: the backend would reject it, and the
   * exporter fills defaults in (§7.2).
   */
  #default<T extends number | bigint>(
    expected: string,
    min: number | bigint | undefined,
    max: number | bigint | undefined,
    convert: (raw: JsonValue) => T | undefined,
  ): T | undefined {
    const value = this.#read("default", expected, convert);
    if (value === undefined || withinBounds(value, min, max)) return value;
    report(
      this.#context,
      "W_INVALID_INPUT_OPTION",
      [...this.#path, "default"],
      `The default ${exact(value)} is outside [${exact(min)}, ${exact(max)}]; ignoring it.`,
    );
    return undefined;
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

  #invalid(message: string, path: DiagnosticPath = this.#path): undefined {
    report(this.#context, "W_INVALID_INPUT_SPEC", path, `${message} Keeping the input as unknown.`);
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

/**
 * An integer count within the backend's limits, or its default when absent. `undefined` when it
 * is present but invalid, which the backend's constructors rule out.
 */
function count(
  object: JsonObject,
  key: string,
  fallback: number,
  least: number,
  most: number,
): number | undefined {
  const raw = object[key];
  if (raw === undefined || raw === null) return fallback;
  return typeof raw === "number" && Number.isSafeInteger(raw) && raw >= least && raw <= most
    ? raw
    : undefined;
}

/**
 * Renders numbers for messages without the shortest-round-trip form JavaScript uses, which shows
 * 2^64 − 2048 as 18446744073709550000.
 */
function exact(value: number | bigint | undefined): string {
  if (value === undefined) return "";
  return typeof value === "number" && Number.isInteger(value) && !Number.isSafeInteger(value)
    ? BigInt(value).toString()
    : String(value);
}

/**
 * The value the frontend gives a combo when none is given (ComfyUI_frontend 1.55.17
 * `useComboWidget.ts`), which is what the exporter fills in: a multi-select widget starts empty
 * whatever the default; otherwise a truthy default, or the first option in place of a falsy one.
 * No default stays no default: tscomfy doesn't invent one (§7.2).
 */
function comboInitialValue(
  read: ComboOption | readonly ComboOption[] | undefined,
  options: readonly ComboOption[],
  multiselectWidget: boolean,
): ComboOption | readonly ComboOption[] | undefined {
  if (multiselectWidget) return [];
  if (read === undefined) return undefined;
  if (read === "" || read === 0 || read === false) return options[0] ?? read;
  return read;
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
