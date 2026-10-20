# ADR-0024: The job record decides the outcome; events are a view

Status: accepted, 2026-10-18; updated 2026-10-19 (a fresh client id per socket, and a slow poll);
updated 2026-10-20 (outputs per run)

## Context

A run's events go only to the socket of the client that queued it, and the server neither pings
nor replays. A reconnect can therefore lose events. A reconnect with the same client id can even
silently unregister the new socket.

There are further traps:

- `execution_error` is not always fatal: a blocked node reports one and the run continues.
- A job cancelled while pending ends without any event.
- A run can hang when the worker thread dies.
- Events can arrive before the response to `POST /prompt`.

Clients that treat the event stream as the truth either hang or report the wrong outcome; the
issue trackers of the surveyed clients are full of both (docs/research/comfyui-execution.md
§1, §9).

## Decision

1. **Mint the id, subscribe, then post.** The client mints the prompt id: a UUID v4 from
   `crypto.getRandomValues`, in canonical lowercase form. It opens the socket and negotiates
   `supports_preview_metadata` and `supports_progress_text_metadata` first, registers the job under that id, then posts the prompt with
   its `client_id` and `prompt_id`. No event can arrive for a job the client doesn't know. The
   POST itself isn't abortable: once sent, only its answer says whether the job exists, so an
   abort during it cancels the job after the answer.
2. **The job record decides.** The outcome comes from `GET /api/jobs/{id}`. The client reads it:
   - when the socket reports the run's end (`executing` with `node: null`);
   - after every reconnect, then polled (1 s growing to 10 s) until the job settles;
   - after `job.cancel()`;
   - every 30 s while the job is open, so no outcome depends on the socket alone;
   - when the queue changes while the job hasn't started, throttled, because a job cancelled
     while pending sends no event.

   A 404 for a job the server accepted means it was cancelled before it ran, if it hadn't
   started. After it started, a 404 means the server lost the record (a restart), and the outcome
   rejects with a `ClientError` (decision 6).
3. **Events are a live view.** Events (start, cached nodes, the running node, progress, previews,
   node outputs, progress text, blocked nodes) are an async iterable that ends when the job ends.
   They never decide the outcome. A slow consumer gets the latest preview and progress per node
   rather than an unbounded buffer.
4. **Outcomes the server reports are data.** The outcome promise resolves with a union:
   - `success`, with the outputs;
   - `rejected`, the server's 400, as diagnostics;
   - `failed`, the node error;
   - `cancelled`.

   Every outcome carries `diagnostics`. A 200 that still reports node errors (partial acceptance)
   puts them there, since those outputs will never arrive.

   Outputs are kept per run, by the node they are displayed as: `ReadonlyMap<NodeId, readonly
   NodeOutput[]>`. A node the server expands at run time, such as a loop's body (one copy per
   iteration), runs several times under ids of its own, and each run reports its own files.
   Keying by the displayed node alone kept only the last run's.
5. **The caller's abort rejects.** Aborting the `AbortSignal` passed when queueing cancels the
   job on the server and rejects the outcome with `signal.reason`, as `fetch` does. `job.cancel()`
   asks the server to cancel; the outcome then settles from the record, normally as `cancelled`
   (a job that was finishing may still succeed).
6. **Failures to talk to the server reject.** These reject with a `ClientError` carrying the
   cause: the server is unreachable after the reconnect budget, the connection was closed, the
   server lost the record of a job that had started, or the server sent an answer the protocol
   doesn't allow. They aren't results of the job.
7. **The socket reconnects carefully.** It reconnects only while a job needs it, with jittered
   exponential backoff, and re-sends the feature flags first. Every socket gets a fresh client
   id. Jobs that were running keep the old id, so their remaining events are lost; they settle
   from the record, polled after the reconnect.

   The first version reused the id, to keep in-flight jobs' events. A network cut that the
   server notices late defeats that: when the server finally closes the old socket, it
   unregisters whatever has the id, so the new socket stays open but deaf. Every later job on
   the connection then gets no events and no final signal. `reconnect.live.test.ts` reproduced
   this on ComfyUI 0.41 with a TCP proxy that holds the server's side of a cut connection.

## Consequences

- A missed event costs a moment of progress display, never a wrong or missing outcome.
- Every job costs one extra GET at its end.
- A hung worker still hangs the job. The caller's signal (`AbortSignal.timeout(…)`) is the only
  way out; the guide says so. There is no default timeout, because long runs are normal.
- Errors stay data where the server decided them, as in D14 and D21. Exceptions mean "no answer"
  or "you gave up".

## Alternatives

- **Trust the stream, as most clients do.** This leads to hangs after a reconnect, to a blocked
  node reported as a failure, and to missing results when the history read races the success
  event.
- **Poll only, with no websocket.** There would be no previews or live progress, which are the
  point of the package.
- **Settle an abort as `cancelled`.** Callers compose signals (timeouts, UI cancel buttons). The
  platform convention, followed by `fetch` and by `@comfyorg/sdk`, is to reject with the signal's
  reason. An explicit `job.cancel()` remains for "cancel and tell me the outcome".
- **Throw for every non-success outcome.** Rejection and failure are expected results of running
  a workflow, with structured data the caller wants. D14's errors-as-data applies.

## Evidence

docs/research/comfyui-execution.md:
- §1 lists the seven facts.
- §3.1 gives the event order and the blocked-node case (execution.py:525-541).
- §6 covers the job record and cancel (comfy_execution/jobs.py, execution.py:1377-1416).
- The same-id reconnect hazard was reproduced against the local server (§1, fact 5).
- §3.2 covers loops; `capture.ts loop` recorded a loop's copies on ComfyUI 0.42.0 (plan §16).
