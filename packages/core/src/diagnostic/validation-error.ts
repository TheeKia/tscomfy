import type { Diagnostic } from "./diagnostic.ts";

/**
 * Thrown by `toApi` when a workflow can't become a prompt the backend would accept. Carries every
 * diagnostic, errors and warnings, so callers can report them all at once.
 */
export class ValidationError extends Error {
  readonly diagnostics: readonly Diagnostic[];

  constructor(diagnostics: readonly Diagnostic[]) {
    const errors = diagnostics.filter((diagnostic) => diagnostic.severity === "error");
    super(
      [
        `The workflow has ${String(errors.length)} error${errors.length === 1 ? "" : "s"}:`,
        ...errors.map(
          (diagnostic) =>
            `  ${diagnostic.code}${diagnostic.path.length === 0 ? "" : ` at ${diagnostic.path.join(" › ")}`}: ${diagnostic.message}`,
        ),
      ].join("\n"),
    );
    this.name = "ValidationError";
    this.diagnostics = Object.freeze([...diagnostics]);
  }
}
