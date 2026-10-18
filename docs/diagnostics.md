# Diagnostics

Every diagnostic tscomfy reports, by code. The model is in [plan §5.4](plan.md#54-diagnostics)
and [ADR-0014](decisions/0014-diagnostic-model.md): a stable code, a severity fixed per code
(`E_` errors, `W_` warnings), a path of segments and a message. Codes are never reused for a
different meaning. A test keeps this list and `DIAGNOSTIC_CODES` in sync, and each code has a
negative test that checks its path.

Paths of parser and normalizer diagnostics point into the raw document, e.g.
`["KSampler", "input", "required", "seed", 1, "max"]`.

## Parsing

| Code | Meaning | What happens |
|---|---|---|
| `E_INVALID_JSON` | The text is not valid JSON. The path is empty; the message has the parser's reason. | No value. |
| `W_NON_FINITE_NUMBER` | `NaN`, `Infinity` or `-Infinity` (not JSON, but Python servers write them for non-finite floats), or a literal with a fraction or an exponent beyond the double range (`1e400`; an integer literal stays exact as a `bigint`, or, without source-text access, becomes `null` too). | Read as `null`, which the normalizer treats as unset: an infinite bound is no bound. |
| `W_PRECISION_LOSS` | An integer beyond 2⁵³ was parsed on a runtime without `JSON.parse` source-text access, so it may have been rounded. | The rounded number is kept. The normalizer then moves such bounds inward by one double. |

## Normalizing `/object_info`

| Code | Meaning | What happens |
|---|---|---|
| `E_INVALID_OBJECT_INFO` | The document is not an object of node definitions. | Empty schema. |
| `E_INVALID_NODE` | A node can't be used: it isn't an object, its `input`, `input.required` or `output` is unreadable, or an output type is unusable: neither a string nor an option list, an empty string, or an option list with an option that isn't a string, number or boolean. | The node is dropped. |
| `W_INVALID_NODE_FIELD` | A descriptive node field is missing or has the wrong type (`display_name`, `category`, `python_module`, `output_node`, flags, `input_order`); an `output_*` array doesn't match `output`; a MatchType output names no template. | A default is used for that field or slot; a MatchType output without a template connects like `*`. |
| `W_NODE_NAME_MISMATCH` | The node's `name` differs from the key it is listed under. | The key is used: prompts address nodes by it. |
| `E_INVALID_INPUT_SECTION` | `input.optional` is not an object. | Its inputs are dropped. |
| `E_DUPLICATE_INPUT` | An input name appears twice: in both `required` and `optional` (the backend reads `required`), or in both sections of a dynamic option or a DynamicGroup's template. | The required (first) one is kept, the other dropped. |
| `W_INPUT_ORDER_MISMATCH` | `input_order` names an input the node doesn't declare, or leaves one out. | The frontend's order: listed required inputs, then listed optional ones, then every unlisted input. |
| `W_INVALID_INPUT_SPEC` | An input spec can't be interpreted: not a `[type, options?]` list, a type that isn't a string or option list, an empty type, a dynamic input missing its payload or with counts outside the backend's limits, an Autogrow whose template is a dynamic input, a DynamicGroup with fields the backend doesn't allow there (sockets, `forceInput`, dynamic inputs, dotted names) or none it sends, or a legacy combo with an option that isn't a string, number or boolean (its links match the full list). | The input is kept as `unknown`. |
| `W_UNSUPPORTED_INPUT_TYPE` | The input uses a `COMFY_…_V3` dynamic type this version doesn't know. | The input is kept as `unknown`. |
| `W_INVALID_INPUT_OPTION` | One option of a readable spec is invalid: wrong type; a combo option that isn't a string, number or boolean; a default the backend would reject (not one of the combo's options, outside `min`/`max`, a list for INT or FLOAT); a malformed or duplicate dynamic-combo option. | That option is ignored. A combo with no listed options keeps its default, since membership can't be checked. |

## Exporting prompts

Paths of export diagnostics point into the prompt: a node id, `inputs`, and the wire key.

