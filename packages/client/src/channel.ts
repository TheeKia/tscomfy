import { type JsonObject, parse, stringify } from "@tscomfy/core";
import { ClientError } from "./client-error.ts";
import type { Connection } from "./connection.ts";
import { decodeFrame, type PreviewFrame, type TextFrame } from "./frames.ts";
import { isObject, readObject, send } from "./http.ts";
import type { Server } from "./server.ts";
import { abortable, sleep } from "./timers.ts";
import { baseUrl, endpoint, shownUrl } from "./url.ts";

/** Connections and the channels behind them. */
const channels = new WeakMap<Connection, Channel>();

/** Ties a connection to its channel. */
export function attach(connection: Connection, channel: Channel): void {
  channels.set(connection, channel);
}

/** The channel behind a connection. Throws a `TypeError` for anything `connect` didn't return. */
export function channelOf(connection: Connection): Channel {
  const channel = channels.get(connection);
  if (channel === undefined) {
    throw new TypeError("Expected a connection returned by connect()");
  }
  return channel;
}

/** What a job hears from the channel. */
export interface JobListener {
  readonly id: string;
  /** A JSON event carrying this job's prompt id. */
  message(type: string, data: JsonObject): void;
  /** A preview or progress text of this job. */
  frame(frame: PreviewFrame | TextFrame): void;
  /** The server's queue changed (a `status` broadcast). */
  queueChanged(): void;
  /** The websocket reopened after a drop: events may have been lost. */
  reconnected(): void;
  /** The channel is gone for good: closed, or the server stayed unreachable. */
  fail(error: ClientError): void;
}

/** How long the server gets to answer the feature flags. */
const HANDSHAKE_MS = 10_000;

/** Delays between reconnect attempts, before jitter: about two minutes in all. */
const BACKOFF_MS = [250, 500, 1000, 2000, 4000, 8000, 15_000, 30_000, 30_000, 30_000];

/** The lowest server version the client supports: the per-job cancel came in 0.26.0. */
const MIN_VERSION = [0, 26, 0] as const;

/**
 * The flags the client announces as its first message: previews and progress text that say
 * which prompt they belong to, as the frontend announces them.
 */
const CLIENT_FLAGS = { supports_preview_metadata: true, supports_progress_text_metadata: true };

/** A websocket's `readyState` once closed; the global `WebSocket` may not exist. */
const CLOSED = 3;

const closedError = (): ClientError => new ClientError("The connection is closed");

/**
 * One websocket and the jobs listening on it. Opens one socket at a time, shared by every
 * caller; reconnects only while jobs are open, after the old socket has closed (two live sockets
 * with one client id lose events on the server), and re-sends the feature flags first. `close()`
 * stops everything it started: sockets, handshakes, backoff waits.
 */
export class Channel {
  readonly server: Server;
  readonly clientId: string;
  features: JsonObject = {};
  readonly #jobs = new Map<string, JobListener>();
  /** Every socket this channel opened and that hasn't closed yet. */
  readonly #sockets = new Set<WebSocket>();
  /** Aborted by `close()`: ends handshakes and backoff waits. */
  readonly #life = new AbortController();
  #socket: WebSocket | undefined;
  #opening: Promise<void> | undefined;
  #reconnecting: Promise<void> | undefined;
  #closing: Promise<void> | undefined;
  /** The job whose prompt the server is running, for progress text without a prompt id. */
  #running: JobListener | undefined;

  constructor(server: Server, clientId: string) {
    this.server = server;
    this.clientId = clientId;
  }

  /** Whether `close()` was called. */
  get closed(): boolean {
    return this.#life.signal.aborted;
  }

