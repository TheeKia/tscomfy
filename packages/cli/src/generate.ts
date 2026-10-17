import { basename, join } from "node:path";
import { generate } from "@tscomfy/codegen";
import { type Diagnostic, normalizeObjectInfo, type Schema } from "@tscomfy/core";
import { type Flags, parseFlags, value } from "./args.ts";
import { CliError, type Io } from "./io.ts";
import { count, formatDiagnostic, reportDiagnostics, size } from "./report.ts";
import { readSource, type Source } from "./source.ts";
import { shellQuote } from "./util.ts";

/** The raw snapshot written next to the generated files, for `--from` and `check`. */
export const SNAPSHOT = "object_info.json";

export const GENERATE_USAGE: string = `Usage: tscomfy generate (--url <server> | --from <object_info.json>) --out <dir> [options]

Writes <dir>/nodes.ts (types), <dir>/index.ts (the typed schema) and <dir>/${SNAPSHOT}
(the raw response, for regenerating offline and for \`tscomfy check\`).

Options:
  --url <server>             A ComfyUI server, e.g. http://127.0.0.1:8188. Only GET requests.
  --from <file>              A saved /object_info response instead of a server.
  --out <dir>                The directory to write into.
  --name <identifier>        The exported schema constant. Default: from the directory name.
  --import-extension <ext>   How index.ts imports nodes.ts: .js (default) or .ts.
  --comfy-version <version>  The ComfyUI version to record, with --from.
  --verbose                  List every diagnostic.
  --quiet                    Print errors only.
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

const IDENTIFIER = /^[A-Za-z_$][A-Za-z0-9_$]*$/;

/** `tscomfy generate`. */
export async function generateCommand(io: Io, args: readonly string[]): Promise<number> {
  const flags = parseFlags(args, FLAGS);
  if (flags.has("help")) {
    io.out(GENERATE_USAGE);
    return 0;
  }
  const out = required(flags, "out");
  const exportName = value(flags, "name") ?? defaultName(out);
  const importExtension = readExtension(flags);
  if (flags.has("comfy-version") && !flags.has("from")) {
    throw new CliError("--comfy-version goes with --from; with --url it comes from the server.", 2);
  }
  const source = await readSource(io, flags);
  const schema = loadSchema(source);

  const command = [
    "tscomfy generate",
    source.flag,
    `--out ${shellQuote(out)}`,
    ...(flags.has("name") ? [`--name ${exportName}`] : []),
    ...(importExtension === ".js" ? [] : [`--import-extension ${importExtension}`]),
    ...(source.comfyVersion !== undefined && flags.has("from")
      ? [`--comfy-version ${shellQuote(source.comfyVersion)}`]
      : []),
  ].join(" ");
  const result = generate(schema.schema, { exportName, importExtension, command });
  const files = [...result.files, { path: SNAPSHOT, contents: source.text }];
  await Promise.all(files.map((file) => io.writeText(join(out, file.path), file.contents)));

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
 * The normalized schema of a source. A response that isn't node definitions at all is fatal;
 * anything less is reported and the rest generated.
 */
export function loadSchema(source: Source): {
  readonly schema: Schema;
  readonly diagnostics: readonly Diagnostic[];
} {
  const result = normalizeObjectInfo(
    source.text,
    source.comfyVersion === undefined ? {} : { comfyVersion: source.comfyVersion },
  );
  const fatal = result.diagnostics.find(
    (diagnostic) =>
      diagnostic.code === "E_INVALID_JSON" || diagnostic.code === "E_INVALID_OBJECT_INFO",
  );
  if (fatal !== undefined) {
    throw new CliError(`${source.label} doesn't hold node definitions: ${fatal.message}`);
  }
  return result;
}

export function required(flags: Flags, name: string): string {
  const given = value(flags, name);
  if (given === undefined) throw new CliError(`--${name} is required.`, 2);
  return given;
}

/** The export name from the output directory: `src/comfy/local` → `local`, `my-server` → `myServer`. */
function defaultName(out: string): string {
  const words = basename(out)
    .split(/[^A-Za-z0-9_$]+/)
    .filter((word) => word !== "");
  const name = words
    .map((word, index) => (index === 0 ? word : word.charAt(0).toUpperCase() + word.slice(1)))
    .join("");
  if (!IDENTIFIER.test(name)) {
    throw new CliError(`Can't make an export name from ${JSON.stringify(out)}; pass --name.`, 2);
  }
  return name;
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
