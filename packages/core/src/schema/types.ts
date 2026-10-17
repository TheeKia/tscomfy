import type { JsonValue } from "../json/value.ts";

// The normalized schema (docs/plan.md §5.1). Everything outside `object-info/` reads node
// definitions through these types, never the raw /object_info format.
//
// These are type aliases rather than interfaces so that a Schema is assignable to JsonValue:
// it is plain, immutable JSON data (bigint included) and serializes with `stringify`.

/**
 * An integer as the schema stores it: a `number` when it is a safe integer, otherwise a `bigint`
 * (docs/plan.md D10). One value never has both forms.
 */
export type IntValue = number | bigint;

/**
 * A combo option. Servers also use numbers and booleans, and the backend compares values exactly,
 * so they are kept as they are.
 */
export type ComboOption = string | number | boolean;

/**
 * The type of a socket, parsed from a ComfyUI type string. Names are trimmed, as the backend
 * trims them when it compares.
 */
export type SocketType =
  /** One type, e.g. `MODEL`. */
  | { readonly kind: "named"; readonly name: string }
  /** A comma list such as `IMAGE,MASK`, in server order, without duplicates. May contain `*`. */
  | { readonly kind: "union"; readonly names: readonly string[] }
  /** Exactly `*`: connects to anything. */
  | { readonly kind: "any" };

/** Fields shared by every input. */
type InputBase = {
  /** The input's key on the wire, exactly as on the server. Never split on dots. */
  readonly name: string;
  /** Whether the backend requires a value. */
  readonly required: boolean;
  readonly tooltip?: string;
  /** Evaluated only when the node asks for it. */
  readonly lazy: boolean;
  /** The node receives the link itself instead of its value. */
  readonly rawLink: boolean;
};

/** Fields shared by inputs the frontend shows as a widget. */
type WidgetBase = InputBase & {
  /** The type a link into this input must match, and the type the backend coerces by. */
  readonly type: SocketType;
  /** The frontend draws no socket for it, so links are only possible in API JSON. */
  readonly socketless: boolean;
  /**
   * The frontend widget the server names, when it differs from the one `kind` implies: a pack's
   * editor for a STRING, or a core widget on a primitive type, whose coercion decides the kind.
   */
  readonly widgetType?: string;
};

/** Takes links only: a custom type, `*`, a comma union, or a widget type with `forceInput`. */
export type SocketInput = InputBase & {
  readonly kind: "socket";
  readonly type: SocketType;
};

/** An INT widget. */
export type IntInput = WidgetBase & {
  readonly kind: "int";
  readonly default?: IntValue;
  readonly min?: IntValue;
  readonly max?: IntValue;
  readonly step?: number;
  /** `control_after_generate` as the server states it; see {@link FloatInput.control}. */
  readonly control?: boolean | string;
};

/** A FLOAT widget. Bounds the server wrote beyond 2^53 are rounded inward (docs/plan.md §9). */
export type FloatInput = WidgetBase & {
  readonly kind: "float";
  readonly default?: number;
  readonly min?: number;
  readonly max?: number;
  readonly step?: number;
  /** Rounding precision the frontend applies, or `false` for none. */
  readonly round?: number | false;
  /**
   * `control_after_generate` as the server states it. The frontend adds a control widget
   * (randomize, fixed, …) when it is truthy, named after it when it is a string; for INT also when
   * it is absent and the input is named `seed` or `noise_seed`. The control is saved in UI
   * workflows but never sent.
   */
  readonly control?: boolean | string;
};

/** A STRING widget. */
export type StringInput = WidgetBase & {
  readonly kind: "string";
  readonly default?: string;
  readonly multiline: boolean;
  /** The frontend rewrites `{a|b}` and comments in this input; tscomfy doesn't (§7.4). */
  readonly dynamicPrompts: boolean;
};

/** A BOOLEAN widget. */
export type BooleanInput = WidgetBase & {
  readonly kind: "boolean";
  readonly default?: boolean;
};

/** An upload flag of a combo: `image_upload`, `video_upload`, … without `_upload`. */
export type ComboUpload = "image" | "video" | "animated_image" | "audio" | "file";

/** A combo, from either the legacy `[[…]]` form or the `["COMBO", {options}]` form. */
export type ComboInput = WidgetBase & {
  readonly kind: "combo";
  /**
   * The backend matches links into the legacy form against the option list itself, and into
   * the `COMBO` form by `type` (§5.2). A legacy combo's `type` is `COMBO`, as the frontend sees it.
   */
  readonly form: "legacy" | "combo";
  /** Server order. May be empty (no model files installed, or a remote combo). */
  readonly options: readonly ComboOption[];
  /**
   * What the frontend sends when no value is given (§7.2): `[]` for a multi-select widget, the
   * first option in place of a falsy default. Absent when the server states none.
   */
  readonly default?: ComboOption | readonly ComboOption[];
  /** The backend validates a list value element by element. */
  readonly multiselect: boolean;
  /** Options are files the user can upload, so they change at runtime. */
  readonly upload: boolean;
  /** Which upload flags the server sets (`image_upload` → `image`), when any. */
  readonly uploads?: readonly ComboUpload[];
  /** Options are fetched by the frontend at runtime. */
  readonly remote: boolean;
  /** `control_after_generate` as the server states it; see {@link FloatInput.control}. */
  readonly control?: boolean | string;
  /**
   * A legacy combo with `forceInput`: the frontend draws a socket and no widget, so it sends a
   * link or nothing, and no default is filled in.
   */
  readonly forceInput?: true;
};

