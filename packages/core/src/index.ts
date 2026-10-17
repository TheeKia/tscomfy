/**
 * @module @tscomfy/core
 *
 * Schema model, graph builder, API-format export/import and validation for
 * type-safe ComfyUI workflow generation. Zero runtime dependencies and
 * runtime-agnostic (see docs/plan.md §4 and D3).
 */

export {
  DIAGNOSTIC_CODES,
  type Diagnostic,
  type DiagnosticCode,
  type DiagnosticPath,
  type Severity,
} from "./diagnostic/diagnostic.ts";
export { parse, type ParseResult } from "./json/parse.ts";
export { stringify } from "./json/stringify.ts";
export type { JsonObject, JsonValue } from "./json/value.ts";
export {
  normalizeObjectInfo,
  type NormalizeOptions,
  type NormalizeResult,
} from "./object-info/normalize.ts";
export { accepts } from "./schema/accepts.ts";
export type {
  AutogrowInput,
  BooleanInput,
  ComboInput,
  ComboOption,
  DynamicComboInput,
  DynamicComboOption,
  DynamicGroupInput,
  FloatInput,
  InputDef,
  IntInput,
  IntValue,
  MatchTypeInput,
  NodeDef,
  OutputDef,
  OutputType,
  Schema,
  SocketInput,
  SocketType,
  StringInput,
  UnknownInput,
  ValueInput,
} from "./schema/types.ts";
