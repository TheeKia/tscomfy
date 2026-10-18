import { basename, dirname, join } from "node:path";
import { CODEGEN_VERSION, exportNameProblem, generate } from "@tscomfy/codegen";
import { hashSchema } from "@tscomfy/core";
import { type Flags, HELP, parseFlags, required, value } from "./args.ts";
import { CliError, type Io } from "./io.ts";
import {
  contentHash,
  formatManifest,
  MANIFEST,
  type Manifest,
  readManifest,
  SNAPSHOT,
} from "./manifest.ts";
import { count, formatDiagnostic, reportDiagnostics, size } from "./report.ts";
import { loadSchema, readSource, type Source } from "./source.ts";
import { camelName, flagWords } from "./util.ts";

/** `tscomfy generate --help`. */
export const GENERATE_USAGE: string = `Usage: tscomfy generate (--url <server> | --from <object_info.json>) --out <dir> [options]

Writes <dir>/nodes.ts (types), <dir>/index.ts (the typed schema), <dir>/${SNAPSHOT}
(the raw response, for regenerating offline and for \`tscomfy check\`) and <dir>/${MANIFEST}
(what was generated, for \`tscomfy check\` and \`tscomfy transpile\`).

Options:
  --url <server>             A ComfyUI server, e.g. http://127.0.0.1:8188. Only GET requests.
                             Credentials and the query are sent, never written or shown.
  --from <file>              A saved /object_info response instead of a server.
  --out <dir>                The directory to write into.
  --name <identifier>        The exported schema constant. Default: from the directory name,
                             camelCased (my-server → myServer).
  --import-extension <ext>   How index.ts imports nodes.ts: .js (default) or .ts.
  --comfy-version <version>  The ComfyUI version to record, with --from. Default: the one
                             recorded next to <file> when it is a snapshot generate wrote.
  --verbose                  List every diagnostic.
  --quiet                    Print errors only.
  -h, --help                 Show this help.

The headers record the command that regenerates the files, for a POSIX shell in the directory
generate ran in. A value that starts with - is written --flag=<value>.
`;

const FLAGS = [
  { name: "url", takesValue: true },
  { name: "from", takesValue: true },
  { name: "out", takesValue: true },
  { name: "name", takesValue: true },
  { name: "import-extension", takesValue: true },
  { name: "comfy-version", takesValue: true },
  { name: "verbose", takesValue: false },
  { name: "quiet", takesValue: false },
  HELP,
] as const;

/** `tscomfy generate`. */
export async function generateCommand(io: Io, args: readonly string[]): Promise<number> {
  const flags = parseFlags(args, FLAGS);
  if (flags.has("help")) {
    io.out(GENERATE_USAGE);
    return 0;
  }
  const out = required(flags, "out");
  const exportName = readName(flags, out);
  const importExtension = readExtension(flags);
  if (flags.has("comfy-version") && !flags.has("from")) {
    throw new CliError("--comfy-version goes with --from; with --url it comes from the server.", 2);
  }
  if (flags.has("verbose") && flags.has("quiet")) {
    throw new CliError("--verbose and --quiet don't go together.", 2);
  }
  const read = await readSource(io, flags);
  const source = await withSnapshotVersion(io, flags, read);
  const schema = loadSchema(source);

  const command = regenerateCommand({
    flag: source.flag,
    out,
    exportName,
    importExtension,
    // With --url, the server says again.
    ...(flags.has("from") && source.comfyVersion !== undefined
      ? { comfyVersion: source.comfyVersion }
      : {}),
  });
  const result = generate(schema.schema, { exportName, importExtension, command });
  const files = [...result.files, { path: SNAPSHOT, contents: source.text }];
  await Promise.all(files.map((file) => io.writeText(join(out, file.path), file.contents)));
  // Last: a run interrupted before this leaves a manifest that doesn't match the files.
  const manifest: Manifest = {
    codegen: CODEGEN_VERSION,
    schema: hashSchema(schema.schema),
    exportName,
    importExtension,
    ...(source.comfyVersion === undefined ? {} : { comfyVersion: source.comfyVersion }),
    files: Object.fromEntries(files.map((file) => [file.path, contentHash(file.contents)])),
  };
  await io.writeText(join(out, MANIFEST), formatManifest(manifest));

  const diagnostics = [...schema.diagnostics, ...result.diagnostics];
  if (!flags.has("quiet")) {
    const version =
      schema.schema.comfyVersion === undefined ? "" : ` (ComfyUI ${schema.schema.comfyVersion})`;
    io.out(
      `Generated ${count(Object.keys(schema.schema.nodes).length, "node type")} from ${source.label}${version} into ${out}:\n` +
        `  ${files.map((file) => `${file.path} ${size(byteLength(file.contents))}`).join(" · ")}\n`,
    );
    io.out(reportDiagnostics(diagnostics, schema.schema, source.text, flags.has("verbose")));
  } else {
    const errors = diagnostics.filter((diagnostic) => diagnostic.severity === "error");
    for (const diagnostic of errors) io.err(`${formatDiagnostic(diagnostic)}\n`);
  }
  return 0;
}