| Code | Meaning | What happens |
|---|---|---|
| `E_INPUT_KEY_COLLISION` | Two inputs of one node send the same wire key: a flattened dynamic key such as `format.codec` equals another input's name. | The first is kept; `toApi` throws a `ValidationError`. |
| `W_LINK_DROPPED` | A link resolves to nothing through bypassed or muted nodes (plan §12): it comes from a muted node; or from a bypassed node with no input for the type, whose chosen input isn't linked, or that loops back through bypassed nodes (where the frontend throws). | A widget sends its value instead (its default), as the frontend does; any other input is left out, and validation reports it if it is required. |
| `E_TOO_MANY_DYNAMIC_INPUTS` | An Autogrow is given more slots than it has, or a DynamicGroup more rows than its `max`. The generated types prevent it; untyped code can still do it. Validation reports the same for a prompt with a group key in a row at or past `max`. | The extra entries aren't sent; `toApi` throws a `ValidationError`. |

## Validating prompts

Validation diagnostics come node by node in prompt order (the node's class, its keys as they expand, then each input
in input order), then for the prompt as a whole. Paths of validation diagnostics point into the
prompt, like export paths: `[id, "inputs", key]`
for an input, `[id, "class_type"]` for a node's class, `[id]` for a cycle through it and `[]` for
the whole prompt. An error is something the generated types reject too, or something they can't
express that the backend rejects; a warning is something the types accept that the backend
takes, but may not do what was meant.

| Code | Meaning | What happens |
|---|---|---|
| `E_INVALID_PROMPT` | A prompt node isn't an object with a `class_type` string and an `inputs` object; the path is `[]` when the prompt itself isn't an object. | The node is skipped; links to it aren't type-checked. |
| `E_UNKNOWN_CLASS_TYPE` | A node's class type isn't in the schema: a `raw()` node, or a pack the server doesn't have. The backend rejects the whole prompt. | The node's inputs aren't checked; links from it aren't type-checked. |
| `E_NO_OUTPUT_NODE` | No node is an output node (save, preview, …). The backend rejects the prompt: it would run nothing. | — |
| `E_UNKNOWN_INPUT` | A key the node doesn't have, after dynamic inputs are expanded: a misspelling, an Autogrow slot past the last one, a DynamicGroup key that isn't `<group>.<row>.<field>`. The backend ignores unknown values but still follows unknown links. | — |
| `E_MISSING_INPUT` | A required input has no value or link, including the first `min` slots of an Autogrow whose template is required and the required fields of a DynamicGroup row that is present. | — |
| `E_INVALID_LINK` | A list, which the backend reads as a link, that isn't `[node id (string), output slot (integer ≥ 0)]`. | — |
| `E_DANGLING_LINK` | A link to a node the prompt doesn't have, or to an output slot its node doesn't have. | — |
| `E_TYPE_MISMATCH` | A link from an output whose type the input doesn't accept (`accepts`, §5.2), including a MatchType input linked to a type its template doesn't allow. A MatchType output has the type linked at its template's inferring input, or `*` while that input is empty, as in the generated types. | — |
| `E_MATCH_TYPE_MISMATCH` | An input of a MatchType template is linked to a type that doesn't agree with the template's inferring input: the one the generated types infer from (its first position, depth-first through every dynamic-combo option; slot 0 of an Autogrow). Nothing is checked while that input is empty or `*`. The backend doesn't check this; the node would get mismatched values. | — |
| `E_NOT_A_LINK` | A value for an input that only takes links (a socket, a MatchType input, an Autogrow slot). | — |
| `E_INVALID_VALUE` | A value of the wrong kind: not a number for INT or FLOAT, a number that isn't finite (only a prompt built in memory holds one), an integer too large for a FLOAT (Python's `float()` overflows), not a string or boolean, `null`, a list for a single-select combo, an option that isn't a string, number or boolean, a dynamic-combo choice that isn't a string (a link, a wrapped value), which the backend drops with its option inputs. | — |
| `W_NON_INTEGER_VALUE` | A fractional number for an input typed exactly INT. The types allow `number`; the backend's `int()` truncates it. (An INT widget on another type isn't coerced, and is compared as it is.) | Truncated before the range check, as the backend does. |
| `E_OUT_OF_RANGE` | A number below `min` or above `max`, compared exactly (bigint-aware). | — |
| `E_NOT_IN_COMBO` | A value that isn't one of a combo's options; for a multi-select, each element is checked. | — |
| `W_UNLISTED_COMBO_VALUE` | The same for an upload or remote combo, or one with no options: its options are runtime state, so the value may well exist. | — |
| `E_UNKNOWN_DYNAMIC_OPTION` | A dynamic combo set to a key it doesn't have. The backend then drops the input and its option inputs without a word. | Keys under it aren't reported again. |
| `E_TOO_FEW_DYNAMIC_INPUTS` | A DynamicGroup with fewer rows than its `min`. | — |
| `E_DEPENDENCY_CYCLE` | Nodes that depend on each other through their links. | One diagnostic per back edge the search meets (two inputs linked to the same node are one edge), at the node it returns to. |

