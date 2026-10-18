import { type JsonValue, parse, stringify } from "@tscomfy/core";

/** Whether a JSON value is an object (not null, not an array). */
export function isRecord(value: JsonValue): value is { readonly [key: string]: JsonValue } {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** A word for a POSIX shell, quoted only when it has to be: `out dir` → `'out dir'`. */
export function shellQuote(word: string): string {
  return /^[\w@%+=:,./-]+$/.test(word) ? word : `'${word.replaceAll("'", "'\\''")}'`;
}

/**
 * `--name value` for a POSIX shell, as the CLI reads it back: `--name=value` when the value
 * starts with `-`, which the separate form would take for a flag (`--out=--weird`).
 */
export function flagWords(name: string, value: string): string {
  return value.startsWith("-")
    ? `--${name}=${shellQuote(value)}`
    : `--${name} ${shellQuote(value)}`;
}

/**
 * An export name from a file or directory name, the same rule for `generate --out` and
 * `transpile --prompt`: camelCase from the runs of ASCII letters and digits, a word in capitals
 * lowercased, the first word starting lowercase and the others uppercase
 * (`src/comfy/local` → `local`, `my-server` → `myServer`, `Anima-API.json` → `animaApi`).
 * May be empty or start with a digit: callers check the result.
 */
export function camelName(text: string): string {
  const words = text.match(/[A-Za-z0-9]+/g) ?? [];
  return words
    .map((word, index) => {
      const lower = word === word.toUpperCase() ? word.toLowerCase() : word;
      return index === 0
        ? lower.charAt(0).toLowerCase() + lower.slice(1)
        : lower.charAt(0).toUpperCase() + lower.slice(1);
    })
    .join("");
}

/** How much of an error body's message a message shows. */
const SHOWN_DETAIL = 200;

/**
 * The message of an error body, when `text` is one rather than an answer: an object with a lone
 * `detail`, `error` or `message` (`{"detail": "Not authenticated"}`, as auth proxies in front of
 * ComfyUI send), whose value isn't a node definition. Shown as compact JSON, at most 200
 * characters, with every control character escaped, so none reaches the terminal.
 */
export function errorBodyMessage(text: string): string | undefined {
  const value = parse(text).value;
  if (value === undefined || !isRecord(value)) return undefined;
  const keys = Object.keys(value);
  const [key] = keys;
  if (keys.length !== 1 || (key !== "detail" && key !== "error" && key !== "message")) {
    return undefined;
  }
  const message = value[key];
  if (message === undefined || message === null) return undefined;
  // A node class named `error` is an object with its inputs and outputs.
  if (isRecord(message) && (Object.hasOwn(message, "input") || Object.hasOwn(message, "output"))) {
    return undefined;
  }
  // `stringify` escapes C0 controls; DEL and C1 controls (a CSI is U+009B) are escaped here.
  const shown = stringify(message).replaceAll(
    /[\u007f-\u009f]/g,
    (char) => `\\u${char.charCodeAt(0).toString(16).padStart(4, "0")}`,
  );
  if (shown.length <= SHOWN_DETAIL) return shown;
  const cut = shown.slice(0, SHOWN_DETAIL);
  // Not half a surrogate pair.
  return `${/[\ud800-\udbff]$/.test(cut) ? cut.slice(0, -1) : cut}…`;
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