  /**
   * Waits until the websocket is open, opening it (once, for every caller) if it isn't. Rejects
   * with the signal's reason when `signal` aborts, and with a {@link ClientError} when the
   * channel is closed or the socket can't be opened.
   */
  async ready(signal?: AbortSignal): Promise<void> {
    for (;;) {
      if (this.closed) throw closedError();
      if (this.#reconnecting !== undefined) {
        // oxlint-disable-next-line no-await-in-loop -- the state changes while it waits
        await abortable(this.#reconnecting, signal);
        continue;
      }
      if (this.#socket !== undefined) return;
      this.#opening ??= this.#open().finally(() => {
        this.#opening = undefined;
      });
      // oxlint-disable-next-line no-await-in-loop -- the state changes while it waits
      await abortable(this.#opening, signal);
    }
  }

  /**
   * Checks that the server is one the client supports: ComfyUI 0.26 or later by its version
   * (when it reports one it can parse), and with the job API. Rejects with a {@link ClientError}.
   */
  async checkServer(signal?: AbortSignal): Promise<void> {
    const stats = await send(this.server, { method: "GET", path: "system_stats", signal });
    if (stats.ok) {
      const body = await readObject(stats).catch(() => undefined);
      const system = body?.["system"];
      const version = isObject(system) ? system["comfyui_version"] : undefined;
      if (typeof version === "string" && isOlder(version, MIN_VERSION)) {
        throw new ClientError(
          `The server runs ComfyUI ${version}; @tscomfy/client needs ComfyUI ${MIN_VERSION.join(".")} or later`,
        );
      }
    } else {
      await stats.body?.cancel();
    }
    const jobs = await send(this.server, {
      method: "GET",
      path: "api/jobs",
      query: { limit: "1" },
      signal,
    });
    await jobs.body?.cancel();
    if (!jobs.ok) {
      throw new ClientError(
        `The server has no job API (GET /api/jobs answered ${String(jobs.status)}); @tscomfy/client needs ComfyUI ${MIN_VERSION.join(".")} or later`,
        { status: jobs.status },
      );
    }
  }

  register(job: JobListener): void {
    if (this.closed) throw closedError();
    this.#jobs.set(job.id, job);
  }

  unregister(job: JobListener): void {
    if (this.#jobs.get(job.id) === job) this.#jobs.delete(job.id);
    if (this.#running === job) this.#running = undefined;
  }

  /** Closes every socket and fails every open job; waits until the sockets have closed. */
  close(): Promise<void> {
    this.#closing ??= this.#close();
    return this.#closing;
  }

  async #close(): Promise<void> {
    this.#life.abort(closedError());
    this.#socket = undefined;
    const jobs = [...this.#jobs.values()];
    this.#jobs.clear();
    for (const job of jobs) job.fail(new ClientError("The connection was closed"));
    await Promise.all([...this.#sockets].map((socket) => closeSocket(socket)));
  }

  /** Opens a socket and negotiates the feature flags; the socket becomes the channel's. */
  async #open(): Promise<void> {
    const url = endpoint(baseUrl(this.server), "ws", { clientId: this.clientId });
    url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
    const shown = shownUrl(url);
    const life = this.#life.signal;
    const socket = this.server.webSocket?.(url.href) ?? new WebSocket(url.href);
    socket.binaryType = "arraybuffer";
    this.#sockets.add(socket);
    socket.addEventListener("close", () => {
      this.#sockets.delete(socket);
      this.#dropped(socket);
    });
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => {
        fail(new ClientError(`${shown} didn't answer the websocket handshake in time`));
      }, HANDSHAKE_MS);
      const done = (): void => {
        clearTimeout(timer);
        life.removeEventListener("abort", aborted);
        socket.removeEventListener("close", closed);
      };
      const fail = (error: unknown): void => {
        done();
        socket.close();
        reject(error);
      };
      const aborted = (): void => {
        fail(closedError());
      };
      const closed = (): void => {
        fail(new ClientError(`Could not open a websocket to ${shown}`));
      };
      if (life.aborted) {
        aborted();
        return;
      }
      life.addEventListener("abort", aborted, { once: true });
      socket.addEventListener("close", closed);
      socket.addEventListener("open", () => {
        socket.send(stringify({ type: "feature_flags", data: CLIENT_FLAGS }));
      });
      let negotiated = false;
      socket.addEventListener("message", (event: MessageEvent) => {
        if (!negotiated && typeof event.data === "string") {
          const message = readMessage(event.data);
          if (message?.type === "feature_flags") {
            negotiated = true;
            done();
            this.features = message.data;
            this.#socket = socket;
            resolve();
            return;
          }
        }
        this.#receive(event.data);
      });
    });
  }

  #receive(data: unknown): void {
    if (typeof data === "string") {
      const message = readMessage(data);
      if (message !== undefined) this.#dispatch(message.type, message.data);
      return;
    }
    if (!(data instanceof ArrayBuffer)) return;
    const frame = decodeFrame(data, this.features["supports_progress_text_metadata"] === true);
    if (frame === undefined) return;
    const job = frame.promptId === undefined ? this.#running : this.#jobs.get(frame.promptId);
    job?.frame(frame);
  }

