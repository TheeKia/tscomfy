import { CHECK_USAGE, checkCommand } from "./check.ts";
import { GENERATE_USAGE, generateCommand } from "./generate.ts";
import { CliError, type Io } from "./io.ts";
import { TRANSPILE_USAGE, transpileCommand } from "./transpile.ts";

/** The CLI's version. A test keeps it equal to package.json. */
export const CLI_VERSION = "0.0.0";

/** `tscomfy --help`. */
export const USAGE: string = `Usage: tscomfy <command> [options]

Commands:
  generate   Generate typed node definitions from a ComfyUI server
  check      Check that the generated types still match the server
  transpile  Turn an API-format prompt into TypeScript over the generated types

Run tscomfy <command> --help for a command's options.
`;

const USAGES = new Map([
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
      case "--version":
        io.out(`${CLI_VERSION}\n`);
        return 0;
      case "--help":
      case "help":
        io.out(USAGE);
        return 0;
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
