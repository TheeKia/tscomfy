import { type Diagnostic, normalizeObjectInfo, type Schema } from "@tscomfy/core";
import { type Flags, value } from "./args.ts";
import { type Io, CliError } from "./io.ts";
import { errorBodyMessage, flagWords, recordable, redactUrl } from "./util.ts";

/** Where node definitions come from: a server, or a saved `/object_info` response. */
export interface Source {
  /** The `/object_info` text, exactly as served or saved. */
  readonly text: string;
  readonly comfyVersion?: string;
  /** For messages: the server or the file. */
  readonly label: string;
  /** For the regenerate command in headers: `--url <server>` or `--from <file>`. */
  readonly flag: string;
}

/**
 * Reads `--url` (GET `/object_info`, and `/system_stats` for the version) or `--from`. Exactly
 * one must be given. Only read-only GETs: tscomfy never queues anything.
 */
export async function readSource(io: Io, flags: Flags): Promise<Source> {
  const url = value(flags, "url");
  const from = value(flags, "from");
  if ((url === undefined) === (from === undefined)) {
    throw new CliError("Give either --url <server> or --from <object_info.json>.", 2);
  }
  if (from !== undefined) {
    const text = await io.readText(from);
    if (text === undefined) throw new CliError(`There is no file at ${from}.`);
    const comfyVersion = value(flags, "comfy-version");
    return {
      text,
      ...(comfyVersion === undefined ? {} : { comfyVersion }),
      label: from,
      flag: flagWords("from", from),
    };
  }
  const base = serverBase(url ?? "");
  const shown = redactUrl(base).replace(/\/+$/, "");
  const text = await io.fetchText(endpoint(base, "object_info"));
  const comfyVersion = await readComfyVersion(io, endpoint(base, "system_stats"));
  return {
    text,
    ...(comfyVersion === undefined ? {} : { comfyVersion }),
    label: shown,
    flag: flagWords("url", shown),
  };
}

/**
 * The server URL. Credentials and the query (which often carries a token) are sent with each
 * request but never shown: messages and generated headers use {@link redactUrl}.
 */
function serverBase(url: string): URL {
  // Not echoed: an unparseable URL may still hold a password.
  if (!URL.canParse(url)) throw new CliError("--url is not a valid URL.", 2);
  const parsed = new URL(url);
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw new CliError(`${redactUrl(parsed)} is not an http(s) URL.`, 2);
  }
  if (parsed.hash !== "") {
    throw new CliError("--url can't have a #fragment: it never reaches the server.", 2);
  }
  return parsed;
}

/** An endpoint under the server's path, keeping its query: `http://h/api/?t=1` → `…/api/x?t=1`. */
function endpoint(base: URL, name: string): string {
  const url = new URL(base.href);
  url.pathname = `${url.pathname.replace(/\/+$/, "")}/${name}`;
  return url.href;
}

/**
 * The ComfyUI version from `/system_stats`; optional, so a failure only loses the version, and so
 * does a version a regenerate command couldn't record.
 */
async function readComfyVersion(io: Io, url: string): Promise<string | undefined> {
  try {
    const stats: unknown = JSON.parse(await io.fetchText(url));
    const system: unknown =
      typeof stats === "object" && stats !== null ? Reflect.get(stats, "system") : undefined;
    const version: unknown =
      typeof system === "object" && system !== null
        ? Reflect.get(system, "comfyui_version")
        : undefined;
    return typeof version === "string" && recordable(version) ? version : undefined;
  } catch {
    return undefined;
  }
}

/**
 * The normalized schema of a source. A response that holds no usable node at all (not JSON, not
 * an object, an error body such as `{"detail": "Not authenticated"}`, or `{}`) is fatal, so it
 * can't replace good types; anything less is reported and the rest generated.
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
    const detail = errorBodyMessage(source.text);
    if (detail !== undefined) {
      throw new CliError(`${source.label} is an error response, not node definitions: ${detail}.`);
    }
    const error = result.diagnostics.find((diagnostic) => diagnostic.severity === "error");
    throw new CliError(
      `${source.label} doesn't hold node definitions${error === undefined ? "" : `: ${error.message}`}`,
    );
  }
  return result;
}
