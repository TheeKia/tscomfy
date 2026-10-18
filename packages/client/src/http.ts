import { type JsonObject, type JsonValue, parse } from "@tscomfy/core";
import { ClientError } from "./client-error.ts";
import type { Server } from "./server.ts";
import { baseUrl, endpoint, shownUrl } from "./url.ts";

/** One HTTP request to a server. */
export interface Request {
  readonly method: "GET" | "POST";
  /** Under the server's path: `prompt`, `api/jobs/<id>`. */
  readonly path: string;
  readonly query?: Readonly<Record<string, string>>;
  readonly body?: string | FormData;
  readonly signal?: AbortSignal | undefined;
}

/**
 * Sends a request and returns the response, whatever its status. A failure to reach the server
 * is a {@link ClientError}; an aborted signal rejects with the signal's reason, as `fetch` does.
 */
export async function send(server: Server, request: Request): Promise<Response> {
  const url = endpoint(baseUrl(server), request.path, request.query);
  const headers = new Headers(server.headers);
  if (typeof request.body === "string") headers.set("content-type", "application/json");
  const fetcher = server.fetch ?? globalThis.fetch;
  try {
    return await fetcher(url, {
      method: request.method,
      headers,
      body: request.body ?? null,
      signal: request.signal ?? null,
    });
  } catch (error) {
    if (request.signal?.aborted === true) throw request.signal.reason;
    // The runtime's message may quote the URL, query and all.
    const why = describe(error).replaceAll(url.href, shownUrl(url));
    throw new ClientError(`Could not reach ${shownUrl(url)}: ${why}`, { cause: error });
  }
}

/** The response's body as JSON, read losslessly (big integers stay exact). */
export async function readJson(response: Response): Promise<JsonValue> {
  const text = await response.text();
  const { value } = parse(text);
  if (value === undefined) {
    throw new ClientError(`${where(response)} answered with a body that isn't JSON`, {
      status: response.status,
    });
  }
  return value;
}

/** The response's body as a JSON object; anything else is a {@link ClientError}. */
export async function readObject(response: Response): Promise<JsonObject> {
  const value = await readJson(response);
  if (!isObject(value)) {
    throw new ClientError(`${where(response)} answered with JSON that isn't an object`, {
      status: response.status,
    });
  }
  return value;
}

/** A {@link ClientError} for an answer the protocol doesn't expect, with the body's message. */
export async function unexpected(response: Response): Promise<ClientError> {
  const answer = `${String(response.status)} ${response.statusText}`.trimEnd();
  // Best effort: the status says what went wrong; the body may say why.
  const body = await response.text().catch(() => "");
  const detail = bodyMessage(body);
  return new ClientError(
    `${where(response)} answered ${answer}${detail === undefined ? "" : `: ${detail}`}`,
    { status: response.status },
  );
}

/** A JSON list. */
export function isList(value: JsonValue | undefined): value is readonly JsonValue[] {
  return Array.isArray(value);
}

/** A JSON object, not an array or `null`. */
export function isObject(value: JsonValue | undefined): value is JsonObject {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** The response's URL without its query, or a fallback when the runtime gives none. */
function where(response: Response): string {
  return URL.canParse(response.url) ? shownUrl(new URL(response.url)) : "The server";
}

/** The message of an error body (`{"error": …}`, `{"detail": …}`), at most 200 characters. */
function bodyMessage(text: string): string | undefined {
  const value = parse(text).value;
  if (!isObject(value)) return undefined;
  const message = value["error"] ?? value["detail"] ?? value["message"];
  const shown =
    typeof message === "string"
      ? message
      : isObject(message) && typeof message["message"] === "string"
        ? message["message"]
        : undefined;
  if (shown === undefined) return undefined;
  // oxlint-disable-next-line no-control-regex -- control characters are what it removes
  const printable = shown.replaceAll(/[\u0000-\u001f\u007f]/g, " ");
  return printable.length <= 200 ? printable : `${printable.slice(0, 200)}…`;
}

/** Why something failed. Node's `fetch` says only "fetch failed"; the reason is in its `cause`. */
function describe(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  const cause: unknown = error instanceof Error ? error.cause : undefined;
  if (!(cause instanceof Error) || message.includes(cause.message)) return message;
  return `${message} (${cause.message})`;
}
