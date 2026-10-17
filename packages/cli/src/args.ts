import { CliError } from "./io.ts";

/** One flag a command accepts: `--name value`, `--name=value`, or a boolean `--name`. */
export interface FlagSpec {
  readonly name: string;
  readonly takesValue: boolean;
}

/** Parsed flags: the value of each given flag, `true` for a boolean one. */
export type Flags = ReadonlyMap<string, string | true>;

/** Parses the arguments after the command name. Throws a usage {@link CliError} (exit 2). */
export function parseFlags(args: readonly string[], specs: readonly FlagSpec[]): Flags {
  const flags = new Map<string, string | true>();
  for (let index = 0; index < args.length; index++) {
    const arg = args[index] ?? "";
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
    if (given === undefined || given === "" || (equals === -1 && given.startsWith("--"))) {
      throw new CliError(`--${name} needs a value.`, 2);
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
