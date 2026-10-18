# ComfyUI serialization: ground truth

How the official frontend builds API prompts and how the backend reads them. Researched
2026-10-17 by reading source: frontend `Comfy-Org/ComfyUI_frontend` 1.58.0, backend
`Comfy-Org/ComfyUI` at the same date (server 0.41.0). Paths are relative to each repo; line
numbers are from those versions and will drift. Both projects are GPL-3.0: this file describes
behavior, it does not copy code.

This was the first pass. Each rule tscomfy implements was then re-read in frontend 1.55.17, the
version ComfyUI 0.41 installs, and checked in the running frontend: the export rules in plan
§7.4, bypass and mute in §12, and the UI format in `ui-format.md`, which supersedes the virtual
node and subgraph notes below.

Abbreviations: FE = frontend, BE = backend, `dW` = FE `src/core/graph/widgets/dynamicWidgets.ts`.

## Graph to API prompt

- Entry point: FE `src/utils/executionUtil.ts` `graphToPrompt` (around lines 59–207), called from
  `src/scripts/app.ts`.
- Every widget value is sent, unless the widget has no name or `options.serialize === false`.
  `serializeValue` is used when present.
- Link inputs come after widgets and overwrite a widget of the same name. An unconnected input
  with no widget is omitted.
- Links are `[origin_id, origin_slot]` with a **string** id. BE `comfy_execution/graph_utils.py`
  `is_link` requires `obj[0]` to be a `str`.
- Node ids: `[...subgraphPath, node.id].join(":")`, e.g. `"12:5"` (`ExecutableNodeDTO.ts`).
- Key order (inferred from JS semantics): integer-like ids first in ascending order, then
  `"a:b"` ids in insertion order.
- `_meta: { title }` is always emitted. The title defaults to display name (possibly localized).
- A final pass drops link inputs pointing at nodes missing from the prompt.

## List values

- Any array-valued widget is sent as `{"__value__": [...]}`. Curve widgets as
  `{"__type__": "CURVE", "__value__": ...}`.
- BE `execution.py` (around 996–1002) unwraps dicts containing `__value__` for schema-known,
  non-link inputs during validation.
- Lists come from multi-select combos (start at `[]`, FE ignores `default`) and list-valued
  defaults.

## Defaults at node creation (frontend)

- INT/FLOAT `default ?? 0` (no clamping to `min`); STRING `default ?? ""`; BOOLEAN
  `default ?? false`.
- COMBO: `default` if truthy, else `options[0]`; remote combos start as `"Loading..."`; an empty
  combo yields `undefined`, which drops the key from JSON.
- DynamicCombo starts at the first option key.
- `control_after_generate`: a separate combo widget with `serialize: false`, so never sent. Added
  when the option is set or the input is named `seed`/`noise_seed`. The prompt carries the current
  value; "after" mode mutates it after queueing, "before" mode before every queue but the first.

tscomfy deliberately fills only explicit schema defaults (plan §7.2).

## V3 dynamic inputs on the wire

- BE `comfy_api/latest/_io.py` `parse_class_inputs` walks the class schema, not the prompt keys.
  Ordinary inputs keep their full id (`finalize_prefix(None, id) == id`), so a name like
  `"input_blocks.0."` is never split. Only dynamic expanders build dotted names.
- **DynamicCombo**: the selected key goes under `name`; option inputs under `name.child`,
  recursively (`format`, `format.codec`, `format.codec.encoding`). If the key is missing, the BE
  adds nothing and raises no required-input error. FE `isInGroup` removes siblings whose names
  start with `name.`.
- **Autogrow**: `group.<names[i]>` (names form) or `group.<prefix><i>` (prefix form). The template
  input is forced to a socket, so only connected slots are sent. Slots with `i < min` are
  required. FE shows `min + 1` slots.
- **DynamicGroup**: `group.<row>.<field>`, rows from 0, decimal without leading zeros, below
  `max`, row count within `[min, max]`. Bad keys fail with `invalid_dynamic_input`.