## Importing prompts

`importApi` reads a prompt back into a workflow (plan §10). Its paths point into the prompt, as
validation's do. It also reports the parser's codes (`E_INVALID_JSON`, `W_NON_FINITE_NUMBER`,
`W_PRECISION_LOSS`), `E_INVALID_PROMPT` (a node it can't read, or with an empty id, is left out)
and `E_INVALID_LINK` (the input is left out).

| Code | Meaning | What happens |
|---|---|---|
| `W_IMPORTED_AS_RAW` | A node of a known class whose wire keys don't fold back into structured inputs: a DynamicGroup with rows missing in between or at or past its `max`, keys under a dynamic combo set to a key it doesn't have, a group key that isn't `<group>.<row>.<field>`, a key two inputs would send, the key of a widget the frontend never sends (display-only, or CameraAngle's optional `view`), which the generated types have no input for. From `importUi`: a linked node of a class the schema doesn't have, or of one the frontend can't create (see `W_UNKNOWN_UI_CLASS`). | The node is kept as a raw node with its wire keys, so it exports as it came. `importUi` keeps the class, the links and the values saved by name; the frontend sends such a node without a class, which the backend rejects. |

## Importing UI workflows

`importUi` reads a UI workflow (plan §11) into the workflow the frontend would queue. Its paths
use two conventions:
- **A node as sent**, and its inputs, by its id in the imported workflow, which joins the ids of
  the subgraph instances it sits in: `["40:31"]`, `["5", "inputs", "positive"]`.
- **A node of the file**, which every instance of a definition shares, by its id in its graph:
  `["5", "widgets_values"]` at the root, and `["definitions", "subgraphs", <definition id>, <node
  id>, …]` inside a definition, with inner ids as reminted (see `E_INVALID_WORKFLOW`). An entry
  that can't be read is named by its position: `[…, "nodes", <index>]`, `[…, "links", <index>]`.

It also reports the parser's codes and `W_IMPORTED_AS_RAW`.

