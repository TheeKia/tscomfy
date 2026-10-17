import { join } from "node:path";
import { diffSchemas, hashSchema, type NodeChange, type SchemaDiff } from "@tscomfy/core";
import { parseFlags } from "./args.ts";
import { loadSchema, required, SNAPSHOT } from "./generate.ts";
import { CliError, type Io } from "./io.ts";
import { count } from "./report.ts";
import { readSource } from "./source.ts";
import { shellQuote } from "./util.ts";

export const CHECK_USAGE: string = `Usage: tscomfy check (--url <server> | --from <object_info.json>) --out <dir>

Compares the server's node definitions with the snapshot in <dir>/${SNAPSHOT}, and checks
that <dir>/nodes.ts and <dir>/index.ts were generated from that snapshot. Exits with 1 when
anything differs, so it can guard a build.

Options:
  --url <server>   A ComfyUI server, e.g. http://127.0.0.1:8188. Only GET requests.
  --from <file>    A saved /object_info response instead of a server.
  --out <dir>      The directory \`tscomfy generate\` wrote.
  --verbose        List every changed combo option.
`;

const FLAGS = [
  { name: "url", takesValue: true },
  { name: "from", takesValue: true },
  { name: "out", takesValue: true },
  { name: "verbose", takesValue: false },
  { name: "help", takesValue: false },
] as const;

/** How many combo options a change lists before the rest are summarized, unless verbose. */
const SHOWN_OPTIONS = 5;

const HEADER_HASH = /^\/\/ Schema (sha256:[0-9a-f]{64})\b/m;
const HEADER_COMMAND = /^\/\/ Regenerate with: (tscomfy generate .+)$/m;

/** `tscomfy check`. */
export async function checkCommand(io: Io, args: readonly string[]): Promise<number> {
  const flags = parseFlags(args, FLAGS);
  if (flags.has("help")) {
    io.out(CHECK_USAGE);
    return 0;
  }
  const out = required(flags, "out");
  const snapshotPath = join(out, SNAPSHOT);
  const snapshotText = await io.readText(snapshotPath);
  if (snapshotText === undefined) {
    throw new CliError(`There is no snapshot at ${snapshotPath}; run tscomfy generate first.`);
  }
  const snapshot = loadSchema({ text: snapshotText, label: snapshotPath, flag: "" }).schema;
  const source = await readSource(io, flags);
  const current = loadSchema(source).schema;
  const expected = hashSchema(snapshot);

  // Generated files that don't match the snapshot were edited or left behind.
  const stale: string[] = [];
  let command: string | undefined;
  for (const file of ["nodes.ts", "index.ts"]) {
    // Sequential: two small reads, and a stable order for the message.
    // oxlint-disable-next-line no-await-in-loop
    const text = await io.readText(join(out, file));
    if (text === undefined || HEADER_HASH.exec(text)?.[1] !== expected) stale.push(file);
    command ??= text === undefined ? undefined : HEADER_COMMAND.exec(text)?.[1];
  }
  const drifted = hashSchema(current) !== expected;

  if (!drifted && stale.length === 0) {
    const nodes = Object.keys(current.nodes).length;
    io.out(
      `Up to date: ${count(nodes, "node type")} ${nodes === 1 ? "matches" : "match"} ${snapshotPath}.\n`,
    );
    return 0;
  }
  const lines: string[] = [];
  if (stale.length > 0) {
    lines.push(
      `${stale.join(" and ")} in ${out} ${stale.length === 1 ? "wasn't" : "weren't"} generated from ${snapshotPath}.`,
    );
  }
  if (drifted) {
    lines.push(
      `${source.label} differs from ${snapshotPath}:`,
      ...formatDiff(diffSchemas(snapshot, current), flags.has("verbose")),
    );
  }
  // The recorded command keeps the options generate was given; this one is a fallback.
  lines.push(
    `Run ${command ?? `tscomfy generate ${source.flag} --out ${shellQuote(out)}`} to update.`,
  );
  io.out(`${lines.join("\n")}\n`);
  return 1;
}

/** The diff as indented lines. */
export function formatDiff(diff: SchemaDiff, verbose: boolean): string[] {
  const lines: string[] = [];
  if (diff.added.length > 0)
    lines.push(`  + ${count(diff.added.length, "node")} added: ${diff.added.join(", ")}`);
  if (diff.removed.length > 0) {
    lines.push(`  - ${count(diff.removed.length, "node")} removed: ${diff.removed.join(", ")}`);
  }
  if (diff.changed.length > 0) {
    lines.push(`  ~ ${count(diff.changed.length, "node")} changed:`);
    for (const change of diff.changed) lines.push(...formatChange(change, verbose));
  }
  return lines;
}

function formatChange(change: NodeChange, verbose: boolean): string[] {
  const lines = [`    ${change.classType}`];
  if (change.inputsAdded.length > 0)
    lines.push(`      inputs added: ${change.inputsAdded.join(", ")}`);
  if (change.inputsRemoved.length > 0)
    lines.push(`      inputs removed: ${change.inputsRemoved.join(", ")}`);
  for (const input of change.inputsChanged) {
    const parts = [
      ...(input.optionsAdded.length > 0 ? [`+${options(input.optionsAdded, verbose)}`] : []),
      ...(input.optionsRemoved.length > 0 ? [`-${options(input.optionsRemoved, verbose)}`] : []),
      ...(input.specChanged ? ["spec changed"] : []),
    ];
    lines.push(`      ${input.name}: ${parts.join("; ")}`);
  }
  if (change.outputsChanged) lines.push("      outputs changed");
  if (change.detailsChanged)
    lines.push("      details changed (name, category, description, flags or order)");
  return lines;
}

function options(list: readonly (string | number | boolean)[], verbose: boolean): string {
  const shown = verbose ? list : list.slice(0, SHOWN_OPTIONS);
  const rest = list.length - shown.length;
  return ` ${shown.map((option) => JSON.stringify(option)).join(", ")}${rest > 0 ? `, … ${String(rest)} more` : ""}`;
}
