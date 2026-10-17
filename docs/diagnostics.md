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
| `W_NON_FINITE_NUMBER` | `NaN`, `Infinity` or `-Infinity` (not JSON, but Python servers write them for non-finite floats), or a number literal beyond the double range. | Read as `null`, which the normalizer treats as unset: an infinite bound is no bound. |
| `W_PRECISION_LOSS` | An integer beyond 2⁵³ was parsed on a runtime without `JSON.parse` source-text access, so it may have been rounded. | The rounded number is kept. The normalizer then moves such bounds inward by one double. |

## Normalizing `/object_info`

| Code | Meaning | What happens |
|---|---|---|
| `E_INVALID_OBJECT_INFO` | The document is not an object of node definitions. | Empty schema. |
| `E_INVALID_NODE` | A node can't be used: it isn't an object, its `input`, `input.required` or `output` is unreadable, or an output type is (an empty string, or an option list with an option that isn't a string, number or boolean). | The node is dropped. |
| `W_INVALID_NODE_FIELD` | A descriptive node field is missing or has the wrong type (`display_name`, `category`, `python_module`, `output_node`, flags, `input_order`); an `output_*` array doesn't match `output`; a MatchType output names no template. | A default is used for that field or slot; a MatchType output without a template connects like `*`. |
| `W_NODE_NAME_MISMATCH` | The node's `name` differs from the key it is listed under. | The key is used: prompts address nodes by it. |
| `E_INVALID_INPUT_SECTION` | `input.optional` is not an object. | Its inputs are dropped. |
| `E_DUPLICATE_INPUT` | An input name appears twice: in both `required` and `optional` (the backend reads `required`), or in both sections of a dynamic option. | The required (first) one is kept, the other dropped. |
| `W_INPUT_ORDER_MISMATCH` | `input_order` names an input the node doesn't declare, or leaves one out. | The frontend's order: listed required inputs, then listed optional ones, then every unlisted input. |
| `W_INVALID_INPUT_SPEC` | An input spec can't be interpreted: not a `[type, options?]` list, a type that isn't a string or option list, an empty type, a dynamic input missing its payload or with counts outside the backend's limits, or a legacy combo with an option that isn't a string, number or boolean (its links match the full list). | The input is kept as `unknown`. |
| `W_UNSUPPORTED_INPUT_TYPE` | The input uses a `COMFY_…_V3` dynamic type this version doesn't know. | The input is kept as `unknown`. |
| `W_INVALID_INPUT_OPTION` | One option of a readable spec is invalid: wrong type; a combo option that isn't a string, number or boolean; a default the backend would reject (not one of the combo's options, outside `min`/`max`, a list for INT or FLOAT); a malformed or duplicate dynamic-combo option. | That option is ignored. A combo with no listed options keeps its default, since membership can't be checked. |

## Exporting prompts

Paths of export diagnostics point into the prompt: a node id, `inputs`, and the wire key.

| Code | Meaning | What happens |
|---|---|---|
| `E_INPUT_KEY_COLLISION` | Two inputs of one node send the same wire key: a flattened dynamic key such as `format.codec` equals another input's name. | The first is kept; `toApi` throws a `ValidationError`. |
| `E_TOO_MANY_DYNAMIC_INPUTS` | An Autogrow is given more slots than it has, or a DynamicGroup more rows than its `max`. The generated types prevent it; untyped code can still do it. Validation reports the same for a prompt with a group key in a row at or past `max`. | The extra entries aren't sent; `toApi` throws a `ValidationError`. |

## Validating prompts

Paths of validation diagnostics point into the prompt, like export paths: `[id, "inputs", key]`
for an input, `[id, "class_type"]` for a node's class, `[id]` for a cycle through it and `[]` for
the whole prompt. An error is something the generated types reject too, or something they can't
express that the backend rejects; a warning is something the types accept that the backend
takes, but may not do what was meant.

| Code | Meaning | What happens |
|---|---|---|
| `E_UNKNOWN_CLASS_TYPE` | A node's class type isn't in the schema: a `raw()` node, or a pack the server doesn't have. The backend rejects the whole prompt. | The node's inputs aren't checked; links from it aren't type-checked. |
| `E_NO_OUTPUT_NODE` | No node is an output node (save, preview, …). The backend rejects the prompt: it would run nothing. | — |
| `E_UNKNOWN_INPUT` | A key the node doesn't have, after dynamic inputs are expanded: a misspelling, an Autogrow slot past the last one, a DynamicGroup key that isn't `<group>.<row>.<field>`. The backend ignores unknown values but still follows unknown links. | — |
| `E_MISSING_INPUT` | A required input has no value or link, including the first `min` slots of an Autogrow whose template is required and the required fields of a DynamicGroup row that is present. | — |
| `E_INVALID_LINK` | A list, which the backend reads as a link, that isn't `[node id (string), output slot (integer ≥ 0)]`. | — |
| `E_DANGLING_LINK` | A link to a node the prompt doesn't have, or to an output slot its node doesn't have. | — |
| `E_TYPE_MISMATCH` | A link from an output whose type the input doesn't accept (`accepts`, §5.2), including a MatchType input linked to a type its template doesn't allow. MatchType outputs count as the type their template resolved to. | — |
| `E_MATCH_TYPE_MISMATCH` | The inputs of one MatchType template are linked to types that don't agree with the type its first input was linked to. The backend doesn't check this; the node would get mismatched values. | — |
| `E_NOT_A_LINK` | A value for an input that only takes links (a socket, a MatchType input, an Autogrow slot). | — |
| `E_INVALID_VALUE` | A value of the wrong kind: not a number for INT or FLOAT, not a string or boolean, `null`, a list for a single-select combo, an option that isn't a string, number or boolean, a dynamic-combo choice that isn't a key. | — |
| `W_NON_INTEGER_VALUE` | A fractional number for an INT input. The types allow `number`; the backend truncates it. | Truncated before the range check, as the backend does. |
| `E_OUT_OF_RANGE` | A number below `min` or above `max`, compared exactly (bigint-aware). | — |
| `E_NOT_IN_COMBO` | A value that isn't one of a combo's options; for a multi-select, each element is checked. | — |
| `W_UNLISTED_COMBO_VALUE` | The same for an upload or remote combo, or one with no options: its options are runtime state, so the value may well exist. | — |
| `E_UNKNOWN_DYNAMIC_OPTION` | A dynamic combo set to a key it doesn't have. The backend then drops the input and its option inputs without a word. | Keys under it aren't reported again. |
| `E_TOO_FEW_DYNAMIC_INPUTS` | A DynamicGroup with fewer rows than its `min`. | — |
| `E_DEPENDENCY_CYCLE` | Nodes that depend on each other through their links. | One diagnostic per cycle, at the node it returns to. |

## Generating types

Paths of codegen diagnostics are a class type followed by the input names leading to the input,
with dynamic-combo option keys in between, e.g. `["SaveVideo", "format", "mp4", "codec"]`.

| Code | Meaning | What happens |
|---|---|---|
| `W_EMPTY_COMBO` | A combo lists no options (no model files installed, an empty folder) and isn't remote. | Its values are typed as `string`. |
| `W_UNTYPED_INPUT` | An input the normalizer kept as `unknown`. | Its value is typed as `unknown`. |
