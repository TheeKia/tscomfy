import type { JsonObject } from "@tscomfy/core";
import { attach, Channel } from "./channel.ts";
import type { Server } from "./server.ts";
import { baseUrl } from "./url.ts";

/**
 * An open connection to a server: a {@link Server} with a websocket that delivers the events of
 * the jobs submitted through it. Several jobs share it. Close it when done: an open websocket
 * keeps a Node or Bun process running.
 */
export interface Connection extends Server {
  /**
   * The id the server sends this connection's events to. A new one for every websocket, so it
   * changes when the connection reconnects.
   */
  readonly clientId: string;
  /** The server's feature flags, as it answered them on the current websocket. */
  readonly features: JsonObject;
  /**
   * Closes the websocket. Jobs still open reject their outcome with a {@link ClientError}; they
   * keep running on the server.
   */
  close(): Promise<void>;
}

/** Options for {@link connect}. */
export interface ConnectOptions {
  /** Aborts opening the connection; rejects with the signal's reason. */
  readonly signal?: AbortSignal;
}

/**
 * Opens a connection: a websocket with a fresh client id, which announces
 * `supports_preview_metadata` (so previews say which job and node they belong to) and waits for
 * the server's feature flags. Also checks that the server is ComfyUI 0.26 or later with the job
 * API. Rejects with a {@link ClientError} when the server can't be reached or is too old, and
 * with the signal's reason when `signal` aborts; either way nothing is left open. Throws a
 * `TypeError` for an invalid `server.url`.
 */
export async function connect(server: Server, options: ConnectOptions = {}): Promise<Connection> {
  baseUrl(server);
  const channel = new Channel(server);
  try {
    await channel.ready(options.signal);
    await channel.checkServer(options.signal);
  } catch (error) {
    await channel.close();
    throw error;
  }
  const connection: Connection = Object.freeze({
    url: server.url,
    ...(server.headers === undefined ? {} : { headers: server.headers }),
    ...(server.fetch === undefined ? {} : { fetch: server.fetch }),
    ...(server.webSocket === undefined ? {} : { webSocket: server.webSocket }),
    get clientId(): string {
      return channel.clientId;
    },
    get features(): JsonObject {
      return channel.features;
    },
    close: () => channel.close(),
  });
  attach(connection, channel);
  return connection;
}
