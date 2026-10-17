# tscomfy: implementation plan

> Packages: `@tscomfy/core`, `@tscomfy/codegen`, `@tscomfy/cli` (bin: `tscomfy`). MIT.
> Publishing is not a priority. Status: revision 2 after a verification round, 2026-10-17. **Phase 0 complete.**
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
| D10 | **Lossless integers.** INT accepts `number \| bigint`. Our own small deterministic serializer writes bigint as a JSON number. The importer reads big ints via `JSON.parse` source-text access | Seeds go up to 2⁶⁴−1, and 102 INT inputs in the real dump have `max` beyond 2⁵³. **[verified]** in Bun 1.4.3 and Node 26. |
| D11 | **oxfmt formats, oxlint lints** (`--type-aware` via tsgolint, built on TS 7) | One toolchain. oxlint's type-aware rules are as accurate as tsc and catch cross-package cases Biome's linter misses. oxfmt is 0.x, so it is pinned exactly. **[verified]** |
| D12 | **No CI for now.** `bun run check` is the single local gate | Your request. Adding CI later means running the same script. |
| D13 | **The generated runtime schema is a `.ts` module holding `JSON.parse("…")`**, not a JSON import | A 3.4 MB JSON import costs 142 MB and 0.2 s of type-checking on every check. The `JSON.parse` module costs 20 MB and 0.02 s, needs no copy step and no `resolveJsonModule`. **[verified]** |

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
  schema/       Schema model, SocketType, accepts()
  graph/        IR, builder, OutputRef
  api/          export (flatten, defaults, __value__), import (schema-driven un-flatten)
  validate/     diagnostics
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
GET /object_info ─► normalizeObjectInfo() ─► { schema: Schema, diagnostics }
                                               ├─► emitTypes()        → nodes.ts   (types only)
                                               └─► emitSchemaModule() → index.ts   (runtime schema + typed export)

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

```ts
interface Schema {
  readonly formatVersion: 1;
  readonly source: { readonly hash: string; readonly comfyVersion?: string };
  readonly nodes: Readonly<Record<string, NodeDef>>;   // key = class_type, exactly as on the server
}

interface NodeDef {
  readonly classType: string;
  readonly displayName: string;
  readonly category: string;
  readonly pythonModule: string;
  readonly description?: string;
  readonly outputNode: boolean;
  readonly isInputList: boolean;          // node-level is_input_list (42 nodes in the real dump)
  readonly deprecated?: boolean;
  readonly experimental?: boolean;
  readonly inputs: readonly InputDef[];   // ordered by input_order; hidden inputs dropped
  readonly outputs: readonly OutputDef[]; // index = slot, never filtered
}

type InputDef =
  | SocketInput                 // custom types, "*", comma unions, forceInput widgets
  | IntInput | FloatInput | BooleanInput | StringInput
  | ComboInput                  // legacy [[…]] and ["COMBO",{options}] unified; numeric options kept;
                                //   flags: multiselect, upload, remote; options may be empty
  | AutogrowInput               // prefix form (array) or names form (record); min/max; template input
  | DynamicComboInput           // options[] → { key, inputs: InputDef[] }   (recursive)
  | DynamicGroupInput           // row template InputDef[]; min/max (upstream calls it unstable)
  | MatchTypeInput              // templateId + allowed SocketType
  | UnknownInput;               // spec we couldn't interpret; kept so later stages degrade gracefully

type SocketType =
  | { readonly kind: "named"; readonly name: string }
  | { readonly kind: "union"; readonly names: readonly string[] }   // "IMAGE,MASK", V3 MultiType
  | { readonly kind: "any" };                                       // "*"

interface OutputDef {
  readonly index: number; readonly name: string; readonly type: SocketType | { readonly kind: "combo" };
  readonly isList: boolean; readonly matchTemplate?: string;   // from output_matchtypes
}
```

Every input carries `name`, `required`, `tooltip?`, `default?` (only when the schema states one),
widget constraints (`min`, `max`, `step`, `multiline`, …) and `lazy`/`rawLink` flags. DynamicSlot
is backend-only, unused by the frontend and absent from the dump; it maps to `UnknownInput` until a real node needs it.

### 5.2 Type compatibility

