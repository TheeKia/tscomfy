import {
  type ApiPrompt,
  createDiagnostic,
  type Diagnostic,
  type JsonObject,
  type JsonValue,
  type NodeId,
  stringify,
  toApi,
  type Workflow,
} from "@tscomfy/core";
import { type Channel, channelOf, type JobListener } from "./channel.ts";
import { ClientError } from "./client-error.ts";
import type { Connection } from "./connection.ts";
import { EventQueue } from "./event-queue.ts";
import type { JobEvent } from "./events.ts";
import type { PreviewFrame, TextFrame } from "./frames.ts";
import { isList, isObject, readObject, send, unexpected } from "./http.ts";
import type { ExecutionError, Outcome } from "./outcome.ts";
import type { NodeOutput, NodeRef, Outputs } from "./outputs.ts";
import { nodeIdOf, outputsInOrder, readNodeOutput } from "./read-outputs.ts";
import { serverDiagnostics } from "./server-errors.ts";
import type { Server } from "./server.ts";
import { sleep } from "./timers.ts";
import { randomUuid } from "./uuid.ts";

/** How the server draws live previews: `auto` is latent2rgb; `taesd` needs its decoder model. */
export type PreviewMethod = "auto" | "latent2rgb" | "taesd" | "none";

/** Options for {@link submit}. */
export interface SubmitOptions {
  /**
   * Live previews for this job (`extra_data.preview_method`). Without it the server's default
   * applies, which is `none` unless it was started with `--preview-method`.
   */
  readonly previews?: PreviewMethod;
  /** Run only these output nodes (`partial_execution_targets`). */
  readonly targets?: readonly NodeRef[];
  /** Queue ahead of the jobs already waiting. */
  readonly front?: boolean;
  /**
   * More `extra_data` for the server, such as `api_key_comfy_org` for partner nodes. The keys the
   * client sets (`client_id`, `preview_method`) are refused.
   */
  readonly extraData?: JsonObject;
  /**
   * Aborting it cancels the job on the server and rejects the outcome with the signal's reason:
   * `AbortSignal.timeout(600_000)`. There is no default timeout.
   */
  readonly signal?: AbortSignal;
}

/** A submitted job. */
export interface Job {
  /** The prompt id, minted by the client. */
  readonly id: string;
  /**
   * What the job reports while it runs, for one consumer, from the moment it was submitted. Ends
   * when the outcome settles; never throws for the job's failure.
   */
  readonly events: AsyncIterable<JobEvent>;
  /**
   * How the job ended, as the server's record says. Rejects only with the signal's reason (see
   * {@link SubmitOptions.signal}) or a {@link ClientError}: the server couldn't be reached, the
   * connection was closed, or the server broke the protocol.
   */
  readonly outcome: Promise<Outcome>;
  /**
   * Asks the server to cancel the job, queued or running. The outcome then settles, normally as
   * `cancelled` (a job that was finishing may still succeed). Rejects with a {@link ClientError}
   * if the server can't be asked.
   */
  cancel(): Promise<void>;
}

/**
 * Submits a workflow, or a prompt, to run on the server. A workflow is exported with `toApi`,
 * which validates it and throws a `ValidationError` for errors (D21); a prompt is sent as given.
 * The job is registered under a prompt id the client mints before anything is sent, so no event
 * is missed. Throws a `TypeError` for invalid options or a closed connection.
 */
export function submit(
  connection: Connection,
  input: Workflow | ApiPrompt,
  options: SubmitOptions = {},
): Job {
  const channel = channelOf(connection);
  if (channel.closed) throw new TypeError("submit: the connection is closed");
  const prompt = isWorkflow(input) ? toApi(input) : input;
  const id = randomUuid();
  const body = requestBody(id, prompt, options);
  const run = new JobRun(channel, id, Object.keys(prompt), options.signal);
  run.start(body);
  return run.job;
}

/** A workflow has a schema and a graph of nodes; a prompt's entries are nodes with a class. */
function isWorkflow(input: Workflow | ApiPrompt): input is Workflow {
  const graph: unknown = Reflect.get(input, "graph");
  const nodes: unknown =
    typeof graph === "object" && graph !== null ? Reflect.get(graph, "nodes") : undefined;
  return (
    Reflect.has(input, "schema") &&
    typeof nodes === "object" &&
    nodes !== null &&
    typeof Reflect.get(nodes, "get") === "function"
  );
}

