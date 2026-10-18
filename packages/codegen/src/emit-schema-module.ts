import { type Schema, stringify } from "@tscomfy/core";
import { assignment, group, ifBreak, indent, print, PRINT_WIDTH, softline } from "./doc.ts";
import { exportNameProblem } from "./export-name.ts";
import { headerLines, quote } from "./names.ts";

/**
 * Emits the runtime schema module, `index.ts` (docs/plan.md §6.1, D13): the schema as one string
 * literal loaded by `defineSchema`, typed by the `Nodes` interface of `nodes.ts`.
 *
 * `exportName` is the exported constant, e.g. `local`; `nodesModule` the import specifier of the
 * types file, e.g. `./nodes.js`. Throws a `TypeError` when `exportNameProblem` finds a problem
 * with `exportName`.
 */
export function emitSchemaModule(
  schema: Schema,
  exportName: string,
  nodesModule: string,
  header: readonly string[] = [],
): string {
  const problem = exportNameProblem(exportName);
  if (problem !== undefined) {
    throw new TypeError(`emitSchemaModule: can't export ${JSON.stringify(exportName)}: ${problem}`);
  }
  const lines = [
    ...headerLines(header),
    ...(header.length > 0 ? [""] : []),
    'import { defineSchema, type TypedSchema } from "@tscomfy/core";',
    `import type { Nodes } from ${JSON.stringify(nodesModule)};`,
    "",
    "/** The node definitions this module was generated from, typed by `Nodes`. */",
    print(
      assignment(`export const ${exportName}: TypedSchema<Nodes>`, [
        group([
          "defineSchema<Nodes>(",
          indent([softline, quote(stringify(schema))]),
          ifBreak(","),
          softline,
          ")",
        ]),
        ";",
      ]),
      PRINT_WIDTH,
    ),
    "",
  ];
  return lines.join("\n");
}
