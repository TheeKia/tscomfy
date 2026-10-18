# tscomfy: design and plan

> Packages: `@tscomfy/core`, `@tscomfy/codegen`, `@tscomfy/cli` (bin: `tscomfy`), `@tscomfy/layout`. MIT.
> Status: revision 7, 2026-10-18. **Phases 0–9 complete**; 0.1.0 is published on npm, from CI (D12).
> This is the design reference: what was decided and why (§3, with an ADR per decision in
> `docs/decisions/`), how it is built (§4–§13), how it got there (§14) and the evidence (§16).
> User documentation is in `docs/guides/`. Every claim marked **[verified]** was checked
> hands-on; the evidence is in [§16](#16-verification-log).

## 1. Goal

A TypeScript library for **generating** ComfyUI workflows as code, with types generated
on demand from a ComfyUI server's `/object_info`. These mistakes fail at **compile time**:
- wiring mistakes
- unknown inputs
- wrong combo values
- missing required inputs

Anything the types can't express is caught by **runtime validation** against the same schema.
Output is byte-for-byte what the ComfyUI frontend would send, apart from the documented
differences in §7.4.

### Non-goals

- Executing workflows, queueing, websockets, progress. We produce plain API-format JSON that any client can run.
- Running nodes in-process (ComfyScript "real mode").
- A GUI, MCP server, or custom-node management.

### Quality bar

- Strict compiler config. No `any`. Casts appear only in a handful of documented branding helpers.
- Pure and deterministic: the same input gives byte-identical output.
- Errors are data: diagnostics carry a stable code, severity, path and message. Only programmer misuse throws.
- Every public symbol has JSDoc and an explicit type (`isolatedDeclarations` enforces this).
- Tests use committed mocks whose coverage comes from real data, backed by a local real-data corpus (§13).
- **Soundness ordering**: whatever compiles also passes runtime validation, and whatever passes runtime
  validation is also accepted by the ComfyUI backend. Types may be stricter than the backend, never looser.

## 2. Lessons from prior art

| Source | Borrow | Avoid |
|---|---|---|
| rvion/comfy-ts | Codegen per server; literal unions from installed models; filling dynamic-combo defaults at serialization | A ~93k-LOC monolith with app dependencies. DynamicCombo typed as flat dotted keys intersected into the node's inputs: no recursion (nested dynamic children are opaque) and a combinatorial union per node |
| stepupgaming/comfy-workflows | Graph IR; index-based slot identity; drift detection by snapshot hash; file-like combos produce warnings | Exact-string type matching; widgets that can't take links; output filtering that shifts indices; dropping defaults; untyped transpiler output |
| @saintno/comfyui-sdk | Phantom-branded refs; `input_order`; the `["COMBO",{options}]` form | Bare-tuple refs (`["1",0]` fits anywhere); codegen that needs a live server; mixed mutable and immutable builder methods |
| StableCanvas/comfyui-client | A transpiler as the way users adopt the library | Untyped outputs |
| ComfyUI frontend 1.55.17 (GPL-3.0), the version ComfyUI 0.41 installs | The **specification** of serialization rules (§7.4, §11, §12) | Copying code |
| ComfyUI backend 0.41 `_io.py`, `execution.py` | Ground truth for V3 dynamic inputs, type compatibility, validation | — |

## 3. Key decisions

| # | Decision | Why |
|---|---|---|
| D1 | **Bun 1.4** for package manager, workspaces (isolated linker, text `bun.lock`), tests and scripts. The published CLI uses only `node:fs`, `node:crypto` and `fetch`, so it runs on Node 24+ and Bun 1.4+ | Fast and a single tool for development; users install and run the packages with whatever they use (`npx @tscomfy/cli`). **[verified]** |
| D2 | **TypeScript 7.0** (`typescript@7.0.x`) | Stable since 2026-07. Strict config, `tsc -b` references, `.d.ts` consumption under `nodenext` and `bundler`, and the type tests all pass. The missing compiler API (arrives in 7.1) doesn't matter: codegen writes strings. **[verified]** |
| D3 | **`core`, `codegen` and `layout` are runtime-agnostic**: no `node:*`, `bun` or `bun:*` imports (oxlint) and no DOM or runtime globals (`lib: ["es2024"]`, `types: []`) | Generation works in Node, Bun, Deno, browsers and edge runtimes. |
| D4 | **ESM only, unbundled** per-file JS, `.d.ts` and maps from `tsc -b`. Source uses `.ts` specifiers with `rewriteRelativeImportExtensions` | Simplest correct library output. **[verified]** |
| D5 | **Zero runtime dependencies in every package** | The object_info normalizer is a hand-written lenient tree walk with diagnostics per field. A schema library would add a dependency and a second representation of the data, and lenient handling needs the custom code anyway. |
| D6 | **The object_info normalizer lives in `core`** | Runtime users (e.g. a browser app against a live server) need it without codegen. Raw object_info is confined to one module, `core/src/object-info/`. |
| D7 | **API format first.** The UI format is separate import/export modules on top (D17) | API format maps 1:1 onto the graph. |
| D8 | **The schema is passed explicitly as a typed value**; no global module augmentation | Several servers in one project, isolated tests, no hidden state. |
| D9 | **Refs are frozen `OutputRef` instances typed as a branded, covariant `Out<T>`** | Lists are meaningful values (they get wrapped as `__value__`, §7.4), so refs can't be tuples. **[verified]** |
| D10 | **Lossless integers.** INT accepts `number \| bigint`. Our own small deterministic serializer writes bigint as a JSON number. The parser reads big ints via `JSON.parse` source-text access. The normalizer and the importer take **raw text**, never an already-parsed value | Seeds go up to 2⁶⁴−1, and 134 bounds in the real dump are integer literals beyond 2⁵³ (102 of them INT `max`). A parsed value has already lost them. **[verified]** in Bun 1.4.3 and Node 26. |
| D11 | **oxfmt formats, oxlint lints** (`--type-aware` via tsgolint, built on TS 7) | One toolchain. oxlint's type-aware rules are as accurate as tsc and catch cross-package cases Biome's linter misses. oxfmt is 0.x, so it is pinned exactly. **[verified]** |
| D12 | **CI runs the local gate and releases.** GitHub Actions runs `bun run check`, and `test:pack` under Node 24 and 26, on pushes and PRs; a `v<version>` tag publishes every package with npm trusted publishing (OIDC, provenance). `bun run check` stays the local gate | The owner's choice (2026-10-18, revising "no CI" once the packages were published). CI runs the same scripts as local work, so it adds no second definition of "passing"; releasing only from CI means no npm token exists anywhere. **[verified]** |
| D13 | **The generated runtime schema is a `.ts` module holding the schema as one string literal**, loaded by `defineSchema`, not a JSON import | A 3.4 MB JSON import costs 142 MB and 0.2 s of type-checking on every check; a string literal is nearly free, needs no copy step and no `resolveJsonModule`. `defineSchema` parses it with the lossless `parse`, because a plain `JSON.parse` would round the 134 big bounds; on a runtime without source-text access (such as Node 20) it throws a clear error rather than load imprecise bounds. **[verified]** |
| D14 | **One diagnostic model, from Phase 1** (§5.4): `{ code, severity, path, message }`. `path` is an array of segments. Each code has one fixed severity, which its `E_`/`W_` prefix names | The normalizer emits diagnostics long before validation exists (Phase 5). Segment paths need no escaping for the 851 dotted input names and 328 non-identifier class names, unlike dotted paths or JSON Pointers |
| D15 | **Schema identity.** `Schema.nodes` is built in code-unit order of class type (JavaScript still lists integer-like keys first). `hashSchema(schema)` is computed on demand, not stored: a synchronous, hand-written SHA-256 over `stringify({ formatVersion, nodes })` | Output doesn't depend on the server's node load order. The hash changes when the generated output can, not when whitespace, key order or the ComfyUI version changes. `crypto.subtle` is async; hashing raw text tracks noise. 62 ms on 3.4 MB. **[verified]** |
| D16 | **An input is a widget exactly when the frontend makes it one**: the frontend looks up `widgetType ?? type` in its widget registry: the core widgets and those its core extensions register (3D, camera, webcam, audio), each saved and sent, or not, as the frontend does. When `type` is primitive (INT/FLOAT/STRING/BOOLEAN/COMBO) the kind follows `type`, because the backend coerces and validates by it, and `widgetType` is recorded. Otherwise a primitive widget gives its kind, another core widget (COLOR, BOUNDING_BOX, CURVE, …) gives a `value` kind holding JSON, and anything else, `TYPE:name` types included, is a socket. The socket type is always `type` | This is the only rule that matches which inputs get values in exported prompts and stays sound. 25 real inputs use non-primitive core widgets, mostly socketless; as sockets they could never be set. `widgetType` splits widget and socket (`frame_rate` is a FLOAT widget on a `FLOAT,INT` socket). Widgets a pack registers in the browser are invisible in `/object_info`, so those inputs stay sockets (stricter, and `raw()` remains). **[verified]** |
| D17 | **`importUi` reproduces the frontend's prompt, quirks included** (with a warning), except that a node of a missing class keeps its class; values by position, as the frontend reads them, by name only when the positions don't fit; **`toUi` writes a flat graph**; layout is its own package | The user gets the prompt they would get from the frontend, checked against the frontend itself. Where the frontend sends something the backend rejects, there is nothing to be faithful to. **[verified]** |
| D18 | **Dynamic combos are `{ option, inputs }`**, nested, or the bare option key when its inputs may all be left out (§6.4) | Option inputs can't collide with the node's own (`SaveVideo` has `codec` and `format.codec`) or with a key named `option`; the shape is recursive, as 189 nested dynamic inputs need. **[verified]** |
| D19 | **Combos are strict** literal unions, except upload, remote and empty combos (§6.5) | The types describe the server they were generated from and `check` catches drift; loosening file combos would compile values validation rejects. One schema per server instead |
| D20 | **Fill the schema's defaults, never invent one** (§7.2) | Prompts match the frontend's wherever a value is stated; the frontend's fallbacks (`0`, the first checkpoint) pick values silently and can break `min` |
| D21 | **`toApi` validates by default and throws `ValidationError`**; `exportApi` returns warnings (§8) | The default path can't produce a prompt the backend rejects for a reason the schema states; a library has nowhere to print warnings |
| D22 | **The public API is pinned by declaration reports** in `docs/api/`, checked by `bun run check` (§13) | Every API change shows as a reviewed diff; TS 7.0 has no compiler API for API Extractor |

## 4. Architecture

```
@tscomfy/cli           node:fs · fetch · args (Node 24+ or Bun 1.4+)
  generate · check · transpile
        │
@tscomfy/codegen       pure: Schema in → files (as data) out
  generate (types + schema module) · transpile (graph → TS)
        │
@tscomfy/core          pure, zero deps
  object-info/  raw /object_info → Schema   (the only module that knows the raw format)
  schema/       Schema model, SocketType, accepts(), hashSchema(), diffSchemas()
  frontend/     the frontend's node model: widget registry (saved, sent), widgets and slots,
                LiteGraph link rules, `%…%` text; shared by api/ and ui/
  graph/        IR, builder, OutputRef, prune, splitOutputs
  api/          export (flatten, defaults, __value__, modes), import (schema-driven un-flatten)
  validate/     prompt checks, as the backend validates
  diagnostic/   Diagnostic model and code registry (every module may import it)
  json/         lossless parse and serialize
  hash/         synchronous SHA-256 (D15)
  ui/           UI workflows: importUi (as the frontend queues them), toUi (flat, format 0.4)

@tscomfy/layout        pure: positions for toUi (layered, left to right)
```

**Dependency rules**:
- Dependencies point downward only.
- Inside `core`, nothing outside `object-info/` reads raw object_info.
- `codegen` returns `{ path, contents }[]` and never touches the filesystem.
- The CLI is the only package with I/O.

### 4.1 Data flow

```
GET /object_info (text) ─► normalizeObjectInfo(text, { comfyVersion? }) ─► { schema: Schema, diagnostics }
                                                                          ├─► emitTypes()        → nodes.ts   (types only)
                                                                          ├─► emitSchemaModule() → index.ts   (runtime schema + typed export)
                                                                          └─► hashSchema()       → file headers, drift check

workflow(local, ({ n, raw }) => …) ─► Workflow { schema, graph }
   ├─► toApi(wf, { validate })  → ApiPrompt   (plain object, may hold bigint)
   ├─► stringify(prompt)        → lossless JSON string for POST /prompt
   ├─► validate(wf)             → Diagnostic[]
   └─► transpile(wf)            → TS source
prompt JSON (text) ─► importApi(text, schema) ─► { workflow, diagnostics }
UI JSON (text) ─► importUi(text, schema) ─► { workflow, diagnostics }
workflow ─► toUi(wf, { positions: layout(wf) }) ─► { workflow: UI JSON object, ids, diagnostics }
```

The core API is free functions over immutable data, so every operation is pure and composable
and nothing is hidden in methods. `Workflow` is a frozen value.

## 5. Domain model (`core`)

### 5.1 Schema

The full model, with JSDoc, is `packages/core/src/schema/types.ts`. In outline:

```ts
type Schema = {
  readonly formatVersion: 1;
  readonly comfyVersion?: string;                    // from /system_stats, passed by the caller; not hashed
  readonly nodes: { readonly [classType: string]: NodeDef };   // exact class_type keys; code-unit order (D15); null prototype
};

type NodeDef = {
  readonly classType: string; readonly displayName: string; readonly category: string;
  readonly pythonModule: string; readonly description?: string;
  readonly outputNode: boolean;
  readonly isInputList: boolean;          // node-level is_input_list (42 nodes in the real dump)
  readonly deprecated: boolean; readonly experimental: boolean;
  readonly inputs: readonly InputDef[];   // input_order, required first; hidden inputs dropped
  readonly outputs: readonly OutputDef[]; // index = slot, never filtered
};

type InputDef =                 // all share name, required, tooltip?, lazy, rawLink
  | SocketInput                 // custom types, "*", comma unions, TYPE:name, forceInput widgets
  | IntInput | FloatInput | StringInput | BooleanInput   // + type (the socket type), socketless, widgetType?
  | ComboInput                  // the same, plus form "legacy" | "combo"; options (strings, numbers, booleans;
                                //   may be empty); multiselect, upload, remote
  | ValueInput                  // other core frontend widgets (D16): widget, type, default?: JsonValue
  | AutogrowInput               // form "prefix" | "names"; slots (every slot name); min; template (a socket)
  | DynamicComboInput           // options: { key, inputs: InputDef[] }[]   (recursive)
  | DynamicGroupInput           // fields: InputDef[]; min; max ≤ 20; groupName? (upstream: unstable)
  | MatchTypeInput              // templateId; allowed: SocketType
  | UnknownInput;               // spec: the raw spec, kept so later stages degrade gracefully

type SocketType =
  | { readonly kind: "named"; readonly name: string }
  | { readonly kind: "union"; readonly names: readonly string[] }   // "IMAGE,MASK"; may contain "*"
  | { readonly kind: "any" };                                       // exactly "*"

type OutputDef = {
  readonly index: number; readonly name: string;
  readonly type: SocketType | { readonly kind: "combo"; readonly options: readonly ComboOption[] };
  readonly isList: boolean; readonly tooltip?: string;
  readonly matchTemplate?: string;      // MatchType outputs; their type is then "any"
};
```

- **Plain data.** These are type aliases, not interfaces, so a `Schema` is assignable to
  `JsonValue` (a type test checks it) and serializes with `stringify`. The normalizer returns it
  deeply frozen, and builds every object in a fixed field order.
- **Integers** are `number` when safe and `bigint` otherwise (`IntValue`), never both forms for
  one value.
- **Defaults** appear only when the schema states one and the backend would accept it (§9).
- DynamicSlot is backend-only, unused by the frontend and absent from the dump; it maps to
  `UnknownInput` (`W_UNSUPPORTED_INPUT_TYPE`) until a real node needs it.

### 5.2 Type compatibility

`accepts(input, output)` follows the backend's `validate_node_input`, non-strict:
- `*` on either side passes, also as a member of a comma list.
- MatchType passes on either side (it is checked at template level instead).
- An option-list output passes into an input typed exactly `COMBO` only (a COMBO widget on
  another type doesn't count). A legacy `[[…]]` combo's type is its option list itself, so the
  backend matches it only against `*`, MatchType or an identical list.
- Comma sets pass when they overlap.
- An Autogrow answers for its slots (the template's type). DynamicGroup inputs and unknown specs
  answer `false`: stricter than the backend, never looser.

The generated types are a **subset** of this rule, and that is tested pair by pair: codegen's
fixture script evaluates `accepts()` on every input × output pair of the `accepts` mock (108 pairs,
`test/generated/accepts-matrix.ts`), and `accepts-table.test-d.ts` checks that no pair compiles that
`accepts()` rejects, and that the pairs where the types are stricter are exactly a documented list
(27 today):
- Union outputs must fit inside the input's set, not merely overlap it.
- A `*` inside a comma list (`*,IMAGE`, or a padded `" *"`) is typed by the other members, on
  inputs and outputs alike: the backend lets such types into string-typed inputs only, never into
  a legacy combo, and never lets an option list in.
- Option-list outputs are `Out<OptionList>`, a socket name of their own, which only inputs typed
  exactly `COMBO` or `*` take. A legacy combo takes `*` only: an identical option list can't be
  told apart by type.

`isList` outputs do **not** affect compatibility: ComfyUI maps a list output over a non-list input.
It is documented in JSDoc only.

### 5.3 Graph IR

```ts
interface Workflow<N> { readonly schema: TypedSchema<N>; readonly graph: Graph }   // frozen
interface Graph { readonly nodes: ReadonlyMap<NodeId, GraphNode> }   // creation order; a read-only view, not a Map
interface GraphNode {
  readonly id: NodeId;                      // string; sequential "1","2",… unless set explicitly
  readonly classType: string;
  readonly inputs: { readonly [name: string]: InputValue };   // STRUCTURED (dynamic inputs nested)
  readonly title?: string;
  readonly raw: boolean;                    // added with raw(): inputs are wire keys, exported as given
  readonly mode?: "bypass" | "mute";        // §12
}
type InputValue = string | number | bigint | boolean | null | Out<string>
  | readonly InputValue[] | { readonly [k: string]: InputValue };
```

Structured values per input kind: a dynamic combo is its option key or `{ option, inputs }`; an
Autogrow a slot list (prefix form) or a record by slot name; a DynamicGroup a list of row records.

**Flattening is the API exporter's job; un-flattening is the importer's.** It is **schema-driven**:
851 ordinary inputs in the real dump already have dots in their names (e.g. ModelMergeSD1
`"input_blocks.0."`), so splitting on `.` would be wrong. The backend's own parser walks the
schema too. The exporter reports a diagnostic if a flattened dynamic key would collide with an
ordinary input name.

### 5.4 Diagnostics

```ts
interface Diagnostic {
  readonly code: DiagnosticCode;                 // stable: "E_…" for errors, "W_…" for warnings
  readonly severity: "error" | "warning";        // fixed per code, matches the prefix
  readonly path: readonly (string | number)[];   // segments into the document the diagnostic is about
  readonly message: string;                      // for humans; the wording may change, the code doesn't
}
```

- **One model everywhere** (D14). The parser, normalizer, exporter, validator and codegen all
  return this type. It lives in `core/src/diagnostic/`.
- **Path roots.** Normalizer paths point into the raw `/object_info` document, e.g.
  `["KSampler", "input", "required", "seed", 1, "max"]`. Export paths point into the prompt, by
  node id and wire key, e.g. `["5", "inputs", "format.codec"]`. Parse errors have an empty path
  and give the position in the message. Keys are strings and array indexes are numbers, so a
  dotted name is always one segment.
- **Severity.** `error`: the item was dropped, or the backend would reject the result. `warning`:
  the item was kept but degraded (`UnknownInput`) or can't be verified (an upload combo). A check
  that can end either way gets two codes.
- **Registry.** `DiagnosticCode` is a literal union backed by one registry (code → severity). Each
  code has one negative test and an entry in `docs/diagnostics.md`; a test keeps the registry and
  that document in sync.

## 6. Generated types

Everything in this section was prototyped against the real 1,758-node dump. **[verified]**

### 6.1 Generated files

`tscomfy generate --url http://127.0.0.1:8188 --out src/comfy/local` writes:

```
src/comfy/local/
  object_info.json   # raw snapshot: offline regeneration (--from), drift diffs. Never imported.
  nodes.ts           # types only: interface Nodes + input interfaces + combo aliases
  index.ts           # export const local: TypedSchema<Nodes> = defineSchema<Nodes>('…')
  tscomfy.json       # manifest, written last: codegen version, schema hash, options, content hash per file
```

Every file starts with a header: generator version, schema hash (`hashSchema`, D15), ComfyUI version, the command to regenerate.
`codegen.generate(schema, { exportName, importExtension?, command? })` returns both files as data;
`index.ts` imports `./nodes.js` by default, which resolves under `nodenext` and `bundler` without extra flags.

### 6.2 Encoding

```ts
declare const socket: unique symbol;
interface Out<T extends string> { readonly [socket]: T; readonly node: NodeId; readonly slot: number }
type In<T extends string> = Out<T | "*">;     // what a socket of type T accepts
```

| Schema | TypeScript |
|---|---|
| socket `MODEL` | `In<"MODEL">` (an any-typed `Out<"*">` fits) |
| socket `IMAGE,MASK` | `In<ImageTypes>`, with a shared alias `ImageTypes = "IMAGE" \| "MASK"`; a `*` member is left out (`*,IMAGE` is `In<"IMAGE">`, §5.2) |
| socket exactly `COMBO` | `In<"COMBO"> \| Out<OptionList>` |
| socket `*` | `Out<string>` |
| INT | `number \| bigint \| In<"INT">` (a widget also takes a link). Never a list: the backend's `int()` rejects one, and list defaults are dropped |
| FLOAT / STRING / BOOLEAN | `number` / `string` / `boolean`, each `\| In<…>` |
| `forceInput` widget | link only |
| combo | literal union alias, plus a link: `\| In<type>` for the `COMBO` form, `\| Out<"*">` for a legacy `[[…]]` combo (its links must match its whole list, §5.2). Identical option lists are **deduplicated into named aliases** (`SamplerName`, `CkptName`) |
| multiselect combo | `readonly (Alias)[]` |
| upload or remote combo | `Alias \| (string & {})`: the options are runtime state (input folder contents), so this keeps autocomplete without false errors |
| empty combo (36–55 in the dump) | `string`, plus a codegen diagnostic |
| value widget (COLOR, BOUNDING_BOX, CURVE, …; D16) | `JsonValue`, `\| In<type>` unless socketless |
| input with an explicit schema default | optional (`?:`); the exporter fills it in |
| Autogrow, prefix form | `Bounded<readonly [T, …, ...T[]], Length1To4>`: the first `min` slots required (at most the slot count), at most as many slots as exist. The backend requires the minimum even when the Autogrow is optional. MatchType slots: the first infers the template, the rest use `Match<NoInfer<T>>` |
| Autogrow, names form | an interface `{ readonly a: T; readonly b?: T }` (first `min` names required) |
| DynamicCombo | a union of option interfaces `{ option: "mp4"; inputs: {…} }`, plus the bare `"flac"` key for each option whose inputs may all be left out. Recursive (§6.4) |
| DynamicGroup | a row interface, bounded like Autogrow slots: `min` to `max` rows, even when the group is optional |
| output | `Out<"T">`; a union `Out<Alias>`; exactly `*` `Out<"*">`; an option list `Out<OptionList>`; a comma list with `*` its other members, a padded `*` `Out<string>` (§5.2) |
| node without inputs | `{ readonly [key: string]: never }`, so any key is an error (`{}` would accept anything) |
| MatchType | generic node function (§6.3) |
| unknown spec | `unknown`, plus a codegen diagnostic |

**Node access** is one interface of function-typed properties, keyed by exact `class_type`.
There are **no mapped types**, which keeps type-checking cheap:

```ts
export interface Nodes {
  /** KSampler · sampling — Uses the provided model, positive and negative conditioning to denoise… */
  readonly KSampler: (inputs: KSampler$In, options?: NodeOptions) => Out<"LATENT">;
  readonly "Context (rgthree)": (inputs: …, options?: NodeOptions) => …;   // bracket access
}
```

Return shapes:
- **0 outputs**: `NodeHandle` (`{ id }`).
- **1 output**: the `Out<T>` itself, so `vae: n.VAELoader({…})` works.
- **More**: `X$Out`, an interface extending the tuple `X$Outputs` and `NodeHandle` with one member
  per unique output name, so both `const [model, clip, vae] = …` and `ckpt.CLIP` work.
- Output names are left out of the aliases (reachable by index only) when they are duplicated, reserved
  (`id`, `node`, `slot`, Array members like `length` and `map`) or numeric-like.

**JSDoc** comes from tooltip, default, min/max/step, display name, category and description.

**Naming.** Node declarations are `<Class>$In`, `<Class>$Out`, `<Class>$Outputs`, and
`<Class>$<Input>…` for nested ones (dynamic-combo options, Autogrow slot sets, DynamicGroup rows),
unique per node. Shared aliases have no `$` (`SamplerName`, `ImageTypes`), so they can't clash
with node declarations; type parameters are `T<Template>` and avoid every alias name. Generic
helper declarations take only the type parameters they actually use.
Deprecated nodes get `@deprecated`, which editors show as strikethrough.

### 6.3 MatchType

Inputs and outputs that share a `template_id` share one type parameter:
- The **first** input of each template (in input order) is where `T` is inferred: `Out<T | "*">`.
- Later inputs check against it: `Out<Match<NoInfer<T>>>`, where `Match<T> = "*" extends T ? string : T | "*"`.
- `T` defaults to the template's allowed types (`"*"` when unrestricted).

Results **[verified]**:
- Equal branches pass.
- **Mismatched branches fail at the call.**
- An any-typed branch passes.
- When `T` can't be inferred it is `"*"` and connects anywhere.

Limits, both sound because the backend skips type checks for MatchType: if the inferring input is
left out, the others fall back to the default and accept anything; and runtime validation (§8)
checks template consistency in full.
- An `IMAGE,MASK` template rejects `LATENT`, and the output keeps the narrowed type.

### 6.4 DynamicCombo shape (D18)

```ts
n.SaveVideo({ video, format: { option: "mp4", inputs: { codec: { option: "h264", inputs: { encoding: "auto" } } } } });
n.SaveAudioAdvanced({ audio, format: "flac" });                         // option with no inputs
```

Why this shape and not the alternatives, based on the real dump:
- **Flattening option inputs into the node's inputs (comfy-ts style) is unsafe.** `SaveVideo` has both
  a top-level `codec` and `format.codec`; they would collide.
- **Nesting is common and deep**: 189 dynamic inputs sit inside dynamic-combo options
  (`format → codec → encoding`, plus Autogrow and MatchType inside options). The shape has to be recursive.
- **`{ option, inputs }` can't collide** with any input name. A `{ option, ...childInputs }` shape could;
  no input is named `option` today, but nothing prevents it.
- **111 of 608 options have no inputs**, so the bare-string shorthand covers a common case.
- TS 7 gives precise errors on nested branches (`"h265"` is not assignable to `"auto" | "av1" | "h264"`).

On the wire this becomes `format`, `format.codec`, `format.codec.encoding`, which matches the
frontend and the backend's recursive expander.

### 6.5 Combo strictness (D19)

**Strict by default.** The types reflect the server they were generated from, and `tscomfy check`
catches drift. There are two principled exceptions, both in the encoding table, rather than a
global loosening:
1. Upload and remote combos: their options are runtime state, not schema.
2. Empty combos: they carry no information to be strict about.

An earlier draft offered `--combos loose-files` for projects that target several servers with
different model sets. It isn't provided: loosened types would compile values that validation
against the generating server then rejects, which breaks the soundness ordering (§1). Such
projects generate one schema per server (`src/comfy/<server>`, D8) and build each workflow for
the server it runs on.

### 6.6 Type-checking speed

TS 7.0.2 with the full strict config, a 20-node workflow over the generated types **[verified]**:

| Nodes in schema | Total | Memory |
|---|---|---|
| 1,758 (the real dump, no workflow) | 0.11 s | 91 MB |
| 1,758 (synthetic) | 0.11 s | 62 MB |
| 3,516 (synthetic) | 0.20 s | 109 MB |
| 7,032 (synthetic) | 0.40 s | 203 MB |

`bun run bench:types` (internal/bench) builds the synthetic schemas from the mocks, with distinct
combo options per copy so aliases don't all deduplicate away, and fails over the budget:
**≤ 0.5 s total and ≤ 300 MB at 7k nodes**. The Phase 0 spike measured 0.26 s at 7k on a lighter
encoding; the margin is smaller now and the budget is what guards it.

## 7. Builder API

```ts
import { workflow, toApi, stringify } from "@tscomfy/core";
import { local } from "./comfy/local/index.ts";

export function txt2img(p: { prompt: string; seed: bigint; steps?: number }) {
  return workflow(local, ({ n }) => {
    const [model, clip, vae] = n.CheckpointLoaderSimple({ ckpt_name: "sdxl_base.safetensors" });
    const latent = n.KSampler({
      model,
      positive: n.CLIPTextEncode({ clip, text: p.prompt }),
      negative: n.CLIPTextEncode({ clip, text: "" }),
      latent_image: n.EmptyLatentImage({ width: 1024, height: 1024 }),
      seed: p.seed, steps: p.steps ?? 30, sampler_name: "euler", scheduler: "normal",
    });
    n.SaveImage({ images: n.VAEDecode({ samples: latent, vae }), filename_prefix: "out" }, { title: "Result" });
  });
}

const body = stringify(toApi(txt2img({ prompt: "a cat", seed: 42n })));   // POST /prompt as { prompt: … }
```

### 7.1 Principles

- **No global state.** The builder context (`{ n, raw }`) is a parameter, so nested and concurrent builds are safe.
- **Object arguments.** The second argument holds node options: `{ id?, title?, mode? }` (§12).
- **Templates are plain TS functions** (above). There is no template DSL and no `ParamRef` in the IR:
  re-running the builder is cheap, and plain parameters give the best types.
- **Composition is plain functions** taking `n` and refs. `toUi` writes them flat; exporting them as UI subgraphs is not supported (§11).
- **Escape hatch**: `raw(classType, inputs, options?)` from the context. It is untyped and kept separate
  from `n`, so no `class_type` can collide with it. Its inputs are wire keys and are exported as
  given, without defaults or flattening; `raw(…).output(slot)` is an `Out<"*">`, which fits any
  socket. Validation checks raw nodes like any other (§8): an unknown class is an error.
- **Results** follow the generated types exactly: the rule for which outputs are also reachable by
  name (`namedOutputs`) lives in core and serves both codegen and the builder. Results and output
  references are frozen; references are instances only the builder creates.
- **Misuse throws** a `TypeError`: an empty or taken explicit id, a node added after the build
  function returned (or threw), an async build function, an input value that is neither JSON nor
  an output reference, an output reference from another workflow (it would link to whatever has
  that id here), a sparse array, a raw output slot that isn't an index, a mode other than `"bypass"` or `"mute"`. `n` is read-only.

### 7.2 Defaults policy

- **Fill explicit schema defaults** for every widget input, required or optional, recursively including
  dynamic-combo branches and DynamicGroup row fields (the backend injects none into rows, and the
  types make row fields with a default optional). This matches the frontend, which sends every
  widget value.
- **Never invent implicit defaults.** The frontend falls back to `0`, `""`, `false` or the first combo
  option; we don't, so those inputs stay **required** in the types. Explicit beats a silently chosen first checkpoint.
- **Where the frontend overrides the schema's default, we do what it does.** The normalizer stores
  the frontend's initial value as `default` (1.55.17 composables), so the exporter, codegen's
  optionality and its JSDoc all follow one rule:
  - a combo the frontend draws as a multi-select (`multi_select` and the backend's `multiselect`
    both set, as V3 multi-selects do) starts as `[]`;
  - a combo with a falsy default (`0`, `""`, `false`) starts at its first option;
  - IMAGECOMPARE starts at `["", ""]`, GALLERIA at the spec's `images`, CHART at its `data`.
- **Inputs named after `Object` members are required** (`constructor`, `toString`, `valueOf`, …):
  TypeScript checks an optional property against the member every object literal has
  (`constructor: Function`), so leaving one out would not compile. Stricter, and found by the
  transpile fuzzer.
- **A DynamicGroup row must send a key.** The backend counts a row only when one of its keys is
  present, so when no field of a row is required or has a default, the types require the first
  field: `[{}]` would otherwise compile and send no row.
- **Display-only widgets** (RESOLUTION_PREVIEW, IMAGEUPLOAD: `options.serialize === false`) are
  never sent, and codegen leaves them out of the input types.

### 7.3 Node ids

- Strings, sequential (`"1"`, `"2"`, …) or set explicitly.
- Links are emitted as `[id, slot]` with a string id; the backend's `is_link` requires that.
- Ids of expanded subgraph nodes (§11) follow the frontend's `parent:child` form.

### 7.4 Parity with the frontend's API output

Researched in frontend 1.55.17 (the version the corpus came from) and backend 0.41 `execution.py`.

| Rule | What we do |
|---|---|
| Every widget value is sent; unconnected socket-only inputs are left out | Same for every widget with a value or a default. **An optional widget without a default is left out**, and so is an optional dynamic combo not given: the frontend sends `0`, `""`, `false`, the first option or the first key. We never invent values (§7.2), and the frontend's `0` can even fall outside `min` |
| A combo with `multi_select` but not the backend's `multiselect` is a multi-select widget, which sends a list the backend then rejects | **We follow the backend**: a single value |
| Key order: each node is `inputs`, `class_type`, `_meta`. Inside `inputs`: every widget in widget order (a linked widget keeps its widget's position), a dynamic combo's option widgets right after it, depth-first; then connected socket-only inputs in input order (Autogrow slots in slot order); then a dynamic combo's option sockets | Same, so `stringify` reproduces an export byte for byte. Confirmed in `executionUtil.ts`, `litegraphService.ts` and `dynamicWidgets.ts` (1.55.17), and on every node of a corpus export |
| A CURVE value is sent as `{"__type__": "CURVE", "__value__": …}` | Same |
| A list-valued widget is sent as `{"__value__": [...]}`, because the backend reads a bare list as a link | Same; the importer unwraps it |
| `_meta.title` is always present (title, or display name) | Same (`toApi({ meta: false })` turns it off) |
| control_after_generate is never sent (its widget has `serialize: false`) | Same. The builder has no controls (seeds are plain values); the schema keeps `control` for the UI format (§11) |
| Autogrow sends connected slots only (`images.image0`, …) | Same |
| DynamicGroup keys are `group.<row>.<field>` | Same keys, as the backend parses them. Frontend 1.55.17 has no DynamicGroup handler at all, so there is nothing to match there; rows go at the group's widget position, as newer frontends place them |
| **The frontend resolves `{a\|b}` dynamic prompts and strips `/* */` and `//` comments** in `dynamicPrompts` STRING inputs, so `http://` gets truncated | **We don't** (determinism, fidelity). Documented in `docs/guides/building-workflows.md`. |
| **The frontend substitutes `%…%`** in save-node `filename_prefix` values when it queues | **The builder doesn't**; the text is sent verbatim. `importUi`, which reproduces what the frontend would queue for a saved file, replaces `%Node.widget%` (§11). Documented |

### 7.5 Serialization

- `toApi()` returns a plain `ApiPrompt` object, which may hold `bigint`. It throws a
  `ValidationError` carrying every diagnostic when the prompt can't be built faithfully: so far a
  flattened key that collides with another input (`E_INPUT_KEY_COLLISION`), or more Autogrow
  slots or group rows than exist (`E_TOO_MANY_DYNAMIC_INPUTS`, which the types already prevent).
  `exportApi()` returns the prompt and the diagnostics without throwing. An output reference
  nested inside a JSON value (not a whole input, slot or field) throws a `TypeError`. `toApi`
  also validates by default (§8).
- `stringify()` is our own deterministic serializer: keys in JavaScript's enumeration order, as
  `JSON.stringify` and the frontend use (integer-like keys such as node ids `"1"`, `"10"` first in
  numeric order, then insertion order; every object we build has a fixed construction order,
  which §7.4 needs), bigint as a JSON number. An integer-valued number beyond 2⁵³ is written in
  exponent form, so it reads back as the same number rather than as a bigint (§16).
- `parse()` reads `NaN`, `Infinity` and `-Infinity`, which Python servers write for non-finite
  floats (`/object_info` goes through `json.dumps`), and literals beyond the double range, as
  `null` with `W_NON_FINITE_NUMBER`, so one such value can't invalidate a whole dump.
- `parse()` keeps big integers through `JSON.parse` source-text access: an integer literal beyond
  2⁵³ becomes a bigint wherever it occurs, and each consumer decides per field (§9). On runtimes
  without source-text access, such literals produce `W_PRECISION_LOSS`. Invalid JSON is a
  diagnostic (`E_INVALID_JSON`), not a throw.

## 8. Validation

`validateApi(prompt, schema): Diagnostic[]` checks an API-format prompt the way the backend does,
and `validate(workflow)` checks what `toApi` would send. `toApi(wf, { validate })` validates by
default and throws one `ValidationError` carrying every diagnostic when there is an error;
`validate: false` skips validation (problems building the prompt itself still throw).
`exportApi` returns the prompt with every diagnostic, warnings included: a pure library has
nowhere to send a warning, so there is no warning level to configure (D21).

**On the wire.** Validation runs on the prompt, keyed by wire keys, because that is what the
backend validates. Dynamic inputs are expanded as `get_finalized_class_inputs` expands them
(backend `comfy_api/latest/_io.py`): an Autogrow's slots before `min` are required when its
template is, even in an optional Autogrow; a dynamic combo's chosen option adds its inputs (an
unknown key makes the backend drop the input silently); DynamicGroup keys are
`<group>.<row>.<field>` with decimal rows below `max` and no leading zeros, rows may have gaps,
and the present rows count against `min`. Each position is then checked as `validate_inputs`
(`execution.py`) checks it: links by `accepts`, values after unwrapping `__value__` and after
the backend's `int()` truncation for bounds. `raw()` nodes are validated like any other.

**Severity follows the soundness ordering.** A check is an error when the generated types reject
the same thing, or when the types can't express it and the backend rejects it (bounds, unknown
classes, cycles, a prompt with no output node). Where the types accept a value the backend still
takes, it is a warning: a fractional INT (`number` in the types; the backend truncates it), a value
outside an upload, remote or empty combo's options (`Alias | (string & {})`). MatchType follows
the types too: a template is inferred at one position, the one codegen's `#matchAtom` picks (the
template's first position in declaration order, depth-first through every dynamic-combo option,
and slot 0 of an Autogrow). Only once that position is linked to a typed output must the others
agree, and a MatchType output has that type, or `*` while the position is empty, as the type
parameter's default does. A FLOAT also takes an integer literal beyond 2^53 (a bigint), which
`float()` reads; `int()` truncation applies only to inputs typed exactly `INT`.
`packages/codegen/test/soundness.test.ts` checks the first half of the ordering with typed
workflows over the generated fixtures (and `@ts-expect-error` for what both refuse); the corpus
API workflows, exported by the frontend, validate without an error.

**Checks** (codes in docs/diagnostics.md):
- unknown class type (the backend rejects the whole prompt) and no output node
- **unknown input**: stricter than the backend, which silently ignores unknown values but still
  follows unknown *links*
- missing required input
- malformed links, dangling links (node or slot), socket compatibility (`accepts`, with MatchType
  outputs resolved to their template's type), a value where only a link fits
- MatchType: allowed types, consistency
- value kinds; combo membership (an error, or a warning for upload, remote and empty combos;
  multi-selects element-wise); int/float coercion, min/max (bigint-aware)
- Autogrow minimum, DynamicCombo option exists, DynamicGroup keys and row count
- flattened-key collisions (the exporter) and cycles

Not checked, because no schema says: what a node's own `VALIDATE_INPUTS` accepts (the backend
then skips its built-in checks for those inputs; `LoadImage` takes annotated file names this
way), and `step`, which the backend ignores.

Diagnostic codes are stable string constants (`E_UNKNOWN_INPUT`, …). Each code gets one negative test and a doc entry.
The diagnostic model is §5.4.

## 9. Codegen

- **Normalizer** (core): lenient per field. One bad node or spec yields a diagnostic and an `UnknownInput`,
  never a crash. It covers:
  - legacy and v2 combos
  - every V3 dynamic type (including `output_matchtypes` and `input_order`)
  - hidden inputs, whose specs can be strange (`"STRING,[object Object]"` occurs in the dump)

  Further rules:
  - The input is raw text (D10), parsed with `parse`.
  - Bounds arrive as bigint when they are integer literals beyond 2⁵³. INT bounds keep the bigint.
    FLOAT bounds (19 in the dump, e.g. `max: 18446744073709551615`) become numbers rounded
    **inward** (max down, min up). The backend compares exactly, so a value we accept stays
    within its bound.
  - Widget or socket follows the frontend (D16). `forceInput` makes a widget a socket, except
    for legacy combos: a COMBO socket would not express their exact-list link rule (§5.2), and
    the backend accepts constants for them anyway. Autogrow templates are always sockets, as the
    backend forces them.
  - Input order is the frontend's (`getOrderedInputSpecs`): the required inputs `input_order`
    lists, then the optional ones it lists, then all others. A name in both sections keeps the
    required one, as the backend does.
  - `TYPE:name` input types (`INT:seed`, 3 inputs in the dump) are sockets of that exact type.
    The frontend has no widget for them, and the backend neither coerces them nor links them to
    `INT` (§16).
  - `null` means unset: Python servers send `None` for `display_name` (223 V3 nodes),
    `output_is_list` entries, defaults and tooltips. No diagnostic.
  - A default the backend would reject (not one of the combo's options, outside `min`/`max`
    after inward rounding, the wrong type, a list for INT or FLOAT) is dropped with `W_INVALID_INPUT_OPTION`, because the
    exporter fills defaults in (§7.2). A combo with no listed options (remote, upload, an empty
    folder) keeps its default: membership can't be checked offline.
  - A legacy combo option that isn't a string, number or boolean makes the input unknown, since
    its links match the full list; in the `COMBO` form, or in an output list, the option is
    dropped or the node is, respectively.
  - Missing Autogrow and DynamicGroup counts take the backend's defaults (prefix: min 1, max 10,
    at most 100 slots; group: min 0, max 20). Counts outside those limits, which the backend's
    constructors rule out, make the input unknown. So does a DynamicGroup whose fields aren't
    all widgets the backend allows there (no sockets, `forceInput`, dynamic inputs or dotted
    names), or that has no field it sends.
  - Without source-text access (`W_PRECISION_LOSS`), integer-valued bounds beyond 2⁵³ move
    inward by one double, which covers any rounding.
  - Nodes are sorted by class type (D15).
