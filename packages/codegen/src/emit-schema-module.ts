import { type Schema, stringify } from "@tscomfy/core";
import { assignment, group, ifBreak, indent, print, softline } from "./doc.ts";
import { headerLines, PRINT_WIDTH } from "./emit-types.ts";

const IDENTIFIER = /^[A-Za-z_$][A-Za-z0-9_$]*$/;

/** Words an ES module can't declare as a constant: reserved words, and this module's imports. */
const UNAVAILABLE = new Set(
  "break case catch class const continue debugger default delete do else enum export extends false finally for function if import in instanceof new null return super switch this throw true try typeof var void while with yield await let static implements interface package private protected public arguments eval undefined NaN Infinity defineSchema TypedSchema Nodes".split(
    " ",
  ),
);

/**
 * Whether `name` can be the exported constant of a schema module: an ASCII identifier that isn't
 * a reserved word or one of the module's own imports.
 */
export function isExportName(name: string): boolean {
  return IDENTIFIER.test(name) && !UNAVAILABLE.has(name);
}

/**
 * Emits the runtime schema module, `index.ts` (docs/plan.md §6.1, D13): the schema as one string
 * literal loaded by `defineSchema`, typed by the `Nodes` interface of `nodes.ts`.
 *
 * `exportName` is the exported constant, e.g. `local`; `nodesModule` the import specifier of the
 * types file, e.g. `./nodes.js`. Throws a `TypeError` unless {@link isExportName} holds.
 */
export function emitSchemaModule(
  schema: Schema,
  exportName: string,
  nodesModule: string,
  header: readonly string[] = [],
): string {
  if (!isExportName(exportName)) {
    throw new TypeError(
      `emitSchemaModule: ${JSON.stringify(exportName)} is not an identifier the module can export`,
    );
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
          indent([softline, stringLiteral(stringify(schema))]),
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

/**
 * A JavaScript string literal in the quotes that need fewer escapes, as oxfmt and Prettier
 * choose them: JSON text has many double quotes, so usually single.
 */
function stringLiteral(text: string): string {
  const doubles = text.split('"').length - 1;
  const singles = text.split("'").length - 1;
  const quote = doubles > singles ? "'" : '"';
  return `${quote}${text.replaceAll("\\", "\\\\").replaceAll(quote, `\\${quote}`)}${quote}`;
}
