/**
 * @module @tscomfy/core
 *
 * Schema model, graph builder, API-format export/import and validation for
 * type-safe ComfyUI workflow generation. Zero runtime dependencies and
 * runtime-agnostic (see docs/plan.md §4 and D3).
 */

export {
  createDiagnostic,
  DIAGNOSTIC_CODES,
  type Diagnostic,
  type DiagnosticCode,
  type DiagnosticPath,
  type Severity,
} from "./diagnostic/diagnostic.ts";
export { exportApi, toApi, type ToApiOptions, validate } from "./api/export.ts";
export { importApi, type ImportResult } from "./api/import.ts";
export type { ApiLink, ApiNode, ApiPrompt } from "./api/prompt.ts";
export { ValidationError } from "./diagnostic/validation-error.ts";
export type {
  BuildContext,
  Graph,
  GraphNode,
  InputValue,
  RawBuilder,
  RawNode,
  Workflow,
} from "./graph/graph.ts";
export { isOutputRef } from "./graph/output-ref.ts";
export type {
  Bounded,
  In,
  Match,
  NodeHandle,
  NodeId,
  NodeMode,
  NodeOptions,
  OptionList,
  Out,
} from "./graph/types.ts";
export { prune, splitOutputs } from "./graph/operations.ts";
export { workflow } from "./graph/workflow.ts";
export { parse, type ParseResult } from "./json/parse.ts";
export { stringify } from "./json/stringify.ts";
export type { JsonObject, JsonValue } from "./json/value.ts";
export {
  normalizeObjectInfo,
  type NormalizeOptions,
  type NormalizeResult,
} from "./object-info/normalize.ts";
export { accepts, acceptsType, socketAccepts } from "./schema/accepts.ts";
export { namedOutputs, sendsValue } from "./schema/frontend.ts";
export { diffSchemas, type InputChange, type NodeChange, type SchemaDiff } from "./schema/diff.ts";
export { hashSchema } from "./schema/hash.ts";
export { defineSchema, type NodesOf, type TypedSchema } from "./schema/typed.ts";
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
export { validateApi } from "./validate/validate-api.ts";
export { toUi, type ToUiOptions, type ToUiResult, uiNodeSizes } from "./ui/export.ts";
export { importUi, type UiImportResult } from "./ui/import.ts";