- **emitTypes** (codegen): builds documents for a small Wadler-style printer (`codegen/src/doc.ts`)
  with Prettier's group/indent/line/ifBreak/indentIfBreak semantics, at 100 columns measured as
  display width (East Asian wide characters and emoji count two). It follows oxfmt's choices:
  quotes that need fewer escapes, unquoted Unicode identifier keys, assignments that break after
  `=` only when the right side's head doesn't fit, breakable type arguments and `extends` lists.
  Output is deterministic and exactly what oxfmt produces: the committed mock fixtures pass
  `format:check`, `format.test.ts` runs crafted hostile and long names through oxfmt and `tsc`, and
  the corpus test feeds the real dump's output through oxfmt and expects no change.
  Server text in comments is split at every line terminator and has `*/` escaped, and header
  lines (ComfyUI version, command) are flattened to one line, so no name can inject code. To keep the layout rules few,
  every type expression is a union of short atoms; anything bigger gets a named declaration
  (§6.2). Generated files are excluded from linting. Identifiers:
  - derived from input names, sanitized
  - de-duplicated with stable suffixes
  - **328 class names in the dump are not valid identifiers**; they stay as quoted keys
  - diagnostics: `W_EMPTY_COMBO`, `W_UNTYPED_INPUT` (docs/diagnostics.md)