const PREVIEW_METHODS: ReadonlySet<unknown> = new Set(["auto", "latent2rgb", "taesd", "none"]);
const RESERVED_EXTRA_DATA = ["client_id", "preview_method"];

/**
 * The body of `POST /prompt` for a client id, serialized losslessly. Built when the request is
 * sent, since the client id is the current socket's. Checks the options first, when called.
 */
function requestBody(
  id: string,
  prompt: ApiPrompt,
  options: SubmitOptions,
): (clientId: string) => string {
  if (options.previews !== undefined && !PREVIEW_METHODS.has(options.previews)) {
    throw new TypeError(`submit: unknown preview method ${options.previews}`);
  }
  const extra = options.extraData ?? {};
  for (const key of RESERVED_EXTRA_DATA) {
    if (Object.hasOwn(extra, key)) throw new TypeError(`submit: extraData can't set ${key}`);
  }
  return (clientId) =>
    stringify({
      client_id: clientId,
      prompt_id: id,
      prompt,
      extra_data: {
        ...extra,
        ...(options.previews === undefined ? {} : { preview_method: options.previews }),
      },
      ...(options.front === true ? { front: true } : {}),
      ...(options.targets === undefined
        ? {}
        : { partial_execution_targets: options.targets.map(nodeIdOf) }),
    });
}

/**
 * How often to read the job record: after a reconnect, when the job's events are gone for good,
 * and, slowly, always, so no outcome depends on the websocket alone. The last delay repeats.
 */
const POLL_AFTER_RECONNECT_MS = [1000, 2000, 5000, 10_000];
const POLL_MS = [30_000];
/** At most one record read per this many milliseconds on queue changes. */
const QUEUE_CHECK_MS = 1000;
/** Retries of a record read that couldn't reach the server. */
const READ_RETRY_MS = [500, 1000, 2000, 4000, 8000];

