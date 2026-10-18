import { CHECK_USAGE, checkCommand } from "./check.ts";
import { GENERATE_USAGE, generateCommand } from "./generate.ts";
import { CliError, type Io } from "./io.ts";
import { TRANSPILE_USAGE, transpileCommand } from "./transpile.ts";

/** The CLI's version. A test keeps it equal to package.json. */
export const CLI_VERSION = "0.1.2";

/** `tscomfy --help`. */
const USAGE = `Usage: tscomfy <command> [options]

Commands:
  generate   Generate typed node definitions from a ComfyUI server
  check      Check that the generated types still match the server
  transpile  Turn an API-format prompt or a UI workflow into TypeScript over the generated types
  help       Show this help, or a command's: tscomfy help <command>

Options:
  -h, --help     Show this help.
  -v, --version  Print the version.

Run tscomfy <command> --help for a command's options.
`;

const USAGES: ReadonlyMap<string, string> = new Map([
  ["generate", GENERATE_USAGE],
  ["check", CHECK_USAGE],
  ["transpile", TRANSPILE_USAGE],
]);

/**
 * Runs the CLI with `args` (without the program name) and returns the exit code: 0 on success,
 * 1 on a failure or detected drift, 2 on a usage error.
 */
export async function run(args: readonly string[], io: Io): Promise<number> {
  const [command, ...rest] = args;
  try {
    switch (command) {
      case "generate":
        return await generateCommand(io, rest);
      case "check":
        return await checkCommand(io, rest);
      case "transpile":
        return await transpileCommand(io, rest);
      case "-v":
      case "--version":
        noArguments(rest);
        io.out(`${CLI_VERSION}\n`);
        return 0;
      case "-h":
      case "--help":
        noArguments(rest);
        io.out(USAGE);
        return 0;
      case "help":
        return help(io, rest);
      case undefined:
        io.err(USAGE);
        return 2;
      default:
        throw new CliError(`Unknown command ${JSON.stringify(command)}.`, 2);
    }
  } catch (error) {
    if (!(error instanceof CliError)) throw error;
    io.err(`tscomfy: ${error.message}\n`);
    if (error.exitCode === 2) {
      io.err(`\n${USAGES.get(command ?? "") ?? USAGE}`);
    }
    return error.exitCode;
  }
}

/** `tscomfy help [<command>]`: the usage, or a command's. */
function help(io: Io, args: readonly string[]): number {
  const [topic, ...rest] = args;
  noArguments(rest);
  if (topic === undefined) {
    io.out(USAGE);
    return 0;
  }
  const usage = USAGES.get(topic);
  if (usage === undefined) throw new CliError(`Unknown command ${JSON.stringify(topic)}.`, 2);
  io.out(usage);
  return 0;
}

function noArguments(args: readonly string[]): void {
  const [extra] = args;
  if (extra !== undefined) throw new CliError(`Unexpected argument ${JSON.stringify(extra)}.`, 2);
}
