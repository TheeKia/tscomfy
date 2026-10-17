/**
 * @module @tscomfy/codegen
 *
 * Turns a normalized tscomfy schema into generated TypeScript (node types and
 * the runtime schema module) and transpiles workflows to code. Pure: returns
 * files as data and never touches the filesystem (see docs/plan.md §4).
 */

export { emitSchemaModule, isExportName } from "./emit-schema-module.ts";
export { emitTypes, type EmitTypesResult, PRINT_WIDTH } from "./emit-types.ts";
export {
  CODEGEN_VERSION,
  generate,
  type GeneratedFile,
  type GenerateOptions,
  type GenerateResult,
} from "./generate.ts";
