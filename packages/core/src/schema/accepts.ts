import type { ComboOption, InputDef, OutputDef, OutputType, SocketType } from "./types.ts";

/**
 * Whether the backend accepts a link from `output` into `input` (docs/plan.md §5.2). Follows the
 * backend's non-strict `validate_node_input`:
 * - `*` on either side passes, also as a member of a comma list;
 * - MatchType passes on either side (it is checked per template instead);
 * - an option-list output passes into an input typed exactly `COMBO`; a legacy `[[…]]` combo only
 *   takes an identical option list;
 * - otherwise the comma lists must share a type.
 *
 * List outputs don't change the answer: ComfyUI maps a list over a non-list input. An Autogrow
 * input answers for its slots. Inputs that can't be linked as a whole (DynamicGroup) and specs
 * the normalizer couldn't interpret answer `false`, whatever the output: stricter than the
 * backend, never looser.
 */
export function accepts(input: InputDef, output: OutputDef): boolean {
  if (input.kind === "dynamicGroup" || input.kind === "unknown") return false;
  if (input.kind === "autogrow") return accepts(input.template, output);
  if (input.kind === "matchType" || output.matchTemplate !== undefined) return true;
  switch (input.kind) {
    case "socket":
    case "int":
    case "float":
    case "string":
    case "boolean":
    case "value":
      return typeAccepts(input.type, output.type);
    case "combo":
      return input.form === "legacy"
        ? legacyComboAccepts(input.options, output.type)
        : typeAccepts(input.type, output.type);
    case "dynamicCombo":
      return typeAccepts(DYNAMIC_COMBO, output.type);
  }
}

const DYNAMIC_COMBO: SocketType = { kind: "named", name: "COMFY_DYNAMICCOMBO_V3" };

function typeAccepts(input: SocketType, output: OutputType): boolean {
  if (input.kind === "any" || output.kind === "any") return true;
  // The backend lets an option list into an input typed exactly COMBO, and nothing else.
  if (output.kind === "combo") return input.kind === "named" && input.name === "COMBO";
  const inputNames = names(input);
  const outputNames = names(output);
  if (inputNames.includes("*") || outputNames.includes("*")) return true;
  return inputNames.some((name) => outputNames.includes(name));
}

function legacyComboAccepts(options: readonly ComboOption[], output: OutputType): boolean {
  // The backend compares the option list itself as the type: only `*` or an equal list matches.
  if (output.kind === "any") return true;
  if (output.kind !== "combo") return false;
  return (
    output.options.length === options.length &&
    output.options.every((option, index) => option === options[index])
  );
}

function names(type: SocketType): readonly string[] {
  switch (type.kind) {
    case "named":
      return [type.name];
    case "union":
      return type.names;
    case "any":
      return ["*"];
  }
}