`accepts(input, output)` follows the backend's `validate_node_input`, non-strict:
- `*` on either side passes.
- MatchType passes (it is checked at template level instead).
- A combo-list output into a combo input passes.
- Comma sets pass when they overlap.

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

## 6. Generated types

Everything in this section was prototyped against the real 1,758-node dump. **[verified]**

### 6.1 Generated files

`tscomfy generate --url http://127.0.0.1:8188 --out src/comfy/local` writes:

```
src/comfy/local/
  object_info.json   # raw snapshot: offline regeneration (--from), drift diffs. Never imported.
  nodes.ts           # types only: interface Nodes + input interfaces + combo aliases
  index.ts           # export const local: TypedSchema<Nodes> = defineSchema<Nodes>(JSON.parse("…"))
```

Every file starts with a header: generator version, source hash, ComfyUI version, the command to regenerate.

### 6.2 Encoding

```ts
declare const socket: unique symbol;
interface Out<T extends string> { readonly [socket]: T; readonly node: NodeId; readonly slot: number }
type In<T extends string> = Out<T | "*">;     // what a socket of type T accepts
```

| Schema | TypeScript |
|---|---|
| socket `MODEL` | `In<"MODEL">` (an any-typed `Out<"*">` fits) |
| socket `IMAGE,MASK` | `Out<"IMAGE" \| "MASK" \| "*">` |
| socket `*` | `Out<string>` |
| INT | `number \| bigint \| In<"INT">` (a widget also takes a link) |
| FLOAT / STRING / BOOLEAN | `number` / `string` / `boolean`, each `\| In<…>` |
| `forceInput` widget | link only |
| combo | literal union alias `\| In<"COMBO">`. Identical option lists are **deduplicated into named aliases** (`SamplerName`, `CkptName`; 363 aliases cover 1,413 combo inputs in the dump) |
| multiselect combo | `readonly (Alias)[]` |
| upload or remote combo | `Alias \| (string & {})`: the options are runtime state (input folder contents), so this keeps autocomplete without false errors |
| empty combo (36–55 in the dump) | `string`, plus a codegen diagnostic |
| input with an explicit schema default | optional (`?:`); the exporter fills it in |
| Autogrow, prefix form | `readonly T[]` |
| Autogrow, names form | `{ readonly a: T; readonly b?: T }` (first `min` names required) |
| DynamicCombo | discriminated union: `{ option: "mp4"; inputs: {…} }`, or a bare `"flac"` string when that option needs no inputs. Recursive (§6.4) |
| DynamicGroup | `readonly { field: … }[]` |
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
- **More**: a readonly tuple, plus named aliases, plus `NodeHandle`, so both `const [model, clip, vae] = …`
  and `ckpt.CLIP` work.
- Output names are left out of the aliases (reachable by index only) when they are duplicated, reserved
  (`id`, `node`, `slot`, Array members like `length` and `map`) or numeric-like.

**JSDoc** comes from tooltip, default, min/max/step, display name, category and description.
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

TS 7.0.2 with the full strict config, a 20-node workflow plus type tests **[verified]**:

| Nodes in schema | Check time | Total | Memory |
|---|---|---|---|
| 1,758 (real) | 0.09 s | 0.11 s | 103 MB |
| 3,516 | 0.09 s | 0.13 s | 137 MB |
| 7,032 | 0.18 s | 0.26 s | 207 MB |

This retires the biggest risk from revision 1. A `bench:types` script keeps a regression budget:
**≤ 0.5 s total and ≤ 300 MB at 7k nodes**.

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
| A list-valued widget is sent as `{"__value__": [...]}`, because the backend reads a bare list as a link | Same; the importer unwraps it |
| `_meta.title` is always present (title, or display name) | Same (`toApi({ meta: false })` turns it off) |
| control_after_generate is never sent (its widget has `serialize: false`) | Not modeled; seeds are plain values |
| Autogrow sends connected slots only (`images.image0`, …) | Same |
| DynamicGroup keys are `group.<row>.<field>` | Same |
| **The frontend resolves `{a\|b}` dynamic prompts and strips `/* */` and `//` comments** in `dynamicPrompts` STRING inputs, so `http://` gets truncated | **We don't** (determinism, fidelity). An opt-in `dynamicPrompt()` helper may come later. Documented. |
| **The frontend substitutes `%…%`** in save-node `filename_prefix` values | **We don't**; the text is sent verbatim. Documented. |

