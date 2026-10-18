import { type NodeId, parse } from "@tscomfy/core";
import { isObject } from "./http.ts";

/** A preview image: binary type 4, which carries the node and prompt it belongs to. */
export interface PreviewFrame {
  readonly kind: "preview";
  readonly promptId: string;
  readonly node: NodeId;
  readonly mime: string;
  readonly bytes: Uint8Array<ArrayBuffer>;
}

/** Progress text: binary type 3. Only newer servers say which prompt it belongs to. */
export interface TextFrame {
  readonly kind: "text";
  readonly promptId: string | undefined;
  readonly node: NodeId;
  readonly text: string;
}

const TEXT = 3;
const PREVIEW_WITH_METADATA = 4;

/**
 * Decodes a binary websocket frame: a big-endian `uint32` type, then the payload. Type 1 (a
 * preview without ids) isn't decoded: the client asks for type 4 instead, and an unattributed
 * image can't be given to a job. Unknown types and malformed frames give `undefined`.
 * `textHasPromptId` is the server's `supports_progress_text_metadata` flag.
 */
export function decodeFrame(
  data: ArrayBuffer,
  textHasPromptId: boolean,
): PreviewFrame | TextFrame | undefined {
  if (data.byteLength < 4) return undefined;
  const view = new DataView(data);
  const type = view.getUint32(0);
  if (type === PREVIEW_WITH_METADATA) return preview(data, view);
  if (type === TEXT) return text(data, view, textHasPromptId);
  return undefined;
}

function preview(data: ArrayBuffer, view: DataView): PreviewFrame | undefined {
  const length = readLength(view, 4);
  if (length === undefined) return undefined;
  const metadata = parse(decoder.decode(new Uint8Array(data, 8, length))).value;
  if (!isObject(metadata)) return undefined;
  const promptId = metadata["prompt_id"];
  const node = metadata["display_node_id"] ?? metadata["node_id"];
  const mime = metadata["image_type"];
  if (typeof promptId !== "string" || typeof node !== "string") return undefined;
  return {
    kind: "preview",
    promptId,
    node,
    mime: typeof mime === "string" ? mime : "image/jpeg",
    bytes: new Uint8Array(data.slice(8 + length)),
  };
}

function text(data: ArrayBuffer, view: DataView, hasPromptId: boolean): TextFrame | undefined {
  let offset = 4;
  let promptId: string | undefined;
  if (hasPromptId) {
    const length = readLength(view, offset);
    if (length === undefined) return undefined;
    promptId = decoder.decode(new Uint8Array(data, offset + 4, length));
    offset += 4 + length;
  }
  const length = readLength(view, offset);
  if (length === undefined) return undefined;
  const node = decoder.decode(new Uint8Array(data, offset + 4, length));
  return {
    kind: "text",
    promptId,
    node,
    text: decoder.decode(new Uint8Array(data, offset + 4 + length)),
  };
}

/** A `uint32` length at `offset` whose bytes fit in the frame after it. */
function readLength(view: DataView, offset: number): number | undefined {
  if (view.byteLength < offset + 4) return undefined;
  const length = view.getUint32(offset);
  return offset + 4 + length <= view.byteLength ? length : undefined;
}

const decoder = new TextDecoder();
