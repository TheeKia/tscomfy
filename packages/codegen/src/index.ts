/**
 * @module @tscomfy/codegen
 *
 * Turns a normalized tscomfy schema into generated TypeScript (node types and
 * the runtime schema module) and transpiles workflows to code. Pure: returns
 * files as data and never touches the filesystem.
 */

export {
  CODEGEN_VERSION,
  generate,
  type GeneratedFile,
  type GenerateOptions,
  type GenerateResult,
} from "./generate.ts";
export { exportNameProblem } from "./export-name.ts";
export {
  transpile,
  transpileNameProblem,
  type TranspileOptions,
  type TranspileResult,
} from "./transpile.ts";
