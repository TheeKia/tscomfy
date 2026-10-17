import { rename, rm } from "node:fs/promises";

/** Everything the CLI does to the outside world, so commands can be tested without it. */
export interface Io {
  /** Writes to standard output. */
  readonly out: (text: string) => void;
  /** Writes to standard error. */
  readonly err: (text: string) => void;
  /** GETs a URL's body; throws a {@link CliError} for a network error or a non-2xx status. */
  readonly fetchText: (url: string) => Promise<string>;
  /** A file's text, or `undefined` when it doesn't exist. */
  readonly readText: (path: string) => Promise<string | undefined>;
  /** Replaces a file's contents in one step, creating its directory. */
  readonly writeText: (path: string, text: string) => Promise<void>;
}

/** A failure to report to the user: a message, and the exit code to end with. */
export class CliError extends Error {
  /** 1 for a failure, 2 for a usage error. */
  readonly exitCode: number;

  /** A failure with `message`, ending the process with `exitCode`. */
  constructor(message: string, exitCode = 1) {
    super(message);
    this.name = "CliError";
    this.exitCode = exitCode;
  }
}

const FETCH_TIMEOUT_MS = 60_000;

/** The real world, through Bun. */
export function systemIo(): Io {
  return {
    out: (text) => {
      process.stdout.write(text);
    },
    err: (text) => {
      process.stderr.write(text);
    },
    fetchText: async (url) => {
      const shown = redactUrl(new URL(url));
      try {
        const response = await fetch(url, { signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) });
        if (!response.ok) {
          const answer = `${String(response.status)} ${response.statusText}`.trimEnd();
          throw new CliError(`${shown} answered ${answer}`);
        }
        return await response.text();
      } catch (error) {
        if (error instanceof CliError) throw error;
        throw new CliError(`Could not reach ${shown}: ${reason(error)}`);
      }
    },
    readText: async (path) => {
      try {
        return await Bun.file(path).text();
      } catch (error) {
        if (codeOf(error) === "ENOENT") return undefined;
        throw new CliError(`Could not read ${path}: ${reason(error)}`);
      }
    },
    writeText: async (path, text) => {
      // Through a temporary file, so an interrupted run never leaves a file half written.
      const temporary = `${path}.${String(process.pid)}.tmp`;
      try {
        await Bun.write(temporary, text);
        await rename(temporary, path);
      } catch (error) {
        // Best effort: when the directory can't be made, there is nothing to remove.
        await rm(temporary, { force: true }).catch(() => undefined);
        throw new CliError(`Could not write ${path}: ${reason(error)}`);
      }
    },
  };
}

/**
 * A URL fit for messages and generated files: without credentials, query or fragment, which is
 * where servers expect passwords and tokens. `http://user:pw@host/api?token=t` → `http://host/api`.
 */
export function redactUrl(url: URL): string {
  const shown = new URL(url.href);
  shown.username = "";
  shown.password = "";
  shown.search = "";
  shown.hash = "";
  return shown.href;
}

function reason(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function codeOf(error: unknown): unknown {
  return typeof error === "object" && error !== null ? Reflect.get(error, "code") : undefined;
}
