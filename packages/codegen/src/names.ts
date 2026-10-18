// Identifiers and literal text for generated code. ComfyUI names (class types, input names,
// option keys) are arbitrary strings: 328 class names in a real dump are not identifiers. They
// stay exact as property keys and are sanitized only where TypeScript needs an identifier.

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
 * Lines of text for a block comment: split at every line terminator (which a comment can't hold
 * raw without oxfmt rewriting it) and with `*\/` escaped, so no name or tooltip can close the
 * comment and inject code.
 */
export function commentLines(text: string): string[] {
  return lines(text).map((each) => each.replaceAll("*/", "*\\/"));
}

/** Text for a one-line block comment. */
export function commentText(text: string): string {
  return commentLines(text).join(" ");
}

/**
 * Server text made inert in a doc comment: an `@` that would start a JSDoc tag (a tooltip line
 * `@deprecated …` would make editors strike the input through) or an inline tag (`{@link …}`) is
 * escaped as `\@`, which TypeScript doesn't read as one.
 */
export function untagged(text: string): string {
  return text.replaceAll(/(^|\s|\{)@/g, "$1\\@");
}

function lines(text: string): string[] {
  return text.split(LINE_TERMINATOR).map((each) => each.trimEnd());
}

/** A number literal as Prettier writes it: exponents without `+` (`1e21`, not `1e+21`). */
export function numberText(value: number): string {
  return Object.is(value, -0) ? "-0" : String(value).replace("e+", "e");
}

/**
 * `//` comment lines, one per entry: line terminators in the text can't end the comment early,
 * and nothing else needs escaping there (a `*\/` in a recorded path stays as it is).
 */
export function headerLines(header: readonly string[]): string[] {
  return header.map((text) => `// ${lines(text).join(" ")}`);
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
  /** Per base, the first suffix not yet tried: names are never given back, so none below is free. */
  readonly #next = new Map<string, number>();

  constructor(reserved: readonly string[] = []) {
    for (const name of reserved) this.#taken.add(name);
  }

  /** A fresh name based on `base`, now taken. */
  claim(base: string): string {
    return this.claimAll([base])[0] ?? base;
  }

  /** Fresh names based on `bases`, claimed in turn, now taken. */
  claimAll(bases: readonly string[]): string[] {
    const { names, next } = this.#fresh(bases);
    for (const name of names) this.#taken.add(name);
    for (const [base, suffix] of next) this.#next.set(base, suffix);
    return names;
  }

  /** The names {@link claimAll} would give `bases`, none of them taken yet. */
  preview(bases: readonly string[]): string[] {
    return this.#fresh(bases).names;
  }

  #fresh(bases: readonly string[]): {
    readonly names: string[];
    readonly next: ReadonlyMap<string, number>;
  } {
    const taken = new Set<string>();
    const next = new Map<string, number>();
    const names = bases.map((base) => {
      let suffix = next.get(base) ?? this.#next.get(base) ?? 1;
      let name = suffix === 1 ? base : `${base}${String(suffix)}`;
      while (this.#taken.has(name) || taken.has(name)) {
        suffix++;
        name = `${base}${String(suffix)}`;
      }
      next.set(base, suffix + 1);
      taken.add(name);
      return name;
    });
    return { names, next };
  }

  /** Whether `name` is taken. */
  has(name: string): boolean {
    return this.#taken.has(name);
  }
}