/**
 * `--from` a snapshot generate wrote, without `--comfy-version`: the version its manifest
 * records, when the file is exactly the one recorded. Regenerating offline then keeps the
 * version a `--url` run fetched. Anything else (another file, an edited snapshot, no manifest,
 * or one that isn't ours) leaves the version unknown, as for any saved response.
 */
async function withSnapshotVersion(io: Io, flags: Flags, source: Source): Promise<Source> {
  const from = value(flags, "from");
  if (from === undefined || source.comfyVersion !== undefined || basename(from) !== SNAPSHOT) {
    return source;
  }
  const manifest = await readManifest(io, dirname(from)).catch(() => undefined);
  const recorded = manifest?.comfyVersion;
  if (recorded === undefined || manifest?.files[SNAPSHOT] !== contentHash(source.text)) {
    return source;
  }
  return { ...source, comfyVersion: recorded };
}

/** What regenerates a directory: the recorded options, from a given source. */
export interface Regenerate {
  /** `--url <server>` or `--from <file>`, as shell words. */
  readonly flag: string;
  readonly out: string;
  readonly exportName: string;
  readonly importExtension: ".js" | ".ts";
  readonly comfyVersion?: string;
}

/** The `tscomfy generate` command for a POSIX shell; options at their defaults are left out. */
export function regenerateCommand(options: Regenerate): string {
  return [
    "tscomfy generate",
    options.flag,
    flagWords("out", options.out),
    ...(options.exportName === defaultName(options.out)
      ? []
      : [flagWords("name", options.exportName)]),
    ...(options.importExtension === ".js" ? [] : [`--import-extension ${options.importExtension}`]),
    ...(options.comfyVersion === undefined
      ? []
      : [flagWords("comfy-version", options.comfyVersion)]),
  ].join(" ");
}

/** The export name from the output directory (see {@link camelName}), if it can be one. */
function defaultName(out: string): string | undefined {
  const name = camelName(basename(out));
  return exportNameProblem(name) === undefined ? name : undefined;
}

function readName(flags: Flags, out: string): string {
  const given = value(flags, "name");
  if (given === undefined) {
    const derived = defaultName(out);
    if (derived === undefined) {
      const name = camelName(basename(out));
      const why =
        name === "" ? "" : `: ${JSON.stringify(name)} won't do, ${exportNameProblem(name) ?? ""}`;
      throw new CliError(
        `Can't make an export name from ${JSON.stringify(out)}${why}; pass --name.`,
        2,
      );
    }
    return derived;
  }
  const problem = exportNameProblem(given);
  if (problem !== undefined) {
    throw new CliError(`--name ${JSON.stringify(given)} isn't usable: ${problem}.`, 2);
  }
  return given;
}

function readExtension(flags: Flags): ".js" | ".ts" {
  const extension = value(flags, "import-extension") ?? ".js";
  if (extension !== ".js" && extension !== ".ts") {
    throw new CliError("--import-extension is .js or .ts.", 2);
  }
  return extension;
}

function byteLength(text: string): number {
  return new TextEncoder().encode(text).length;
}
