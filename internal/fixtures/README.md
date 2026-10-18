# Fixtures

Mock data for tests, written or distilled by hand. Everything here is ours: no raw server dumps,
no personal data, no text copied from upstream projects. The shapes follow what ComfyUI actually
serves; the coverage list below comes from analyzing real `/object_info` output.

Real data lives in the gitignored `corpus/` directory and is used only by local corpus tests
(see `corpus/README.md` and docs/plan.md §13).

Tests load data through this package (`@tscomfy/fixtures`), never by relative path:

```ts
import { listCorpus, readMockObjectInfo } from "@tscomfy/fixtures";

const text = await readMockObjectInfo("dynamic-combo"); // raw JSON text
const dumps = await listCorpus("object-info"); // [] on a fresh clone
```

Loaders return raw text because parsing (e.g. keeping big integers exact) is under test.

**Rule:** when a corpus run finds a shape or failure that no mock covers, distill it into a new
mock here (the regression test) before fixing it.

## `mocks/workflows/api/`

Each file is the prompt the ComfyUI frontend would send for one graph over a mock schema, written
by hand from the frontend's rules (docs/plan.md §7.4), apart from the differences documented there:
optional widgets and dynamic combos left out stay out (node 8 of `dynamic-combo.json`), and
DynamicGroup, which frontend 1.55.17 doesn't handle, follows the backend's keys. The parity tests in
`packages/codegen/test/parity.test.ts` build the same graph and must export it byte for byte.
Adding a file means adding its name to `MOCK_API_WORKFLOW_NAMES`; a test enforces this.

| File | Covers |
|---|---|
| `txt2img.json` | A frontend-export-shaped txt2img: a seed node feeding a widget, defaults, a title |
| `dynamic-combo.json` | Nested options flattened depth-first, option defaults, bare keys, option sockets after the node's own, raw source nodes |
| `autogrow.json` | Given slots only, prefix and names forms, MatchType slots |
| `dynamic-group.json` | `group.<row>.<field>` keys with row defaults, an optional group with min 1 |
| `value-widgets.json` | JSON values, list wrapping, CURVE marking, display-only widgets left out, `widgetType` defaults |
| `lists.json` | Multi-selects (empty when not given), boolean options, a raw node's list input |

## `mocks/workflows/ui/` and `mocks/workflows/ui-api/`

UI workflows as the frontend saves them, all over the `basic-pipeline` mock schema, and under the
same name in `ui-api/` the prompt frontend 1.55.17 itself builds for each, captured with
`scripts/frontend.ts` (below). They are written by us: most started as probes of the frontend's
behavior, with mock file names in place of real ones. `importUi` must give each prompt byte for
byte (`packages/core/test/ui-import.test.ts`), and the transpiled modules in
`packages/codegen/test/generated/transpiled/ui/` must rebuild it. Adding a file means adding its
name to `MOCK_UI_WORKFLOW_NAMES`; a test enforces this.

| File | Covers |
|---|---|
| `txt2img.json` | The `api/txt2img.json` graph in UI form: a Reroute, a PrimitiveNode feeding a widget, a Note, a seed node feeding a widget slot, control widgets in `widgets_values`, a title. `MockSeed` isn't a server class, so its expected prompt is `api/txt2img.json`, which the capture matches on every other node |
| `modes.json` | A muted Reroute in front of a widget-less socket (the input is left out), a bypassed sampler passing its latent through, a muted loader |
| `subgraphs.json` | Nested subgraphs, two instances of one definition, promoted widget values (outer over inner over interior), a root id an inner node also uses (reminted from `last_node_id`) |
| `subgraph-modes.json` | A muted subgraph inside another: its interior is still sent, its output resolves to nothing (`W_FRONTEND_QUIRK`) |
| `subgraph-primitive.json` | A PrimitiveNode linked to a promoted subgraph input: the value never arrives, and the instance's order changes (`W_FRONTEND_QUIRK`) |

## `mocks/protocol/`

What a ComfyUI server sends while it runs prompts, for `FakeServer` (`src/fake-server.ts`): a
real HTTP and websocket server (`Bun.serve`) that plays these runs to the client, with faults to
inject (a dropped socket, events before the HTTP answer, the same-id hazard, a job cancelled
while queued, a dead worker). The client's tests and `test:pack` use it.

Each file holds runs: the prompt, the answer to `POST /prompt`, the websocket events in order,
and the job record (`GET /api/jobs/{id}`) at the end. `PROMPT_ID`
stands for the prompt id the client chose; binary frames are `{ "binary": 4, "metadata", "image" }`
(base64) or `{ "binary": 3, "node", "text" }`. They are distilled from captures of ComfyUI 0.41.0
(`scripts/capture.ts`, into `corpus/protocol/`): tracebacks cut to two frames, the server's
paths and model names generalized, image bytes replaced by a tiny image. Adding a file
means adding its name to `MOCK_PROTOCOL_NAMES`; a test enforces this.