- **CLI** (`packages/cli`, the only I/O; commands take an injected `Io`, so tests run without a
  disk or network):
  - `generate (--url <server> | --from <file>) --out <dir>` writes `nodes.ts`, `index.ts`,
    `object_info.json` (the raw response, byte for byte) and last the `tscomfy.json` manifest
    (§6.1). Each file is replaced in one step (a temporary file, then a rename). The snapshot
    lets `--from` regenerate offline and gives `check` its baseline. With `--url` it GETs
    `/object_info` and `/system_stats` (for `comfyui_version`; optional) under the URL's path,
    keeping its query, and nothing else. Credentials and the query (where servers put tokens)
    are sent but never shown or written. The headers record the schema hash and the command
    that regenerates the files, for a POSIX shell in the directory generate ran in; values with
    control characters or line separators are refused, and a server version with one isn't
    recorded. Names and versions from the server are printed with every character a terminal
    acts on (controls, bidirectional marks) escaped. A response with no usable node (not JSON, not an object,
    an error body such as `{"detail": …}`, or `{}`) is fatal: exit 1, nothing written, so it
    can't replace good types. Anything less is reported and generated (exit 0).
  - `check (--url | --from) --out <dir>` normalizes the server and the snapshot and diffs them
    (`diffSchemas` in core; empty exactly when `hashSchema` is equal, D15), so differences in
    fields the schema doesn't keep don't count. Option changes of upload and remote combos are
    runtime state (§6.2), not drift: they are mentioned and ignored. It also checks every file
    against the manifest (exactly its three files, by content hash; its codegen version; its
    schema hash, which another core would compute differently), which catches edited, truncated,
    missing or half-written files and output of another version. It exits 1 on
    any of these and suggests `generate` with the checked source and the recorded options.
  - Exit codes: 0 on success, 1 on a failure or drift, 2 on a usage error (with the usage).
  - `-h`/`--help`, `-v`/`--version` and `help <command>`. A value starting with `-` is given and
    recorded as `--flag=value`. A body that holds only `detail`, `error` or `message` is reported
    as an error response. The manifest records the ComfyUI version whenever it is known, and
    `--from` the recorded snapshot keeps it. `check` lists at most 10 names and 5 options per list
    unless `--verbose`. Default export names follow one camelCase rule (`camelName`).