- **DynamicSlot**: BE only; no FE handler; no node in the 0.41.0 dump uses it.
- **MatchType**: an ordinary key. The FE narrows the socket type at runtime; outputs start as `*`.

## Bypass and mute

- Both modes are skipped in output; a bypassed or muted subgraph node is not expanded.
- **Mute**: resolving through a muted node yields nothing, so the dependent's input is omitted
  while the dependent itself is still emitted (the BE then reports `required_input_missing`).
- **Bypass** (`ExecutableNodeDTO.ts` `_getBypassSlotIndex`), checked against the type the link
  must have (first the consumer's input type, then at each bypassed node the type of the input
  passed through, since `resolveInput` passes no type on), in order:
  1. target type `*` or empty: the input at the same index, else input 0;
  2. the same-index input, if valid for both the output type and the target type;
  3. the first input whose type equals the target type exactly;
  4. the first input valid for both;
  5. otherwise drop the input, with a warning.

  Resolution recurses, so an unconnected widget input means the value is dropped. Validity
  (`LiteGraphGlobal.ts` `isValidConnection`) treats `*`/`""` as wildcards and splits comma types.
  Input index order: socket-only inputs first, then widget-backed sockets.
- A muted or bypassed SubgraphNode nested inside another subgraph still has its inner nodes
  expanded and sent (confirmed in the running frontend 1.55.17; `ui-format.md`,
  `W_FRONTEND_QUIRK`).

## Virtual nodes and subgraphs

- Virtual: PrimitiveNode, Reroute, Note, MarkdownNote, SubgraphNode.
- PrimitiveNode copies its value into target widgets before serialization; the target's own widget
  value is what gets sent.
- Reroute resolves through to the upstream link and keeps the downstream type.
- Note and MarkdownNote are never emitted.
- Subgraph inputs resolve to the outer link; an unconnected promoted input uses the promoted
  widget's value. Outputs resolve via `_resolveSubgraphOutput`.

## Backend validation (`execution.py`)

- Only schema inputs are validated; **unknown constant keys are ignored** and dropped from kwargs.
  **Unknown link-valued keys still pull in their source node** (`graph.py` `add_node`) and are
  passed as kwargs.
- Only output nodes (optionally filtered by `partial_execution_targets`) and their ancestors are
  validated and executed. Disconnected nodes don't run, but every node must have a known
  `class_type` or the whole prompt is rejected.
- If some outputs fail, the prompt is still accepted with `node_errors`; it is rejected only if no
  output passes.
- Values are coerced with `int()`, `float()`, `str()`, `bool()`; then min, max and combo membership
  are checked (multi-select element-wise). Nodes with `VALIDATE_INPUTS` taking an input skip the
  built-in checks for it.
- Type compatibility, `comfy_execution/validation.py` `validate_node_input` (non-strict): equal
  passes; `*` on either side passes; MatchType passes; an option-list output into COMBO passes;
  otherwise comma sets must overlap.
- Unknown class types may first be rewritten by a node-replacement manager (`server.py`).

## Frontend-only transforms at queue time

The builder and `toApi` replicate neither; `importUi`, which reproduces what the frontend would
queue for a saved file, replicates the `%Node.widget%` substitution (plan §11).

- `dynamicPrompts` STRING inputs: `{a|b}` resolved to a random choice, `/* */` and `//` comments
  stripped (which truncates `http://`). FE `dynamicPrompts.ts`, `formatUtil.ts`.
- Save nodes: `%…%` substitution in `filename_prefix` (FE `saveImageExtraOutput.ts`).
- Upload, preview and refresh helper widgets are `serialize: false`; the combo value is still sent.
- `advanced`, `hidden`, `socketless`, `widgetType` don't change serialization. `forceInput` means no
  widget exists.

## Request body (`api.ts`)

`{ client_id, prompt, partial_execution_targets?, extra_data: { auth_token_comfy_org,
api_key_comfy_org, comfy_usage_source, extra_pnginfo: { workflow }, preview_method? },
front? | number? }`. Relevant only to clients that queue prompts, which tscomfy doesn't.
