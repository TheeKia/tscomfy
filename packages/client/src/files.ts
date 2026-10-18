import { ClientError } from "./client-error.ts";
import { readObject, send, unexpected } from "./http.ts";
import type { FileRef, FolderType } from "./outputs.ts";
import { isFolderType } from "./read-outputs.ts";
import type { Server } from "./server.ts";
import { baseUrl, endpoint } from "./url.ts";

/** A file to upload. */
export interface UploadSource {
  /** The file name to store it under. */
  readonly name: string;
  readonly bytes: Uint8Array;
  /** Its media type, such as `image/png`. */
  readonly mime?: string;
}

/** Options for {@link uploadFile}. */
export interface UploadOptions {
  /** A folder under the target directory. */
  readonly subfolder?: string;
  /** The directory: `input` (default), `temp` or `output`. */
  readonly type?: FolderType;
  /** Replace a file of the same name. Otherwise the server keeps both, renaming the new one. */
  readonly overwrite?: boolean;
  readonly signal?: AbortSignal;
}

/** An uploaded file, as the server stored it. */
export interface UploadedFile extends FileRef {
  /**
   * The value a loader node's file input takes (`LoadImage`'s `image`): `subfolder/name`, with
   * ` [temp]` or ` [output]` after it outside the input directory.
   */
  readonly value: string;
}

/**
 * Uploads a file (an image, video or audio for a loader node) through `/upload/image`. The
 * stored name can differ from `source.name`: without `overwrite`, the server renames a file whose
 * name is taken by different content. Rejects with a {@link ClientError} if the server refuses.
 */
export async function uploadFile(
  server: Server,
  source: UploadSource,
  options: UploadOptions = {},
): Promise<UploadedFile> {
  const form = new FormData();
  const blob = new Blob([new Uint8Array(source.bytes)], { type: source.mime ?? "" });
  form.append("image", blob, source.name);
  form.append("type", options.type ?? "input");
  if (options.subfolder !== undefined) form.append("subfolder", options.subfolder);
  if (options.overwrite === true) form.append("overwrite", "true");
  const response = await send(server, {
    method: "POST",
    path: "upload/image",
    body: form,
    signal: options.signal,
  });
  if (!response.ok) throw await unexpected(response);
  const answer = await readObject(response);
  const { name, subfolder, type } = answer;
  if (typeof name !== "string" || !isFolderType(type)) {
    throw new ClientError("The server's answer to an upload has no file name or folder");
  }
  const folder = typeof subfolder === "string" ? subfolder : "";
  const path = folder === "" ? name : `${folder}/${name}`;
  return Object.freeze({
    filename: name,
    subfolder: folder,
    type,
    value: type === "input" ? path : `${path} [${type}]`,
  });
}

/** A downloaded file. */
export interface FileData {
  readonly bytes: Uint8Array<ArrayBuffer>;
  /** The server's `Content-Type`; `application/octet-stream` when it sent none. */
  readonly mime: string;
}

/** Options for {@link fetchFile}. */
export interface FetchFileOptions {
  readonly signal?: AbortSignal;
}

/**
 * Downloads a file the server has, such as an output, through `/view`. Rejects with a
 * {@link ClientError} if the server doesn't have it.
 */
export async function fetchFile(
  server: Server,
  file: FileRef,
  options: FetchFileOptions = {},
): Promise<FileData> {
  const response = await send(server, {
    method: "GET",
    path: "view",
    query: viewQuery(file),
    signal: options.signal,
  });
  if (!response.ok) throw await unexpected(response);
  return Object.freeze({
    bytes: new Uint8Array(await response.arrayBuffer()),
    mime: response.headers.get("content-type") ?? "application/octet-stream",
  });
}

/**
 * The URL `/view` serves a file at, for `<img src>` on a page the server allows (same origin, or
 * `--enable-cors-header`). It carries the server URL's query, so a token in it is in the result.
 */
export function fileUrl(server: Server, file: FileRef): string {
  return endpoint(baseUrl(server), "view", viewQuery(file)).href;
}

function viewQuery(file: FileRef): Record<string, string> {
  return { filename: file.filename, subfolder: file.subfolder, type: file.type };
}