- **Report**: counts plus diagnostics grouped by node pack (`python_module`; the dump has 203
  packs), 5 per pack unless `--verbose`. `--quiet` prints errors only, to stderr.

## 10. Transpiler (API JSON → TS)

**Import.** `importApi(text, schema) → { workflow, diagnostics }` (core) is the exporter in
reverse. It takes raw text (D10). Nodes keep their ids; a title is kept only when it differs from
the display name the exporter writes. Wire keys are folded back by the schema, mirroring the
exporter: dynamic-combo options into `{ option, inputs }` (or the bare key), Autogrow slots into a
list when they are the first ones in order (else by slot name), DynamicGroup keys into rows,
`{"__value__": [...]}` into the list and CURVE's `{"__type__", "__value__"}` into its value. A
node of an unknown class, or one whose keys don't fold back (rows missing in between or at or past
the group's `max`, keys under a dynamic combo's unknown option, a key two inputs would send, a
display-only widget's key), is kept as a raw node with its wire keys (`W_IMPORTED_AS_RAW`), so it
still exports as it came. Hostile input (an empty id, a row index of 2^32) is reported, never
thrown. Keys the schema doesn't know pass through for validation to
report. An internal `assembleWorkflow` builds the graph, so links may point forward.

**Transpile.** `transpile(workflow, { name, schemaModule, schemaName, inline?, header? }) → { code,
diagnostics }` (codegen) writes an ES module exporting `const <name>: Workflow<NodesOf<typeof
<schema>>> = workflow(<schema>, ({ n, raw }) => { … })`:
- Dependency order, ties broken by graph order (a heap; linear name claims, so 40,000-node
  chains and fans take well under a second); nodes on a cycle, and nodes that depend on one, are
  reported apart and left out. Problems the exporter reports are passed on.
