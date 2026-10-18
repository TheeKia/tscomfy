# ADR-0023: An execution client, `@tscomfy/client`

Status: accepted, 2026-10-18 (revises the non-goal "executing workflows" of plan §1)

## Context

tscomfy stops at the API prompt: users queue it, follow progress and fetch the images with code
of their own, or with a third-party client. That last step is the same for everyone and easy to
get wrong:

- events can be missed between queueing and subscribing;
- the websocket loses events on reconnect;
- previews come without node ids unless negotiated;
- seeds above 2⁵³ are rounded by `JSON.stringify`.

No existing client fits the project. The official `@comfyorg/sdk` targets Comfy's hosted API and
needs a proxy in front of a self-hosted server; it is Node-only, has runtime dependencies and
rounds big seeds. The community clients have the failure modes above
(docs/research/comfyui-execution.md §9).

tscomfy already owns the hard parts of a correct client: the lossless serializer and parser
(D10), the diagnostic model (D14), and the builder's node handles, which can key the results.

## Decision

1. **The package.** A new package, `@tscomfy/client`, runs prompts on a ComfyUI server. It:
   - queues a `Workflow` (through `toApi`, so D21's validation runs first) or an `ApiPrompt`;
   - streams progress, live previews and outputs;
   - settles the job's outcome;
   - cancels jobs;
   - uploads input files and downloads output files.
2. **Dependencies.** It depends on `@tscomfy/core` as a peer (D5), uses `stringify` for every
   request body and core's `parse` for every JSON response and websocket message. It has no
   other dependency.
3. **Runtime.** It is runtime-agnostic, like `core`. It uses only the WHATWG globals `fetch`,
   `WebSocket`, `AbortSignal`, `FormData`, `Blob`, `crypto.getRandomValues`, `TextDecoder` and
   their companions (`Headers`, `Response`, `URL`, `AbortController`).
   - It builds with `lib: ["es2024", "webworker"]`, which declares those globals and not
     `document` or `window`, so a browser-only API fails `tsc -b`.
   - oxlint bans `node:*` and `bun` imports in it, as in `core`.
   - Its public types name the standard Web types (`AbortSignal`, `WebSocket`, `fetch`,
     `Uint8Array`). A consumer needs a runtime's types (Node's, Bun's, Deno's or the DOM lib),
     which any program that can run the client has.
4. **I/O.** `cli` and `client` are the packages that do I/O; `core`, `codegen` and `layout` stay
   pure.
5. **Supported servers.** ComfyUI 0.26.0 and later. That version has the job record
   (`/api/jobs/{id}`, 0.6.0) and the per-job cancel (`POST /api/jobs/{id}/cancel`, 0.26.0), on
   which ADR-0024 relies. The client is tested against the local 0.41.
6. **Scope.** Out of scope: pools of servers, a queue of our own, Comfy's hosted API, starting or
   managing a server, models or custom nodes, and any UI.
7. **Testing.** Committed tests run against a fake server that replays hand-written protocol
   traces. Each trace is distilled from a real capture, following the corpus rule for mocks.
   - Real-server runs exist only on the owner's machine: a capture script and a `test:live`
     suite.
   - Both POST prompts. `test:live` uses model-free workflows (empty images, blurs,
     text), so it costs no GPU time.
   - Neither runs in CI.

## Consequences

- The plan's non-goal "executing workflows, queueing, websockets, progress" and AGENTS.md's
  "never POST to `/prompt`" change. Only the capture script and `test:live` POST prompts, and only
  the owner runs them.
- ADR-0003's I/O rule names `client` beside `cli`.
- The release workflow, `test:pack` and the root `tsconfig.json` list one more package.
  `test:pack` type-checks a client consumer with the DOM lib's web types rather than with no
  ambient types, and runs it against a fake server under Node and Bun.
- New diagnostic codes for the server's validation errors join core's registry, as codegen's did.
- The client follows ComfyUI's protocol, which changes faster than `/object_info`. Feature flags
  are negotiated, unknown messages and fields are ignored, and the server versions tested are
  recorded in plan §16.

## Alternatives

- **Recommend `@comfyorg/sdk`.** It can't talk to a plain ComfyUI server, runs on Node only and
  rounds big seeds. It stays the recommendation for Comfy's hosted API.
- **Recommend a community client.** Each has missed-event races, unattributed previews or heavy
  dependencies, and none keeps big integers.
- **Structural types (`WebSocketLike`, `FetchLike`) in the public API instead of the Web types.**
  - A structural type can't be passed through to the real `fetch` without casts: its `signal` and
    `headers` don't match the platform's types in either direction.
  - It also gains nothing, since every consumer has the Web types.
- **`lib: ["es2024", "dom"]`.** This lets `document` and `window` type-check in a package that
  must also run on Node.
- **Support servers from 0.6.0 with fallbacks** (`/interrupt` and `/queue` instead of the per-job
  cancel). It doubles the cancel path for servers more than four months old.

## Evidence

docs/research/comfyui-execution.md: §1–§7 for the protocol, read in the 0.41.0 source and probed
read-only; §8 for the runtime probes and the type-declaration spike; §9 for the survey.