  #dispatch(type: string, data: JsonObject): void {
    if (type === "status") {
      for (const job of this.#jobs.values()) job.queueChanged();
      return;
    }
    const promptId = data["prompt_id"];
    if (typeof promptId !== "string") return;
    const job = this.#jobs.get(promptId);
    if (job === undefined) {
      // Another client's prompt, or one of ours that settled: it isn't running ours.
      if (type === "execution_start") this.#running = undefined;
      return;
    }
    if (type === "execution_start") this.#running = job;
    if (type === "executing" && data["node"] === null && this.#running === job) {
      this.#running = undefined;
    }
    job.message(type, data);
  }

  #dropped(socket: WebSocket): void {
    if (this.#socket !== socket) return;
    this.#socket = undefined;
    this.#running = undefined;
    // With no job open, the next submit reopens it.
    if (this.closed || this.#jobs.size === 0) return;
    this.#reconnecting = this.#reconnect().finally(() => {
      this.#reconnecting = undefined;
    });
  }

  async #reconnect(): Promise<void> {
    const life = this.#life.signal;
    for (const delay of BACKOFF_MS) {
      // oxlint-disable-next-line no-await-in-loop -- attempts are sequential, with growing waits
      await sleep(delay * (0.5 + Math.random() / 2), life);
      if (life.aborted) return;
      try {
        // oxlint-disable-next-line no-await-in-loop -- attempts are sequential, with growing waits
        await this.#open();
        for (const job of this.#jobs.values()) job.reconnected();
        return;
      } catch {
        // The next attempt, after a longer wait; none after close().
      }
    }
    const error = new ClientError(
      `Lost the websocket to ${shownUrl(baseUrl(this.server))} and couldn't reopen it`,
    );
    const jobs = [...this.#jobs.values()];
    this.#jobs.clear();
    for (const job of jobs) job.fail(error);
  }
}

/** Closes a socket and waits for its close, a second at most. */
function closeSocket(socket: WebSocket): Promise<void> {
  if (socket.readyState === CLOSED) return Promise.resolve();
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, 1000);
    socket.addEventListener("close", () => {
      clearTimeout(timer);
      resolve();
    });
    socket.close();
  });
}

/** Whether a `major.minor.patch` version (anything after it ignored) is below `minimum`. */
function isOlder(version: string, minimum: readonly [number, number, number]): boolean {
  const match = /^v?(\d+)\.(\d+)\.(\d+)/.exec(version);
  if (match === null) return false;
  const parts = [Number(match[1]), Number(match[2]), Number(match[3])];
  for (const [index, part] of parts.entries()) {
    const least = minimum[index] ?? 0;
    if (part !== least) return part < least;
  }
  return false;
}

/** A JSON message `{ type, data }`, read losslessly; anything else is ignored. */
function readMessage(
  text: string,
): { readonly type: string; readonly data: JsonObject } | undefined {
  const value = parse(text).value;
  if (!isObject(value) || typeof value["type"] !== "string") return undefined;
  return { type: value["type"], data: isObject(value["data"]) ? value["data"] : {} };
}
