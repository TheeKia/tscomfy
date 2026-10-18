import type { JobEvent } from "./events.ts";

/**
 * Events of these types are snapshots: a newer one of a node replaces its unread one. Progress
 * text isn't: each says something different ("Downloading…", "Generating…").
 */
const COALESCED: ReadonlySet<JobEvent["type"]> = new Set(["progress", "preview"]);

type Waiter = (result: IteratorResult<JobEvent, undefined>) => void;

/**
 * A job's events, for one consumer. Buffered from the start, so none is missed before the
 * consumer starts reading; while it lags, a newer progress or preview of a node replaces the
 * unread one where it stands, so the buffer stays bounded by the number of nodes and keeps its
 * order.
 */
export class EventQueue implements AsyncIterable<JobEvent> {
  readonly #buffer: JobEvent[] = [];
  /** `next()` calls waiting for an event, in the order they were made. */
  readonly #waiting: Waiter[] = [];
  #ended = false;
  #taken = false;

  /** Adds an event, unless the queue has ended or its consumer stopped. */
  push(event: JobEvent): void {
    if (this.#ended) return;
    const waiting = this.#waiting.shift();
    if (waiting !== undefined) {
      waiting({ done: false, value: event });
      return;
    }
    if (COALESCED.has(event.type) && "node" in event) {
      const stale = this.#buffer.findIndex(
        (queued) => queued.type === event.type && "node" in queued && queued.node === event.node,
      );
      if (stale !== -1) {
        this.#buffer[stale] = event;
        return;
      }
    }
    this.#buffer.push(event);
  }

  /** Ends the queue: the consumer reads what is buffered, then stops. */
  end(): void {
    this.#ended = true;
    for (const waiting of this.#waiting.splice(0)) waiting({ done: true, value: undefined });
  }

  [Symbol.asyncIterator](): AsyncIterator<JobEvent, undefined> {
    if (this.#taken) throw new TypeError("job.events can be iterated only once");
    this.#taken = true;
    return {
      next: () => {
        const event = this.#buffer.shift();
        if (event !== undefined) return Promise.resolve({ done: false, value: event });
        if (this.#ended) return Promise.resolve({ done: true, value: undefined });
        return new Promise((resolve) => {
          this.#waiting.push(resolve);
        });
      },
      return: () => {
        // The consumer stopped (`break`): drop the buffer and what comes later.
        this.#buffer.length = 0;
        this.end();
        return Promise.resolve({ done: true, value: undefined });
      },
    };
  }
}
