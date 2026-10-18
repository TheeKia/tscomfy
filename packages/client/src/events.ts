import type { NodeId } from "@tscomfy/core";
import type { NodeOutput } from "./outputs.ts";

/** The server started running the job. */
export interface StartedEvent {
  readonly type: "started";
}

/** Nodes whose cached results the run reuses instead of running them. */
export interface CachedEvent {
  readonly type: "cached";
  readonly nodes: readonly NodeId[];
}

/** A node started running. */
export interface ExecutingEvent {
  readonly type: "executing";
  readonly node: NodeId;
}

/** A running node's progress: `value` of `max` (sampler steps, say). */
export interface ProgressEvent {
  readonly type: "progress";
  readonly node: NodeId;
  readonly value: number;
  readonly max: number;
}

/**
 * A live preview from a running node: a sampler's latent preview (a JPEG at most 512 pixels on a
 * side, sent when the job asks for previews with `previews` in {@link SubmitOptions}, or the
 * server was started with `--preview-method`), or a `SaveImageWebsocket` image (a full-size PNG,
 * always sent).
 */
export interface PreviewEvent {
  readonly type: "preview";
  readonly node: NodeId;
  /** `image/jpeg` or `image/png`. */
  readonly mime: string;
  readonly bytes: Uint8Array<ArrayBuffer>;
}

/** A node finished and reported output (files, text). */
export interface OutputEvent {
  readonly type: "output";
  readonly node: NodeId;
  readonly output: NodeOutput;
}

/** Progress text from a running node (partner nodes report their status this way). */
export interface TextEvent {
  readonly type: "text";
  readonly node: NodeId;
  readonly text: string;
}

/**
 * A node blocked execution with a message. The run continues without what depends on it; the
 * outcome also lists it, as a `W_NODE_BLOCKED` diagnostic.
 */
export interface BlockedEvent {
  readonly type: "blocked";
  readonly node: NodeId;
  readonly message: string;
}

/** What a job reports while it runs. Node ids are the prompt's (the builder's) ids. */
export type JobEvent =
  | StartedEvent
  | CachedEvent
  | ExecutingEvent
  | ProgressEvent
  | PreviewEvent
  | OutputEvent
  | TextEvent
  | BlockedEvent;
