# tscomfy: implementation plan

> Packages: `@tscomfy/core`, `@tscomfy/codegen`, `@tscomfy/cli` (bin: `tscomfy`). MIT.
> Publishing is not a priority. Status: revision 5, 2026-10-17: the generated encoding as built in Phase 2 (§6). **Phases 0–2 complete.**
> Every claim marked **[verified]** was checked hands-on; the evidence is in [§16](#16-verification-log).

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
| ComfyUI frontend 1.58 (GPL-3.0) | The **specification** of serialization rules (§7.4) | Copying code |
| ComfyUI backend 0.41 `_io.py`, `execution.py` | Ground truth for V3 dynamic inputs, type compatibility, validation | — |

## 3. Key decisions

| # | Decision | Why |
|---|---|---|
| D1 | **Bun 1.4** for package manager, workspaces (isolated linker, text `bun.lock`), tests and scripts. The CLI may use Bun APIs | Fast and a single tool. **[verified]** |
| D2 | **TypeScript 7.0** (`typescript@7.0.x`) | Stable since 2026-07. Strict config, `tsc -b` references, `.d.ts` consumption under `nodenext` and `bundler`, and the type tests all pass. The missing compiler API (arrives in 7.1) doesn't matter: codegen writes strings. **[verified]** |
| D3 | **`core` and `codegen` are runtime-agnostic**: no `node:*`, `bun`, `bun:*` or DOM APIs, enforced by lint | Generation works in Node, Bun, Deno, browsers and edge runtimes. |
| D4 | **ESM only, unbundled** per-file JS, `.d.ts` and maps from `tsc -b`. Source uses `.ts` specifiers with `rewriteRelativeImportExtensions` | Simplest correct library output. **[verified]** |
| D5 | **Zero runtime dependencies in every package** | The object_info normalizer is a hand-written lenient tree walk with diagnostics per field. A schema library would add a dependency and a second representation of the data, and lenient handling needs the custom code anyway. |
| D6 | **The object_info normalizer lives in `core`** | Runtime users (e.g. a browser app against a live server) need it without codegen. Raw object_info is confined to one module, `core/src/object-info/`. |
| D7 | **API format first.** UI format later, as separate import/export modules | API format maps 1:1 onto the graph. |
| D8 | **The schema is passed explicitly as a typed value**; no global module augmentation | Several servers in one project, isolated tests, no hidden state. |
| D9 | **Refs are frozen `OutputRef` instances typed as a branded, covariant `Out<T>`** | Lists are meaningful values (they get wrapped as `__value__`, §7.4), so refs can't be tuples. **[verified]** |
| D10 | **Lossless integers.** INT accepts `number \| bigint`. Our own small deterministic serializer writes bigint as a JSON number. The parser reads big ints via `JSON.parse` source-text access. The normalizer and the importer take **raw text**, never an already-parsed value | Seeds go up to 2⁶⁴−1, and 134 bounds in the real dump are integer literals beyond 2⁵³ (102 of them INT `max`). A parsed value has already lost them. **[verified]** in Bun 1.4.3 and Node 26. |
| D11 | **oxfmt formats, oxlint lints** (`--type-aware` via tsgolint, built on TS 7) | One toolchain. oxlint's type-aware rules are as accurate as tsc and catch cross-package cases Biome's linter misses. oxfmt is 0.x, so it is pinned exactly. **[verified]** |
| D12 | **No CI for now.** `bun run check` is the single local gate | Your request. Adding CI later means running the same script. |
| D13 | **The generated runtime schema is a `.ts` module holding the schema as one string literal**, loaded by `defineSchema`, not a JSON import | A 3.4 MB JSON import costs 142 MB and 0.2 s of type-checking on every check; a string literal is nearly free, needs no copy step and no `resolveJsonModule`. `defineSchema` parses it with the lossless `parse`, because a plain `JSON.parse` would round the 134 big bounds. **[verified]** |
| D14 | **One diagnostic model, from Phase 1** (§5.4): `{ code, severity, path, message }`. `path` is an array of segments. Each code has one fixed severity, which its `E_`/`W_` prefix names | The normalizer emits diagnostics long before validation exists (Phase 5). Segment paths need no escaping for the 851 dotted input names and 328 non-identifier class names, unlike dotted paths or JSON Pointers |
| D15 | **Schema identity.** `Schema.nodes` is built in code-unit order of class type (JavaScript still lists integer-like keys first). `hashSchema(schema)` is computed on demand, not stored: a synchronous, hand-written SHA-256 over `stringify({ formatVersion, nodes })` | Output doesn't depend on the server's node load order. The hash changes when the generated output can, not when whitespace, key order or the ComfyUI version changes. `crypto.subtle` is async; hashing raw text tracks noise. 62 ms on 3.4 MB. **[verified]** |
| D16 | **An input is a widget exactly when the frontend makes it one**: the frontend looks up `widgetType ?? type` in its core widget registry. When `type` is primitive (INT/FLOAT/STRING/BOOLEAN/COMBO) the kind follows `type`, because the backend coerces and validates by it, and `widgetType` is recorded. Otherwise a primitive widget gives its kind, another core widget (COLOR, BOUNDING_BOX, CURVE, …) gives a `value` kind holding JSON, and anything else, `TYPE:name` types included, is a socket. The socket type is always `type` | This is the only rule that matches which inputs get values in exported prompts and stays sound. 25 real inputs use non-primitive core widgets, mostly socketless; as sockets they could never be set. `widgetType` splits widget and socket (`frame_rate` is a FLOAT widget on a `FLOAT,INT` socket). Widgets a pack registers in the browser are invisible in `/object_info`, so those inputs stay sockets (stricter, and `raw()` remains). **[verified]** |

## 4. Architecture

```
@tscomfy/cli           Bun · fs · network · args
  generate · check · transpile
        │
@tscomfy/codegen       pure: Schema in → files (as data) out
  emitTypes · emitSchemaModule · transpile (graph → TS)
        │
@tscomfy/core          pure, zero deps
  object-info/  raw /object_info → Schema   (the only module that knows the raw format)
  schema/       Schema model, SocketType, accepts(), hashSchema()
  graph/        IR, builder, OutputRef
  api/          export (flatten, defaults, __value__), import (schema-driven un-flatten)
  validate/     workflow checks
  diagnostic/   Diagnostic model and code registry (every module may import it)
  json/         lossless parse and serialize
later: ui/ (UI-format import/export) and layout/ (auto-layout package)
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
parse(json) ─► importApi(prompt, schema) ─► Workflow
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

The generated types are a **subset** of this rule: union outputs must fit inside the input's set.
That is stricter, and the real dump has no union outputs at all. A table-driven suite runs the
same cases against both the runtime rule and the type rule.

`isList` outputs do **not** affect compatibility: ComfyUI maps a list output over a non-list input.
It is documented in JSDoc only.

### 5.3 Graph IR

```ts
interface Graph { readonly nodes: ReadonlyMap<NodeId, GraphNode> }          // insertion-ordered
interface GraphNode {
  readonly id: NodeId;                      // string; sequential "1","2",… unless set explicitly
  readonly classType: string;
  readonly inputs: Readonly<Record<string, InputValue>>;   // STRUCTURED (dynamic inputs nested)
  readonly title?: string;
  readonly mode?: "bypass" | "mute";
}
type InputValue = string | number | bigint | boolean | null | OutputRef
  | readonly InputValue[] | { readonly [k: string]: InputValue };
```

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
  `["KSampler", "input", "required", "seed", 1, "max"]`. Export and validation paths point into the
  structured workflow, e.g. `["5", "inputs", "format", "codec"]`. Parse errors have an empty path
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
| socket `IMAGE,MASK` | `In<ImageTypes>`, with a shared alias `ImageTypes = "IMAGE" \| "MASK"`; a union containing `*` is `Out<string>` |
| socket `*` | `Out<string>` |
| INT | `number \| bigint \| In<"INT">` (a widget also takes a link) |
| FLOAT / STRING / BOOLEAN | `number` / `string` / `boolean`, each `\| In<…>` |
| `forceInput` widget | link only |
| combo | literal union alias, plus a link: `\| In<type>` for the `COMBO` form, `\| Out<"*">` for a legacy `[[…]]` combo (its links must match its whole list, §5.2). Identical option lists are **deduplicated into named aliases** (`SamplerName`, `CkptName`) |
| multiselect combo | `readonly (Alias)[]` |
| upload or remote combo | `Alias \| (string & {})`: the options are runtime state (input folder contents), so this keeps autocomplete without false errors |
| empty combo (36–55 in the dump) | `string`, plus a codegen diagnostic |
| value widget (COLOR, BOUNDING_BOX, CURVE, …; D16) | `JsonValue`, `\| In<type>` unless socketless |
| input with an explicit schema default | optional (`?:`); the exporter fills it in |
| Autogrow, prefix form | `readonly T[]`, or `readonly [T, …, ...T[]]` with the first `min` slots required |
| Autogrow, names form | an interface `{ readonly a: T; readonly b?: T }` (first `min` names required) |
| DynamicCombo | a union of option interfaces `{ option: "mp4"; inputs: {…} }`, plus the bare `"flac"` key for each option whose inputs may all be left out. Recursive (§6.4) |
| DynamicGroup | a row interface, repeated like Autogrow slots (first `min` rows required) |
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
- An `IMAGE,MASK` template rejects `LATENT`, and the output keeps the narrowed type.

### 6.4 DynamicCombo shape (your question 4: decided with evidence)

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

### 6.5 Combo strictness (your question 5)

**Strict by default; I agree with you.** The types then reflect the server they were generated
from, and `tscomfy check` catches drift. There are two principled exceptions, both in the
encoding table, rather than a global loosening:
1. Upload and remote combos: their options are runtime state, not schema.
2. Empty combos: they carry no information to be strict about.

`--combos loose-files` stays as an opt-in for projects that target several servers with different model sets.

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
- **Object arguments.** The second argument holds node options: `{ id?, title?, mode? }`.
- **Templates are plain TS functions** (above). There is no template DSL and no `ParamRef` in the IR:
  re-running the builder is cheap, and plain parameters give the best types.
- **Composition is plain functions** taking `n` and refs. Mapping them to UI subgraphs comes with the UI format.
- **Escape hatch**: `raw(classType, inputs, options?)` from the context. It is untyped and kept separate
  from `n`, so no `class_type` can collide with it. Validation warns when it is used.

### 7.2 Defaults policy

- **Fill explicit schema defaults** for every widget input, required or optional, recursively including
  dynamic-combo branches. This matches the frontend, which sends every widget value.
- **Never invent implicit defaults.** The frontend falls back to `0`, `""`, `false` or the first combo
  option; we don't, so those inputs stay **required** in the types. Explicit beats a silently chosen first checkpoint.

### 7.3 Node ids

- Strings, sequential (`"1"`, `"2"`, …) or set explicitly.
- Links are emitted as `[id, slot]` with a string id; the backend's `is_link` requires that.
- Ids of expanded subgraph nodes (UI-format phase) follow the frontend's `parent:child` form.

### 7.4 Parity with the frontend's API output

Researched in frontend 1.58 `executionUtil.ts` and backend 0.41 `execution.py`.

| Rule | What we do |
|---|---|
| Every widget value is sent; unconnected socket-only inputs are left out | Same |
| Key order: each node is `inputs`, `class_type`, `_meta`. Inside `inputs`, widget inputs come first in `input_order` (linked widgets included), then socket-only inputs | Same, so `stringify` reproduces an export byte for byte. Observed on every node of a corpus export (frontend 1.55.17); to be confirmed in `executionUtil.ts` in Phase 3 |
| A list-valued widget is sent as `{"__value__": [...]}`, because the backend reads a bare list as a link | Same; the importer unwraps it |
| `_meta.title` is always present (title, or display name) | Same (`toApi({ meta: false })` turns it off) |
| control_after_generate is never sent (its widget has `serialize: false`) | Not modeled; seeds are plain values |
| Autogrow sends connected slots only (`images.image0`, …) | Same |
| DynamicGroup keys are `group.<row>.<field>` | Same |
| **The frontend resolves `{a\|b}` dynamic prompts and strips `/* */` and `//` comments** in `dynamicPrompts` STRING inputs, so `http://` gets truncated | **We don't** (determinism, fidelity). An opt-in `dynamicPrompt()` helper may come later. Documented. |
| **The frontend substitutes `%…%`** in save-node `filename_prefix` values | **We don't**; the text is sent verbatim. Documented. |

### 7.5 Serialization

- `toApi()` returns a plain `ApiPrompt` object, which may hold `bigint`.
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
- Both land in Phase 1: the normalizer needs `parse`, and `hashSchema` needs `stringify`.

## 8. Validation

`validate(wf): Diagnostic[]`. `toApi(wf, { validate: "error" | "warn" | "off" })` defaults to `"error"`,
which throws a single `ValidationError` carrying all diagnostics.

**Checks**:
- unknown class type (the backend rejects the whole prompt for this)
- **unknown input**: stricter than the backend, which silently ignores unknown values but still follows
  unknown *links*
- missing required input
- dangling ref, slot out of range
- socket compatibility (`accepts`)
- MatchType consistency (all inputs of a template agree)
- combo membership (an error, or a warning for upload, remote and empty combos)
- int/float coercion, min/max (bigint-aware)
- Autogrow count against min/max
- DynamicCombo option exists
- DynamicGroup row count, ≤ 20 rows
- flattened-key collisions
- cycles

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
    after inward rounding, the wrong type) is dropped with `W_INVALID_INPUT_OPTION`, because the
    exporter fills defaults in (§7.2). A combo with no listed options (remote, upload, an empty
    folder) keeps its default: membership can't be checked offline.
  - A legacy combo option that isn't a string, number or boolean makes the input unknown, since
    its links match the full list; in the `COMBO` form, or in an output list, the option is
    dropped or the node is, respectively.
  - Missing Autogrow and DynamicGroup counts take the backend's defaults (prefix: min 1, max 10,
    at most 100 slots; group: min 0, max 20). Counts outside those limits, which the backend's
    constructors rule out, make the input unknown.
  - Without source-text access (`W_PRECISION_LOSS`), integer-valued bounds beyond 2⁵³ move
    inward by one double, which covers any rounding.
  - Nodes are sorted by class type (D15).
