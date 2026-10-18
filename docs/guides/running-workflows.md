# Running workflows

`@tscomfy/client` runs workflows on a ComfyUI server. It queues them, streams progress, live
previews and outputs while they run, and reports how each job ended. It needs ComfyUI 0.26 or
later.

```sh
npm install @tscomfy/client @tscomfy/core
```

## A run, start to finish

```ts
import { workflow } from "@tscomfy/core";
import { connect, fetchFile, outputFiles, submit } from "@tscomfy/client";
import { local } from "./comfy/local/index.js";

const wf = workflow(local, ({ n }) => {
  // …
  const save = n.SaveImage({ images, filename_prefix: "portraits/run" });
  return { save };
});

const comfy = await connect({ url: "http://127.0.0.1:8188" });
try {
  const job = submit(comfy, wf, { previews: "taesd" });
  for await (const event of job.events) {
    if (event.type === "progress") console.log(`${event.node}: ${event.value}/${event.max}`);
  }
  const outcome = await job.outcome;
  for (const file of outputFiles(outcome, wf.handles.save)) {
    const { bytes, mime } = await fetchFile(comfy, file);
    // …
  }
} finally {
  await comfy.close();
}
```

- **`connect(server)`** opens a websocket to the server and checks that the server is ComfyUI
  0.26 or later, with the job API. A connection carries any number of jobs at once. Close it when you're done: an open
  websocket keeps a Node or Bun process running.
- **`submit(connection, workflow, options?)`** queues the workflow and returns a job right away.
  - It exports the workflow with `toApi`, so a workflow that fails validation throws a
    `ValidationError` before anything is sent.
  - A prompt (`ApiPrompt`) is sent as given: `exportApi(wf).prompt`, `toApi(wf, { validate:
    false })`, or JSON of your own read with core's `parse`. A workflow from `importApi` or
    `importUi` is a workflow, and is validated like any other.
- **`job.events`** is what the job reports while it runs, from the moment it was submitted.
- **`job.outcome`** is how the job ended.

## Getting at the results

The build function can return the nodes you care about; they come back as `wf.handles`
([building workflows](building-workflows.md)). The client looks outputs up by those handles:

| Call | Gives |
|---|---|
| `outputFiles(outcome, wf.handles.save)` | The files that node produced. Each has a `filename`, `subfolder` and `type` (`output` or `temp`); a `kind` (`image`, `video`, `audio`, `3d` or `file`); `animated`; the `key` it was listed under (`images`, `audio`, …); and, when the server measured it, `width` and `height` |
| `outputFiles(outcome)` | Every node's files, in prompt order |
| `outputOf(outcome, node)` | Everything one node reported: `files`, `text` (PreviewAny and other text previews) and the raw `ui` record |
| `fetchFile(server, file)` | `{ bytes, mime }` |
| `fileUrl(server, file)` | A `/view` URL, for `<img src>` on a page the server allows |

Any reference to a node works: its handle, one of its outputs (as on servers where `SaveImage`
also has an `IMAGE` output), or its id as a string.

Videos come back as files of kind `video`. Core's video nodes list them under `images` with an
`animated` flag; the client reads the extension and the server's metadata.

## Events

| `type` | When | Fields |
|---|---|---|
| `started` | The server started the job | |
| `cached` | Nodes whose earlier results are reused | `nodes` |
| `executing` | A node started | `node` |
| `progress` | A node advanced: sampler steps, say | `node`, `value`, `max` |
| `preview` | A live preview, or a `SaveImageWebsocket` image | `node`, `mime`, `bytes` |
| `output` | A node finished and reported files or text | `node`, `output` |
| `text` | Progress text from a running node | `node`, `text` |
| `blocked` | A node blocked execution; the rest goes on | `node`, `message` |

How events behave:
- **Node ids** are your workflow's node ids: a handle's `id`, or an output's `node`.
- **One reader.** Events can be read once.
- **Bounded buffering.** Events are buffered until you read them. If you read slowly, only the
  latest progress and preview of each node are kept.
- **The end.** Reading ends when the job ends.
- **Events are only a view.** You don't have to read them at all; the outcome doesn't depend on
  them.

**Live previews** from samplers are off unless the job asks for them (or the server was started
with `--preview-method`):
- `previews: "auto"` (latent2rgb, which needs no extra model);
- `"taesd"` (sharper, needs the TAESD decoder in `models/vae_approx`);
- `"latent2rgb"`;
- `"none"`.

