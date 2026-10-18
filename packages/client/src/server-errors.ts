import { createDiagnostic, type Diagnostic, type JsonValue } from "@tscomfy/core";
import { isList, isObject } from "./http.ts";

/**
 * The diagnostics of the server's answer to a prompt: its top-level `error` (only on a
 * rejection) as `E_PROMPT_REJECTED`, then each node error as `E_SERVER_VALIDATION`, by node id.
 */
export function serverDiagnostics(
  error: JsonValue | undefined,
  nodeErrors: JsonValue | undefined,
): readonly Diagnostic[] {
  const diagnostics: Diagnostic[] = [];
  if (error !== undefined) diagnostics.push(rejection(error));
  if (isObject(nodeErrors)) {
    for (const [node, entry] of Object.entries(nodeErrors)) {
      const listed = isObject(entry) ? entry["errors"] : undefined;
      const errors = isList(listed) ? listed : [entry];
      for (const each of errors) {
        const inputName = isObject(each) ? inputOf(each["extra_info"]) : undefined;
        diagnostics.push(
          createDiagnostic(
            "E_SERVER_VALIDATION",
            inputName === undefined ? [node] : [node, "inputs", inputName],
            describe(each),
          ),
        );
      }
    }
  }
  return Object.freeze(diagnostics);
}

/** The top-level error: at the node it names (an unknown class), else at the prompt. */
function rejection(error: JsonValue): Diagnostic {
  const extra = isObject(error) && isObject(error["extra_info"]) ? error["extra_info"] : {};
  const node = extra["node_id"];
  return createDiagnostic(
    "E_PROMPT_REJECTED",
    typeof node === "string" && node !== "" ? [node] : [],
    describe(error),
  );
}

function inputOf(extra: JsonValue | undefined): string | undefined {
  const name = isObject(extra) ? extra["input_name"] : undefined;
  return typeof name === "string" && name !== "" ? name : undefined;
}

/** `type: message: details`, leaving out the parts the server didn't send. */
function describe(error: JsonValue): string {
  if (typeof error === "string") return error;
  if (!isObject(error)) return "The server reported an error it didn't describe.";
  const parts = [error["type"], error["message"], error["details"]].filter(
    (part): part is string => typeof part === "string" && part !== "",
  );
  // The server repeats the message as the details for some errors.
  const unique = parts.filter((part, index) => parts.indexOf(part) === index);
  return unique.length === 0
    ? "The server reported an error it didn't describe."
    : unique.join(": ");
}
