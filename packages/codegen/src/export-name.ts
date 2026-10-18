// The one rule for the names generated modules export (docs/plan.md §9, §10): `generate`'s
// schema constant and `transpile`'s workflow constant.

const ASCII_IDENTIFIER = /^[A-Za-z_$][A-Za-z0-9_$]*$/;

/**
 * Words an ES module can't declare as a constant (reserved words, `arguments` and `eval` in
 * strict code) or must not shadow (`undefined`, `NaN`, `Infinity`).
 */
const RESERVED: ReadonlySet<string> = new Set(
  "break case catch class const continue debugger default delete do else enum export extends false finally for function if import in instanceof new null return super switch this throw true try typeof var void while with yield await let static implements interface package private protected public arguments eval undefined NaN Infinity".split(
    " ",
  ),
);

/** What the schema module (`index.ts`) imports. */
export const SCHEMA_MODULE_NAMES: readonly string[] = ["defineSchema", "TypedSchema", "Nodes"];

/** What a transpiled module imports or binds itself. */
export const TRANSPILED_MODULE_NAMES: readonly string[] = [
  "workflow",
  "Workflow",
  "NodesOf",
  "n",
  "raw",
];

/**
 * Why `name` can't be the exported constant of a generated module, or `undefined` when it can.
 * One rule for both kinds: a schema module's export (`generate`) and a transpiled workflow's
 * (`transpile`), which imports the schema's, so a schema named `raw` is refused when it is
 * generated rather than when a workflow is first transpiled over it. The name must be an ASCII
 * identifier, not a reserved word, and none of the names either module declares itself
 * (`defineSchema`, `TypedSchema`, `Nodes`, `workflow`, `Workflow`, `NodesOf`, `n`, `raw`).
 */
export function exportNameProblem(name: string): string | undefined {
  if (!ASCII_IDENTIFIER.test(name)) {
    return "it isn't an identifier (ASCII letters, digits, _ and $, not starting with a digit)";
  }
  if (RESERVED.has(name)) return "JavaScript reserves it";
  if (SCHEMA_MODULE_NAMES.includes(name) || TRANSPILED_MODULE_NAMES.includes(name)) {
    const names = [...SCHEMA_MODULE_NAMES, ...TRANSPILED_MODULE_NAMES].join(", ");
    return `the generated modules declare it themselves (${names})`;
  }
  return undefined;
}

/** Whether {@link exportNameProblem} finds nothing wrong with `name`. */
export function isExportName(name: string): boolean {
  return exportNameProblem(name) === undefined;
}