| File | Covers |
|---|---|
| `success.json` | A saved and a previewed image, then the same prompt again, every node cached |
| `websocket.json` | `SaveImageWebsocket`'s type-4 PNG frame, PreviewAny's text output |
| `rejected.json` | 400s: no output node, an unknown class (`node_id` in `extra_info`), an input out of bounds |
| `partial.json` | A 200 with `node_errors`: one output refused, the other run |
| `error.json` | A node raising after an output ran: `execution_error`, a failed record with that output |
| `cancel.json` | A running job cancelled: `execution_interrupted`, a cancelled record |
| `pending.json` | A job cancelled while queued: no event, then a 404 record |
| `sampler.json` | A real sampler run (captured with a model, its name generalized): six latent previews as type-4 JPEG frames, step progress, a 2⁶⁴−1 seed echoed exactly |
| `blocked.json` | Hand-written from the source, since no core node does it without a model or a partner account: progress text (type 3) and a blocked node |

## `mocks/workflows/ui-extensions/`, `ui-extensions-api/` and `ui-extensions-export/`

UI workflows over the `ui-extensions` mock schema, of core classes whose widgets the frontend's
core extensions make (3D loaders and previews, audio, cameras, a remote combo, CustomCombo,
KSamplerAdvanced's load-time fixups), and under the same name in `ui-extensions-api/` the prompt
the frontend builds for each; `ui-extensions-export/` holds the prompt it builds for `toUi`'s
export of the import. Both are captured with `scripts/frontend.ts --object-info
mocks/object-info/ui-extensions.json --remote-files '["other.png [output]", "out.png [output]"]'`,
which registers the mock's definitions in the page (so the frontend's extensions see the mock
shapes) and lists the saved remote file, so the frontend keeps it. The mock classes mirror the
server's shapes, written by hand. `importUi` must
give each prompt apart from the documented differences (keys the classes don't declare, values
computed at queue time), checked in `packages/core/test/ui-extensions.test.ts`. Adding a file
means adding its name to `MOCK_UI_EXTENSION_WORKFLOW_NAMES`.

| File | Covers |
|---|---|
| `core-extensions.json` | Load3D's buttons and computed scene, Load3DAdvanced, Preview3D and SaveGLB's added `image`, LoadAudio and SaveAudio's players and upload button, RecordAudio, CameraAngle's unsent view, CreateCameraInfo's state, ImageCropV2's box fields, LoadImageOutput's remote toggle and refresh button, CustomCombo's scripted widgets, KSamplerAdvanced's boolean control and old sampler name, a file name referencing both |

`mocks/workflows/ui-export/` holds, under the same names, the prompt the frontend builds when it
loads `toUi`'s export of each import: the oracle for the export. The export is deterministic, so
a change to `toUi` that fails `ui-export.test.ts` there means capturing them again with the script below.

## `scripts/frontend.ts`

`bun internal/fixtures/scripts/frontend.ts [--server URL] [--object-info FILE] [--remote-files JSON]
--out DIR UI.json…` loads UI workflows into the server's own frontend (`--server`, by default the
local one) in a headless Chromium
(`TSCOMFY_CHROME`, or the one Playwright caches) and writes the prompt `graphToPrompt` builds for
each, without queueing it: every request but a GET is answered by the script and never reaches
the server, and so are the server's file lists (`/internal/files/…`, which remote combos fetch:
`--remote-files`, or an empty list), so a capture holds none of the server's files.
`--object-info` registers a mock's node definitions in the page first. It needs the server
running. Use it to capture `ui-api/` prompts and
to settle any question about the frontend's behavior. Development tooling: no test runs it.

## `mocks/object-info/`

Each file is a complete `/object_info` response containing a few nodes around one theme. Adding a
file means adding its name to `MOCK_OBJECT_INFO_NAMES` in `src/index.ts`; a test enforces this.
Node class names start with `Mock` unless the name itself is the thing being tested.

