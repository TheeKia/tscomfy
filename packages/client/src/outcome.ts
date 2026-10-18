import type { Diagnostic, NodeId } from "@tscomfy/core";
import type { Outputs } from "./outputs.ts";

/** The job ran to the end. Outputs left out by a partial acceptance are in `diagnostics`. */
export interface SuccessOutcome {
  readonly status: "success";
  readonly outputs: Outputs;
  /**
   * `E_SERVER_VALIDATION` for outputs the server refused while running the others, and
   * `W_NODE_BLOCKED` for nodes that blocked execution.
   */
  readonly diagnostics: readonly Diagnostic[];
}

/** The server refused the prompt: nothing ran. */
export interface RejectedOutcome {
  readonly status: "rejected";
  /** `E_PROMPT_REJECTED` for the server's error, and `E_SERVER_VALIDATION` for each node error. */
  readonly diagnostics: readonly Diagnostic[];
}

/** A node raised an error; the run stopped there. */
export interface FailedOutcome {
  readonly status: "failed";
  readonly error: ExecutionError;
  /** What the nodes that finished before the error reported. */
  readonly outputs: Outputs;
  readonly diagnostics: readonly Diagnostic[];
}

/** The job was cancelled or interrupted, by this client or another. */
export interface CancelledOutcome {
  readonly status: "cancelled";
  /** What the nodes that finished before the cancel reported. */
  readonly outputs: Outputs;
  readonly diagnostics: readonly Diagnostic[];
}

/** How a job ended, as the server's record of it says. */
export type Outcome = SuccessOutcome | RejectedOutcome | FailedOutcome | CancelledOutcome;

/** The error a node raised. */
export interface ExecutionError {
  readonly node: NodeId;
  readonly classType: string;
  /** The exception's class, qualified: `torch.OutOfMemoryError`, `ValueError`. */
  readonly exceptionType: string;
  readonly message: string;
  readonly traceback: readonly string[];
  /** The nodes that had finished. */
  readonly executed: readonly NodeId[];
}
