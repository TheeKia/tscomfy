# ComfyUI execution: protocol, runtimes and prior art

Research for `@tscomfy/client` (plan §17, D23–D25), done 2026-10-18. Sources:

- **Backend:** the ComfyUI checkout at 0.41.0 plus 19 commits (`v0.41.0-19-g872eb6a3`), read as a
  specification. Citations are `file:line` in that checkout.
- **Frontend:** 1.55.18, the TypeScript recovered from the installed bundle's source maps, read
  as a specification. Compared with upstream 1.58.0.
- **Probes:** read-only, against the local server: GETs, websocket handshakes and the
  feature-flag exchange. Nothing was queued. Marked **[probed]**.
- **Runtime probes:** Bun 1.4.3, Node 24.22.0 (undici 7.29.1) and Node 26.11.1, against the
  local server and a local echo server.
- **Library survey:** shallow clones and npm metadata; nothing was installed or run.

ComfyUI and its frontend are GPL-3.0: everything below is a description in our own words, with
identifiers and field names only.

## 1. The shape of a run

A client opens a websocket, queues a prompt over HTTP, follows events on the socket, and reads the
results over HTTP. Seven facts decide the design:

1. **Events go only to the queuing client.** The server sends a prompt's execution events to the
   socket whose `clientId` equals the prompt's `client_id`. Without a `client_id`, no
   `executing`, `executed` or `execution_*` event reaches anyone, while progress, previews and
   `execution_interrupted` are broadcast to every socket (execution.py:680-702, main.py:464-476,
   server.py:1468-1486).
2. **The client can choose the prompt id.** `POST /prompt` accepts `prompt_id`. Since 0.25 it must
   be a canonical lowercase UUID; anything else is a 400 `invalid_prompt_id` (server.py:1179-1193).
   Accepted since July 2025 (commit 260a5ca5). A client that mints the id registers the job before
   it posts, so no event can arrive for a job it doesn't know yet. Events can arrive before the
   HTTP response does.
3. **The end of a run is `executing` with `node: null`.** It carries our `prompt_id` and is sent
   after the history entry is written, for success, error and interrupt alike (main.py:382-392).
   `execution_success`, `execution_error` and `execution_interrupted` come *before* the history
   write, so a read right after them can miss the result.
4. **The socket is not a record.** The server sends no pings and replays nothing after a
   reconnect. The only catch-up is a bare `executing {node}` without a `prompt_id`
   (server.py:351-354). Events sent while a client is disconnected are dropped.
5. **Reconnecting with the same `clientId` while the old socket is open is broken.** The handler's
   cleanup removes the entry for the id without checking that it is still the closing socket
   (server.py:337-345, 388-390). If the old socket closes after the new one registered, the new
   one stays open but receives no targeted events and loses its feature flags. **[probed]**:
   with two sockets on one id, closing the first left the second without a reply to its
   feature-flag message; a lone socket gets one. **[probed]**, 2026-10-19: after a network cut
   the server noticed two seconds late (a TCP proxy holding its side open), the client's new
   socket on the same id received nothing more, and the next job on it hung. A late close can
   come much later in practice: the server never pings, so it notices a dead peer only when a
   send fails, and it sends nothing to a socket no longer registered. Hence a fresh id for
   every socket (ADR-0024 §7).
6. **The job record is the authority.** `GET /api/jobs/{id}` (since 0.6.0) gives the status
   (`pending`, `in_progress`, `completed`, `failed`, `cancelled`), the outputs and the
   `execution_error` (comfy_execution/jobs.py). A job cancelled while pending has no record
   afterwards: the route answers 404, and no event announces it (execution.py:1405-1416).
7. **A run can hang.** If an exception escapes outside node execution, the worker thread dies; the
   job stays `in_progress` with no final event (main.py:430-438). Only a caller's timeout ends the
   wait.

## 2. Queueing: `POST /prompt`

Every route is also mounted under `/api` (server.py:1326-1335).

Request body (server.py:1161-1240):

