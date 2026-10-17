import { basename, dirname, join, relative, sep } from "node:path";
import { isExportName, transpile } from "@tscomfy/codegen";
import { defineSchema, importApi, stringify } from "@tscomfy/core";
import { type Flags, parseFlags, value } from "./args.ts";
import { loadSchema, path, SNAPSHOT } from "./generate.ts";
import { CliError, type Io } from "./io.ts";
import { MANIFEST, readManifest } from "./manifest.ts";
import { count, formatDiagnostic } from "./report.ts";
import { shellQuote } from "./util.ts";

/** `tscomfy transpile --help`. */
export const TRANSPILE_USAGE: string = `Usage: tscomfy transpile --prompt <prompt.json> --schema <dir> [options]

Turns an API-format prompt (the frontend's "Export (API)") into TypeScript that builds it with
the types \`tscomfy generate\` wrote into <dir>. Running the code and exporting gives the prompt
back. Nodes the types can't express are written as raw(…), with a warning.

Options:
  --prompt <file>      The prompt to transpile.
  --schema <dir>       The directory \`tscomfy generate\` wrote (it reads ${SNAPSHOT} and ${MANIFEST}).
  --out <file>         Where to write the module. Default: standard output.
  --name <identifier>  The exported constant. Default: from the prompt's file name.
  --no-inline          Give every node a variable, rather than inlining those used once.
`;

const FLAGS = [
  { name: "prompt", takesValue: true },
  { name: "schema", takesValue: true },
  { name: "out", takesValue: true },
  { name: "name", takesValue: true },
  { name: "no-inline", takesValue: false },
  { name: "help", takesValue: false },
] as const;

/** `tscomfy transpile`. */
export async function transpileCommand(io: Io, args: readonly string[]): Promise<number> {
  const flags = parseFlags(args, FLAGS);
  if (flags.has("help")) {
    io.out(TRANSPILE_USAGE);
    return 0;
  }
  const promptPath = path(flags, "prompt");
  const schemaDir = path(flags, "schema");
  const out = flags.has("out") ? path(flags, "out") : undefined;
  const manifest = await readManifest(io, schemaDir);
  const snapshotPath = join(schemaDir, SNAPSHOT);
  const snapshot = await io.readText(snapshotPath);
  if (manifest === undefined || snapshot === undefined) {
    throw new CliError(
      `There is no ${manifest === undefined ? MANIFEST : SNAPSHOT} in ${schemaDir}; run tscomfy generate first.`,
    );
  }
  const name = readName(flags, promptPath, manifest.exportName);
  const text = await io.readText(promptPath);
  if (text === undefined) throw new CliError(`There is no file at ${promptPath}.`);

  const schema = loadSchema({ text: snapshot, label: snapshotPath, flag: "" }).schema;
  const imported = importApi(text, defineSchema(stringify(schema)));
  const fatal = imported.diagnostics.find(
    (diagnostic) =>
      diagnostic.path.length === 0 &&
      (diagnostic.code === "E_INVALID_JSON" || diagnostic.code === "E_INVALID_PROMPT"),
  );
  if (fatal !== undefined) {
    throw new CliError(`${promptPath} isn't a prompt: ${fatal.message}`);
  }
  const command = [
    "tscomfy transpile",
    `--prompt ${shellQuote(promptPath)}`,
    `--schema ${shellQuote(schemaDir)}`,
    ...(out === undefined ? [] : [`--out ${shellQuote(out)}`]),
    ...(flags.has("name") ? [`--name ${name}`] : []),
    ...(flags.has("no-inline") ? ["--no-inline"] : []),
  ].join(" ");
  const result = transpile(imported.workflow, {
    name,
    schemaModule: moduleSpecifier(out, schemaDir, manifest.importExtension),
    schemaName: manifest.exportName,
    inline: !flags.has("no-inline"),
    header: [`Regenerate with: ${command}`],
  });

  for (const diagnostic of [...imported.diagnostics, ...result.diagnostics]) {
    io.err(`${formatDiagnostic(diagnostic)}\n`);
  }
  if (out === undefined) {
    io.out(result.code);
    return 0;
  }
  await io.writeText(out, result.code);
  io.out(
    `Transpiled ${count(imported.workflow.graph.nodes.size, "node")} from ${promptPath} into ${out}.\n`,
  );
  return 0;
}

/** How the module imports the schema: relative to where it is written, POSIX separators. */
function moduleSpecifier(out: string | undefined, schemaDir: string, extension: string): string {
  const from = out === undefined ? "." : dirname(out);
  const target = relative(from, join(schemaDir, `index${extension}`))
    .split(sep)
    .join("/");
  return target.startsWith(".") ? target : `./${target}`;
}

/** The export name: `--name`, or from the prompt's file name (`Anima-API.json` → `animaApi`). */
function readName(flags: Flags, promptPath: string, schemaName: string): string {
  const given = value(flags, "name");
  const name = given ?? camel(basename(promptPath).replace(/\.[^.]*$/, ""));
  if (!isExportName(name) || name === schemaName) {
    throw new CliError(
      given === undefined
        ? `Can't make an export name from ${JSON.stringify(promptPath)}; pass --name.`
        : `--name ${JSON.stringify(given)} isn't usable: it must be an identifier, not a reserved word or ${schemaName}.`,
      2,
    );
  }
  return name;
}

/** camelCase from the runs of letters and digits: `Anima-API` → `animaApi`. */
function camel(text: string): string {
  const words = text.match(/[A-Za-z0-9]+/g) ?? [];
  return words
    .map((word, index) => {
      const lower = word === word.toUpperCase() ? word.toLowerCase() : word;
      return index === 0
        ? lower.charAt(0).toLowerCase() + lower.slice(1)
        : lower.charAt(0).toUpperCase() + lower.slice(1);
    })
    .join("");
}
