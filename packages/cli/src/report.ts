import { type Diagnostic, parse, type Schema } from "@tscomfy/core";
import { isRecord, printable } from "./util.ts";

/** How many diagnostics a pack shows before the rest are summarized, unless verbose. */
const SHOWN_PER_PACK = 5;

/**
 * Diagnostics grouped by node pack (`python_module`; docs/plan.md §9), errors and warnings
 * counted, at most a few lines per pack unless `verbose`.
 */
export function reportDiagnostics(
  diagnostics: readonly Diagnostic[],
  schema: Schema,
  objectInfo: string,
  verbose: boolean,
): string {
  if (diagnostics.length === 0) return "";
  const packs = packsOf(schema, objectInfo);
  const groups = new Map<string, Diagnostic[]>();
  for (const diagnostic of diagnostics) {
    const classType = String(diagnostic.path[0] ?? "");
    const pack = packs.get(classType) ?? "(no pack)";
    groups.set(pack, [...(groups.get(pack) ?? []), diagnostic]);
  }
  const errors = diagnostics.filter((diagnostic) => diagnostic.severity === "error").length;
  const lines = [
    `${count(errors, "error")} and ${count(diagnostics.length - errors, "warning")} in the node definitions:`,
  ];
  for (const pack of [...groups.keys()].toSorted()) {
    const group = groups.get(pack) ?? [];
    lines.push(`  ${printable(pack)}: ${String(group.length)}`);
    const shown = verbose ? group : group.slice(0, SHOWN_PER_PACK);
    for (const diagnostic of shown) lines.push(`    ${formatDiagnostic(diagnostic)}`);
    if (shown.length < group.length) {
      lines.push(`    … and ${String(group.length - shown.length)} more (--verbose shows all)`);
    }
  }
  return `${lines.join("\n")}\n`;
}

/** One line for a diagnostic: its code, where, and what. Names in it come from the server. */
export function formatDiagnostic(diagnostic: Diagnostic): string {
  return printable(`${diagnostic.code} ${diagnostic.path.join(" › ")}: ${diagnostic.message}`);
}

/** `1 warning`, `3 errors`. */
export function count(amount: number, noun: string): string {
  return `${String(amount)} ${noun}${amount === 1 ? "" : "s"}`;
}

/** A byte size for humans. */
export function size(bytes: number): string {
  if (bytes < 1024) return `${String(bytes)} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

/**
 * Each class type's pack: from the schema, or from the raw response for nodes the normalizer
 * dropped.
 */
function packsOf(schema: Schema, objectInfo: string): Map<string, string> {
  const packs = new Map<string, string>();
  const raw = parse(objectInfo).value;
  if (raw !== undefined && isRecord(raw)) {
    for (const [classType, node] of Object.entries(raw)) {
      const module = isRecord(node) ? node["python_module"] : undefined;
      if (typeof module === "string") packs.set(classType, module);
    }
  }
  for (const node of Object.values(schema.nodes)) packs.set(node.classType, node.pythonModule);
  return packs;
}