| Field | Meaning |
|---|---|
| `prompt` | The API-format prompt. Missing: 400 `no_prompt` |
| `client_id` | Routes the run's events (fact 1). Copied into `extra_data.client_id` |
| `prompt_id` | Optional; a canonical lowercase UUID (fact 2). Not checked for uniqueness: a reused id overwrites the history entry |
| `number`, `front` | Priority. Lower runs first; `front` queues ahead of the rest |
| `partial_execution_targets` | Output-node ids to run; the other outputs are skipped |
| `extra_data` | `preview_method` (§4); `api_key_comfy_org` and `auth_token_comfy_org` for partner nodes, kept out of history and the queue listings (execution.py:162); `extra_pnginfo`, embedded in saved files; `comfy_usage_source` |

Responses:

- **200** `{prompt_id, number, node_errors}`. `node_errors` can be non-empty: when some outputs
  validate, the server queues the prompt with only those outputs and still reports the others
  (execution.py:1281-1301). The reported outputs never arrive.
- **400** `{error, node_errors}`. `error` is `{type, message, details, extra_info}`; `node_errors`
  maps a node id to `{errors, dependent_outputs, class_type}`, each error with the same four
  fields and `extra_info.input_name` for input errors (execution.py:1253-1258).
- Error types: `no_prompt`, `invalid_prompt_id`, `missing_node_type`, `prompt_no_outputs`,
  `prompt_outputs_failed_validation`, `dependency_cycle`, `invalid_dynamic_input`,
  `required_input_missing`, `bad_linked_input`, `return_type_mismatch`, `invalid_input_type`,
  `value_smaller_than_min`, `value_bigger_than_max`, `value_not_in_list`,
  `custom_validation_failed`, `exception_during_validation`,
  `exception_during_inner_validation`.
- Malformed JSON is a 500 without an envelope. A 403 comes from the origin check (§7), and a 413
  from the upload size limit.

Validation rewrites the prompt it stores: it unwraps `__value__` and coerces widget values with
`int()`, `float()`, `str()` and `bool()` (execution.py:996-1015). History and the job record hold
the coerced prompt, not the bytes that were sent.

## 3. The websocket

`GET /ws?clientId=<id>` (server.py:333-391). Any non-empty id is used as is.

- The first frame is `status` with the queue size and the `sid` **[probed]**.
- If the client's **first** text message is `{"type":"feature_flags","data":{…}}`, the server
  stores the flags and answers with its own. A later flag message is ignored. The server's flags
  include `supports_preview_metadata` and `max_upload_size` **[probed]**.
- The only client flag 0.41 reads is `supports_preview_metadata` (feature_flags.py:146-163).
  The frontend also announces `supports_progress_text_metadata`, and decodes type-3 frames with a
  prompt id prefix when the server advertises that flag; 0.41 does neither. The client announces
  both, as the frontend does, and decodes by the server's flag, so a server that gates the prefix
  on the client's flag, as it does for previews, works too.
- The server sends no heartbeat and answers client pings, which browsers can't send. Inbound
  messages are capped at 4 MiB (aiohttp defaults).
- Every JSON frame is `{type, data}`. When a prompt carries `workflow_metadata`, its keys are
  merged into every message of that prompt (server.py:1488-1506).
- JSON comes from Python's `json.dumps` defaults. Integers above 2⁵³ (seeds in `current_inputs`
  and in stored prompts) and `NaN` or `Infinity` can appear. Core's `parse` already reads both:
  big integers as `bigint`, non-finite numbers as `null` with `W_NON_FINITE_NUMBER`.

### 3.1 Events of a run, in order

1. `status`, broadcast, when the prompt is queued and again when it starts.
2. `execution_start` `{prompt_id, timestamp}`.
3. `execution_cached` `{nodes, prompt_id}`: every node with a cache hit.
4. Per node:
   - A cached output node sends `executed` with its cached UI output, or with `output: null`
     when it has none (asset_enrichment.py:129-142).
   - A node that runs sends `progress_state` (now `running`), then `executing`
     `{node, display_node, prompt_id}`.
   - Each progress tick sends `progress_state`, then the preview frame if any, then `progress`
     `{value, max, node, prompt_id}`. Ticks are throttled to at least 100 ms and 0.5 %
     (comfy/utils.py:1302-1346).
   - `executed` `{node, display_node, output, prompt_id}` follows, but only if the node returned
     UI output.
   - Last comes `progress_state` (now `finished`).