- Variables named after outputs (`latent`, `conditioning2`) for single outputs, destructured by
  output name for several, after the class for raw nodes; de-duplicated with numeric suffixes.
- A single-output node used once is inlined into its use, unless it inlines another itself, so
  nesting stays one level deep (`inline: false` turns it off).
- Ids and titles are kept as `{ id, title }`; values equal to their default are left out at every
  level (the exporter fills them back in).
- A node becomes `n.Class(…)` only when the generated types accept its inputs, decided by the
  rules `emit-types.ts` writes them with (link atoms per output, `#link`, legacy combos taking
  `*`, socketless widgets, MatchType's inferring position and parameter defaults, Autogrow and
  DynamicGroup bounds, the forced row field). Anything else becomes `raw(…)` with its wire keys
  and `W_TRANSPILED_AS_RAW`; unknown classes are raw without a warning. Nodes are decided in
  dependency order, so a source written as `raw(…)` counts as `Out<"*">` downstream, as it is.
- Layout follows oxfmt's (Prettier's) rules: calls with two object arguments, objects, keys
  narrower than five columns never breaking after `:`, arrays of multi-element objects or arrays
  always breaking, number arrays filled, exponents without `+`, `["__proto__"]` keys, destructuring
  only while the pattern fits its line, and the declaration hugging the build function, moving
  below `=`, or breaking its arguments as Prettier would. The committed transpiled mock prompts
  pass `format:check` and `tsc -b`; `transpile-fuzz.test.ts` runs crafted cases and 300 seeded
  random workflows through oxfmt, `tsc` and back through the exporter.