Latent previews are JPEGs at most 512 pixels on a side (the server's `--preview-size`).
`SaveImageWebsocket` images always arrive as previews too: full-size PNGs. The bytes are a
`Uint8Array`: write them to a file, or wrap them as `new Blob([event.bytes], { type: event.mime })`
for an `<img>`.

## Outcomes

The outcome is data. The promise doesn't reject because the job went wrong:

| `status` | Meaning | Also has |
|---|---|---|
| `success` | The job ran | `outputs` |
| `rejected` | The server refused the prompt; nothing ran | `diagnostics` (`E_PROMPT_REJECTED`, `E_SERVER_VALIDATION` at the node and input) |
| `failed` | A node raised an error | `error` (`node`, `classType`, `exceptionType`, `message`, `traceback`, `executed`), and the `outputs` of nodes that finished first |
| `cancelled` | Cancelled or interrupted, by you or by someone else | the `outputs` of nodes that finished first |

**Diagnostics.**
- **Every outcome has `diagnostics`.** On a success, they can list outputs the server refused
  while it ran the others (`E_SERVER_VALIDATION`), and nodes that blocked (`W_NODE_BLOCKED`).
- **Where they come from.** Local validation rejects most of what the server would. A server
  rejection usually means the server changed since you generated the types: a model was removed,
  say. `tscomfy check` shows what changed.

**What rejects.** The outcome promise rejects in two cases:
- **Your abort.** The `signal` you passed was aborted; it rejects with the signal's reason.
- **Lost contact.** It rejects with a `ClientError`: the server couldn't be reached, the
  connection was closed, or the server answered in a way the protocol doesn't allow.

**How the outcome is decided.** It comes from the server's record of the job
(`/api/jobs/{id}`), not from the websocket. If the socket drops, the client reconnects, reads the
record and carries on, so a dropped connection costs some progress events, never the result.

## Cancelling and timeouts

```ts
const job = submit(comfy, wf, { signal: AbortSignal.timeout(10 * 60_000) });
await job.cancel(); // the outcome settles as "cancelled"
```

- **`job.cancel()`** cancels the job on the server, whether it is waiting in the queue or
  running. A running job stops at the next node or sampler step.
- **Aborting `signal`** cancels the job on the server too, and rejects the outcome with the
  signal's reason.
- **No default timeout.** Long runs are normal, so the client never times out on its own. If the
  server's worker dies, a job never ends; only your signal stops the wait.

## Uploading inputs

```ts
import { uploadFile } from "@tscomfy/client";

const photo = await uploadFile(comfy, { name: "photo.png", bytes, mime: "image/png" });
const wf = workflow(local, ({ n }) => {
  const [image] = n.LoadImage({ image: photo.value });
  // …
});
```

- **Stored name.** `uploadFile` stores the file in the server's `input` directory, or `temp` or
  `output` with `type`. It returns the name the server stored it under, which differs when the
  name was taken.
- **`value`** is what a loader's file input takes. `LoadImage`'s combo lists the files the server
  had when you generated the types. An uploaded name isn't among them, which validation reports as
  a warning; the upload combo's type accepts it.

## Servers, headers and browsers

`connect` and the file functions take a `Server`: `{ url, headers?, fetch?, webSocket? }`.

- **`url` may hold a path and a query.** `http://host/comfy/?token=t` is kept on every request
  and on the websocket.
- **`headers` go on every HTTP request.** A browser can't put headers on a websocket handshake;
  in Bun, Node and Deno, pass `webSocket: (url) => new WebSocket(url, { headers })`.
- **No credentials in the URL.** `user:password@` is refused, because runtimes disagree on them;
  send an `authorization` header.
- **Browsers.** A page on another origin, a dev server on another port included, is refused by
  ComfyUI's default origin check. Start the server with `--enable-cors-header <your origin>`, or
  serve the page from the server's origin through a proxy.
- **Type declarations.** The client's declarations name `fetch`, `WebSocket` and `AbortSignal`.
  Your project needs a runtime's web types: `@types/node`, Bun's types, Deno, or the DOM lib.

## Partner nodes and other `extra_data`

`options.extraData` adds to the request's `extra_data`. For example, ComfyUI's partner (API) nodes
take a Comfy.org key:

```ts
submit(comfy, wf, { extraData: { api_key_comfy_org: key } });
```

The server keeps the key out of its history. `options.front` queues the job ahead of the others,
and `options.targets` runs only some output nodes.