5. `execution_success` `{prompt_id, timestamp}`, or the failure events below.
6. `executing` `{node: null, prompt_id}`: the end (fact 3).

`progress_state` is `{prompt_id, nodes}`, a full snapshot of every non-pending node with
`{value, max, state, node_id, display_node_id, parent_node_id, real_node_id}`. `state` is
`running` or `finished` in practice (progress.py:160-186).

Failures:

- **`execution_error`** has `{prompt_id, node_id, node_type, executed, exception_message,
  exception_type, traceback, current_inputs, current_outputs, timestamp}`
  (execution.py:704-715).
  - `node_id` is the original node.
  - `current_inputs` is an object normally but an empty list for cycles and blocked nodes.
- **A blocked node isn't a failure.** A node that blocks execution with a message sends an
  `execution_error` with `exception_type: "ExecutionBlocked"`, no timestamp and no history record,
  and the run continues (execution.py:525-541). Judge the outcome from the final status, not the
  first error event.
- **`execution_interrupted`** `{prompt_id, node_id, node_type, executed, timestamp}`. Interrupts
  take effect at the next progress tick or node call, so a run that is finishing can still
  succeed.

### 3.2 Node ids in events

- **Expanded nodes:** nodes that expand at run time create ephemeral nodes with ids like
  `"<parent>.<i>.<j>.<id>"` (comfy_execution/graph_utils.py:27-40).
- **`node` and `display_node`:** `executing` and `executed` carry both. `display_node` names the
  node the prompt contains.
- **Other events:** `progress_state` and preview metadata carry `display_node_id`;
  `execution_error` and `execution_interrupted` carry the original node id. `progress.node` may be
  ephemeral.
- **tscomfy prompts:** these are flat, so `display_node` is the builder's node id; graph ids equal
  prompt ids (plan §7.3).

## 4. Previews and binary frames

Every binary frame starts with a big-endian `uint32` type (server.py:1398-1405, protocol.py):

| Type | Layout after the type | Notes |
|---|---|---|
| 1 | `uint32` format (1 JPEG, 2 PNG), image bytes | No node or prompt id. Sent only to clients that didn't announce `supports_preview_metadata` |
| 2 | — | Internal; never on the wire |
| 3 | `uint32` length, node id (UTF-8), text (UTF-8) | Progress text. No prompt id; core nodes broadcast it (server.py:1581-1591) |
| 4 | `uint32` length, JSON metadata, image bytes | Metadata `{node_id, prompt_id, display_node_id, parent_node_id, real_node_id, image_type}`. Sent only to the queuing client when it announced the flag (progress.py:218-229) |

- **Off by default:** the default preview method is `none` (cli_args.py:136). A prompt turns
  previews on with `extra_data.preview_method`: `auto`, `latent2rgb`, `taesd`, `none` or
  `default`.
- **Per prompt:** the value is set at the start of every prompt and reset by the next. Prompts
  run one at a time, so nothing leaks between them (execution.py:734, latent_preview.py:142-148).
- **`auto` means latent2rgb** in 0.41; `taesd` needs its decoder model and falls back to
  latent2rgb.
- **Format:** latent previews are JPEG at quality 95, fitted inside `--preview-size` (default
  512).
- **`SaveImageWebsocket`** (bundled in `custom_nodes/`) sends full-size PNGs through the same
  path, so they arrive as type-4 frames carrying its node id. It has no UI output and never
  caches.
- **Type-3 text** carries no prompt id. It belongs to our run exactly while our prompt is the one
  executing, because the server runs one prompt at a time.

## 5. Outputs

