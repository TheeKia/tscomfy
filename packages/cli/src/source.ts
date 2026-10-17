import { type Flags, value } from "./args.ts";
import { type Io, CliError, withoutCredentials } from "./io.ts";
import { shellQuote } from "./util.ts";

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
      flag: `--from ${shellQuote(from)}`,
    };
  }
  const { request, shown } = serverBase(url ?? "");
  const text = await io.fetchText(`${request}/object_info`);
  const comfyVersion = await readComfyVersion(io, request);
  return {
    text,
    ...(comfyVersion === undefined ? {} : { comfyVersion }),
    label: shown,
    flag: `--url ${shellQuote(shown)}`,
  };
}

/**
 * The server URL without a trailing slash: as requested, and as shown, without credentials,
 * which mustn't end up in messages or generated headers.
 */
function serverBase(url: string): { readonly request: string; readonly shown: string } {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new CliError(`${JSON.stringify(url)} is not a URL.`, 2);
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw new CliError(`${url} is not an http(s) URL.`, 2);
  }
  return {
    request: withoutTrailingSlash(parsed.href),
    shown: withoutTrailingSlash(withoutCredentials(parsed.href)),
  };
}

function withoutTrailingSlash(href: string): string {
  return href.replace(/\/+$/, "");
}

/** The ComfyUI version from `/system_stats`; optional, so a failure only loses the version. */
async function readComfyVersion(io: Io, base: string): Promise<string | undefined> {
  try {
    const stats: unknown = JSON.parse(await io.fetchText(`${base}/system_stats`));
    const system: unknown =
      typeof stats === "object" && stats !== null ? Reflect.get(stats, "system") : undefined;
    const version: unknown =
      typeof system === "object" && system !== null
        ? Reflect.get(system, "comfyui_version")
        : undefined;
    return typeof version === "string" ? version : undefined;
  } catch {
    return undefined;
  }
}
