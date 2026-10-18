import type { JsonValue } from "../json/value.ts";
import type { ComboOption } from "./types.ts";

/** Whether a value can be a combo option: a string, a boolean or a finite number. */
export function isComboOption(value: JsonValue): value is ComboOption {
  return (
    typeof value === "string" ||
    typeof value === "boolean" ||
    (typeof value === "number" && Number.isFinite(value))
  );
}