`executed.output` and the job record's `outputs` hold each node's UI output: an open record of
lists. File entries are `{filename, subfolder, type}` with `type` one of `output`, `temp` or
`input` (comfy_api/latest/_ui.py:23-37). Since 0.40 they also carry `metadata` with `kind`,
`width`, `height` and, for video, `duration`, `fps` and `frame_count`
(comfy_execution/media_enrichment.py:52-94).

| Node | Keys |
|---|---|
| SaveImage, PreviewImage | `images` (`output` or `temp`) |
| SaveAnimatedWEBP/PNG | `images`, plus `animated: [true]` when there is more than one frame |
| SaveVideo, SaveWEBM, video previews | **`images`** with `animated: [true]`; no `video` key in core (_ui.py:426-431) |
| SaveAudio and variants, PreviewAudio | `audio` |
| PreviewAny, text previews | `text: [string]` |
| SaveText | `text`, `files` |
| Save3D and variants | `3d`, `camera_info`, `model_3d_info` |
| Preview3D | `result: [path string, camera info, background]`: a path, not a file entry |
| SaveLatent | `latents` |
| Image compare nodes | `a_images`, `b_images` |

Custom nodes add their own keys; for example, VideoHelperSuite adds `gifs`. A client should
recognize file entries by shape under any key, and decide image, video, audio or 3D by key and
extension.

The job record's `outputs` aren't always what `executed` sent: `normalize_outputs`
(comfy_execution/jobs.py:68-110) turns any string with a 3D file extension, under any key, into a
file entry `{filename, subfolder: "", type: "output", mediaType: "3d"}`. A PreviewAny that shows
`"mesh.glb"` loses its text there, and a Preview3D path with directories becomes a file name that
`/view` strips. The client keeps the `executed` output for every node it saw live.

## 6. Job records, cancelling and files

- **`GET /api/jobs/{id}`** gives `{id, status, priority, create_time, execution_start_time?,
  execution_end_time?, execution_error?, outputs?, execution_status?, workflow?}`. It answers 404
  for an unknown id (jobs.py:85-110, 186-267). **[probed]**: 404 for an unknown UUID.
- **`GET /history/{id}`** has `meta`, which maps output ids to display ids, but answers `{}` with
  200 for an unknown id. History keeps 10,000 entries in memory; a restart loses it.
- **`POST /api/jobs/{id}/cancel`** (since 0.26.0) dequeues a pending job or interrupts a running
  one. The check runs under the queue lock, so it can't hit the next job (execution.py:1377-1394).
  It always answers 200 `{cancelled}` and is idempotent.
- **Legacy cancel:** `POST /interrupt` without a prompt id interrupts whatever is running, ours or
  not. `POST /queue {delete}` only removes pending jobs. `openapi.yaml` marks both deprecated.
  That file describes local and cloud servers together and lists routes the local server lacks;
  `server.py` is the authority.
- **`GET /view`** takes `filename`, `subfolder` and `type` (server.py:596-746).
  - Directories in `filename` are stripped, so they belong in `subfolder`.
  - `preview=webp;90` re-encodes still images.
  - Risky types such as SVG and HTML come back to non-browser clients as an octet-stream
    attachment.
- **`POST /upload/image`** takes multipart `image`, `type`, `subfolder` and `overwrite`
  (server.py:465-548).
  - It answers `{name, subfolder, type}`; the key is `name`.
  - Without `overwrite`, a clashing name gets a ` (n)` suffix unless the content is identical.
  - An unknown `type` is a 500.
  - The size limit is `--max-upload-size` (default 100 MB).
- **Widget values:** the frontend writes an uploaded file into a widget as `subfolder/name`, with
  ` [temp]` or ` [output]` appended when the folder isn't `input`.

## 7. Origins, auth and headers

- **No authentication** on any execution route.
- **`--multi-user`:** the `comfy-user` header picks a user for user data and settings only. The
  queue, history and jobs are shared, and `/prompt`, `/ws`, uploads and `/view` ignore the header.
- **Default origin check** (server.py:202-246): without `--enable-cors-header`, a request is
  refused with 403 when it carries `Sec-Fetch-Site: cross-site`, or when the host is loopback and
  `Origin` names a different host. **[probed]**: the websocket handshake is refused too.
  - Bun and Node send neither header, so they pass.
  - A browser page on another origin, a dev server on another port included, can't use a default
    server at all.