/** One job: its events, its record reads and its outcome. */
class JobRun implements JobListener {
  readonly id: string;
  readonly job: Job;
  readonly #channel: Channel;
  readonly #order: readonly NodeId[];
  readonly #signal: AbortSignal | undefined;
  readonly #events = new EventQueue();
  readonly #diagnostics: Diagnostic[] = [];
  /** The runs' outputs seen live, by the server's node id, in the order they ran. */
  readonly #outputs = new Map<string, NodeOutput>();
  /** The node a server node id is displayed as (they differ for nodes expanded at run time). */
  readonly #display = new Map<string, NodeId>();
  /** The last progress sent, by the server's node id: copies of one node progress apart. */
  readonly #progress = new Map<string, string>();
  readonly #accepted: Promise<boolean>;
  #accept: (accepted: boolean) => void = () => undefined;
  #resolve: (outcome: Outcome) => void = () => undefined;
  #reject: (error: unknown) => void = () => undefined;
  #settled = false;
  #started = false;
  #reading = false;
  #readAgain = false;
  #lastQueueCheck = 0;
  #queueCheck: ReturnType<typeof setTimeout> | undefined;
  #poll: ReturnType<typeof setTimeout> | undefined;
  /** Aborted when the job settles: ends its waits, so no timer outlives it. */
  readonly #done = new AbortController();
  readonly #abort = (): void => {
    this.#abandon(this.#signal?.reason);
  };

  constructor(
    channel: Channel,
    id: string,
    order: readonly NodeId[],
    signal: AbortSignal | undefined,
  ) {
    this.#channel = channel;
    this.id = id;
    this.#order = order;
    this.#signal = signal;
    this.#accepted = new Promise((resolve) => {
      this.#accept = resolve;
    });
    const outcome = new Promise<Outcome>((resolve, reject) => {
      this.#resolve = resolve;
      this.#reject = reject;
    });
    // Handled here so a rejection nobody awaits doesn't crash the process; awaiting still throws.
    outcome.catch(() => undefined);
    this.job = Object.freeze({
      id,
      events: this.#events,
      outcome,
      cancel: () => this.#cancel(),
    });
  }

  start(body: (clientId: string) => string): void {
    if (this.#signal?.aborted === true) {
      this.#abandon(this.#signal.reason);
      return;
    }
    this.#signal?.addEventListener("abort", this.#abort, { once: true });
    void this.#post(body);
  }

  async #post(body: (clientId: string) => string): Promise<void> {
    try {
      await this.#channel.ready(this.#signal);
      if (this.#settled) {
        this.#accept(false);
        return;
      }
      this.#channel.register(this);
      // Not abortable: once sent, the prompt may be queued, and only its answer says so. An
      // abort meanwhile cancels the job after the answer (`#abandon`).
      const response = await send(this.#channel.server, {
        method: "POST",
        path: "prompt",
        body: body(this.#channel.clientId),
      });
      if (response.status === 200) {
        // Queued: from here on the job can be cancelled, whatever the body says.
        this.#accept(true);
        this.#watch(POLL_MS);
        const answer = await readObject(response).catch(() => undefined);
        const id = answer?.["prompt_id"];
        if (typeof id === "string" && id !== this.id) {
          // A server or proxy that ignores the client's id: the record would never be found.
          void cancelJob(this.#channel.server, id);
          throw new ClientError(
            `The server queued the prompt as ${id}, not as the id the client chose (${this.id})`,
          );
        }
        this.#diagnostics.push(...serverDiagnostics(undefined, answer?.["node_errors"]));
        return;
      }
      if (response.status === 400) {
        const answer = await readObject(response);
        this.#accept(false);
        this.#settle({
          status: "rejected",
          diagnostics: serverDiagnostics(answer["error"] ?? "", answer["node_errors"]),
        });
        return;
      }
      throw await unexpected(response);
    } catch (error) {
      this.#accept(false);
      this.fail(error);
    }
  }

  message(type: string, data: JsonObject): void {
    if (this.#settled) return;
    switch (type) {
      case "execution_start":
        this.#started = true;
        this.#events.push({ type: "started" });
        return;
      case "execution_cached":
        this.#started = true;
        this.#events.push({ type: "cached", nodes: Object.freeze(strings(data["nodes"])) });
        return;
      case "executing": {
        const node = data["display_node"] ?? data["node"];
        if (node === null) {
          this.#read();
        } else if (typeof node === "string") {
          this.#events.push({ type: "executing", node });
        }
        return;
      }
      case "progress_state":
        this.#progressState(data["nodes"]);
        return;
      case "executed":
        this.#executed(data);
        return;
      case "execution_error":
        this.#executionError(data);
        return;
      default:
        // execution_success, execution_interrupted: the record decides, read on the final
        // `executing`. Anything else isn't ours to interpret.
        return;
    }
  }

  frame(frame: PreviewFrame | TextFrame): void {
    if (this.#settled) return;
    const node = this.#display.get(frame.node) ?? frame.node;
    if (frame.kind === "preview") {
      this.#events.push({ type: "preview", node, mime: frame.mime, bytes: frame.bytes });
    } else {
      this.#events.push({ type: "text", node, text: frame.text });
    }
  }

  queueChanged(): void {
    // A job cancelled while queued sends no event; the record shows it.
    if (this.#started || this.#settled) return;
    // At most one read per interval; a change inside it is read at its end, not dropped.
    if (this.#queueCheck !== undefined) return;
    const wait = this.#lastQueueCheck + QUEUE_CHECK_MS - Date.now();
    this.#queueCheck = setTimeout(
      () => {
        this.#queueCheck = undefined;
        this.#lastQueueCheck = Date.now();
        this.#read();
      },
      Math.max(0, wait),
    );
  }

  reconnected(): void {
    // The job's events went to the old socket's client id: poll the record until it settles.
    this.#read();
    this.#watch(POLL_AFTER_RECONNECT_MS);
  }

  fail(error: unknown): void {
    if (this.#settled) return;
    this.#finish();
    this.#reject(error);
  }

  #progressState(nodes: JsonValue | undefined): void {
    if (!isObject(nodes)) return;
    for (const [key, entry] of Object.entries(nodes)) {
      if (!isObject(entry)) continue;
      const { value, max } = entry;
      const id = entry["node_id"] ?? key;
      const display = entry["display_node_id"] ?? id;
      if (
        typeof value !== "number" ||
        typeof max !== "number" ||
        typeof id !== "string" ||
        typeof display !== "string"
      ) {
        continue;
      }
      const seen = `${String(value)}/${String(max)}`;
      if (this.#progress.get(id) === seen) continue;
      this.#progress.set(id, seen);
      this.#events.push({ type: "progress", node: display, value, max });
    }
  }

  #executed(data: JsonObject): void {
    const node = data["node"];
    const display = data["display_node"] ?? node;
    if (typeof node !== "string" || typeof display !== "string") return;
    this.#display.set(node, display);
    // A cached node without UI output reports `null`.
    if (!isObject(data["output"])) return;
    const output = readNodeOutput(display, node, data["output"]);
    this.#outputs.set(node, output);
    this.#events.push({ type: "output", node: display, output });
  }

  #executionError(data: JsonObject): void {
    // Only a blocked node is reported here; a real error ends the run, and the record has it.
    if (data["exception_type"] !== "ExecutionBlocked") return;
    const node = data["node_id"];
    if (typeof node !== "string") return;
    const reported = data["exception_message"];
    const message = typeof reported === "string" ? reported : "Execution blocked";
    this.#diagnostics.push(createDiagnostic("W_NODE_BLOCKED", [node], message));
    this.#events.push({ type: "blocked", node, message });
  }

  /** Reads the job record and settles from it; one read at a time, again if asked meanwhile. */
  #read(): void {
    if (this.#settled) return;
    if (this.#reading) {
      this.#readAgain = true;
      return;
    }
    this.#reading = true;
    void this.#readRecord()
      .catch((error: unknown) => {
        this.fail(error);
      })
      .finally(() => {
        this.#reading = false;
        if (this.#readAgain && !this.#settled) {
          this.#readAgain = false;
          this.#read();
        }
      });
  }

  async #readRecord(): Promise<void> {
    if (!(await this.#accepted) || this.#settled) return;
    const response = await this.#retried(() =>
      send(this.#channel.server, { method: "GET", path: `api/jobs/${this.id}` }),
    );
    // Settled meanwhile (aborted, closed): the answer comes too late.
    if (this.#isSettled()) return;
    if (response.status === 404) {
      // An unknown job: cancelled while it was queued. A server without the job API answers
      // with a 404 that isn't JSON.
      const answer = await readObject(response).catch(() => undefined);
      if (answer === undefined) throw await unexpected(response);
      if (this.#started) {
        // It ran, and its record is gone: the server restarted, or its history moved on.
        throw new ClientError(
          `The server has no record of job ${this.id} any more (restarted?); its outcome is unknown`,
          { status: 404 },
        );
      }
      this.#settle({ status: "cancelled", outputs: this.#liveOutputs(), diagnostics: [] });
      return;
    }
    if (!response.ok) throw await unexpected(response);
    const record = await readObject(response);
    const status = record["status"];
    if (status === "pending" || status === "in_progress") return;
    if (status === "completed") {
      this.#settle({ status: "success", outputs: this.#recordOutputs(record), diagnostics: [] });
    } else if (status === "failed") {
      this.#settle({
        status: "failed",
        error: executionError(record["execution_error"]),
        outputs: this.#recordOutputs(record),
        diagnostics: [],
      });
    } else if (status === "cancelled") {
      this.#settle({ status: "cancelled", outputs: this.#recordOutputs(record), diagnostics: [] });
    } else {
      throw new ClientError(`The server reported job status ${stringify(status ?? null)}`);
    }
  }

  #isSettled(): boolean {
    return this.#settled;
  }

  /** Retries a request that couldn't reach the server, a few times, with growing waits. */
  async #retried(request: () => Promise<Response>): Promise<Response> {
    for (const delay of READ_RETRY_MS) {
      try {
        // oxlint-disable-next-line no-await-in-loop -- retries are sequential, with growing waits
        return await request();
      } catch (error) {
        if (!(error instanceof ClientError) || this.#settled) throw error;
        // oxlint-disable-next-line no-await-in-loop -- retries are sequential, with growing waits
        await sleep(delay, this.#done.signal);
        // Settled meanwhile: no more requests; the error goes nowhere.
        if (this.#isSettled()) throw error;
      }
    }
    return request();
  }

  /**
   * The record's outputs, by the nodes they are displayed as, in prompt order. The record lists
   * each run under the server's id, in the order they ran. A run whose output the client saw
   * live keeps that one: the record rewrites some entries (any string with a 3D file extension
   * becomes a file, `text` included), the live output is as the node reported it.
   */
  #recordOutputs(record: JsonObject): Outputs {
    const runs: NodeOutput[] = [];
    const recorded = record["outputs"];
    if (isObject(recorded)) {
      for (const [id, ui] of Object.entries(recorded)) {
        if (!isObject(ui)) continue;
        runs.push(this.#outputs.get(id) ?? readNodeOutput(this.#display.get(id) ?? id, id, ui));
      }
    }
    return outputsInOrder(runs, this.#order);
  }

  #liveOutputs(): Outputs {
    return outputsInOrder(this.#outputs.values(), this.#order);
  }

  #settle(outcome: Outcome): void {
    if (this.#settled) return;
    this.#finish();
    const diagnostics = Object.freeze([...this.#diagnostics, ...outcome.diagnostics]);
    this.#resolve(Object.freeze({ ...outcome, diagnostics }));
  }

  #finish(): void {
    this.#settled = true;
    this.#done.abort();
    this.#signal?.removeEventListener("abort", this.#abort);
    if (this.#poll !== undefined) clearTimeout(this.#poll);
    if (this.#queueCheck !== undefined) clearTimeout(this.#queueCheck);
    this.#channel.unregister(this);
    this.#events.end();
  }

  /** Reads the record after each delay in turn, the last one repeating, until the job settles. */
  #watch(delays: readonly number[], step = 0): void {
    if (this.#poll !== undefined) clearTimeout(this.#poll);
    if (this.#settled) return;
    const delay = delays[Math.min(step, delays.length - 1)] ?? 10_000;
    this.#poll = setTimeout(() => {
      this.#read();
      this.#watch(delays, step + 1);
    }, delay);
  }

  async #cancel(): Promise<void> {
    if (this.#settled || !(await this.#accepted)) return;
    const response = await send(this.#channel.server, {
      method: "POST",
      path: `api/jobs/${this.id}/cancel`,
      body: "{}",
    });
    if (!response.ok) throw await unexpected(response);
    await response.body?.cancel();
    this.#read();
  }

  /** The caller gave up: cancel on the server, best effort, and reject with the reason. */
  #abandon(reason: unknown): void {
    if (this.#settled) return;
    const accepted = this.#accepted;
    const server = this.#channel.server;
    const id = this.id;
    this.fail(reason);
    void accepted.then((wasAccepted) => (wasAccepted ? cancelJob(server, id) : undefined));
  }
}

/** Asks the server to cancel a job, best effort: for a caller who has already given up. */
async function cancelJob(server: Server, id: string): Promise<void> {
  try {
    const response = await send(server, {
      method: "POST",
      path: `api/jobs/${id}/cancel`,
      body: "{}",
    });
    await response.body?.cancel();
  } catch {
    // Nobody is left to tell.
  }
}

/** The strings of a JSON list. */
function strings(value: JsonValue | undefined): string[] {
  return isList(value) ? value.filter((item): item is string => typeof item === "string") : [];
}

/** The record's `execution_error`, read leniently. */
function executionError(value: JsonValue | undefined): ExecutionError {
  const error = isObject(value) ? value : {};
  const text = (key: string): string => {
    const item = error[key];
    return typeof item === "string" ? item : "";
  };
  return Object.freeze({
    node: text("node_id"),
    classType: text("node_type"),
    exceptionType: text("exception_type"),
    message: text("exception_message"),
    traceback: Object.freeze(strings(error["traceback"])),
    executed: Object.freeze(strings(error["executed"])),
  });
}