| File | Covers |
|---|---|
| `accepts.json` | One input per link rule and one output per output kind, for the `accepts` table run against both `accepts()` and the generated types |
| `empty.json` | An empty response: no nodes |
| `basic-pipeline.json` | A txt2img pipeline with realistic fields, and a seed node whose output feeds the sampler's seed widget: legacy combos, widgets with defaults, seed max 2⁶⁴−1, multi-output loader, output node, hidden inputs; and the LoRA loader, latent upscale and preview the `hires-fix` example uses |
| `combos.json` | Legacy `[[…]]` and v2 `["COMBO",{options}]` forms, numeric, mixed and boolean options, a default that is not an option, a falsy default (the frontend sends the first option instead), empty lists, upload and remote combos, the three multi-select flag combinations, option-list outputs, a custom widget-like type that is not a COMBO |
| `dynamic-combo.json` | `COMFY_DYNAMICCOMBO_V3`: options without inputs, required and optional option inputs, three levels of nesting (`format.codec.encoding`), a top-level name colliding with a nested one, option keys with spaces and brackets, Autogrow and MatchType inside options, an optional dynamic combo, an option input whose flattened key equals another input's name |
| `autogrow.json` | `COMFY_AUTOGROW_V3`: prefix form (min 1 and min 0), names form with a comma-union template, an optional Autogrow whose template sits in `optional`, an optional Autogrow with a required template, MatchType slots |
| `dynamic-group.json` | `COMFY_DYNAMICGROUP_V3`: required group with mixed widget fields, optional group with required and optional fields, optional group with min 1 |
| `match-type.json` | `COMFY_MATCHTYPE_V3`: any-typed lazy switch, a template restricted to `IMAGE,MASK`, two templates with `output_matchtypes` containing nulls |
| `sockets.json` | Socket-only inputs: custom, `*`, comma union, `forceInput` widgets, `lazy`, `rawLink`, `socketless`, `defaultInput`; any-typed outputs |
| `outputs.json` | No outputs, list outputs, node-level `is_input_list`, `output_name`/`output_tooltips` longer than `output`, duplicate output names, names clashing with array/handle members, numeric-like and spaced names |
| `names.json` | Class names with spaces, parentheses, dots, emoji; ordinary input names containing dots (must never be split); input names that are not identifiers |
| `hidden.json` | Hidden inputs in every observed shape: server-filled names, tuple specs, `*`, empty string, plain widget type, object |
| `numbers.json` | Integer bounds beyond 2⁵³ (exact in the file), also as FLOAT bounds, beyond the double range and on an `INT:seed` type, defaults outside the bounds, widgets with no default, list-valued defaults, every widget option variant |
| `malformed.json` | Inputs that must produce diagnostics instead of crashes: null, string, numeric type, empty tuple, bad options, V3 types missing their payload, unknown V3 type, non-record section, mismatched output arrays, dangling `input_order`, missing fields, `name` disagreeing with its key, an input declared in two sections, null options, a legacy combo or output list with an unrepresentable option, out-of-range Autogrow and DynamicGroup counts, duplicate dynamic-combo keys and nested inputs, a MatchType output without a template, an incomplete `input_order` |
| `ui-widgets.json` | Widgets the frontend adds without an input of their own (docs/plan.md §11): controls after INT (on by default for `seed`, off with an explicit `false`, named after a string option), FLOAT and combo (with its filter) inputs; the `upload` button for the first required image or video upload combo, an animated-image upload, a required `audio` upload combo, and none for an optional one or another name; a `forceInput` socket, whose placeholder value old files saved; a dynamic combo whose first option has inputs (links by slot land on those) |
| `ui-extensions.json` | Core classes whose widgets the frontend's core extensions make, in the server's shapes: Load3D, Load3DAdvanced, Preview3D, SaveGLB, RecordAudio, WebcamCapture, CameraAngle, CreateCameraInfo, LoadAudio, SaveAudio, LoadImageOutput (remote, refresh button), ImageCropV2 (BOUNDING_BOX), CustomCombo, KSamplerAdvanced, LoadImage, SaveImage; and mock shapes for the frontend rules they exercise: a class merely named `KSampler…`, an INT named like a BOUNDING_BOX field, inputs named `upload` (required and optional), a socketless widget before a socket, a remote combo with a control, FLOAT and multi-select controls, every extension widget type on one node |
| `widget-types.json` | Core frontend value widgets (COLOR, BOUNDING_BOX, COLORS, IMAGECOMPARE, CURVE with `forceInput`, a CURVE value, display-only RESOLUTION_PREVIEW); `widgetType` (FLOAT on a `FLOAT,INT` socket, PAINTER on STRING, pack-registered widgets, COMBO on a pack type and on INT); a pack type with a default that stays a socket |
| `nulls.json` | `null` where the server means "not set": `display_name`, `description`, `default`, `tooltip`, an input section, an `output_is_list` entry |
| `legacy-and-flags.json` | Older servers: no `input_order`, `output_name` or `output_is_list`; empty `input`; `deprecated`, `experimental`, `dev_only`, `advanced`, `essentials_category` |

Note: integers beyond 2⁵³ are written exactly in these files. `JSON.parse` without source-text
access rounds them, which is precisely what the lossless parser is tested against.