- **emitTypes** (codegen): builds documents for a small Wadler-style printer (`codegen/src/doc.ts`)
  with Prettier's group/indent/line/ifBreak semantics, at 100 columns. Output is deterministic and
  exactly what oxfmt produces: the committed mock fixtures pass `format:check`, and the corpus test
  feeds the real dump's output through oxfmt and expects no change. To keep the layout rules few,
  every type expression is a union of short atoms; anything bigger gets a named declaration
  (§6.2). Generated files are excluded from linting. Identifiers:
  - derived from input names, sanitized
  - de-duplicated with stable suffixes
  - **328 class names in the dump are not valid identifiers**; they stay as quoted keys
  - diagnostics: `W_EMPTY_COMBO`, `W_UNTYPED_INPUT` (docs/diagnostics.md)
- **check**: diffs the live server against the snapshot (nodes added, removed or changed, combo option
  changes). It exits non-zero on drift.
- **Report**: counts plus diagnostics grouped by node pack (`python_module`; the dump has 203 packs).

## 10. Transpiler (API JSON → TS)

`transpile(wf, opts) → string`:
- Topological order.
- Variable names from output and class names, de-duplicated.
- Short single-use refs inlined (configurable).
- Ids and titles kept.
- Dynamic inputs re-nested.
- Unknown classes become `raw(…)` with a comment.

