// A fake ComfyUI server for the client's tests and test:pack: real HTTP and a real websocket (Bun.serve), playing
// the runs of protocol mocks (`@tscomfy/fixtures`, mocks/protocol/) as the server sent them, with
// faults to inject. It follows ComfyUI 0.41's routing: events go to the socket registered under
// the prompt's client id, a socket's close removes whatever is registered under its id (the
// server's same-id hazard), progress text goes to every socket.

import { type JsonObject, type JsonValue, parse, stringify } from "@tscomfy/core";
import type { Server as BunServer, ServerWebSocket } from "bun";
import { type MockProtocolName, readMockProtocol } from "./protocol.ts";

type Json = JsonValue;

function isRecord(value: JsonValue | undefined): value is JsonObject {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isList(value: JsonValue | undefined): value is readonly JsonValue[] {
  return Array.isArray(value);
}

function list(value: JsonValue | undefined): readonly JsonValue[] {
  return isList(value) ? value : [];
}

/** A `{ status, body }` exchange of a mock. */
function exchange(
  value: JsonValue | undefined,
): { readonly status: number; readonly body: Json } | undefined {
  if (!isRecord(value) || typeof value["status"] !== "number") return undefined;
  return { status: value["status"], body: value["body"] ?? null };
}

/** One run of a protocol mock. */
export interface TraceRun {
  readonly prompt: Json;
  readonly answer: { readonly status: number; readonly body: Json };
  readonly events: readonly Json[];
  readonly record?: { readonly status: number; readonly body: Json };
}

/** How the fake server plays a run. */
export interface Behavior {
  /** Events sent before the answer to `POST /prompt` (the server can be that fast). */
  readonly eventsBeforeAnswer?: number;
  /** Closes the client's socket before this event; later events go nowhere, as on a real drop. */
  readonly dropSocketBefore?: number;
  /**
   * With `dropSocketBefore`: the reconnected socket is unregistered as soon as it registers, as
   * when the old socket's close reaches the server late (the same-id hazard).
   */
  readonly hazard?: boolean;
  /** Waits for a cancel request before the first `execution_interrupted` event. */
  readonly holdUntilCancel?: boolean;
  /** Plays nothing until released: the job waits in the queue. A cancel removes it (404). */
  readonly queued?: boolean;
  /** Stops before this event and never finishes (a dead worker). */
  readonly hangBefore?: number;
  /** Milliseconds between events. */
  readonly gapMs?: number;
  /**
   * With `dropSocketBefore`: the server forgets the job there and plays nothing more, as when it
   * restarts (its history is in memory): the record answers 404.
   */
  readonly forget?: boolean;
  /** Milliseconds before the server answers `POST /prompt` (it has queued the job already). */
  readonly answerDelayMs?: number;
}

interface Job {
  readonly id: string;
  readonly clientId: string;
  state: "pending" | "in_progress" | "done" | "gone";
  readonly run: TraceRun;
  cancelled: boolean;
  /** Starts a queued job; for a running one, lets `holdUntilCancel` go on. */
  release: () => void;
}

interface SocketData {
  readonly clientId: string;
  first: boolean;
}

/** A request the fake server received. */
export interface Received {
  readonly method: string;
  readonly path: string;
  readonly search: string;
  readonly body: string;
  readonly headers: Headers;
}

/** Options for {@link FakeServer.start}. */
export interface FakeOptions {
  /** Answer `GET /api/jobs` with a plain 404, as servers before 0.6 do. */
  readonly noJobApi?: boolean;
  /** The version `/system_stats` reports; default `0.41.0`. */
  readonly version?: string;
}

/** Reads the runs of a protocol mock. */
export async function trace(name: MockProtocolName): Promise<readonly TraceRun[]> {
  const { value } = parse(await readMockProtocol(name));
  return list(isRecord(value) ? value["runs"] : undefined).flatMap((run) => {
    const answer = isRecord(run) ? exchange(run["answer"]) : undefined;
    if (!isRecord(run) || answer === undefined) return [];
    const record = exchange(run["record"]);
    return [
      {
        prompt: run["prompt"] ?? null,
        answer,
        events: list(run["events"]),
        ...(record === undefined ? {} : { record }),
      },
    ];
  });
}

const PNG = Uint8Array.from(atob("iVBORw0KGgo="), (char) => char.charCodeAt(0));

/** The fake server. Stop it after each test. */
export class FakeServer {
  readonly received: Received[] = [];
  /** The query of every websocket handshake. */
  readonly sockets: string[] = [];
  readonly #runs: { run: TraceRun; behavior: Behavior }[] = [];
  readonly #jobs = new Map<string, Job>();
  readonly #sockets = new Map<string, ServerWebSocket<SocketData>>();
  readonly #all = new Set<ServerWebSocket<SocketData>>();
  readonly #options: FakeOptions;
  #server: BunServer<SocketData> | undefined;
  /** Client ids whose next registration the hazard removes. */
  readonly #hazard = new Set<string>();
  connections = 0;

  /** Sockets open on the server's side. */
  get openSockets(): number {
    return this.#all.size;
  }

  private constructor(options: FakeOptions) {
    this.#options = options;
  }

  static start(options: FakeOptions = {}): FakeServer {
    const fake = new FakeServer(options);
    fake.#server = Bun.serve<SocketData>({
      port: 0,
      fetch: (request, server) => fake.#fetch(request, server),
      websocket: {
        open: (socket) => {
          fake.connections++;
          fake.#all.add(socket);
          fake.#sockets.set(socket.data.clientId, socket);
          if (fake.#hazard.delete(socket.data.clientId)) {
            // The old socket's late close removes the entry: this socket gets nothing targeted.
            fake.#sockets.delete(socket.data.clientId);
          }
          socket.send(
            JSON.stringify({
              type: "status",
              data: { status: { exec_info: { queue_remaining: 0 } }, sid: socket.data.clientId },
            }),
          );
        },
        message: (socket, message) => {
          if (!socket.data.first) return;
          socket.data.first = false;
          if (typeof message === "string" && message.includes('"feature_flags"')) {
            socket.send(
              JSON.stringify({
                type: "feature_flags",
                data: { supports_preview_metadata: true, max_upload_size: 104857600 },
              }),
            );
          }
        },
        close: (socket) => {
          fake.#all.delete(socket);
          // As the server does: whatever is registered under the id goes, this socket or not.
          fake.#sockets.delete(socket.data.clientId);
        },
      },
    });
    return fake;
  }

  get url(): string {
    return `http://127.0.0.1:${String(this.#server?.port)}`;
  }

  /** Plays `run` for the next `POST /prompt`. */
  expect(run: TraceRun, behavior: Behavior = {}): void {
    this.#runs.push({ run, behavior });
  }

  /** Releases a job held by `queued`. */
  start(id: string): void {
    this.#jobs.get(id)?.release();
  }

  /** The prompt ids the server accepted, in order. */
  get jobIds(): string[] {
    return [...this.#jobs.keys()];
  }

  /** Closes every client socket from the server's side. */
  dropSockets(): void {
    for (const socket of this.#all) socket.close();
  }

  stop(): void {
    void this.#server?.stop(true);
  }

  async #fetch(request: Request, server: BunServer<SocketData>): Promise<Response | undefined> {
    const url = new URL(request.url);
    const body = request.method === "POST" ? await request.clone().text() : "";
    this.received.push({
      method: request.method,
      path: url.pathname,
      search: url.search,
      body,
      headers: request.headers,
    });
    if (url.pathname === "/ws") {
      this.sockets.push(url.search);
      const clientId = url.searchParams.get("clientId") ?? crypto.randomUUID();
      return server.upgrade(request, { data: { clientId, first: true } })
        ? undefined
        : new Response("upgrade failed", { status: 400 });
    }
    if (request.method === "POST" && url.pathname === "/prompt") return this.#prompt(body);
    if (request.method === "GET" && url.pathname === "/system_stats") {
      return Response.json({ system: { comfyui_version: this.#options.version ?? "0.41.0" } });
    }
    if (request.method === "GET" && url.pathname === "/api/jobs") {
      if (this.#options.noJobApi === true) return new Response("404: Not Found", { status: 404 });
      return Response.json({
        jobs: [],
        pagination: { offset: 0, limit: 1, total: 0, has_more: false },
      });
    }
    const job = /^\/api\/jobs\/([^/]+)(\/cancel)?$/.exec(url.pathname);
    if (job !== null) {
      if (this.#options.noJobApi === true) return new Response("404: Not Found", { status: 404 });
      const id = job[1] ?? "";
      return job[2] === undefined ? this.#record(id) : this.#cancel(id);
    }
    if (request.method === "GET" && url.pathname === "/view") {
      return url.searchParams.get("filename") === "missing.png"
        ? new Response("404: Not Found", { status: 404 })
        : new Response(PNG, { headers: { "content-type": "image/png" } });
    }
    if (request.method === "POST" && url.pathname === "/upload/image") {
      // oxlint-disable-next-line typescript/no-deprecated -- a test server parsing its own client's form
      const form = await request.formData();
      const file = form.get("image");
      return Response.json({
        name: file instanceof File ? `${file.name.replace(/\.png$/, "")} (1).png` : "",
        subfolder: form.get("subfolder") ?? "",
        type: form.get("type") ?? "input",
      });
    }
    return new Response("404: Not Found", { status: 404 });
  }

  async #prompt(body: string): Promise<Response> {
    const next = this.#runs.shift();
    if (next === undefined) return new Response("no run expected", { status: 500 });
    const request = parse(body).value;
    const id =
      isRecord(request) && typeof request["prompt_id"] === "string" ? request["prompt_id"] : "";
    const clientId =
      isRecord(request) && typeof request["client_id"] === "string" ? request["client_id"] : "";
    const substitute = (value: Json): Json =>
      parse(stringify(value).replaceAll("PROMPT_ID", id)).value ?? null;
    const run: TraceRun = {
      prompt: next.run.prompt,
      answer: { status: next.run.answer.status, body: substitute(next.run.answer.body) },
      events: next.run.events.map(substitute),
      ...(next.run.record === undefined
        ? {}
        : { record: { status: next.run.record.status, body: substitute(next.run.record.body) } }),
    };
    if (run.answer.status !== 200)
      return Response.json(run.answer.body, { status: run.answer.status });
    const released = Promise.withResolvers<void>();
    const job: Job = {
      id,
      clientId,
      state: "pending",
      run,
      cancelled: false,
      release: released.resolve,
    };
    this.#jobs.set(id, job);
    this.#broadcast({ type: "status", data: { status: { exec_info: { queue_remaining: 1 } } } });
    const before = next.behavior.eventsBeforeAnswer ?? 0;
    const sent = Promise.withResolvers<void>();
    const answered = Promise.withResolvers<void>();
    void this.#play(job, next.behavior, {
      before,
      sent: sent.resolve,
      answered: answered.promise,
      queued: next.behavior.queued === true ? released.promise : undefined,
    });
    if (before > 0) await sent.promise;
    if (next.behavior.answerDelayMs !== undefined) await Bun.sleep(next.behavior.answerDelayMs);
    // The events after these go out once the answer has.
    setTimeout(answered.resolve, 5);
    return Response.json(run.answer.body);
  }

  async #play(
    job: Job,
    behavior: Behavior,
    order: {
      readonly before: number;
      readonly sent: () => void;
      readonly answered: Promise<void>;
      readonly queued: Promise<void> | undefined;
    },
  ): Promise<void> {
    if (order.before === 0) await order.answered;
    if (order.queued !== undefined) await order.queued;
    if (job.state === "gone") return;
    job.state = "in_progress";
    const cancel = Promise.withResolvers<void>();
    job.release = cancel.resolve;
    for (const [index, event] of job.run.events.entries()) {
      if (index === order.before && index > 0) {
        order.sent();
        // oxlint-disable-next-line no-await-in-loop -- the answer goes out between two events
        await order.answered;
      }
      if (index === behavior.hangBefore) return;
      if (index === behavior.dropSocketBefore) {
        const socket = this.#sockets.get(job.clientId);
        if (behavior.hazard === true) this.#hazard.add(job.clientId);
        socket?.close();
        if (behavior.forget === true) {
          job.state = "gone";
          return;
        }
      }
      if (
        behavior.holdUntilCancel === true &&
        isRecord(event) &&
        event["type"] === "execution_interrupted"
      ) {
        // oxlint-disable-next-line no-await-in-loop -- holds until the client cancels
        await cancel.promise;
      }
      if (isFinalEvent(event)) {
        job.state = "done";
        this.#broadcast({
          type: "status",
          data: { status: { exec_info: { queue_remaining: 0 } } },
        });
      }
      // oxlint-disable-next-line no-await-in-loop -- events are sent in order, spaced
      await Bun.sleep(behavior.gapMs ?? 1);
      this.#send(job.clientId, event);
    }
    order.sent();
    job.state = "done";
  }

  #record(id: string): Response {
    const job = this.#jobs.get(id);
    if (job === undefined || job.state === "gone") {
      return Response.json({ error: "Job not found" }, { status: 404 });
    }
    if (job.state !== "done" || job.run.record === undefined) {
      return Response.json({ id, status: job.state });
    }
    return Response.json(job.run.record.body, { status: job.run.record.status });
  }

  #cancel(id: string): Response {
    const job = this.#jobs.get(id);
    if (job === undefined || job.state === "done" || job.state === "gone") {
      return Response.json({ cancelled: false });
    }
    if (job.state === "pending") {
      job.state = "gone";
      job.release();
      this.#broadcast({ type: "status", data: { status: { exec_info: { queue_remaining: 0 } } } });
    } else {
      job.cancelled = true;
      job.release();
    }
    return Response.json({ cancelled: true });
  }

  #send(clientId: string, event: Json): void {
    if (!isRecord(event)) return;
    const { binary, node, text, image } = event;
    if (binary === 3 && typeof node === "string" && typeof text === "string") {
      // Progress text goes to every socket, as core nodes send it.
      const frame = textFrame(node, text);
      for (const socket of this.#all) socket.send(frame);
      return;
    }
    const socket = this.#sockets.get(clientId);
    if (socket === undefined) return;
    if (binary === 4 && typeof image === "string") {
      socket.send(previewFrame(event["metadata"] ?? {}, image));
      return;
    }
    socket.send(stringify(event));
  }

  #broadcast(event: Json): void {
    for (const socket of this.#all) socket.send(stringify(event));
  }
}

function isFinalEvent(event: Json): boolean {
  if (!isRecord(event)) return false;
  const data = event["data"];
  return event["type"] === "executing" && isRecord(data) && data["node"] === null;
}

function previewFrame(metadata: Json, image: string): Uint8Array {
  const meta = new TextEncoder().encode(stringify(metadata));
  const bytes = Uint8Array.from(atob(image), (char) => char.charCodeAt(0));
  const frame = new Uint8Array(8 + meta.length + bytes.length);
  const view = new DataView(frame.buffer);
  view.setUint32(0, 4);
  view.setUint32(4, meta.length);
  frame.set(meta, 8);
  frame.set(bytes, 8 + meta.length);
  return frame;
}

function textFrame(node: string, text: string): Uint8Array {
  const id = new TextEncoder().encode(node);
  const body = new TextEncoder().encode(text);
  const frame = new Uint8Array(8 + id.length + body.length);
  const view = new DataView(frame.buffer);
  view.setUint32(0, 3);
  view.setUint32(4, id.length);
  frame.set(id, 8);
  frame.set(body, 8 + id.length);
  return frame;
}
