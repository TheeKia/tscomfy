import { CliError } from "./io.ts";
import { recordable } from "./util.ts";

/** One flag a command accepts: `--name value`, `--name=value`, or a boolean `--name`. */
export interface FlagSpec {
  readonly name: string;
  readonly takesValue: boolean;
  /** A one-letter alias of a boolean flag: `h` for `-h`. */
  readonly short?: string;
}

/** Parsed flags: the value of each given flag, `true` for a boolean one. */
export type Flags = ReadonlyMap<string, string | true>;

/** `-h, --help`, which every command takes. */
export const HELP: FlagSpec = { name: "help", takesValue: false, short: "h" };

/**
 * Parses the arguments after the command name. Throws a usage {@link CliError} (exit 2).
 *
 * A value given apart (`--out dir`) can't start with `-`, so a forgotten value isn't read from
 * the next flag (`--out --from x`); `--out=-dir` gives such a value. Every value is recorded in
 * a regenerate command, which can't keep control characters or line separators, so none may
 * have one.
 */
export function parseFlags(args: readonly string[], specs: readonly FlagSpec[]): Flags {
  const flags = new Map<string, string | true>();
  for (let index = 0; index < args.length; index++) {
    const arg = args[index] ?? "";
    const short = /^-([A-Za-z])$/.exec(arg)?.[1];
    if (short !== undefined) {
      const spec = specs.find((each) => each.short === short);
      if (spec === undefined) throw new CliError(`Unknown option -${short}.`, 2);
      if (flags.has(spec.name)) throw new CliError(`--${spec.name} is given twice.`, 2);
      flags.set(spec.name, true);
      continue;
    }
    if (!arg.startsWith("--")) throw new CliError(`Unexpected argument ${JSON.stringify(arg)}.`, 2);
    const equals = arg.indexOf("=");
    const name = arg.slice(2, equals === -1 ? undefined : equals);
    const spec = specs.find((each) => each.name === name);
    if (spec === undefined) throw new CliError(`Unknown option --${name}.`, 2);
    if (flags.has(name)) throw new CliError(`--${name} is given twice.`, 2);
    if (!spec.takesValue) {
      if (equals !== -1) throw new CliError(`--${name} takes no value.`, 2);
      flags.set(name, true);
      continue;
    }
    const given = equals === -1 ? args[++index] : arg.slice(equals + 1);
    if (given === undefined || given === "") throw new CliError(`--${name} needs a value.`, 2);
    if (equals === -1 && given.startsWith("-")) {
      throw new CliError(
        `--${name} needs a value; for one that starts with -, write --${name}=<value>.`,
        2,
      );
    }
    if (!recordable(given)) {
      throw new CliError(
        `--${name} has a control character or a line separator, which a regenerate command can't keep.`,
        2,
      );
    }
    flags.set(name, given);
  }
  return flags;
}

/** A flag's value, if given. */
export function value(flags: Flags, name: string): string | undefined {
  const given = flags.get(name);
  return typeof given === "string" ? given : undefined;
}

/** A flag's value, which must be given. */
export function required(flags: Flags, name: string): string {
  const given = value(flags, name);
  if (given === undefined) throw new CliError(`--${name} is required.`, 2);
  return given;
}
