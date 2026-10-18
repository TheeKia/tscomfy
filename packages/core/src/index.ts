/**
 * @module @tscomfy/core
 *
 * Type-safe ComfyUI workflow generation: the `/object_info` normalizer and schema model, the
 * workflow builder, API-format export and import, validation, bypass and mute, graph operations,
 * the UI workflow format, and lossless JSON. Zero runtime dependencies and runtime-agnostic.
 */

export {
  createDiagnostic,
  DIAGNOSTIC_CODES,
  type Diagnostic,
  type DiagnosticCode,
  type DiagnosticPath,
  type Severity,
} from "./diagnostic/diagnostic.ts";
export {
  type ApiExportResult,
  exportApi,
  toApi,
  type ToApiOptions,
  validate,
} from "./api/export.ts";
export { type ApiImportResult, importApi } from "./api/import.ts";
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
export { accepts } from "./schema/accepts.ts";
export { namedOutputs, sendsInputValue } from "./schema/frontend.ts";
export { diffSchemas, type InputChange, type NodeChange, type SchemaDiff } from "./schema/diff.ts";
export { hashSchema } from "./schema/hash.ts";
export { defineSchema, type NodesOf, type TypedSchema, typedSchema } from "./schema/typed.ts";
export type {
  AutogrowInput,
  BooleanInput,
  ComboInput,
  ComboOption,
  ComboUpload,
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
