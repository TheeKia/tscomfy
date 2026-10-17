/** How bad a diagnostic is. Every code has exactly one severity (docs/plan.md §5.4, D14). */
export type Severity = "error" | "warning";

/**
 * Every diagnostic code with its severity. The prefix names the severity: `E_` for errors (the
 * item was dropped, or the backend would reject the result), `W_` for warnings (the item was
 * kept but degraded, or can't be verified). Each code is documented in docs/diagnostics.md.
 */
export const DIAGNOSTIC_CODES = {
  E_INVALID_JSON: "error",
  W_PRECISION_LOSS: "warning",
  W_NON_FINITE_NUMBER: "warning",
  E_INVALID_OBJECT_INFO: "error",
  E_INVALID_NODE: "error",
  W_INVALID_NODE_FIELD: "warning",
  W_NODE_NAME_MISMATCH: "warning",
  E_INVALID_INPUT_SECTION: "error",
  E_DUPLICATE_INPUT: "error",
  W_INPUT_ORDER_MISMATCH: "warning",
  W_INVALID_INPUT_SPEC: "warning",
  W_UNSUPPORTED_INPUT_TYPE: "warning",
  W_INVALID_INPUT_OPTION: "warning",
  E_INPUT_KEY_COLLISION: "error",
  E_TOO_MANY_DYNAMIC_INPUTS: "error",
  E_UNKNOWN_CLASS_TYPE: "error",
  E_NO_OUTPUT_NODE: "error",
  E_UNKNOWN_INPUT: "error",
  E_MISSING_INPUT: "error",
  E_INVALID_LINK: "error",
  E_DANGLING_LINK: "error",
  E_TYPE_MISMATCH: "error",
  E_MATCH_TYPE_MISMATCH: "error",
  E_NOT_A_LINK: "error",
  E_INVALID_VALUE: "error",
  W_NON_INTEGER_VALUE: "warning",
  E_OUT_OF_RANGE: "error",
  E_NOT_IN_COMBO: "error",
  W_UNLISTED_COMBO_VALUE: "warning",
  E_UNKNOWN_DYNAMIC_OPTION: "error",
  E_TOO_FEW_DYNAMIC_INPUTS: "error",
  E_DEPENDENCY_CYCLE: "error",
  W_EMPTY_COMBO: "warning",
  W_UNTYPED_INPUT: "warning",
} as const;

/** A stable diagnostic code. Codes are never reused for a different meaning. */
export type DiagnosticCode = keyof typeof DIAGNOSTIC_CODES;

/**
 * Where a diagnostic points: segments into the document it is about. Keys are strings and array
 * indexes are numbers, so a dotted input name is always a single segment.
 */
export type DiagnosticPath = readonly (string | number)[];

/** A problem found in input data. tscomfy reports these as values instead of throwing. */
export interface Diagnostic {
  /** Stable code; see {@link DIAGNOSTIC_CODES}. */
  readonly code: DiagnosticCode;
  /** Fixed per code, and named by the code's prefix. */
  readonly severity: Severity;
  /** Where the problem is, as segments into the document the diagnostic is about. */
  readonly path: DiagnosticPath;
  /** Human-readable explanation. The wording may change between versions; the code doesn't. */
  readonly message: string;
}

/** Builds a frozen diagnostic, taking the severity from the registry. */
export function createDiagnostic(
  code: DiagnosticCode,
  path: DiagnosticPath,
  message: string,
): Diagnostic {
  return Object.freeze({
    code,
    severity: DIAGNOSTIC_CODES[code],
    path: Object.freeze([...path]),
    message,
  });
}
