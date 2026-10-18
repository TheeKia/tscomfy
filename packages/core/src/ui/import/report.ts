import type { DiagnosticCode } from "../../diagnostic/diagnostic.ts";

/** Records a diagnostic of the import. */
export type Report = (
  code: DiagnosticCode,
  path: readonly (string | number)[],
  message: string,
) => void;