CLI: `tscomfy transpile (--prompt <file> | --workflow <file>) --schema <dir> [--out <file>]
[--name] [--no-inline]`, for an API prompt or a UI workflow (read with `importUi`, §11),
importing the schema relative to the output, with the import extension the manifest records. It
refuses types generated by another version (the manifest's codegen version and schema hash), a
file of the other kind or a `POST /prompt` body, a file with no readable node, and export names that
`exportNameProblem` or `transpileNameProblem` refuse: one rule shared with `generate`, which
refuses the names the module uses itself (`workflow`, `Workflow`, `NodesOf`, `n`, `raw`) too.

**Round-trip guarantee**: `stringify(toApi(importApi(x, schema).workflow))` equals
`stringify(parse(x).value)`, and
running the transpiled module and exporting gives the same bytes, for prompts as the frontend
writes them (every node with `_meta`, every widget value present, the frontend's key order): every
mock prompt and every corpus API workflow. Other prompts come back normalized: defaults filled in,
`_meta` added (unless `meta: false`), keys in the frontend's order. Ids that aren't integers may
also come back in another order after transpiling, since creation order follows dependencies.

## 11. UI format

`core/src/ui/` reads and writes the JSON the frontend saves (D17, ADR-0017). The frontend
behavior it follows is in `docs/research/ui-format.md`, read in frontend 1.55.17 and checked
with probes in the frontend itself.

**The frontend's node.** `frontend/node.ts` rebuilds a node as the frontend creates it from its
definition, the one model both directions and the exporter's modes (§12) share. Its registry
(`frontend/widgets.ts`) holds the core widgets and those the frontend's core extensions register
(AUDIO_RECORD, AUDIO_UI, AUDIOUPLOAD, CAMERA_ANGLE_VIEW, CAMERA_INFO_STATE, LOAD_3D,
LOAD_3D_ADVANCED, PREVIEW_3D, WEBCAM), each with whether the frontend saves its value and whether
it sends it, sends nothing, or computes the value when it queues. The exporter, the importers and
codegen ask one predicate (`sendsInputValue`) whether an input's value is sent:
- **Widgets**, in input order, the order `widgets_values` lists them: a value widget per input;
  after an INT or FLOAT with `control_after_generate` (on by default for INT inputs named `seed`
  or `noise_seed`; an explicit `false` turns it off) a control widget, named after the option
  when it is a string; after a combo with one, a control and a `control_filter_list`; a dynamic
  combo followed by the chosen option's widgets, depth-first; then the `upload` button the
  upload extensions add (for the first required combo that uploads images or videos, or a
  required `audio` combo that uploads audio); the inputs and buttons core extensions add
  (3D previews, audio players, the Load3D buttons, a remote combo's refresh toggle and button);
  names an earlier widget has are made unique (`width#1`), as the frontend does.
  IMAGECOMPARE, RESOLUTION_PREVIEW, AUDIO_UI and CAMERA_INFO_STATE aren't saved; values the
  extensions compute at queue time (a 3D scene, a webcam frame, a recording) are reported
  (`W_QUEUE_TIME_VALUE`); widgets JavaScript builds from nothing in the definition
  (CustomCombo's) are reported as `W_EXTENSION_WIDGETS`. The schema keeps what this needs:
  `control` on INT, FLOAT and COMBO inputs, `uploads` and `refreshButton` on combos.
- **Slots**, the order links target: sockets in input order (`forceInput` legacy combos,
  MatchType inputs and Autogrow slots among them), then widget slots, `socketless` ones
  included (frontend 1.55.17 ignores the flag); a chosen option's slots right after its combo's.

**Import** (`importUi(text, schema)`): `toApi` of the result is the frontend's prompt.
- **Versions.** Format 0.4 has tuple links; anything else, object links. Tuple links outside
  0.4 are dropped, as the frontend drops them.
- **Node ids** are strings, as in the frontend (`4` and `"4"` are one node). At the root a node
  whose id one added before it holds gets the next free number after the counter, in file order
  (so a later node whose own id that took is reminted in turn); links follow a reminted node when
  no other node asked for its id. Inside a definition the later node is dropped.
- **Links** come from the `links` array; an `inputs[].link` missing from it connects nothing.
  Links competing for one slot keep the first, unless only a later one is referenced by an input
  (`normalizeConfiguredTopology`). Each lands on its `target_slot` of the node as created (every
  dynamic combo on its first option, whose inputs come before the combo's slot), then the chosen
  options are rebuilt, dropping links on slots they lack, and a link that a saved input of its own
  target names moves to the slot of that name (`realignInputLinkSlots`, with its blocking rules).
- **Widget values** by position over the layout above, as the frontend restores them, settling
  afresh each pass as dynamic-combo options add widgets, after dropping the placeholders files
  from before frontend 1.16 saved for `forceInput` inputs (`migrateWidgetsValues`). When the
  positions don't fit the layout (pack widgets the schema can't predict) and names are saved
  (`widgets_values_named`, or `widgets_values` as an object, as VHS saves it), by name. Values by
  name that disagree with the positions are reported. Widgets without a value keep their initial
  one. Fixups on load: a combo saved as `null` takes its first option; KSampler's old `sample_`
  sampler names lose the prefix.
- **Frontend-only nodes.** Reroutes are resolved through (a muted one passes nothing on, a
  bypassed one passes no type). A PrimitiveNode writes its value into every widget it links to,
  whatever its mode, after `%…%` replacement when its property says so. Notes and MarkdownNotes
  are dropped.
- **File names.** Save nodes' `filename_prefix` has `%Node.widget%` replaced as the frontend
  replaces it (the node found by its `Node name for S&R` property, else its title, the frontend's
  own default titles included, interiors first; any widget, controls too); `%date:…%` is the
  queue time, kept and reported (`W_QUEUE_TIME_VALUE`).
- **Subgraphs** are expanded (one that contains itself makes the frontend refuse the file, and
  imports nothing): inner ids join the instance path with `:` (`40:31:21`); inner ids
  that collide with the root's or an earlier definition's are reminted from `last_node_id`, as
  the frontend does; links across the boundary go through the definition's `-10` and `-20`
  nodes; a promoted input's value is the instance's saved value for it (one per input that
  reaches a widget, in input order), else the interior widget's. Interiors come after their
  instance, in the definition's node order, depth-first; root nodes in the frontend's execution
  order.
- **Modes.** Real nodes keep theirs, for the exporter (§12). A muted or bypassed subgraph
  instance at the root isn't expanded and its outputs resolve by its mode, over its definition's
  inputs. One nested in another still sends its interior (`W_FRONTEND_QUIRK`, ADR-0017). An input
  linked through two instances of one subgraph in a row trips the frontend's loop check, which
  keys steps by definition; it is resolved through both, and reported.
- **Unknown classes** stay raw with their class, links and values by name; unlinked ones are
  left out (`W_NODE_LEFT_OUT`). Legacy group nodes (`extra.groupNodes`) aren't converted
  (`E_LEGACY_GROUP_NODE`). Pack JavaScript that changes the prompt at queue time isn't
  reproduced.
- **Cost.** Resolution is a loop, memoized at the root, and promoted values are computed once per
  definition in dependency order, so long Reroute chains and deep nesting import in linear time
  without recursion.

**Export** (`toUi(workflow, { positions? })`): a flat format 0.4 file the frontend loads to the
same prompt.
- Integer node ids stay; others (`ckpt`, `40:31`) get the next free numbers in graph order, and
  the result maps each id to its number (`ids`).
- Every slot is written, in the frontend's order, with its link; links into inputs a pack's
  JavaScript adds become extra slots typed by their source. Outputs list their links.
- `widgets_values` and `widgets_values_named` hold every saved widget: controls `fixed`, so the
  frontend doesn't change a seed after queueing; a linked widget keeps its initial value.
- A muted node is mode 2, a bypassed one mode 4. The file's `id` is a uuid derived from its
  content, so the output is deterministic.
- Optional widgets left out are sent by the frontend with their initial values, as for a node
  added by hand (a documented exception to "the same prompt", not reported). Reported:
  `W_UI_VALUE_LOST` (DynamicGroup rows, IMAGECOMPARE values), `W_UNKNOWN_UI_CLASS`,
  `W_UNSAFE_INTEGER` (the frontend rounds integers beyond 2^53), `W_QUEUE_TIME_VALUE` (file
  names the frontend rewrites).

**Layout** (`@tscomfy/layout`): `layout(workflow)` places nodes in columns by their longest path
from a source, ordered within a column by their sources' rows (`layered`, iterative, cycles
broken deterministically). Sizes come from `uiNodeSizes`, the sizes `toUi` writes.

## 12. Graph operations

`NodeOptions.mode` is `"bypass"` or `"mute"` (the frontend's other modes, always and the event
modes, aren't modes here). The exporter applies modes to the prompt it builds
(`core/src/api/modes.ts`) as the frontend does in `graphToPrompt` (ComfyUI_frontend 1.55.17
`ExecutableNodeDTO.ts` `resolveInput`/`resolveOutput`/`_getBypassSlotIndex`, LiteGraph
`isValidConnection`, `withComfyMatchType`/`commonType`, read in the installed bundle);
`exportApi({ modes: false })` skips them, for tools such as the transpiler:
- **Neither kind of node is sent.**
- **Mute**: a link from a muted node resolves to nothing.
- **Bypass**: a link from output `slot` of a bypassed node reroutes to one of its inputs:
  1. if the target type is `*` or empty, the input at the same index if there is one, else
     input 0;
  2. the same-index input, if it is valid for both the output's type and the target type;
  3. the first input whose type equals the target type exactly;
  4. the first input valid for both;
  5. otherwise the link resolves to nothing.

  The chosen input is then resolved in turn: an input that isn't linked resolves to nothing,
  and a link continues from its source. The target type of that next step is the type of the
  bypassed node's input (`resolveInput` passes no type on), not the original consumer's.
  Validity is LiteGraph's: `*` and `""` match anything, comparison ignores case, comma lists
  match when any members match. Resolution remembers every step, so many links through a long
  chain resolve in linear time.
- **What resolves to nothing**: the input is left out, unless it is a widget, whose value the
  frontend wrote first and a link would only have replaced: then its value is sent (the default
  the exporter would fill; left out without one). Each case is reported (`W_LINK_DROPPED`); the
  frontend only logs "no input matches". Where the frontend throws instead of building a prompt
  (a bypassed node with no input at all, a cycle of bypassed nodes, a link to an output the node
  doesn't have), the first two resolve to nothing with the warning and the last keeps its link
  for validation to report.
- **Slots** are a node's as the frontend creates it (`litegraphService.ts` `addInputs`,
  `dynamicWidgets.ts`): sockets in input order (inputs without a widget, `forceInput` legacy
  combos, which the normalizer marks `forceInput`, MatchType inputs, Autogrow slots), then the
  sockets of widgets in input order (`socketless` widgets too); a chosen dynamic-combo option's inputs follow the combo's
  own slot, one each in declaration order. Slot types are the declared types (COMBO for legacy
  combos; a widget's `type`, not its `widgetType`). **MatchType narrowing** follows
  `withComfyMatchType`, which runs once a graph is loaded: each input of a template takes the
  `commonType` of the other inputs' links and the allowed types, and the template's outputs the
  `commonType` of all its links (`*` ignored, comma members intersected).
- **Limits**, where the frontend's slots depend on more than the graph: an Autogrow lists the
  slots it is given (the frontend adds one empty slot, and a loaded workflow keeps saved slots in
  the file's order); a node created anew in the frontend lists a dynamic combo's first option
  inputs before the combo's own slot; DynamicGroup fields have no slots (no frontend handler).
- **Prune** (`prune(workflow)`): the output nodes that run, and every node they link to,
  directly or through bypassed and muted nodes, so no kept link points to a node left out.
  Cosmetic, since the backend only runs output nodes and their ancestors.
- **Split per output** (`splitOutputs(workflow)`), as ComfyScript does: one workflow per output
  node that runs, each with what it links to; an output another depends on is in both.

A `forceInput` legacy combo is a socket for the exporter too (sent among the sockets, no default
filled in) and required in the generated types. The transpiler writes modes as node options
(`{ id, mode: "bypass" }`) and raw nodes with their own inputs, before modes apply.

## 13. Repository and tooling

```
tscomfy/
  README.md                # what this is, layout, commands
  AGENTS.md                # working agreements, architecture rules, conventions, gotchas
  CLAUDE.md                # imports AGENTS.md for Claude Code
  LICENSE                  # MIT
  CONTRIBUTING.md          # how-to: scripts, data, common changes
  package.json             # private root: bun workspaces (packages/*, internal/*, examples/*), scripts
  bun.lock                 # text lockfile (Bun default)
  tsconfig.base.json       # shared strict flags
  tsconfig.json            # solution: "files": [], references to every project
  .oxfmtrc.json            # formatter and import sorting; Markdown excluded
  .oxlintrc.json           # linter (type-aware)
  .gitignore               # required: oxlint otherwise walks node_modules symlinks
  packages/                # publishable packages only; folder = unscoped package name
    core/                  # @tscomfy/core
      src/  test/  package.json  tsconfig.json  test/tsconfig.json
    codegen/               # @tscomfy/codegen
    cli/                   # @tscomfy/cli
    layout/                # @tscomfy/layout: positions for toUi
    */README.md  */LICENSE #   what npm shows; src/ ships too, so the maps resolve
  examples/                # txt2img, hires-fix: projects typed by your server; tests generate from the mocks
  internal/                # private workspace packages, never published
    fixtures/              # @tscomfy/fixtures: all test data, typed loaders
      src/index.ts         #   readMockObjectInfo(name), listCorpus(section)
      mocks/object-info/   #   committed hand-written mocks, one theme per file
      mocks/workflows/     #   committed mock API and UI workflows, and the frontend's prompts for the UI ones
      scripts/frontend.ts  #   asks the server's own frontend, in headless Chromium, what it would queue
      corpus/              #   local real data; only its README is committed
    fixtures/src/exec.ts   #   process and scratch-project helpers for tests and scripts
    bench/                 # @tscomfy/bench: bench:types, synthetic schemas from the mocks
    api-report/            # @tscomfy/api-report: docs/api/ from the declarations (D22)
    pack-test/             # @tscomfy/pack-test: test:pack, the published packages as a user installs them
  docs/
    guides/                # user documentation
    api/                   # API-surface reports, generated
    diagnostics.md         # every diagnostic code
    plan.md                # this document
    decisions/             # one short ADR per decision in §3
    research/              # ComfyUI serialization ground truth, UI format, prior-art review
```

**tsconfig.base.json** **[verified]**:
- language and modules: `target`/`lib` es2024, `module nodenext`
- strictness: `strict`, `exactOptionalPropertyTypes`, `noUncheckedIndexedAccess`, `noImplicitOverride`,
  `noPropertyAccessFromIndexSignature`
- syntax and emit: `verbatimModuleSyntax`, `isolatedDeclarations`, `erasableSyntaxOnly`,
  `rewriteRelativeImportExtensions`, `declaration`, `declarationMap`, `sourceMap`
- other: `skipLibCheck`, `types: []`, `customConditions: ["@tscomfy/source"]`

Configs per package:
- **Build** (`tsconfig.json`): `composite`, `rootDir: src`, `outDir: dist`,
  `tsBuildInfoFile: dist/.tsbuildinfo` (so deleting `dist` triggers a rebuild), plus `references`.
  `cli` adds `types: ["node"]` (`@types/node` 24), so its source can't use Bun's APIs.
- **Test** (`test/tsconfig.json`): `noEmit`, non-composite, `incremental`, `types: ["bun"]`,
  **no references**. References in a noEmit config cause TS2878.

**Source-first development** **[verified]**:
- Exports: `{ "@tscomfy/source": "./src/index.ts", "types": "./dist/index.d.ts", "default": "./dist/index.js" }`.
- TS: `customConditions`, so the check config and test configs resolve to `src` with no build.
- Bun: there is no bunfig setting for conditions, so scripts pass `--conditions=@tscomfy/source` (or set `BUN_OPTIONS`).

**Scripts**:
- `build`: `tsc -b`
- `clean`: remove the `dist` directories, `internal/*/tsconfig.tsbuildinfo` and `internal/bench/.out` (tsc never deletes stale outputs)
- `test`: `bun test --conditions=@tscomfy/source`, skipping corpus tests
- `test:corpus`: only the corpus tests (`*.corpus.test.ts`)
- `lint`: `oxlint --type-aware`
- `format`: `oxfmt` (format and sort imports); `format:check`: `oxfmt --check`
- `bench:types`: the type-check budget (§6.6)
- `api:update` / `api:check`: write or check the API-surface reports in `docs/api/` (D22)
- `test:pack`: cleans, builds, packs every package, installs the tarballs offline with npm, runs
  the CLI under Node and Bun and type-checks and runs a consumer; not part of `check`
- `generate:fixtures`: regenerates `packages/codegen/test/generated/` from the mocks
- **`check`**: `tsc -b`, then lint, `format:check`, `api:check` and test

There is no separate fast check config: under TS 7, `tsc -b` is fast enough to be the one type-checking
path, and a second config with Bun types would let library code use Bun APIs undetected (ADR-0004).

**Tests**:
- **Unit**: `bun test` (`*.test.ts`).
- **Type tests**: `*.test-d.ts` with `expect-type` and `@ts-expect-error`, checked by tsc. A stale directive
  is TS2578. `bun test` ignores these files on its own **[verified]**.
- **Codegen fixtures**: the committed output for every mock (`packages/codegen/test/generated/`), compared by `generated.test.ts`; normalizer snapshots (`toMatchSnapshot`).
- **Parity tests**: §7.4 rules, one mock workflow per rule, with the expected API JSON written from the frontend source.
- **Round-trip**: §10, on mock workflows.
- **Corpus tests** (`test/*.corpus.test.ts`, run by `bun run test:corpus`, local only): the same
  normalize, generate, compile and round-trip checks on whatever is in `internal/fixtures/corpus/`.
  `bun run test` and `check` skip them (`--path-ignore-patterns`), so the gate never depends on
  local data. An empty section reports one skipped test. Every phase exit requires them to pass.
- **`accepts` table**: the runtime rows in `core/test/accepts-cases.ts`, and the full input × output
  matrix of the `accepts` mock checked against the generated types (§5.2).

**Lint rules** (oxlint):
- `no-explicit-any`, `no-non-null-assertion`, `import/no-default-export`, `consistent-type-imports`
- type-aware: `no-floating-promises`, `no-unnecessary-condition`, `strict-boolean-expressions`,
  `switch-exhaustiveness-check`, `no-unsafe-*`
- `no-restricted-imports` for `node:*`, `bun` and `bun:*`, scoped to `packages/{core,codegen,layout}/src/**`
- generated files excluded
- `unicorn/no-empty-file` off: tsc and the tests already catch an accidentally empty module

**Fixtures**: a committed mock set plus a local, uncommitted real corpus.

- **Committed mocks** (`internal/fixtures/mocks/`) are small and hand-written: one feature or edge case per file,
  named after what it covers (`dynamic-combo.json`, `names.json`, …).
  - They are written by us, not copied, so they hold no personal data and no upstream text.
  - They stay stable when a server's models change, and a failure points straight at the cause.
  - Their **coverage comes from the real data**. Every fact in §16's dump row gets a mock: dotted
    ordinary names, nested DynamicCombo with a sibling-name collision, both Autogrow forms,
    MatchType inside an option, empty, upload, remote and numeric combos, unsafe-integer maxima,
    list outputs, duplicate output names, class names that aren't identifiers, odd hidden-input specs.
- **Local corpus** (`internal/fixtures/corpus/`, gitignored apart from its README) holds real data. `tscomfy generate --url …` already writes
  `object_info.json`, so populating it is one command against a server. Real workflows go there
  too (the UI's "Export (API)" output).
  - This catches what mocks can't: shapes nobody thought to write down. That gap is how
    comfy-workflows ended up tested against a 24-node hand-picked subset that missed most real-world cases.
- **The rule that connects them**: when a corpus run finds a new shape or failure, it gets distilled
  into a new committed mock (a regression test) before the fix lands. The mocks grow from real
  findings, and the repo never contains anyone's data.
- **Scale**: `bench/` generates synthetic schemas of N nodes from the mock templates, so the speed
  budget (§6.6) doesn't depend on any real dump.

## 14. Phases

Each phase ends with `bun run check` and `bun run test:corpus` passing and a short demo. A phase isn't done while it has known `TODO`s.

**Phase 0: foundation** (done)
- `git init`; the workspace skeleton exactly as in §13; ADRs for §3.
- Write the first mock fixtures (§13 list); fill the local corpus from your server, plus a few
  real workflows exported from the UI.

Exit: empty packages build, lint, format-check and test; mock fixtures are committed; the corpus is gitignored.

**Phase 1: schema and normalizer** (done)
- `json/`: lossless `parse` and deterministic `stringify` (§7.5, D10). They move up from Phases 3
  and 6 because the normalizer reads big integers and `hashSchema` serializes the schema.
- `diagnostic/`: the model, the code registry and `docs/diagnostics.md` (§5.4, D14).
- Research `TYPE:name` input types (§9) first; record the result in §16.
- The `core` Schema model, `SocketType`, `accepts`, and `object-info/normalize` covering every kind
  in §5.1, with the rules in §9.
- Corpus tests that normalize every dump in the corpus.

Exit: every mock node, and every node in the local corpus, either normalizes or yields a precise
diagnostic; `parse` keeps every big integer of every mock and corpus dump, and `stringify(parse(x))`
re-parses to the same value; snapshot tests; the `accepts` table suite.

**Phase 2: type emitter** (done)
- `codegen.emitTypes` and `emitSchemaModule`, using the encoding in §6, which the spike already validated.
- The type surface in core the generated code uses: `Out`, `In`, `Match`, `NodeHandle`,
  `NodeOptions`, `TypedSchema`, `defineSchema`.
- Committed generated fixtures for every mock (`bun run generate:fixtures`), type-checked, format-checked
  and covered by type tests.
- `hashSchema` (D15) for the file headers, tested against published SHA-256 vectors and `Bun.CryptoHasher`.
- The schema module must keep bigints (134 bounds in the dump): a plain `JSON.parse("…")` would
  round them, so the module parses with `parse` or encodes them.
- Combo alias naming; JSDoc.

Exit: generated output for every mock and for the local corpus compiles; type tests cover every row of §6.2 and every
case in §6.3–6.4; `bench:types` is within budget.

**Phase 3: builder and API export** (done)
- Graph IR, `workflow()`, `OutputRef`, node handles.
- Default filling, schema-driven flattening, `__value__` wrapping, `_meta`, frontend key order (§7.4).
- Research first, against the frontend version the corpus came from: how each value widget
  serializes (RESOLUTION_PREVIEW sets `serialize: false` and is absent from the corpus export;
  IMAGECOMPARE sends a value the schema has no default for; CURVE is wrapped as
  `{"__type__": "CURVE", …}`), and DynamicGroup, which frontend 1.55.17 has no handler for.

Exit: byte-stable API output; parity tests (§7.4) pass, one committed mock workflow
(`mocks/workflows/`) per rule, distilled from corpus exports. Re-exporting the corpus itself needs
the importer, so it is Phase 6's exit.

**Phase 4: CLI** (done)
- `generate` (`--url` or `--from`), `check` (drift), the report (§9). `diffSchemas` in core.
- `examples/txt2img`: a workspace project whose `generate` script targets the local server and
  whose generated directory is gitignored. Its test runs it over the basic-pipeline mock
  (generate, `tsc`, run, compare the prompt), and the corpus test runs it over each real dump.

Exit: an example project generates from the live server and builds `txt2img` end to end.

**Phase 5: validation** (done)
- Everything in §8.

Exit: a negative test for every code; `toApi({ validate })`.

**Phase 6: API import and transpiler** (done)
- `parse`, `importApi` (schema-driven un-flattening, `__value__` unwrap), `transpile`, CLI `transpile`.

Exit: every corpus API workflow re-exports byte for byte, key order included:
`stringify(toApi(importApi(x, schema).workflow))` equals `stringify(parse(x).value)`. The transpiler round-trip
(§10) passes on the same corpus.

**Phase 7: graph operations** (done)
- Everything in §12, and `NodeOptions.mode` (`bypass`, `mute`) to use them.

Exit: tests mirror the frontend algorithms case by case.

**Phase 8: UI format** (done)
- Import (§11), then export, then the layout package. `tscomfy transpile --workflow` takes UI
  workflows.

Exit: the UI corpus imports to the prompts the frontend builds for it and round-trips through
`toUi`; exported UI JSON opens in the frontend, which builds the same prompt from it. Both are
checked against the frontend itself, in a headless browser (`internal/fixtures/scripts/frontend.ts`),
rather than by hand.

**Phase 9: polish** (done)
- README and guides (`docs/guides/`), examples (`examples/txt2img`, `examples/hires-fix`), an
  API-surface snapshot (`docs/api/`, D22), CONTRIBUTING, and packages ready to publish under the
  `@tscomfy` npm org. 0.1.0 was published 2026-10-18, with CI and release workflows (D12).
- Four independent audits (core API, core UI and normalizer, codegen, CLI and packaging, docs);
  every finding reproduced before it was fixed (§16).

Exit: `check`, `test:corpus`, `bench:types` and `test:pack` pass; the guides' code type-checks
against real generated types; the packed packages install and run under Node and Bun.

## 15. Risks

| Risk | Mitigation |
|---|---|
| ComfyUI schema changes (V3 is recent; DynamicGroup is marked unstable) | All raw-format knowledge lives in one module; `UnknownInput` lets output degrade gracefully; a corpus run after each ComfyUI update finds new shapes, which become mocks |
| Mocks drift from reality | The rule that every new corpus finding becomes a mock; corpus tests run before each phase is closed |
| Frontend serialization rules change | Parity mocks cite the frontend source lines they encode; re-checked against UI exports in the corpus after ComfyUI updates |
| Type-checking slows as the encoding grows | `bench:types` budget (§6.6) |
| Bun- or Node-specific APIs leak into libraries | oxlint restricted imports; note that `bun` types pull in `@types/node`, so lint, not `types: []`, is the guard **[verified]** |
| oxfmt churn (still 0.x) | Pinned exactly; an upgrade that reformats code lands as its own change. The formatter is replaceable without touching code |
| TS 7 ecosystem gaps (no compiler API before 7.1) | Not needed; API-surface checks use `.d.ts` snapshots |
| GPL code entering the project | Upstream code is read as a specification only |

## 16. Verification log

Checked from 2026-10-17 to 2026-10-18 with Bun 1.4.3, Node 26.11.1, TS 7.0.2 and a local ComfyUI 0.41.0 (frontend 1.55.17), unless a row says otherwise.

| Claim | Result |
|---|---|
| TS 7 strict library build; consumers resolve `.ts` specifiers inside emitted `.d.ts` (nodenext and bundler) | Pass |
| `tsc -b` references across 3 packages, incremental | Pass (needs `tsBuildInfoFile` inside `dist`) |
| Source-first via `customConditions` (TS) and `--conditions` (Bun) | Pass (TS: only in non-composite noEmit configs; Bun: CLI flag only) |
| `expect-type` + `@ts-expect-error` under TS 7; `bun test` ignores `.test-d.ts` | Pass |
| Lossless bigint parse and serialize without dependencies | Pass in Bun and Node |
| JSON import vs a `JSON.parse` module (3.4 MB) | JSON import costs 142 MB and 0.2 s per check; the `.ts` module costs 20 MB and 0.02 s. `.d.json.ts` breaks at runtime |
| Biome lint vs oxlint `--type-aware` | Biome missed cross-package floating promises, cross-package truthiness checks, and `noUncheckedIndexedAccess` nullability. oxlint caught all of them |
| oxfmt 0.73.0 as a drop-in for Biome 2.5.15 | Identical output on every TypeScript file, including import order with `newlinesBetween: false`. Respects `.gitignore` (`dist`, corpus). Differences: it sorts `package.json` keys and reflows one mock JSON line; it pads Markdown tables, so Markdown is excluded |
| Type encoding on the real dump: covariant sockets, widget+link, combo errors (with "did you mean"), excess and missing inputs, Autogrow, nested DynamicCombo, DynamicGroup, MatchType with `NoInfer` | Pass, every negative test fires |
| Type-checking cost at 1,758 / 3,516 / 7,032 nodes (Phase 0 spike, a lighter encoding; today's numbers are in §6.6) | 0.11 s / 0.13 s / 0.26 s |
| Dump facts used in this plan | 851 dotted ordinary input names; 193 DynamicCombo inputs (189 nested dynamics; 111/608 options have no inputs; a `codec` vs `format.codec` collision); 57 Autogrow (19 names form); 17 MatchType; 102 INT with max > 2⁵³; 19 FLOAT bounds and 3 `INT:seed` inputs with integer literals beyond 2⁵³; 328 class names that aren't identifiers; 72 list outputs; 2 nodes with duplicate output names |
| Lossless parse of the 3.4 MB dump (reviver with source text, Bun 1.4.3) | 26 ms, vs 4 ms for plain `JSON.parse`. 134 integer literals beyond 2⁵³, all of them `min`/`max`: 102 INT max, 7 INT min, 10 FLOAT max, 9 FLOAT min, 3 `INT:seed` max, 3 inside DynamicCombo options. None in exponent notation |
| Hand-written synchronous SHA-256 (D15) | 62 ms on the 3.4 MB dump in Bun 1.4.3; matches `Bun.CryptoHasher` on the dump and on empty input |
| Frontend API key order (§7.4) | All 13 nodes of a corpus API export: `inputs`, `class_type`, `_meta`; widget inputs in `input_order` (linked ones included), then socket-only inputs |
| Separating corpus tests (§13) | `bun test --path-ignore-patterns='**/*.corpus.test.ts'` skips them; a positional filter selects only them (Bun 1.4.3) |
| Widget classification (D16) | Frontend 1.55.17 `addInputSocket`/`addInputWidget` (`litegraphService.ts`) look up `widgetType ?? type` in `ComfyWidgets` (`widgets.ts`): INT, FLOAT, BOOLEAN, STRING, MARKDOWN, COMBO, IMAGEUPLOAD, COLOR, IMAGECOMPARE, BOUNDING_BOX, CHART, GALLERIA, PAINTER, COMPOSITOR, TEXTAREA, CURVE, RANGE, VIDEO_EDIT, RESOLUTION_PREVIEW, BOUNDING_BOXES, COLORS, plus `COMFY_DYNAMICCOMBO_V3`; Autogrow and MatchType are handled as dynamic inputs; no DynamicGroup handler. The dump has 25 inputs on non-primitive core widgets and 12 with `widgetType` (FLOAT on `FLOAT,INT`, STRING on a file union, PAINTER, three pack widgets) |
| `TYPE:name` types | `INT:seed` is not a frontend widget (not in the registry, not in the bundle). Backend `validate_inputs` coerces only exact `INT`/`FLOAT`/`STRING`/`BOOLEAN` but still checks min/max; `validate_node_input("INT", "INT:seed")` is false |
| Normalizing the corpus dump | 1,758 of 1,758 nodes, 55–66 ms in Bun 1.4.3. 13 warnings, all real server inconsistencies: 7 combo defaults that aren't options, 1 INT default below its `min`, 3 `output_*` arrays longer than `output`, 2 `name` mismatches. Also found and distilled into mocks: `null` for unset fields, boolean combo options (3), value widgets, `widgetType` |
| Generated code (§6, §9) | The real dump: 3.0 MB `nodes.ts` and 4.1 MB `index.ts` generated in 0.19 s; type-checks in 0.11 s / 91 MB; oxfmt leaves both unchanged. The first printer version took 99 s (it trimmed the whole output at every newline) |
| Tuple-extending result interfaces (§6.2) | `interface X$Out extends X$Outputs, NodeHandle` keeps destructuring types and `length`; neither it nor an intersection makes an out-of-range index an error under TS 7.0.2, and the interface lays out more simply |
| Phase 2 review | An independent review found 10 issues, each proven with a failing snippet or input, among them: option-list and loose-`*` outputs fitting inputs `accepts()` rejects, optional Autogrow/DynamicGroup minimums the backend still enforces, INT/FLOAT list defaults, comment injection through names, and eight printer layouts that differed from oxfmt. All fixed, with mocks and tests; the type-level `accepts` matrix now proves soundness for all 108 pairs |
| oxfmt layout rules (§9) | Probed on crafted code: `extends` breaks to its own line with one parent per line; type arguments break one per line without a trailing comma; assignments break after `=` when the head of the right side doesn't fit; strings use single quotes only when that needs fewer escapes; Unicode identifier keys are unquoted; CJK and fullwidth characters count as two columns |
| Exported key order (§7.4) | `graphToPrompt` writes widgets first (`node.widgets` order), then links (`node.inputs` order); assigning an existing key keeps its position. `dynamicWidgets.ts` inserts option widgets after their combo and option sockets after its socket; Autogrow slots after the previous slot. Six hand-written parity prompts (`mocks/workflows/api/`) export byte for byte |
| Combo defaults (§7.2) | `useComboWidget.ts`: a multi-select starts at `ref([])`; `getDefaultValue` returns `default` if truthy, else `options[0]` |
| Phase 3 review | An independent review found 15 issues, each reproduced: explicit `null` replaced by defaults, references from another workflow silently mis-wired, sparse arrays, multi-select flags, frontend initial values (IMAGECOMPARE), row and slot maximums missing from the types, async builds, proxy and builder edge cases, doc mismatches. All fixed with tests; it also rebuilt the corpus Anima export through `workflow()` byte for byte |
| Bounded list types (§6.2, §6.6) | Fixed tuples with optional elements up to the maximum took the 7k-node bench to 0.90 s; `Bounded<open tuple, Length…>` with a shared length alias checks the same bounds in 0.41 s |
| Input order (§9) | Frontend 1.55.17 `getOrderedInputSpecs` (`nodeDefOrderingUtil.ts`): listed required, listed optional, then remaining inputs in definition order; no `input_order`, definition order |
| `stringify`/`parse` round trip (§7.5) | `JSON.stringify(2 ** 64 - 2048)` is `"18446744073709550000"`, an integer literal that `parse` reads as a different bigint; `toExponential()` (`1.844674407370955e+19`) round-trips exactly. Found by `defineSchema` on the numbers mock |
| Non-finite numbers (§7.5) | `/object_info` is served by aiohttp `web.json_response`, whose default `json.dumps` writes `Infinity`/`NaN` (checked with the server's Python). None in the corpus dump today |
| CLI against the live server (§9) | `generate --url` on ComfyUI 0.41.0: 1,758 node types in 1.6 s; 0 errors and 67 warnings (54 `W_EMPTY_COMBO` for loaders with no model files, plus the 13 normalizer warnings above). `check --url` takes 0.36 s. `examples/txt2img` generates, type-checks and prints a prompt over the live types |
| Schema identity across responses (D15) | A corpus dump saved earlier and the live response differ only in the order of `vhs_path_extensions` on `VHS_LoadImagePath`, a field the normalizer doesn't keep. The hashes are equal and `check` reports up to date, as intended |
| Credentials in `--url` | Bun's `fetch` turns `http://user:pw@host` into `Authorization: Basic …`; Node 26's refuses such a URL, and its error quotes it whole. So the CLI sends the credentials as that header itself, percent-decoded, and replaces the URL in any error with the redacted one (checked under both runtimes with `Bun.serve` in `system.test.ts`). It strips them from every message and header |
| Phase 4 review | An independent review found 10 issues, each reproduced: a `?token=` query appended before `/object_info` (and shown), `check` trusting header lines over file contents, an error body (`{"detail": …}`) generating 0 nodes over good types with exit 0, reserved-word export names, upload combos counted as drift, an unguarded response body read, a fix command that named the old source, credentials in usage errors, control characters in recorded paths, and doc gaps. All fixed with tests |
| Backend validation (§8) | Read in backend 0.41 `execution.py` (`validate_inputs`, `validate_prompt`) and `comfy_api/latest/_io.py` (`get_finalized_class_inputs`, the Autogrow, DynamicCombo and DynamicGroup expanders): coercion with `int()`/`float()`/`str()`/`bool()` before bounds, combo membership with multi-selects element-wise, `VALIDATE_INPUTS` skipping built-in checks, an unknown dynamic-combo key dropping the input silently, DynamicGroup key grammar and row counts, Autogrow minimums from the template's section, cycles and "no outputs" rejecting the prompt. The corpus Anima export (13 nodes) validates with no diagnostic in 0.8 ms; 20,000-node chains, plain and through MatchType nodes, validate without deep recursion |
| Phase 5 review | An independent review found 10 issues, each reproduced: MatchType outputs narrowed by inputs the types don't infer from (typed code over the real `ComfySwitchNode` failed validation), the inferring position in an unchosen dynamic-combo option, links and wrapped keys into dynamic combos that the backend drops, `[{}]` rows that send nothing, recursive MatchType resolution overflowing the stack at 16,000 nodes, unchecked links into unknown inputs, Autogrow slots never checked against slot 0, `int()` truncation assumed for non-INT types, misdescribed ordering and duplicate cycle reports, and tests whose sources were all untyped. All fixed; `soundness.test.ts` now builds typed workflows |
| Import and transpile round trip (§10) | The corpus Anima export (13 nodes) imports without a diagnostic or raw node, re-exports byte for byte with validation on, and transpiles to typed code (no `raw`) that type-checks against the corpus types, is oxfmt-formatted, and rebuilds the prompt byte for byte. The six mock prompts do the same over their mock schemas |
| Phase 6 review | An independent review found 11 issues, each reproduced: raw-written known-class sources typed by their schema outputs (4 of 1,494 differential pairs failed to compile), CURVE in rows wrapped twice, unfoldable keys imported typed (rows past `max`, double-claimed keys, display-only widgets), hostile row indices throwing, four oxfmt layout classes (short keys, the declaration, long destructuring, exponents and number arrays; ~10% of 2,400 fuzzed workflows), CLI names and specifiers that don't compile, exporter errors ignored, quadratic name claims and fans, `__proto__` keys, and cycle reporting. All fixed; a fuzz test now checks oxfmt, `tsc` and the round trip |
| Bypass and mute (§12) | Read in the frontend 1.55.17 bundle installed with the server (`settingStore-*.js`): `_getBypassSlotIndex`, `resolveInput`/`resolveOutput`, `isValidConnection`, `addInputs`/`addInputSocket`/`addInputWidget`, `addOutputs`, `withComfyMatchType`/`commonType`, `graphToPrompt` (widget values written before links). It corrected one note: each step past a bypassed node is checked against that node's input type, not the consumer's. `modes.test.ts` follows the five rules, the slot order (forceInput combos, dynamic-combo options), MatchType narrowing, widget fallbacks, chains, mutes behind bypasses and cycles case by case |
| Phase 7 review | An independent review found 11 issues, each reproduced: raw nodes transpiled after modes applied, MatchType narrowing missing (a switch fed through a bypass took the wrong input), `forceInput` legacy combos in the widget group (rgthree's Context Big rerouted a width to the seed), option inputs sockets-first, widgets dropped instead of keeping their value, links to missing outputs hidden by a bypass, `prune` leaving links to removed nodes, two quadratic paths, frontend throw cases misdescribed, stale docs, and missing case tests. All fixed with tests |
| UI format (§11) | Read in frontend 1.55.17 (the TypeScript in the installed bundle's source maps): `LGraph.configure`/`serialize`, `ComfyNode.configure`, `addInputs`, `getOrderedInputSpecs`, `dynamicWidgets.ts`, `widgets.ts` `addValueControlWidgets`, the upload extensions, `widgetInputs.ts` (PrimitiveNode), `rerouteNode.ts`, `SubgraphNode.ts`, `subgraphDeduplication.ts`, `ExecutableNodeDTO.ts`, `computeExecutionOrder`. 45 synthetic files loaded in the live frontend settled the cases the source leaves open (links only in the array or only on inputs, wrong `target_slot`s, versions, named vs positional values, too few or many values, null combos, Reroute and PrimitiveNode modes, nested, muted and bypassed subgraphs, colliding inner ids, missing `linkIds`). Our `InputDef` order equals `getOrderedInputSpecs` for all 1,758 classes |
| `importUi` against the frontend | `frontend.ts` loads files into the server's own frontend in headless Chromium and saves what `graphToPrompt` builds; every request but a GET is answered locally. For the 10 corpus UI files `importUi` gives 248 of the 259 prompt entries byte for byte, and every file's node order. The other 11 are pack JavaScript at queue time (4 VHS date substitutions, 2 rgthree Any Switch, 2 pack widgets) and 3 nodes of classes the server doesn't have, which the frontend sends without `class_type`. Of the five committed mock UI files, four match the captured prompts exactly; `txt2img` uses the mock class `MockSeed`, which the server lacks, and its expected prompt is the hand-written parity prompt, which the capture matches on every other node |
| `toUi` against the frontend | The frontend loads `toUi` output of every corpus file to the prompt `importUi` reads from it in 247 of 259 entries; the other 12 are the 11 above and use-everywhere's Anything Everywhere, whose JavaScript rebuilds its inputs from properties we don't write. Sizes after loading: 221 of 231 nodes of core classes are no larger than `uiNodeSizes` (the frontend snaps to 10 px); the others carry frontend-extension widgets the schema doesn't show (audio players, PreviewAny's preview) or long labels, up to 60 px taller or 40 px wider |
| Phase 8 review | An independent review found 15 issues, each reproduced in the real frontend, among them: self-containing subgraphs expanded (or hanging) where the frontend refuses the file, promoted values through nested subgraphs costing exponential time, quadratic primitive, unknown-node and Reroute paths, `toUi` spreading every id into one `Math.max` (a RangeError past ~125k nodes under V8), link placement without the frontend's deduplication and realignment rules, object-form and partial named values, stale values across settle passes, `forceInput` placeholders, `%Node.widget%` file names, legacy group nodes, string and repeated node ids, null promoted values, and the frontend's per-definition loop guard. All fixed with tests; the reviewer's 54 crafted files match the frontend except a big seed (rounded), a `%date:…%`, a group node and a refused loop, each reported. 200,000 Reroutes in a chain import in 1.4 s, 200 nested subgraphs in 5 ms. The five mock UI files' `toUi` exports load in the frontend to the prompts committed in `mocks/workflows/ui-export/`. A re-review confirmed the fixes and found six more, each reproduced and fixed: reminting when the next id is taken, the frontend's default titles (`Primitive`), references to controls, a quadratic file-name lookup (8,000 save nodes: 6.75 s, now 0.1 s), fractional ids, and quadratic wide nodes (50,000 inputs: 0.15 s) |
| Frontend and backend serialization rules (§7.4, §12) | An early pass over the frontend 1.58 source, before each rule was re-read in 1.55.17 (§7.4, §11, §12): `executionUtil.ts`, `ExecutableNodeDTO.ts`, `dynamicWidgets.ts`; backend `execution.py`, `comfy_api/latest/_io.py`, `comfy_execution/validation.py` |
| Phase 9 audits | Four independent reviews, each finding reproduced. Fixed with tests: the exporter dropping misshaped values silently instead of passing them to validation, a muted link into a dynamic combo re-sending the dropped link, `W_UNSAFE_INTEGER` for every bigint (`42n` included), widgets of the frontend's core extensions not modeled (Load3D, CameraAngle, Webcam, RecordAudio: `widgets_values` misaligned by one or more), three disagreeing "not sent" lists, the KSampler control fixup applied by class-name prefix, a memoized message naming the wrong link, `widgets_values_named` collisions on an input named `upload`, a mutable diagnostics registry, `bun run check` failing on a fresh clone (type-aware lint of examples needs generated types), a second copy of core breaking layout silently, the CLI running only under Bun, tarballs shipping build info, npm dropping the `bin`, unbounded `check` output, unreproducible regenerate commands. Structure: the frontend's node model once (`core/src/frontend/`), `ui/import.ts` split into eight modules, codegen's transpiler into four |
| Frontend registry (D16, §11) | Created a node of every widget type and every core-extension class in frontend 1.55.17, with mock classes registered through `app.registerNodeDef`: the saved and sent table in `frontend/widgets.ts`, the extensions' added inputs and buttons, widget renaming (`width#1`), and that `socketless` is ignored: every widget gets a slot, which a bypass picks by index. Details in `docs/research/ui-format.md` |
| Consumers of the packages | A project over the built packages and generated mock types type-checks with TypeScript 5.9.3, 6.0.3 and 7.0.2 under `nodenext` and `bundler`, `strict` and `skipLibCheck: false`, and runs under Node 24.22.0, Node 26.11.1 and Bun 1.4.3. `test:pack` checks the same from packed tarballs installed offline, the `tscomfy` bin included |
| Guides | Every snippet in `docs/guides/` type-checks against types generated from the corpus server (1,758 classes), the four compile errors getting-started promises included; the runtime-schema snippet validates with one expected warning |
| Frontend 1.55.18 | The server updated its frontend from 1.55.17 to 1.55.18 during Phase 9. Captured again on 1.55.18, every committed mock prompt (`ui-api/`, `ui-export/`) is identical. The `ui-extensions` captures were made on 1.55.18, with the mock's definitions registered in the page and the server's file lists answered by the probe (a remote combo's saved file listed), so no capture holds the server's files. The frontend queues exactly `toApi`'s prompt for `examples/hires-fix`'s UI workflow, its bypassed LoRA included |
| Publishing (D12) | Packed with `bun pm pack` (Bun 1.4.3): tarballs `tscomfy-<name>-<version>.tgz`, `workspace:*` rewritten to the exact version and `workspace:^` to `^<version>`. A fresh npm project installing them, generating from the `basic-pipeline` mock with `--import-extension .ts` and the README's `tsconfig.json`, type-checks the README's opening example with TypeScript 5.9, rejects `"eular"` (TS2820), runs under Node 26.11.1 and Bun 1.4.3 with no build step, and transpiles a UI workflow that type-checks. npm's trusted publishing needs npm 11.5.1+ and Node 22.14+, `id-token: write`, a `repository.url` matching the repository, and a package that already exists (`npm help trust`, npm 12.2.1). Released 2026-10-18: 0.1.0 of each package published by hand (each tarball's integrity equals the local `bun pm pack` output), trusted publishers configured, and a fresh npm project installs all four and runs `tscomfy --version`. Running `npm trust` before a package exists makes npm create it with a `0.0.0-stage` stub version. The first `check.yml` run passed (`check`, `test:pack` under Node 24 and 26); the `v0.1.0` run of `release.yml` passed and skipped the four versions already on npm. Publishing over OIDC is first exercised by the next release |
