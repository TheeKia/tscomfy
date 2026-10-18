import {
  createDiagnostic,
  type Diagnostic,
  type DiagnosticPath,
} from "../diagnostic/diagnostic.ts";
import { isJsonArray, type JsonValue } from "./value.ts";

/** The result of {@link parse}. */
export interface ParseResult {
  /** The parsed value, or `undefined` when the text is not valid JSON. */
  readonly value: JsonValue | undefined;
  /** `E_INVALID_JSON`, `W_NON_FINITE_NUMBER` or `W_PRECISION_LOSS`; see {@link parse}. */
  readonly diagnostics: readonly Diagnostic[];
}

/** A `JSON.parse` reviver's context argument, on runtimes with source-text access. */
interface ReviverContext {
  readonly source?: string;
}

type Reviver = (key: string, value: unknown, context?: ReviverContext) => unknown;

/**
 * `JSON.parse`, typed by what it returns: JSON values, plus the bigints our reviver produces.
 * Its declared return type is `any`, which this boundary keeps out of the rest of the code.
 */
const parseJson: (text: string, reviver?: Reviver) => JsonValue = JSON.parse;

const INTEGER_LITERAL = /^-?(?:0|[1-9]\d*)$/;

/** Python's `json.dumps` writes these for non-finite floats. They aren't JSON. */
const PYTHON_NON_FINITE = ["-Infinity", "Infinity", "NaN"] as const;

/** Whether this runtime passes the source text of primitives to `JSON.parse` revivers. */
const HAS_SOURCE_ACCESS: boolean = probeSourceAccess();

function probeSourceAccess(): boolean {
  let supported = false;
  JSON.parse("0", (_key: string, value: unknown, context?: ReviverContext) => {
    supported = context?.source === "0";
    return value;
  });
  return supported;
}

/**
 * Parses JSON text, keeping integers beyond 2^53 exact as `bigint` wherever they occur
 *. Integer literals inside the safe range, and every literal with a fraction
 * or an exponent, stay `number`. The result never holds a non-finite number.
 *
 * Never throws for bad input:
 * - invalid JSON yields `E_INVALID_JSON` and no value;
 * - `NaN`, `Infinity` and `-Infinity` (which Python servers write for non-finite floats), and
 *   number literals beyond the double range, become `null` with `W_NON_FINITE_NUMBER`;
 * - on runtimes without `JSON.parse` source-text access, each integer that may have lost
 *   precision yields `W_PRECISION_LOSS`.
 */
export function parse(text: string): ParseResult {
  return parseWith(text, HAS_SOURCE_ACCESS);
}

/**
 * {@link parse} with source-text access forced on or off. Exported for tests of the fallback;
 * not part of the public API.
 */
export function parseWith(text: string, sourceAccess: boolean): ParseResult {
  // An object, so the flag set inside the reviver isn't narrowed away.
  const seen = { nonFinite: false };
  const reviver: Reviver = (_key, value, context) => {
    if (typeof value !== "number" || Number.isSafeInteger(value)) return value;
    const source = context?.source;
    if (source !== undefined && INTEGER_LITERAL.test(source)) return BigInt(source);
    if (!Number.isFinite(value)) seen.nonFinite = true;
    return value;
  };
  const read = (source: string): JsonValue =>
    sourceAccess ? parseJson(source, reviver) : parseJson(source);

  let value: JsonValue;
  let marker: string | undefined;
  try {
    value = read(text);
  } catch (error) {
    const marked = markPythonNonFinite(text);
    try {
      if (marked === undefined) throw error;
      value = read(marked.text);
      marker = marked.marker;
    } catch {
      const reason = error instanceof Error ? error.message : String(error);
      return {
        value: undefined,
        diagnostics: [createDiagnostic("E_INVALID_JSON", [], `Invalid JSON: ${reason}`)],
      };
    }
  }
  if (sourceAccess && !seen.nonFinite && marker === undefined) return { value, diagnostics: [] };
  const diagnostics: Diagnostic[] = [];
  const clean = sanitize(value, [], { checkPrecision: !sourceAccess, marker, diagnostics });
  return { value: clean, diagnostics };
}

interface SanitizeOptions {
  readonly checkPrecision: boolean;
  /** Prefix of the strings {@link markPythonNonFinite} put in place of non-finite tokens. */
  readonly marker: string | undefined;
  readonly diagnostics: Diagnostic[];
}

/** Replaces non-finite numbers and marked tokens with `null`, reporting each. */
function sanitize(value: JsonValue, path: DiagnosticPath, options: SanitizeOptions): JsonValue {
  if (typeof value === "number") {
    if (!Number.isFinite(value)) {
      options.diagnostics.push(
        createDiagnostic(
          "W_NON_FINITE_NUMBER",
          path,
          "A number literal is beyond the double range; reading it as null.",
        ),
      );
      return null;
    }
    if (options.checkPrecision && Number.isInteger(value) && !Number.isSafeInteger(value)) {
      options.diagnostics.push(
        createDiagnostic(
          "W_PRECISION_LOSS",
          path,
          `The integer ${String(value)} may have lost precision: this runtime has no JSON.parse source-text access.`,
        ),
      );
    }
    return value;
  }
  if (typeof value === "string") {
    const { marker } = options;
    if (marker === undefined || !value.startsWith(marker)) return value;
    options.diagnostics.push(
      createDiagnostic(
        "W_NON_FINITE_NUMBER",
        path,
        `${value.slice(marker.length)} is not JSON (Python writes it for non-finite floats); reading it as null.`,
      ),
    );
    return null;
  }
  if (typeof value !== "object" || value === null) return value;
  if (isJsonArray(value))
    return value.map((item, index) => sanitize(item, [...path, index], options));
  // Object.fromEntries defines own data properties, so a "__proto__" key stays an ordinary key.
  return Object.fromEntries(
    Object.entries(value).map(([key, item]) => [key, sanitize(item, [...path, key], options)]),
  );
}

/**
 * Replaces each `NaN`/`Infinity`/`-Infinity` token outside strings with a marked JSON string, so
 * the text parses and {@link sanitize} can report each one at its path. Returns `undefined` when
 * there is none. Outside strings, valid JSON has no other words starting with `N` or `I`.
 */
function markPythonNonFinite(text: string): { text: string; marker: string } | undefined {
  // The marker starts with U+0000, which raw JSON text can't hold inside a string; checking the
  // rest keeps it apart from escaped `\u0000` too.
  let marker = "\u0000tscomfy:non-finite:";
  while (text.includes(marker.slice(1))) marker += "#";
  let result = "";
  let copied = 0;
  let inString = false;
  for (let index = 0; index < text.length; index++) {
    const char = text[index];
    if (inString) {
      if (char === "\\") index++;
      else if (char === '"') inString = false;
      continue;
    }
    if (char === '"') {
      inString = true;
      continue;
    }
    const token = PYTHON_NON_FINITE.find((candidate) => text.startsWith(candidate, index));
    if (token === undefined) continue;
    result += text.slice(copied, index) + JSON.stringify(marker + token);
    index += token.length - 1;
    copied = index + 1;
  }
  if (copied === 0) return undefined;
  return { text: result + text.slice(copied), marker };
}
