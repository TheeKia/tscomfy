// Identifiers for generated declarations. ComfyUI names (class types, input names, option keys)
// are arbitrary strings: 328 class names in a real dump are not identifiers. They stay exact as
// property keys and are sanitized only where TypeScript needs an identifier.

// ECMAScript IdentifierName, which oxfmt leaves unquoted as a key (`café`, `日本`).
const IDENTIFIER = /^[\p{ID_Start}$_][\p{ID_Continue}$\u200c\u200d]*$/u;

/** A property key: the name itself when it is an identifier, else a string literal. */
export function propertyKey(name: string): string {
  return IDENTIFIER.test(name) ? name : quote(name);
}

/**
 * A string literal as oxfmt writes it: double quotes, unless the text holds more double quotes
 * than single ones, then single quotes. Other escapes are `JSON.stringify`'s.
 */
export function quote(text: string): string {
  const doubled = JSON.stringify(text);
  const doubles = text.split('"').length - 1;
  const singles = text.split("'").length - 1;
  if (doubles <= singles) return doubled;
  const inner = doubled.slice(1, -1).replaceAll('\\"', '"').replaceAll("'", "\\'");
  return `'${inner}'`;
}

const LINE_TERMINATOR = /\r\n|[\r\n\u2028\u2029]/;

/**
 * Lines of server text for a comment: split at every line terminator (which a comment can't
 * hold raw without oxfmt rewriting it) and with `*\/` escaped, so no name or tooltip can close
 * the comment and inject code.
 */
export function commentLines(text: string): string[] {
  return text.split(LINE_TERMINATOR).map((each) => each.replaceAll("*/", "*\\/").trimEnd());
}

/** Server text for a one-line comment. */
export function commentText(text: string): string {
  return commentLines(text).join(" ");
}

/**
 * A PascalCase identifier part from an arbitrary name: the runs of letters and digits, each
 * capitalized (`sampler_name` → `SamplerName`, `easy kSampler` → `EasyKSampler`). Never empty
 * and never starts with a digit.
 */
export function pascal(name: string, fallback: string): string {
  const words = name.match(/[A-Za-z0-9]+/g) ?? [];
  const joined = words.map((word) => word.charAt(0).toUpperCase() + word.slice(1)).join("");
  if (joined === "") return fallback;
  return /^[0-9]/.test(joined) ? `${fallback}${joined}` : joined;
}

/**
 * Hands out unique names in one namespace, in call order. A taken base gets the first free
 * numeric suffix (`Mode`, `Mode2`, …), so names are stable for a given schema.
 */
export class NameRegistry {
  readonly #taken = new Set<string>();

  constructor(reserved: readonly string[] = []) {
    for (const name of reserved) this.#taken.add(name);
  }

  /** A fresh name based on `base`, now taken. */
  claim(base: string): string {
    let name = base;
    for (let suffix = 2; this.#taken.has(name); suffix++) name = `${base}${String(suffix)}`;
    this.#taken.add(name);
    return name;
  }

  /** Whether `name` is taken. */
  has(name: string): boolean {
    return this.#taken.has(name);
  }
}
