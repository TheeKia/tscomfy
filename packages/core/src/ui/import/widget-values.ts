// Restoring a node's widget values from a UI file as the frontend restores them (docs/plan.md
// §11): by position over the widgets it saves (`LGraphNode.configure`), after dropping the
// placeholders old files saved for `forceInput` inputs (`migrateWidgetsValues`), with the
// load-time fixups (`app.ts` `loadGraphData`); by name only when the positions don't fit.

import {
  controlOn,
  createdWidgets,
  frontendInputs,
  frontendWidgets,
  type FrontendWidget,
} from "../../frontend/node.ts";
import { stringify } from "../../json/stringify.ts";
import { isJsonArray, isJsonObject, type JsonObject, type JsonValue } from "../../json/value.ts";
import type { InputDef, NodeDef } from "../../schema/types.ts";
import type { UiNode } from "./file.ts";
import type { Report } from "./report.ts";

/** A node's restored widget values. */
export interface RestoredValues {
  /** By wire key, for the widgets of declared inputs. */
  readonly values: Map<string, JsonValue>;
  /** Of the other widgets (controls, buttons), by widget name. */
  readonly extras: Map<string, JsonValue>;
}

/**
 * Each pass lays a node's widgets out for the dynamic-combo choices the previous pass read, so it
 * settles one more level of nested options: the real dump nests three. A layout that still
 * changes after this many passes (choices that flip as positions shift) keeps the last one.
 */
const MAX_SETTLE_PASSES = 8;

/** Classes whose control saved as a boolean becomes `randomize` or `fixed` on load. */
const BOOLEAN_CONTROL_NODES: ReadonlySet<string> = new Set([
  "KSampler",
  "KSamplerAdvanced",
  "PrimitiveNode",
]);
/** Classes whose old `sample_` sampler names lose the prefix on load. */
const SAMPLER_NODES: ReadonlySet<string> = new Set(["KSampler", "KSamplerAdvanced"]);
/** A control's first option, which a control saved as `null` takes (the combo fixup). */
const FIRST_CONTROL = "fixed";

/**
 * A node's widget values, by wire key (§11). By position, as the frontend restores them, after
 * dropping the placeholders old files saved for `forceInput` inputs; by name when the positions
 * don't fit the layout (pack widgets the schema can't predict, which 1.55's names do hold). Then
 * the frontend's load-time fixups. Widgets without a value keep the one they were created with.
 */
export function restoreWidgetValues(
  node: UiNode,
  definition: NodeDef,
  path: readonly (string | number)[],
  report: Report,
): RestoredValues {
  const named = node.named ?? (isNamedValues(node.values) ? node.values : undefined);
  const saved = positionalValues(node.values);
  let restored: Settled;
  if (saved === undefined) {
    restored = settle(definition, (widgets) =>
      named === undefined ? empty() : byNameOf(widgets, named),
    );
  } else {
    const positional = migrate(definition, saved);
    const byPosition = settle(definition, (widgets) => byPositionOf(widgets, positional));
    const fits = byPosition.saved === positional.length;
    if (!fits && named !== undefined) {
      restored = settle(definition, (widgets) => byNameOf(widgets, named));
    } else {
      restored = byPosition;
      if (!fits) {
        report(
          "W_WIDGET_VALUES_MISMATCH",
          path,
          `Node ${node.id} (${node.type}) saves ${String(positional.length)} widget values where its definition has ${String(byPosition.saved)}: a pack's own widgets, or a file older than its definition. Values are read by position, as the frontend reads them.`,
        );
      } else if (named !== undefined && disagree(byPosition, named)) {
        report(
          "W_WIDGET_VALUES_MISMATCH",
          path,
          `Node ${node.id} (${node.type}) saves widget values by name that disagree with its values by position; the frontend reads them by position, and so does this import.`,
        );
      }
    }
  }
  const { values, extras } = restored;
  for (const widget of restored.widgets) {
    if (widget.key === undefined) {
      // Controls and buttons without a saved value keep the one they were created with.
      if (extras.has(widget.name)) {
        extras.set(widget.name, fixedUp(definition.classType, widget, extras.get(widget.name)));
      }
      continue;
    }
    if (!values.has(widget.key)) {
      values.set(widget.key, widget.initial);
    } else if (widget.saved) {
      values.set(widget.key, fixedUp(definition.classType, widget, values.get(widget.key)));
    }
  }
  return { values, extras };
}

/**
 * A value after the frontend's load-time fixups, which it applies to every widget by name and
 * type (`loadGraphData`): KSampler's old `sample_` sampler names lose the prefix; a
 * `control_after_generate` of KSampler, KSamplerAdvanced and PrimitiveNode saved as `true` or
 * `false` becomes `randomize` or `fixed`; a combo saved as `null` takes its first option.
 */
export function fixedUp(
  classType: string,
  widget: Pick<FrontendWidget, "name" | "role" | "input">,
  value: JsonValue | undefined,
): JsonValue {
  let fixed = value ?? null;
  if (
    SAMPLER_NODES.has(classType) &&
    widget.name === "sampler_name" &&
    typeof fixed === "string" &&
    fixed.startsWith("sample_")
  ) {
    fixed = fixed.slice("sample_".length);
  }
  if (
    BOOLEAN_CONTROL_NODES.has(classType) &&
    widget.name === "control_after_generate" &&
    typeof fixed === "boolean"
  ) {
    fixed = fixed ? "randomize" : "fixed";
  }
  if (fixed === null) {
    if (widget.role === "control") return FIRST_CONTROL;
    const first = firstOption(widget.input);
    if (first !== undefined) return first;
  }
  return fixed;
}