- **`--enable-cors-header`** allows only the `Content-Type` and `Authorization` request headers,
  so a browser request with any other custom header fails preflight.

## 8. Runtimes

Probed locally (Deno from its documentation):

| | Bun 1.4.3 | Node 24 / 26 | Deno | Browsers |
|---|---|---|---|---|
| Global `WebSocket`, `fetch` | yes | yes | yes | yes |
| Default `binaryType` | **`nodebuffer`** | `blob` | `blob` | `blob` |
| `new WebSocket(url, { headers })` | sends them | sends them (undici) | sends them (non-standard) | throws |
| Credentials in the URL | become Basic auth | ws drops them; fetch throws | — | fetch throws |
| `crypto.randomUUID` | yes | yes | yes | secure contexts only |

So:

- **`binaryType`:** always set it to `arraybuffer`.
- **Credentials:** never put them in URLs; pass explicit headers, plus a websocket factory for
  runtimes that can send headers on the handshake.
- **UUIDs:** make them from `crypto.getRandomValues`, which works in insecure pages too.

**Type declarations.** A package built with `lib: ["es2024", "webworker"]` can use `fetch`,
`WebSocket`, `AbortSignal`, `FormData`, `Blob`, `crypto` and `TextDecoder`. `document` doesn't
type-check, so the compiler itself keeps browser-only APIs out. A declaration file that names
`fetch`, `WebSocket` and `AbortSignal` type-checks for consumers with `@types/node`, with Bun's
types, and with the DOM lib (Bun's with `skipLibCheck: true`, since the workspace's store holds
two `@types/node` versions that collide; plan §16). It fails only for a consumer with no runtime types at all, which
couldn't run a client anyway. This was verified with TS 7.0.2 in a scratch project.

## 9. Prior art

The libraries surveyed are MIT unless noted.

- **`@comfyorg/sdk`** 0.5.0 (official, October 2026) targets Comfy's hosted "API v2". A
  self-hosted ComfyUI needs the separate `comfy-api-proxy` service in front of it.
  - Node 22+ only, with three runtime dependencies.
  - Sends prompts with `JSON.stringify`, so seeds above 2⁵³ are rounded and a `bigint` throws.
  - Not a base for tscomfy. Its design is the best of the survey, and we borrow it: the job
    record decides the outcome and the event stream is only a view; events are an async
    iterable; every call takes an `AbortSignal`; previews are `{nodeId, contentType, data}`.
- **`comfyui-node`** (successor of `@saintno/comfyui-sdk`) depends on ws, zod, sharp and an MCP
  SDK.
  - Most of its two main files compensate for subscribing after queueing and for not knowing
    whether a job still exists.
  - Its cancel only rejects locally.
- **`@saintno/comfyui-sdk`**: its issue tracker lists the failure modes to design against:
  - a listener attached after queueing missed events (#3);
  - jobs deleted elsewhere waited forever (#9, #12);
  - a 403 during server start-up caused a reconnect storm and ran out of memory (#21);
  - "WebSocket is not defined" on old Node (#26, #29);
  - Bun's `nodebuffer` frames were dropped (#31).
- **`@stable-canvas/comfyui-client`** takes injected `fetch` and `WebSocket`.
  - It attributes previews by guessing.
  - It once resolved on the first output of a multi-output prompt (#13).
  - Unknown message types used to throw (#4).
- **ComfyScript** (Python) waits on results by the builder's own output reference
  (`task.result(output)`). That is the idea behind D25.
- **`comfy_api_simplified`** (Python) queues before opening the socket, so a fast job can finish
  unseen.
- **Hosted APIs** (ComfyICU, RunComfy, Replicate's cog-comfyui) queue, then poll or call a
  webhook, and return outputs as URLs; few stream progress.

No surveyed client mints the prompt id, uses the per-job cancel, asks for previews per prompt,
reports partial acceptance, or keeps big integers.
