import { mkdir, readFile, realpath, rename, rm, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { errorBodyMessage, redactUrl } from "./util.ts";

/** Everything the CLI does to the outside world, so commands can be tested without it. */
export interface Io {
  /** Writes to standard output. */
  readonly out: (text: string) => void;
  /** Writes to standard error. */
  readonly err: (text: string) => void;
  /**
   * GETs a URL's body; throws a {@link CliError} for a network error or a non-2xx status (with
   * the message of an error body, such as `{"detail": "Not authenticated"}`).
   */
  readonly fetchText: (url: string) => Promise<string>;
  /** A file's text (UTF-8, without a byte order mark), or `undefined` when it doesn't exist. */
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

/** The real world: the process's streams, `fetch` and `node:fs`, which Node and Bun both have. */
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
          // Best effort: the status says what went wrong; the body may say why.
          const body = await response.text().catch(() => "");
          const detail = errorBodyMessage(body);
          throw new CliError(
            `${shown} answered ${answer}${detail === undefined ? "" : `: ${detail}`}`,
          );
        }
        return await response.text();
      } catch (error) {
        if (error instanceof CliError) throw error;
        throw new CliError(`Could not reach ${shown}: ${reason(error)}`);
      }
    },
    readText: async (path) => {
      try {
        // TextDecoder drops a byte order mark, as editors that save one expect.
        return new TextDecoder().decode(await readFile(path));
      } catch (error) {
        if (codeOf(error) === "ENOENT") return undefined;
        throw new CliError(`Could not read ${path}: ${reason(error)}`);
      }
    },
    writeText: async (path, text) => {
      // Through a temporary file, so an interrupted run never leaves a file half written. One
      // name per file, so a run that was killed leaves nothing a later run doesn't replace; and
      // a symlink is followed, so the file it points to is the one replaced.
      const target = await realpath(path).catch(() => path);
      const temporary = `${target}.tmp`;
      try {
        await mkdir(dirname(target), { recursive: true });
        await writeFile(temporary, text);
        await rename(temporary, target);
      } catch (error) {
        // Best effort: when the directory can't be made, there is nothing to remove.
        await rm(temporary, { force: true }).catch(() => undefined);
        throw new CliError(`Could not write ${path}: ${reason(error)}`);
      }
    },
  };
}

function reason(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function codeOf(error: unknown): unknown {
  return typeof error === "object" && error !== null ? Reflect.get(error, "code") : undefined;
}
