/**
 * @module @tscomfy/client
 *
 * Runs tscomfy workflows on a ComfyUI server: `connect` opens a websocket, `submit` queues a
 * workflow and returns a job whose events stream progress, live previews and outputs, and whose
 * outcome the server's record of the job decides. `uploadFile` and `fetchFile` move files.
 * Runtime-agnostic: it uses only `fetch`, `WebSocket` and their companions.
 */

export { ClientError } from "./client-error.ts";
export { type Connection, type ConnectOptions, connect } from "./connection.ts";
export type {
  BlockedEvent,
  CachedEvent,
  ExecutingEvent,
  JobEvent,
  OutputEvent,
  PreviewEvent,
  ProgressEvent,
  StartedEvent,
  TextEvent,
} from "./events.ts";
export {
  type FetchFileOptions,
  fetchFile,
  type FileData,
  fileUrl,
  type UploadedFile,
  uploadFile,
  type UploadOptions,
  type UploadSource,
} from "./files.ts";
export { type Job, type PreviewMethod, submit, type SubmitOptions } from "./job.ts";
export type {
  CancelledOutcome,
  ExecutionError,
  FailedOutcome,
  Outcome,
  RejectedOutcome,
  SuccessOutcome,
} from "./outcome.ts";
export {
  type FileKind,
  type FileRef,
  type FolderType,
  type NodeOutput,
  type NodeRef,
  type OutputFile,
  outputFiles,
  type Outputs,
  outputsOf,
} from "./outputs.ts";
export type { Server } from "./server.ts";