/**
 * A frontend widget whose value is arbitrary JSON (COLOR, BOUNDING_BOX, CURVE, …), see
 * docs/plan.md D16. The backend coerces by `type`, not by the widget.
 */
export type ValueInput = WidgetBase & {
  readonly kind: "value";
  /** The frontend widget that edits the value. */
  readonly widget: string;
  /** What the frontend sends when no value is given: the server's default, for most widgets. */
  readonly default?: JsonValue;
};

/** `COMFY_AUTOGROW_V3`: a growing list of sockets built from one template input. */
export type AutogrowInput = InputBase & {
  readonly kind: "autogrow";
  /** `prefix`: slots `<prefix>0`, `<prefix>1`, …; `names`: a fixed list of slot names. */
  readonly form: "prefix" | "names";
  /** Every slot name, in order. Wire keys are `<name>.<slot>`. */
  readonly slots: readonly string[];
  /** Slots before this index are required when the template is. */
  readonly min: number;
  /** The input every slot copies. Always link-only: the backend forces it to a socket. */
  readonly template: InputDef;
};

/** One choice of a {@link DynamicComboInput}. */
export type DynamicComboOption = {
  readonly key: string;
  /** Inputs that exist only while this option is selected. Wire keys are `<name>.<child>`. */
  readonly inputs: readonly InputDef[];
};

/** `COMFY_DYNAMICCOMBO_V3`: a combo whose selected option adds its own inputs. */
export type DynamicComboInput = InputBase & {
  readonly kind: "dynamicCombo";
  readonly options: readonly DynamicComboOption[];
};

/** `COMFY_DYNAMICGROUP_V3`: rows of widget fields. Upstream marks it unstable. */
export type DynamicGroupInput = InputBase & {
  readonly kind: "dynamicGroup";
  /** The fields of one row. Wire keys are `<name>.<row>.<field>`. */
  readonly fields: readonly InputDef[];
  readonly min: number;
  readonly max: number;
  readonly groupName?: string;
};

/** `COMFY_MATCHTYPE_V3`: takes any allowed type, shared with other inputs and outputs. */
export type MatchTypeInput = InputBase & {
  readonly kind: "matchType";
  readonly templateId: string;
  readonly allowed: SocketType;
};

/**
 * An input spec the normalizer couldn't interpret. It is kept, with a diagnostic, so later stages
 * can degrade gracefully instead of losing the input.
 */
export type UnknownInput = InputBase & {
  readonly kind: "unknown";
  /** The spec exactly as the server sent it. */
  readonly spec: JsonValue;
};

/** One input of a node. */
export type InputDef =
  | SocketInput
  | IntInput
  | FloatInput
  | StringInput
  | BooleanInput
  | ComboInput
  | ValueInput
  | AutogrowInput
  | DynamicComboInput
  | DynamicGroupInput
  | MatchTypeInput
  | UnknownInput;

/** The type of an output slot. */
export type OutputType =
  | SocketType
  /** An option list, which may connect to a `COMBO`-form combo input. */
  | { readonly kind: "combo"; readonly options: readonly ComboOption[] };

/** One output slot of a node. */
export type OutputDef = {
  /** The slot index used in links. Outputs are never filtered, so this is also the array index. */
  readonly index: number;
  /** Display name. Not unique: two outputs may share a name. */
  readonly name: string;
  readonly type: OutputType;
  /** The node emits a list; ComfyUI maps it over a non-list input downstream. */
  readonly isList: boolean;
  readonly tooltip?: string;
  /** The MatchType template this output follows; its `type` is then `any`. */
  readonly matchTemplate?: string;
};

/** One node class. */
export type NodeDef = {
  /** The key used as `class_type` in prompts, exactly as on the server. */
  readonly classType: string;
  readonly displayName: string;
  readonly category: string;
  /** The Python module that defines the node, which identifies its pack. */
  readonly pythonModule: string;
  readonly description?: string;
  /** The node produces results (save, preview), so the backend executes it. */
  readonly outputNode: boolean;
  /** The node receives every input as a whole list. */
  readonly isInputList: boolean;
  readonly deprecated: boolean;
  readonly experimental: boolean;
  /** In `input_order`; hidden inputs are dropped. */
  readonly inputs: readonly InputDef[];
  readonly outputs: readonly OutputDef[];
};

/** The node definitions of one ComfyUI server, normalized. */
export type Schema = {
  readonly formatVersion: 1;
  /** The ComfyUI version, if the caller supplied it. Metadata only: not part of the hash. */
  readonly comfyVersion?: string;
  /**
   * Keyed by class type and built in code-unit order of class type (D15). JavaScript enumerates
   * integer-like keys first, in numeric order, so a class named "10" would list before "A".
   */
  readonly nodes: { readonly [classType: string]: NodeDef };
};
