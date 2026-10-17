import {
  createDiagnostic,
  type Diagnostic,
  type DiagnosticPath,
} from "../diagnostic/diagnostic.ts";
import type { JsonValue } from "./value.ts";

/** The result of {@link parse}. */
export interface ParseResult {
  /** The parsed value, or `undefined` when the text is not valid JSON. */
  readonly value: JsonValue | undefined;
  /** `E_INVALID_JSON`, or `W_PRECISION_LOSS` for each big integer a runtime could not keep. */
  readonly diagnostics: readonly Diagnostic[];
}

/** The context argument of a `JSON.parse` reviver, where the runtime supports source-text access. */
interface ReviverContext {
  readonly source?: string;
}

/**
 * `JSON.parse`, typed by what it returns: JSON values, plus the bigints our reviver produces.
 * Its declared return type is `any`, which this boundary keeps out of the rest of the code.
 */
const parseJson: (
  text: string,
  reviver?: (key: string, value: unknown, context?: ReviverContext) => unknown,
) => JsonValue = JSON.parse;

const INTEGER_LITERAL = /^-?(?:0|[1-9]\d*)$/;

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
 * (docs/plan.md §7.5). Integer literals inside the safe range, and every literal with a fraction
 * or an exponent, stay `number`.
 *
 * Never throws for bad input: invalid JSON yields `E_INVALID_JSON` and no value. On runtimes
 * without `JSON.parse` source-text access, each integer that lost precision yields
 * `W_PRECISION_LOSS`.
 */
export function parse(text: string): ParseResult {
  return parseWith(text, HAS_SOURCE_ACCESS);
}

/**
 * {@link parse} with source-text access forced on or off. Exported for tests of the fallback;
 * not part of the public API.
 */
export function parseWith(text: string, sourceAccess: boolean): ParseResult {
  let value: JsonValue;
  try {
    value = sourceAccess ? parseJson(text, reviveBigIntegers) : parseJson(text);
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    return {
      value: undefined,
      diagnostics: [createDiagnostic("E_INVALID_JSON", [], `Invalid JSON: ${reason}`)],
    };
  }
  return { value, diagnostics: sourceAccess ? [] : findPrecisionLoss(value) };
}

function reviveBigIntegers(_key: string, value: unknown, context?: ReviverContext): unknown {
  if (typeof value !== "number" || Number.isSafeInteger(value)) return value;
  const source = context?.source;
  return source !== undefined && INTEGER_LITERAL.test(source) ? BigInt(source) : value;
}

/**
 * Without source text, an integer-valued number beyond the safe range may have been written as
 * an exact integer, which `JSON.parse` rounded. Report every such number.
 */
function findPrecisionLoss(root: JsonValue): Diagnostic[] {
  const found: Diagnostic[] = [];
  const visit = (value: JsonValue, path: DiagnosticPath): void => {
    if (typeof value === "number") {
      if (Number.isInteger(value) && !Number.isSafeInteger(value)) {
        found.push(
          createDiagnostic(
            "W_PRECISION_LOSS",
            path,
            `The integer ${String(value)} may have lost precision: this runtime has no JSON.parse source-text access.`,
          ),
        );
      }
    } else if (Array.isArray(value)) {
      value.forEach((item: JsonValue, index) => visit(item, [...path, index]));
    } else if (typeof value === "object" && value !== null) {
      for (const [key, item] of Object.entries(value)) visit(item, [...path, key]);
    }
  };
  visit(root, []);
  return found;
}