**Round-trip guarantee** on a corpus of real workflows: `toApi(run(transpile(x)))` equals `x`, after a
documented normalization (defaults filled, key order ignored).

## 11. UI format (later phases)

**Import first**:
- formats 0.4 and 1.0 (tuple vs object links)
- `widgets_values` / `widgets_values_named`, skipping control widgets
- Reroute, PrimitiveNode (its value copied into the target), Note and MarkdownNote (dropped)
- bypass and mute (§12)
- subgraph expansion with `parent:child` ids

**Export** comes after that, with auto-layout in a separate package. The upstream frontend source is a specification only.

## 12. Graph operations (Phase 7)

Each follows the frontend algorithm exactly, as found in the research:
- **Bypass**: the outputs of a bypassed node reroute to an input chosen in this order:
  1. if the target type is `*` or empty, the input at the same index, else input 0;
  2. the same-index input, if it is valid for both the output type and the target type;
  3. the first input whose type exactly equals the target type;
  4. the first input valid for both types;
  5. otherwise the input is dropped, with a warning.

  This resolves recursively. Input index order: socket-only inputs come first, then widget sockets.
- **Mute**: the node is left out; inputs that depended on it are left out too, and the
  dependents themselves are still emitted (the backend then reports `required_input_missing`).
- **Prune**: drop nodes that don't feed any output node. This is cosmetic, since the backend only
  executes output nodes and their ancestors.
