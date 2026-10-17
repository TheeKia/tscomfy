import { basename, join } from "node:path";
import { CODEGEN_VERSION, generate, isExportName } from "@tscomfy/codegen";
import { type Diagnostic, hashSchema, normalizeObjectInfo, type Schema } from "@tscomfy/core";
import { type Flags, parseFlags, value } from "./args.ts";
import { CliError, type Io } from "./io.ts";
import { contentHash, formatManifest, MANIFEST, type Manifest } from "./manifest.ts";
import { count, formatDiagnostic, reportDiagnostics, size } from "./report.ts";
import { readSource, type Source } from "./source.ts";
import { shellQuote } from "./util.ts";

/** The raw snapshot written next to the generated files, for `--from` and `check`. */
export const SNAPSHOT = "object_info.json";

/** `tscomfy generate --help`. */
export const GENERATE_USAGE: string = `Usage: tscomfy generate (--url <server> | --from <object_info.json>) --out <dir> [options]

Writes <dir>/nodes.ts (types), <dir>/index.ts (the typed schema), <dir>/${SNAPSHOT}
(the raw response, for regenerating offline and for \`tscomfy check\`) and <dir>/${MANIFEST}
(what was generated, for \`tscomfy check\`).

Options:
  --url <server>             A ComfyUI server, e.g. http://127.0.0.1:8188. Only GET requests.
                             Credentials and the query are sent, never written or shown.
  --from <file>              A saved /object_info response instead of a server.
  --out <dir>                The directory to write into.
  --name <identifier>        The exported schema constant. Default: from the directory name.
  --import-extension <ext>   How index.ts imports nodes.ts: .js (default) or .ts.
  --comfy-version <version>  The ComfyUI version to record, with --from.
  --verbose                  List every diagnostic.
  --quiet                    Print errors only.

The headers record the command that regenerates the files, for a POSIX shell in the directory
generate ran in.
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
  { name: "help", takesValue: false },
] as const;

/** `tscomfy generate`. */
export async function generateCommand(io: Io, args: readonly string[]): Promise<number> {
  const flags = parseFlags(args, FLAGS);
  if (flags.has("help")) {
    io.out(GENERATE_USAGE);
    return 0;
  }
  const out = path(flags, "out");
  if (flags.has("from")) path(flags, "from");
  const exportName = readName(flags, out);
  const importExtension = readExtension(flags);
  if (flags.has("comfy-version") && !flags.has("from")) {
    throw new CliError("--comfy-version goes with --from; with --url it comes from the server.", 2);
  }
  if (flags.has("verbose") && flags.has("quiet")) {
    throw new CliError("--verbose and --quiet don't go together.", 2);
  }
  const source = await readSource(io, flags);
  const schema = loadSchema(source);

  const command = regenerateCommand({
    flag: source.flag,
    out,
    exportName,
    importExtension,
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
 * The normalized schema of a source. A response that holds no usable node at all (not JSON, not
 * an object, or an error body such as `{"detail": "Not authenticated"}`) is fatal, so it can't
 * replace good types; anything less is reported and the rest generated.
 */
export function loadSchema(source: Source): {
  readonly schema: Schema;
  readonly diagnostics: readonly Diagnostic[];
} {
  const result = normalizeObjectInfo(
    source.text,
    source.comfyVersion === undefined ? {} : { comfyVersion: source.comfyVersion },
  );
  if (Object.keys(result.schema.nodes).length === 0) {
    const error = result.diagnostics.find((diagnostic) => diagnostic.severity === "error");
    throw new CliError(
      `${source.label} doesn't hold node definitions${error === undefined ? "" : `: ${error.message}`}`,
    );
  }
  return result;
}

/** What regenerates a directory: the recorded options, from a given source. */
export interface Regenerate {
  /** `--url <server>` or `--from <file>`, quoted. */
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
    `--out ${shellQuote(options.out)}`,
    ...(options.exportName === defaultName(options.out)
      ? []
      : [`--name ${shellQuote(options.exportName)}`]),
    ...(options.importExtension === ".js" ? [] : [`--import-extension ${options.importExtension}`]),
    ...(options.comfyVersion === undefined
      ? []
      : [`--comfy-version ${shellQuote(options.comfyVersion)}`]),
  ].join(" ");
}

/** A path flag's value, required; refused when it has control characters a header can't keep. */
export function path(flags: Flags, name: string): string {
  const given = value(flags, name);
  if (given === undefined) throw new CliError(`--${name} is required.`, 2);
  // oxlint-disable-next-line no-control-regex -- control characters are what this looks for
  if (/[\u0000-\u001f\u007f]/.test(given)) {
    throw new CliError(
      `--${name} has a control character, which a regenerate command can't keep.`,
      2,
    );
  }
  return given;
}

/** The export name from the output directory: `src/comfy/local` → `local`, `my-server` → `myServer`. */
function defaultName(out: string): string | undefined {
  const words = basename(out)
    .split(/[^A-Za-z0-9_$]+/)
    .filter((word) => word !== "");
  const name = words
    .map((word, index) => (index === 0 ? word : word.charAt(0).toUpperCase() + word.slice(1)))
    .join("");
  return isExportName(name) ? name : undefined;
}

function readName(flags: Flags, out: string): string {
  const given = value(flags, "name");
  if (given === undefined) {
    const derived = defaultName(out);
    if (derived === undefined) {
      throw new CliError(`Can't make an export name from ${JSON.stringify(out)}; pass --name.`, 2);
    }
    return derived;
  }
  if (!isExportName(given)) {
    throw new CliError(
      `--name ${JSON.stringify(given)} isn't usable: it must be an identifier, not a reserved word.`,
      2,
    );
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
