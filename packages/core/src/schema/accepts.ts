import type { ComboOption, InputDef, OutputDef, OutputType, SocketType } from "./types.ts";

/**
 * Whether the backend accepts a link from `output` into `input`. Follows the
 * backend's non-strict `validate_node_input`:
 * - `*` on either side passes, also as a member of a comma list;
 * - MatchType passes on either side (it is checked per template instead);
 * - an option-list output passes into an input typed exactly `COMBO`; a legacy `[[…]]` combo only
 *   takes an identical option list;
 * - otherwise the comma lists must share a type.
 *
 * List outputs don't change the answer: ComfyUI maps a list over a non-list input. An Autogrow
 * input answers for its slots. Inputs that can't be linked as a whole (DynamicGroup, and a
 * dynamic combo, whose choice a link never matches) and specs
 * the normalizer couldn't interpret answer `false`, whatever the output: stricter than the
 * backend, never looser.
 */
export function accepts(input: InputDef, output: OutputDef): boolean {
  if (input.kind === "dynamicGroup" || input.kind === "unknown") return false;
  if (input.kind === "autogrow") return accepts(input.template, output);
  if (output.matchTemplate !== undefined) return true;
  return acceptsType(input, output.type);
}

/**
 * {@link accepts} for an output of a known type: a MatchType output once its template has
 * resolved, for example. A MatchType input takes any type here; its template's allowed types
 * are checked with {@link socketAccepts}.
 */
export function acceptsType(input: InputDef, output: OutputType): boolean {
  switch (input.kind) {
    case "dynamicGroup":
    case "unknown":
      return false;
    case "autogrow":
      return acceptsType(input.template, output);
    case "matchType":
      return true;
    case "socket":
    case "int":
    case "float":
    case "string":
    case "boolean":
    case "value":
      return socketAccepts(input.type, output);
    case "combo":
      return input.form === "legacy"
        ? legacyComboAccepts(input.options, output)
        : socketAccepts(input.type, output);
    case "dynamicCombo":
      // The backend compares the choice with the option keys as it is, so a link never selects
      // an option: the input and its option inputs are dropped (§8).
      return false;
  }
}

/** Whether a socket of type `input` takes a link from an output of type `output`. */
export function socketAccepts(input: SocketType, output: OutputType): boolean {
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
