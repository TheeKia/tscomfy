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
  /** Writes a file, creating its directory. */
  readonly writeText: (path: string, text: string) => Promise<void>;
}

/** A failure to report to the user: a message, and the exit code to end with. */
export class CliError extends Error {
  readonly exitCode: number;

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
      let response: Response;
      try {
        response = await fetch(url, { signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) });
      } catch (error) {
        throw new CliError(`Could not reach ${withoutCredentials(url)}: ${reason(error)}`);
      }
      if (!response.ok) {
        const answer = `${String(response.status)} ${response.statusText}`.trimEnd();
        throw new CliError(`${withoutCredentials(url)} answered ${answer}`);
      }
      return response.text();
    },
    readText: async (path) => {
      const file = Bun.file(path);
      if (!(await file.exists())) return undefined;
      try {
        return await file.text();
      } catch (error) {
        throw new CliError(`Could not read ${path}: ${reason(error)}`);
      }
    },
    writeText: async (path, text) => {
      try {
        await Bun.write(path, text);
      } catch (error) {
        throw new CliError(`Could not write ${path}: ${reason(error)}`);
      }
    },
  };
}

/** A URL fit for messages: `http://user:secret@host/` → `http://host/`. */
export function withoutCredentials(url: string): string {
  if (!URL.canParse(url)) return url;
  const parsed = new URL(url);
  parsed.username = "";
  parsed.password = "";
  return parsed.href;
}

function reason(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