### 7.5 Serialization

- `toApi()` returns a plain `ApiPrompt` object, which may hold `bigint`.
- `stringify()` is our own deterministic serializer: stable key order, bigint as a JSON number.
- `parse()` keeps big integers through `JSON.parse` source-text access. On runtimes without it,
  ints above 2⁵³ produce `W_PRECISION_LOSS`.

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

## 9. Codegen

- **Normalizer** (core): lenient per field. One bad node or spec yields a diagnostic and an `UnknownInput`,
  never a crash. It covers:
  - legacy and v2 combos
  - every V3 dynamic type (including `output_matchtypes` and `input_order`)
  - hidden inputs, whose specs can be strange (`"STRING,[object Object]"` occurs in the dump)
- **emitTypes** (codegen): a small internal `CodeWriter`. Output is deterministic and already
  oxfmt-formatted; generated files are excluded from linting. Identifiers for interfaces and combo aliases:
  - derived from input names, sanitized
  - de-duplicated with stable suffixes
  - **328 class names in the dump are not valid identifiers**; they stay as quoted keys
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
    bench/                 # type-check speed harness, synthetic schemas (Phase 2)
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
- `test`: `bun test --conditions=@tscomfy/source`
- `lint`: `oxlint --type-aware`
- `format`: `oxfmt` (format and sort imports); `format:check`: `oxfmt --check`
- `bench:types`
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
- **Corpus tests** (`bun run test:corpus`, local only): the same normalize, generate, compile and
  round-trip checks on whatever is in `internal/fixtures/corpus/`. They are skipped when it's empty.
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

Each phase ends with `bun run check` passing and a short demo. A phase isn't done while it has known `TODO`s.

**Phase 0: foundation**
- `git init`; the workspace skeleton exactly as in §13; ADRs for §3.
- Write the first mock fixtures (§13 list); fill the local corpus from your server, plus a few
  real workflows exported from the UI.

Exit: empty packages build, lint, format-check and test; mock fixtures are committed; the corpus is gitignored.

**Phase 1: schema and normalizer**
- The `core` Schema model, `SocketType`, `accepts`, and `object-info/normalize` covering every kind in §5.1.

Exit: every mock node, and every node in the local corpus, either normalizes or yields a precise
diagnostic; snapshot tests; the `accepts` table suite.

**Phase 2: type emitter**
- `codegen.emitTypes` and `emitSchemaModule`, using the encoding in §6, which the spike already validated.
- Combo alias naming; JSDoc.

Exit: generated output for every mock and for the local corpus compiles; type tests cover every row of §6.2 and every
case in §6.3–6.4; `bench:types` is within budget.

**Phase 3: builder and API export**
- Graph IR, `workflow()`, `OutputRef`, node handles.
- Default filling, schema-driven flattening, `__value__` wrapping, `_meta`, `stringify`.

Exit: byte-stable API output; parity tests (§7.4) pass; corpus workflows exported from your UI
re-export identically.

**Phase 4: CLI**
- `generate` (`--url` or `--from`), `check` (drift), the report.

Exit: an example project generates from the live server and builds `txt2img` end to end.

**Phase 5: validation**
- Everything in §8.

Exit: a negative test for every code; `toApi({ validate })`.

**Phase 6: API import and transpiler**
- `parse`, `importApi` (schema-driven un-flattening, `__value__` unwrap), `transpile`, CLI `transpile`.

Exit: the round-trip corpus passes.

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
| Dump facts used in this plan | 851 dotted ordinary input names; 193 DynamicCombo inputs (189 nested dynamics; 111/608 options have no inputs; a `codec` vs `format.codec` collision); 57 Autogrow (19 names form); 17 MatchType; 102 INT with max > 2⁵³; 328 class names that aren't identifiers; 72 list outputs; 2 nodes with duplicate output names |
| Frontend and backend serialization rules (§7.4, §12) | From source: frontend 1.58 `executionUtil.ts`, `ExecutableNodeDTO.ts`, `dynamicWidgets.ts`; backend `execution.py`, `comfy_api/latest/_io.py`, `comfy_execution/validation.py` |