| Code | Meaning | What happens |
|---|---|---|
| `E_INVALID_WORKFLOW` | The file isn't an object with a `nodes` list; a node or link can't be read (a node needs an id, an integer or a string, and a type; a link is a tuple in format 0.4 and an object otherwise); or a subgraph contains itself, directly or through others. | An unreadable file gives an empty workflow, and so does a subgraph that contains itself, which the frontend refuses to load. An unreadable node or link is left out; a tuple link in a format 1 file too, as the frontend drops it. A repeated node id is not an error: as in the frontend, the later node gets the next free id at the root and is dropped inside a definition. |
| `E_LEGACY_GROUP_NODE` | A node is a legacy group node (`workflow>Name`, defined in `extra.groupNodes`), which the frontend converts into a subgraph when it loads the file. | The conversion isn't supported: the node is kept raw, so the prompt differs from the frontend's. |
| `W_UNRESOLVED_LINK` | An input is linked from a node the graph doesn't have, or through Reroutes or subgraph boundaries that loop back on themselves. The frontend refuses to build a prompt for either. | The input is left out. |
| `W_WIDGET_VALUES_MISMATCH` | A node's saved widget values don't fit its definition: a different number of values by position and none by name (a pack's own widgets, a file older than the definition), or values by name that disagree with the ones by position. | Values are read by position, as the frontend reads them; widgets without one keep their initial values. When the positions don't fit and names are saved, the names are used (that case isn't reported: frontend 1.55 saves names for pack widgets the schema can't predict). |
| `W_FRONTEND_QUIRK` | The file relies on frontend behavior that looks unintended: a muted or bypassed subgraph inside another subgraph, whose interior the frontend still sends; a PrimitiveNode linked to a subgraph's promoted input, whose value never reaches it; or an input linked through two instances of one subgraph in a row, where the frontend's loop check refuses to build the prompt; or two nodes whose ids are the same once subgraph interiors are expanded (a root node `"40:31"` and node 31 inside instance 40), where the frontend keeps the later one. | Reproduced as the frontend does it, so the prompt matches the frontend's; the last is resolved through both instances. |
| `W_NODE_LEFT_OUT` | A node of a class the schema doesn't have is linked to nothing: a pack's frontend-only node (a label, a group toggle), or a missing class. | The node is left out, which changes nothing else in the prompt. |
| `W_QUEUE_TIME_VALUE` | A save node's `filename_prefix`, or a PrimitiveNode that replaces text, holds `%date:…%`, which the frontend replaces with the time it queues the prompt; or a widget's value is one the frontend's core extensions compute when it queues (a 3D scene from `LOAD_3D` or `LOAD_3D_ADVANCED`, a webcam frame from `WEBCAM`, a recording from `AUDIO_RECORD`). (`importUi` replaces `%Node.widget%` references, as the frontend does; `toUi` reports them too, see below.) | The pattern is sent as written; a computed value is left out. |
| `W_EXTENSION_WIDGETS` | A node's class gets widgets from frontend JavaScript that its definition doesn't describe (CustomCombo's option fields and `index`), so its saved values and what the frontend sends for them can't be reproduced. `toUi` reports it too. | The widgets the definition declares are read and sent; the others are left out (on export, not written). |

## Exporting UI workflows

`toUi` writes a workflow as a UI workflow (plan §11). Paths point into the workflow, as the
exporter's do. It also reports `W_QUEUE_TIME_VALUE`, for a save node's `filename_prefix` holding
`%date:…%` or `%Node.widget%` (it is written as given, and the frontend sends the replaced text)
and for a value given to a widget the frontend computes when it queues (not written), and
`W_EXTENSION_WIDGETS`.

| Code | Meaning | What happens |
|---|---|---|
| `W_UNKNOWN_UI_CLASS` | A node's class isn't in the schema, or the frontend can't create a node of it (its upload combo is named `upload` or is `forceInput`, or an input asks for an upload button directly: the button's constructor throws), so its slots and widgets can't be laid out as the frontend lays them out. | Its links and its values by name are written; the frontend shows it as missing, and `importUi` reads it back raw. |
| `W_UNSAFE_INTEGER` | A widget value holds an integer outside ±(2^53 − 1), which tscomfy keeps as a bigint (a seed up to 2^64−1). A `number`, however large, round-trips. | The value is written exactly, but the frontend's JSON parser rounds it, so the frontend queues a different number. `importUi` reads it exactly. |
| `W_UI_VALUE_LOST` | An input has nowhere to go in a UI workflow: a DynamicGroup row (frontend 1.55.17 has no widgets for them), a widget the frontend doesn't save (IMAGECOMPARE) or doesn't send (CAMERA_ANGLE_VIEW, an upload button), an input an upload button replaces, or a widget the frontend renames because an earlier widget has its name (`width#1` after a BOUNDING_BOX), which it then sends under that name; or a link to a node the workflow doesn't have (from an imported prompt). | The value isn't written where the frontend would send it; the frontend sends its own value for it, or nothing. |

## Generating types

Paths of codegen diagnostics are a class type followed by the input names leading to the input,
with dynamic-combo option keys in between, e.g. `["SaveVideo", "format", "mp4", "codec"]`.

| Code | Meaning | What happens |
|---|---|---|
| `W_EMPTY_COMBO` | A combo lists no options (no model files installed, an empty folder) and isn't remote. | Its values are typed as `string`. |
| `W_UNTYPED_INPUT` | An input the normalizer kept as `unknown`. | Its value is typed as `unknown`. |

## Transpiling

`transpile` writes builder code for a workflow (plan §10). Its paths point into the workflow's
nodes, by id. It also reports `E_DEPENDENCY_CYCLE` (no program can build a cycle; nodes on one, and
nodes that depend on one, are left out), `E_DANGLING_LINK` (a link to a node the workflow doesn't
have; the input is left out) and whatever the exporter reports.

| Code | Meaning | What happens |
|---|---|---|
| `W_TRANSPILED_AS_RAW` | A node of a known class whose inputs the generated types can't express: a value or link they refuse (a legacy combo linked from an option list, a link into a socketless widget, a MatchType input that disagrees with the inferring one), an input the class doesn't have, a missing required input, a link to an output the node doesn't have. | The node is written as `raw(…)` with its wire keys, so the program still builds the same prompt. |
