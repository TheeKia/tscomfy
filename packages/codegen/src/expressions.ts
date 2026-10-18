// Expression layout, as oxfmt prints it (Prettier's rules for calls, objects and arrays), and
// the layout of the transpiled module's declaration.

import { type InputValue, isOutputRef, type JsonValue } from "@tscomfy/core";
import {
  bracketed,
  type Doc,
  fill,
  group,
  groupId,
  hardline,
  indent,
  indentIfBreak,
  join,
  line,
  PRINT_WIDTH,
  softline,
} from "./doc.ts";
import { numberText, propertyKey, quote } from "./names.ts";
import { textWidth } from "./text-width.ts";
import { isList } from "./values.ts";

/** The names a transpiled module's declaration is written with. */
export interface DeclarationNames {
  /** The exported constant. */
  readonly name: string;
  /** The schema module's export. */
  readonly schemaName: string;
}

/**
 * How `export const <name>: Workflow<…> = workflow(<schema>, <build> <block>);` is laid out, as
 * Prettier lays out an assignment whose right side is a call with a function last: the function
 * hugs the call while the line up to its `{` fits (with `});` for an empty block), else each
 * argument takes a line of its own; the right side moves below `=` when that makes the call's
 * first line fit.
 */
export type Layout = "hug" | "expand" | "belowHug" | "belowExpand";

/** The column the build function's statements start at, per layout. */
export const STATEMENT_INDENT: Record<Layout, number> = {
  hug: 2,
  expand: 4,
  belowHug: 4,
  belowExpand: 6,
};

export function declarationLayout(
  options: DeclarationNames,
  build: string,
  empty: boolean,
): Layout {
  const left = declarationLeft(options);
  const hug = `workflow(${options.schemaName}, ${build} ${empty ? "{});" : "{"}`;
  if (textWidth(`${left} ${hug}`) <= PRINT_WIDTH) return "hug";
  if (textWidth(`${left} workflow(`) <= PRINT_WIDTH) return "expand";
  return textWidth(`  ${hug}`) <= PRINT_WIDTH ? "belowHug" : "belowExpand";
}

export function declarationLeft(options: DeclarationNames): string {
  return `export const ${options.name}: Workflow<NodesOf<typeof ${options.schemaName}>> =`;
}

export function declarationDoc(
  options: DeclarationNames,
  build: string,
  block: Doc,
  layout: Layout,
): Doc {
  const { schemaName } = options;
  const left = declarationLeft(options);
  const hugged: Doc = [`workflow(${schemaName}, `, build, " ", block, ");"];
  const expanded: Doc = [
    "workflow(",
    indent([hardline, schemaName, ",", hardline, build, " ", block, ","]),
    hardline,
    ");",
  ];
  switch (layout) {
    case "hug":
      return [left, " ", hugged];
    case "expand":
      return [left, " ", expanded];
    case "belowHug":
      return [left, indent([hardline, hugged])];
    case "belowExpand":
      return [left, indent([hardline, expanded])];
  }
}

/** A call: arguments on one line, or one per line. */
export function callDoc(callee: string, args: readonly Doc[]): Doc {
  return bracketed([callee, "("], args, ")");
}

export function objectDoc(properties: readonly Doc[]): Doc {
  return properties.length === 0 ? "{}" : bracketed("{", properties, "}", { spaced: true });
}

/**
 * An array. Prettier always breaks an array of two or more objects or arrays that each have
 * more than one element.
 */
export function arrayDoc(items: readonly Doc[], breaks = false): Doc {
  if (items.length === 0) return "[]";
  if (breaks) return ["[", indent([hardline, join([",", hardline], items)]), ",", hardline, "]"];
  return bracketed("[", items, "]");
}

/**
 * `key: value`. A value that isn't a string literal (a number, a name, a call) stays on the key's
 * line, and so does any value after a short key; a string or a structure may move below it.
 */
export function propertyDoc(key: string, value: Doc): Doc {
  // Prettier never breaks after a key narrower than five columns (tab width plus three).
  const short = textWidth(key) < 5;
  if (short || (typeof value === "string" && !value.startsWith('"') && !value.startsWith("'"))) {
    return [key, ": ", value];
  }
  const id = groupId("property");
  return group([key, ":", group(indent(line), id), indentIfBreak(value, id)]);
}

export function scalarDoc(value: string | number | bigint | boolean | null): Doc {
  if (typeof value === "string") return quote(value);
  if (typeof value === "bigint") return `${String(value)}n`;
  if (typeof value === "number") return numberText(value);
  return String(value);
}

/** "object" or "array" for an element with more than one entry. */
function many(item: InputValue | JsonValue): "object" | "array" | undefined {
  if (isList(item)) return item.length > 1 ? "array" : undefined;
  if (typeof item === "object" && item !== null && !isOutputRef(item)) {
    return Object.keys(item).length > 1 ? "object" : undefined;
  }
  return undefined;
}

/**
 * Whether Prettier breaks an array whatever its width: two or more elements, all objects with
 * more than one key or all arrays with more than one element.
 */
export function breaksArray(items: readonly (InputValue | JsonValue)[]): boolean {
  const first = items[0] === undefined ? undefined : many(items[0]);
  return items.length > 1 && first !== undefined && items.every((item) => many(item) === first);
}

/** A JSON value as an expression. */
export function jsonDoc(value: JsonValue): Doc {
  if (isList(value)) {
    return isNumberList(value)
      ? numbersDoc(value)
      : arrayDoc(value.map(jsonDoc), breaksArray(value));
  }
  if (typeof value === "object" && value !== null) {
    return objectDoc(
      Object.entries(value).map(([key, item]) => propertyDoc(objectKey(key), jsonDoc(item))),
    );
  }
  return scalarDoc(value);
}

/** A list of two or more numbers, which Prettier prints concisely, as many per line as fit. */
export function isNumberList(
  value: readonly (InputValue | JsonValue)[],
): value is readonly number[] {
  return value.length > 1 && value.every((item) => typeof item === "number");
}

export function numbersDoc(values: readonly number[]): Doc {
  const items = values.map((value, index) =>
    index < values.length - 1 ? `${numberText(value)},` : numberText(value),
  );
  // The trailing comma belongs to the last item, so the last line's fit counts it.
  return group(["[", indent([softline, fill(items, ",")]), softline, "]"]);
}

/**
 * A key for an object literal. `__proto__` is computed, since a plain `__proto__:` would set
 * the prototype rather than make a property.
 */
export function objectKey(name: string): string {
  return name === "__proto__" ? '["__proto__"]' : propertyKey(name);
}
