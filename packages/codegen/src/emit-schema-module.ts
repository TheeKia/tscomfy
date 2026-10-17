import { type Schema, stringify } from "@tscomfy/core";
import { assignment, group, ifBreak, indent, print, softline } from "./doc.ts";
import { headerLines, PRINT_WIDTH } from "./emit-types.ts";

const IDENTIFIER = /^[A-Za-z_$][A-Za-z0-9_$]*$/;

/**
 * Emits the runtime schema module, `index.ts` (docs/plan.md §6.1, D13): the schema as one string
 * literal loaded by `defineSchema`, typed by the `Nodes` interface of `nodes.ts`.
 *
 * `exportName` is the exported constant, e.g. `local`; `nodesModule` the import specifier of the
 * types file, e.g. `./nodes.js`. Throws for an export name that isn't an identifier.
 */
export function emitSchemaModule(
  schema: Schema,
  exportName: string,
  nodesModule: string,
  header: readonly string[] = [],
): string {
  if (!IDENTIFIER.test(exportName)) {
    throw new TypeError(`emitSchemaModule: ${JSON.stringify(exportName)} is not an identifier`);
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