- **Split per output**, as ComfyScript does.

## 13. Repository and tooling

```
tscomfy/
  README.md                # what this is, layout, commands
  AGENTS.md                # working agreements, architecture rules, conventions, gotchas
  CLAUDE.md                # imports AGENTS.md for Claude Code
  LICENSE                  # MIT
  package.json             # private root: bun workspaces (packages/*, internal/*), scripts
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
  internal/                # private workspace packages, never published
    fixtures/              # @tscomfy/fixtures: all test data, typed loaders
      src/index.ts         #   readMockObjectInfo(name), listCorpus(section)
      mocks/object-info/   #   committed hand-written mocks, one theme per file
      mocks/workflows/     #   committed mock API and UI workflows (Phase 3)
      corpus/              #   local real data; only its README is committed
    bench/                 # @tscomfy/bench: bench:types, synthetic schemas from the mocks
  docs/
    plan.md                # this plan
    decisions/             # one short ADR per decision in §3
    research/              # ComfyUI serialization ground truth, prior-art review
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
  `cli` adds `types: ["bun"]`.
- **Test** (`test/tsconfig.json`): `noEmit`, non-composite, `incremental`, `types: ["bun"]`,
  **no references**. References in a noEmit config cause TS2878.

**Source-first development** **[verified]**:
- Exports: `{ "@tscomfy/source": "./src/index.ts", "types": "./dist/index.d.ts", "default": "./dist/index.js" }`.
- TS: `customConditions`, so the check config and test configs resolve to `src` with no build.
- Bun: there is no bunfig setting for conditions, so scripts pass `--conditions=@tscomfy/source` (or set `BUN_OPTIONS`).

**Scripts**:
- `build`: `tsc -b`
- `clean`: remove the `dist` directories (tsc never deletes stale outputs)
- `test`: `bun test --conditions=@tscomfy/source`, skipping corpus tests
- `test:corpus`: only the corpus tests (`*.corpus.test.ts`)
- `lint`: `oxlint --type-aware`
- `format`: `oxfmt` (format and sort imports); `format:check`: `oxfmt --check`
- `bench:types`: the type-check budget (§6.6)
- `generate:fixtures`: regenerates `packages/codegen/test/generated/` from the mocks
- **`check`**: `tsc -b`, then lint, `format:check` and test

There is no separate fast check config: under TS 7, `tsc -b` is fast enough to be the one type-checking
path, and a second config with Bun types would let library code use Bun APIs undetected (ADR-0004).

**Tests**:
- **Unit**: `bun test` (`*.test.ts`).
- **Type tests**: `*.test-d.ts` with `expect-type` and `@ts-expect-error`, checked by tsc. A stale directive
  is TS2578. `bun test` ignores these files on its own **[verified]**.
- **Codegen snapshots**: `toMatchSnapshot` against the mock fixtures.
- **Parity tests**: §7.4 rules, one mock workflow per rule, with the expected API JSON written from the frontend source.
- **Round-trip**: §10, on mock workflows.
- **Corpus tests** (`test/*.corpus.test.ts`, run by `bun run test:corpus`, local only): the same
  normalize, generate, compile and round-trip checks on whatever is in `internal/fixtures/corpus/`.
  `bun run test` and `check` skip them (`--path-ignore-patterns`), so the gate never depends on
  local data. An empty section reports one skipped test. Every phase exit requires them to pass.
- **`accepts` table**: shared by the runtime and type-level suites.

**Lint rules** (oxlint):
- `no-explicit-any`, `no-non-null-assertion`, `import/no-default-export`, `consistent-type-imports`
- type-aware: `no-floating-promises`, `no-unnecessary-condition`, `strict-boolean-expressions`,
  `switch-exhaustiveness-check`, `no-unsafe-*`
- `no-restricted-imports` for `node:*`, `bun` and `bun:*`, scoped to `packages/{core,codegen}/src/**`
- generated files excluded
- `unicorn/no-empty-file` off: tsc and the tests already catch an accidentally empty module

**Fixtures**: a committed mock set plus a local, uncommitted real corpus.

- **Committed mocks** (`internal/fixtures/mocks/`) are small and hand-written: one feature or edge case per file,
  named after what it covers (`dynamic-combo-nested.json`, `dotted-input-names.json`, …).
  - They are written by us, not copied, so they hold no personal data and no upstream text.
  - They stay stable when your models change, and a failure points straight at the cause.
  - Their **coverage comes from the real data**. Every fact in §16's dump row gets a mock: dotted
    ordinary names, nested DynamicCombo with a sibling-name collision, both Autogrow forms,
    MatchType inside an option, empty, upload, remote and numeric combos, unsafe-integer maxima,
    list outputs, duplicate output names, class names that aren't identifiers, odd hidden-input specs.
- **Local corpus** (`internal/fixtures/corpus/`, gitignored apart from its README) holds real data. `tscomfy generate --url …` already writes
  `object_info.json`, so populating it is one command against your server. Real workflows go there
  too (the UI's "Export (API)" output).
  - This catches what mocks can't: shapes nobody thought to write down. That gap is how
    comfy-workflows ended up tested against a 24-node hand-picked subset that missed most real-world cases.
- **The rule that connects them**: when a corpus run finds a new shape or failure, it gets distilled
  into a new committed mock (a regression test) before the fix lands. The mocks grow from real
  findings, and the repo never contains your data.
- **Scale**: `bench/` generates synthetic schemas of N nodes from the mock templates, so the speed
  budget (§6.6) doesn't depend on any real dump.

## 14. Phases

Each phase ends with `bun run check` and `bun run test:corpus` passing and a short demo. A phase isn't done while it has known `TODO`s.

**Phase 0: foundation**
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

**Phase 3: builder and API export**
- Graph IR, `workflow()`, `OutputRef`, node handles.
- Default filling, schema-driven flattening, `__value__` wrapping, `_meta`, frontend key order (§7.4).
- Research first, against the frontend version the corpus came from: how each value widget
  serializes (RESOLUTION_PREVIEW sets `serialize: false` and is absent from the corpus export;
  IMAGECOMPARE sends a value the schema has no default for; CURVE is wrapped as
  `{"__type__": "CURVE", …}`), and DynamicGroup, which frontend 1.55.17 has no handler for.

Exit: byte-stable API output; parity tests (§7.4) pass, one committed mock workflow
(`mocks/workflows/`) per rule, distilled from corpus exports. Re-exporting the corpus itself needs
the importer, so it is Phase 6's exit.

**Phase 4: CLI**
- `generate` (`--url` or `--from`), `check` (drift), the report.

Exit: an example project generates from the live server and builds `txt2img` end to end.

**Phase 5: validation**
- Everything in §8.

Exit: a negative test for every code; `toApi({ validate })`.

**Phase 6: API import and transpiler**
- `parse`, `importApi` (schema-driven un-flattening, `__value__` unwrap), `transpile`, CLI `transpile`.

Exit: every corpus API workflow re-exports byte for byte, key order included:
`stringify(toApi(importApi(parse(x))))` equals `stringify(parse(x))`. The transpiler round-trip
(§10) passes on the same corpus.

**Phase 7: graph operations**
- Everything in §12.

Exit: tests mirror the frontend algorithms case by case.

**Phase 8: UI format**
- Import (§11), then export, then the layout package.

Exit: the UI corpus imports and round-trips through API format; exported UI JSON opens in the frontend (checked by hand).

**Phase 9: polish**
- README and guides, examples, an API-surface snapshot (`dist/*.d.ts`), and (optionally) publishing under the `@tscomfy` npm org.

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

Checked on 2026-10-17 with Bun 1.4.3, Node 26.11.1, TS 7.0.2 and a local ComfyUI 0.41.0 (frontend 1.55.17).

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
| Type-checking cost at 1,758 / 3,516 / 7,032 nodes | 0.11 s / 0.13 s / 0.26 s |
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
| Input order (§9) | Frontend 1.55.17 `getOrderedInputSpecs` (`nodeDefOrderingUtil.ts`): listed required, listed optional, then remaining inputs in definition order; no `input_order`, definition order |
| `stringify`/`parse` round trip (§7.5) | `JSON.stringify(2 ** 64 - 2048)` is `"18446744073709550000"`, an integer literal that `parse` reads as a different bigint; `toExponential()` (`1.844674407370955e+19`) round-trips exactly. Found by `defineSchema` on the numbers mock |
| Non-finite numbers (§7.5) | `/object_info` is served by aiohttp `web.json_response`, whose default `json.dumps` writes `Infinity`/`NaN` (checked with the server's Python). None in the corpus dump today |
| Frontend and backend serialization rules (§7.4, §12) | From source: frontend 1.58 `executionUtil.ts`, `ExecutableNodeDTO.ts`, `dynamicWidgets.ts`; backend `execution.py`, `comfy_api/latest/_io.py`, `comfy_execution/validation.py` |
