import type { NodeHandle, NodeId, JsonObject, Out } from "@tscomfy/core";
import type { Outcome } from "./outcome.ts";
import { nodeIdOf } from "./read-outputs.ts";

/** Which of the server's folders a file is in. */
export type FolderType = "output" | "temp" | "input";

/** A file on the server, as outputs name it and `/view` serves it. */
export interface FileRef {
  readonly filename: string;
  /** The folder under {@link FileRef.type}'s directory; `""` for none. */
  readonly subfolder: string;
  readonly type: FolderType;
}

/** What a file holds, from the server's metadata, the file's extension, or its output key. */
export type FileKind = "image" | "video" | "audio" | "3d" | "file";

/** A file a node produced. */
export interface OutputFile extends FileRef {
  readonly kind: FileKind;
  /**
   * The node marked its images animated. Animated WEBP and PNG stay `image`; core's video nodes
   * report their files under `images` with this flag, and their kind is `video`.
   */
  readonly animated: boolean;
  /** The key of the node's UI output it was listed under: `images`, `audio`, `3d`, `gifs`, … */
  readonly key: string;
  /** Pixels, when the server measured the file. */
  readonly width?: number;
  readonly height?: number;
}

/** What one node reported when it ran: its files, its text, and the raw record. */
export interface NodeOutput {
  /** The node, by its id in the prompt (the builder's id for tscomfy workflows). */
  readonly node: NodeId;
  /** Every file entry under any key, in the order the node listed them. */
  readonly files: readonly OutputFile[];
  /** The strings under `text` (PreviewAny, text previews). */
  readonly text: readonly string[];
  /** The node's UI output as the server sent it: lists by key. */
  readonly ui: JsonObject;
}

/** Every node's output, by node id, in prompt order. */
export type Outputs = ReadonlyMap<NodeId, NodeOutput>;

/** A node: its id, its handle (`n.SaveImage(…)`), or one of its outputs. */
export type NodeRef = NodeId | NodeHandle | Out<string>;

/**
 * What a node (by id, handle or output) reported, or `undefined` when it reported nothing, didn't
 * run, or the job was rejected.
 */
export function outputOf(outcome: Outcome, node: NodeRef): NodeOutput | undefined {
  return outcome.status === "rejected" ? undefined : outcome.outputs.get(nodeIdOf(node));
}

/**
 * The files of the given nodes (by id, handle or output), or of every node when none is given, in
 * prompt order. Empty for a rejected job, which has no outputs.
 */
export function outputFiles(outcome: Outcome, ...nodes: readonly NodeRef[]): readonly OutputFile[] {
  if (outcome.status === "rejected") return [];
  const outputs = outcome.outputs;
  if (nodes.length === 0) return [...outputs.values()].flatMap((output) => output.files);
  return nodes.flatMap((node) => outputs.get(nodeIdOf(node))?.files ?? []);
}