/** The first option of a combo widget's input, if it has one. */
function firstOption(input: InputDef | undefined): JsonValue | undefined {
  if (input?.kind === "combo") return input.options[0];
  if (input?.kind === "dynamicCombo") return input.options[0]?.key;
  return undefined;
}

/** A node's widgets and values once its dynamic combos settle on the restored choices. */
interface Settled extends RestoredValues {
  readonly widgets: readonly FrontendWidget[];
  /** How many of the widgets are saved. */
  readonly saved: number;
}

/**
 * Restores values over a layout that dynamic combos change: each pass lays the widgets out for
 * the choices the previous pass read, and assigns afresh, until the layout stays.
 */
function settle(
  definition: NodeDef,
  assign: (widgets: readonly FrontendWidget[]) => RestoredValues,
): Settled {
  let assigned = empty();
  let widgets: readonly FrontendWidget[] = [];
  let layout = "";
  for (let pass = 0; pass < MAX_SETTLE_PASSES; pass++) {
    const previous = assigned.values;
    widgets = frontendWidgets(definition, (key) => previous.get(key));
    assigned = assign(widgets);
    const next = widgets.map((widget) => widget.name).join("\u0000");
    if (next === layout) break;
    layout = next;
  }
  return { widgets, ...assigned, saved: widgets.filter((widget) => widget.saved).length };
}

function empty(): RestoredValues {
  return { values: new Map(), extras: new Map() };
}

/** Values by position over the saved widgets, as the frontend restores them. */
function byPositionOf(
  widgets: readonly FrontendWidget[],
  saved: readonly JsonValue[],
): RestoredValues {
  const assigned = empty();
  let position = 0;
  for (const widget of widgets) {
    if (!widget.saved) continue;
    const value = saved[position++];
    if (value === undefined) continue;
    if (widget.key === undefined) assigned.extras.set(widget.name, value);
    else assigned.values.set(widget.key, value);
  }
  return assigned;
}

/** Values by widget name. */
function byNameOf(widgets: readonly FrontendWidget[], named: JsonObject): RestoredValues {
  const assigned = empty();
  for (const widget of widgets) {
    if (!widget.saved || !Object.hasOwn(named, widget.name)) continue;
    const value = named[widget.name] ?? null;
    if (widget.key === undefined) assigned.extras.set(widget.name, value);
    else assigned.values.set(widget.key, value);
  }
  return assigned;
}

/** Whether values by name disagree with the ones restored by position. */
function disagree(restored: Settled, named: JsonObject): boolean {
  return restored.widgets.some(
    (widget) =>
      widget.key !== undefined &&
      widget.saved &&
      Object.hasOwn(named, widget.name) &&
      stringify(named[widget.name] ?? null) !== stringify(restored.values.get(widget.key) ?? null),
  );
}

/**
 * `migrateWidgetsValues`: files from frontends before 1.16 saved a placeholder for every
 * `forceInput` input. Over the inputs that have a widget or are `forceInput`, in the order the
 * frontend's definition lists them (required ones, those its extensions add among them, then
 * optional ones; an explicit truthy `control_after_generate` counting a second entry), the
 * placeholders are dropped when the values line up with that list, with or without the unsaved
 * widgets'.
 */
function migrate(definition: NodeDef, saved: readonly JsonValue[]): readonly JsonValue[] {
  const created = createdWidgets(definition);
  const names = new Set(created.map((widget) => widget.name));
  const unsaved = new Set(created.filter((widget) => !widget.saved).map((each) => each.name));
  const inputs = frontendInputs(definition).map(({ input }) => input);
  const placeholders = [
    ...inputs.filter((input) => input.required),
    ...inputs.filter((input) => !input.required),
  ]
    .filter((input) => names.has(input.name) || isForced(input))
    .flatMap((input) => {
      if (unsaved.has(input.name)) return [];
      return explicitControl(input) ? [isForced(input), false] : [isForced(input)];
    });
  const count = created.filter((widget) => widget.saved).length;
  if (!placeholders.includes(true) && saved.length === count) return saved;
  const compacted = saved.filter((_, index) => created[index]?.saved !== false);
  const aligned =
    compacted.length === placeholders.length
      ? compacted
      : saved.length === placeholders.length
        ? saved
        : undefined;
  return aligned === undefined ? saved : aligned.filter((_, index) => placeholders[index] !== true);
}

function isForced(input: InputDef): boolean {
  return (input.kind === "socket" || input.kind === "combo") && input.forceInput === true;
}

/** Whether the server states a `control_after_generate` that adds a control. */
function explicitControl(input: InputDef): boolean {
  switch (input.kind) {
    case "int":
    case "float":
    case "combo":
    case "socket":
      return controlOn(input.control);
    case "string":
    case "boolean":
    case "value":
    case "dynamicCombo":
    case "autogrow":
    case "dynamicGroup":
    case "matchType":
    case "unknown":
      return false;
  }
}

/**
 * More positions than any node has widgets: an array-like's positions past this can't land on a
 * widget, so reading it this long changes nothing but the count a mismatch reports, and a file
 * claiming a huge `length` costs nothing.
 */
const MAX_POSITIONS = 2 ** 16;

/** `widgets_values` as a list: an array, or an object with a numeric `length` (array-like). */
export function positionalValues(values: JsonValue | undefined): readonly JsonValue[] | undefined {
  if (isJsonArray(values)) return values;
  if (!isJsonObject(values) || typeof values["length"] !== "number") return undefined;
  const length = Math.min(Math.max(0, Math.floor(values["length"])), MAX_POSITIONS);
  return Array.from({ length }, (_, at) => values[String(at)] ?? null);
}

/** `widgets_values` saved as an object (VHS does), which the frontend reads by name. */
export function isNamedValues(values: JsonValue | undefined): values is JsonObject {
  return isJsonObject(values) && typeof values["length"] !== "number";
}
