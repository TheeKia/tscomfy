// Identifiers for generated declarations. ComfyUI names (class types, input names, option keys)
// are arbitrary strings: 328 class names in a real dump are not identifiers. They stay exact as
// property keys and are sanitized only where TypeScript needs an identifier.

const IDENTIFIER = /^[A-Za-z_$][A-Za-z0-9_$]*$/;

/** A property key: the name itself when it is an identifier, else a string literal. */
export function propertyKey(name: string): string {
  return IDENTIFIER.test(name) ? name : JSON.stringify(name);
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
