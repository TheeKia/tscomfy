# Exporting and validating

A built workflow becomes the API-format prompt that `POST /prompt` takes. This guide covers the
functions that do it, what they check, and how problems are reported.

## The prompt

```ts
import { stringify, toApi } from "@tscomfy/core";

const prompt = toApi(built);
const body = stringify({ prompt, client_id: "my-app" });
```

`toApi` builds exactly what the ComfyUI frontend would send for the same graph, so a prompt
exported from tscomfy and one from "Export (API)" can be compared byte for byte:

- every widget input is sent, with its schema default when you left it out;
- links are `["<id>", <slot>]`;
- dynamic inputs are flattened to their wire keys: `format`, `format.codec`; `images.image0`,
  `images.image1`; `loras.0.lora_name`;
- list-valued widgets are wrapped as `{"__value__": [...]}`, CURVE values as
  `{"__type__": "CURVE", "__value__": …}`;
- each node has `inputs`, `class_type` and `_meta.title`, its keys in the frontend's order;
- bypassed and muted nodes are left out and links through them resolved, as the frontend does
  ([graph operations](graph-operations.md)).

Where tscomfy differs from the frontend, it does so on purpose: it never invents a value for an
optional widget without a default (the frontend would send `0`, `""` or the first option), and it
sends text as written, without the frontend's dynamic-prompt expansion and `%…%` replacement.

**Serialize with `stringify`, not `JSON.stringify`.** Prompts may hold `bigint` (seeds go up to
2^64 − 1), which `JSON.stringify` refuses; `stringify` writes them as exact JSON numbers and is
deterministic: the same prompt always gives the same bytes. `parse` is its counterpart and keeps
big integers exact when reading.

## Validation

`toApi` validates the prompt against the schema before returning it, the way the backend's
`validate_prompt` would, and throws a `ValidationError` when the backend would reject it:

```ts
import { ValidationError, toApi } from "@tscomfy/core";

try {
  toApi(built);
} catch (error) {
  if (!(error instanceof ValidationError)) throw error;
  for (const { code, path, message } of error.diagnostics) console.error(code, path, message);
}
```

The types catch most mistakes at compile time; validation catches what they can't express:

- numbers outside `min`/`max` (bigint-aware) and INT values that aren't integers;
- combo values that aren't options, element by element for multi-selects;
- links whose source node or slot doesn't exist, or whose type doesn't fit;
- MatchType inputs that disagree, dynamic-combo options that don't exist, Autogrow minimums,
  DynamicGroup row counts;
- unknown classes (including `raw` nodes the server doesn't have), unknown inputs, missing
  required inputs;
- cycles, and a prompt without an output node.

The ordering is deliberate: whatever compiles also passes validation, and whatever passes
validation is accepted by the backend. The types may be stricter than the backend, never looser.
What no schema states isn't checked: a node's own `VALIDATE_INPUTS` (`LoadImage` uses it to accept
annotated file names), and `step`, which the backend ignores.

### Without throwing

| Function | Returns |
|---|---|
| `toApi(workflow, options?)` | The prompt; throws `ValidationError` on any error |
| `exportApi(workflow, options?)` | `{ prompt, diagnostics }`: the prompt as far as it could be built, and every error and warning |
| `validate(workflow)` | The diagnostics alone |
| `validateApi(prompt, schema)` | The diagnostics of any prompt, such as one from another tool: it takes the parsed JSON, so read it with `parse` |

Warnings never make `toApi` throw, so `exportApi` (or `validate`) is how to see them. Typical
ones: `W_UNLISTED_COMBO_VALUE`, a file name an upload combo doesn't list (the file may be
uploaded later), and `W_LINK_DROPPED`, a link through a muted node.

### Options

| Option | Default | Effect |
|---|---|---|
| `validate` | `true` | `false` skips validation. Problems building the prompt itself (`E_INPUT_KEY_COLLISION`, `E_TOO_MANY_DYNAMIC_INPUTS`) are still reported, and `toApi` still throws for them |
| `meta` | `true` | `false` leaves out `_meta` |
| `modes` | `true` | `false` sends bypassed and muted nodes as if they ran |

## Diagnostics

Every function that reads or checks data returns diagnostics instead of throwing:

```ts
interface Diagnostic {
  readonly code: DiagnosticCode; // stable: "E_…" errors, "W_…" warnings
  readonly severity: "error" | "warning"; // fixed per code
  readonly path: readonly (string | number)[]; // into the document it is about
  readonly message: string; // for people; the wording may change, the code won't
}
```

Match on `code`, never on `message`. A path is a list of segments, so a dotted input name stays
one segment: `["5", "inputs", "format.codec"]` is node `5`, input key `format.codec` of the
prompt. Paths of the normalizer point into the `/object_info` document; those of the UI importer
point into the workflow file (`["nodes", 3]`, `["links", 7]`) or, once a node is read, at its id in
the prompt it builds. [The diagnostics reference](../diagnostics.md) lists every code, what it
means and what happens.

Only programmer errors throw, and they throw a `TypeError`: misuse of the builder (see
[building workflows](building-workflows.md#mistakes-the-types-cant-catch)), an output reference
nested inside a JSON value, a non-finite number given to `stringify`, a generated schema module
that was edited by hand.
