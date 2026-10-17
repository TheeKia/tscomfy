# Diagnostics

Every diagnostic tscomfy reports, by code. The model is in [plan §5.4](plan.md#54-diagnostics)
and [ADR-0014](decisions/0014-diagnostic-model.md): a stable code, a severity fixed per code
(`E_` errors, `W_` warnings), a path of segments and a message. Codes are never reused for a
different meaning. A test keeps this list and `DIAGNOSTIC_CODES` in sync, and each code has a
negative test.

Paths of normalizer diagnostics point into the raw `/object_info` document, e.g.
`["KSampler", "input", "required", "seed", 1, "max"]`.

## Parsing

| Code | Meaning | What happens |
|---|---|---|
| `E_INVALID_JSON` | The text is not valid JSON. The path is empty; the message has the parser's reason. | No value. |
| `W_PRECISION_LOSS` | An integer beyond 2⁵³ was parsed on a runtime without `JSON.parse` source-text access, so it may have been rounded. | The rounded number is kept. |

## Normalizing `/object_info`

| Code | Meaning | What happens |
|---|---|---|
| `E_INVALID_OBJECT_INFO` | The document is not an object of node definitions. | Empty schema. |
| `E_INVALID_NODE` | A node can't be used: it isn't an object, or its `input`, `input.required` or `output` is unreadable, or an output type is unreadable. | The node is dropped. |
| `W_INVALID_NODE_FIELD` | A descriptive node field is missing or has the wrong type (`display_name`, `category`, `python_module`, `output_node`, flags, `input_order`), or an `output_*` array doesn't match `output`. | A default is used for that field or slot. |
| `W_NODE_NAME_MISMATCH` | The node's `name` differs from the key it is listed under. | The key is used: prompts address nodes by it. |
| `E_INVALID_INPUT_SECTION` | `input.optional` is not an object. | Its inputs are dropped. |
| `E_DUPLICATE_INPUT` | An input name appears in more than one section of the same node or dynamic option. | The first is kept, the rest dropped. |
| `W_INPUT_ORDER_MISMATCH` | `input_order` names an input that doesn't exist, or leaves one out. | Listed inputs keep their order; unlisted ones follow in key order. |
| `W_INVALID_INPUT_SPEC` | An input spec can't be interpreted: not a `[type, options?]` list, a type that isn't a string or option list, an empty type, or a dynamic input missing its required payload. | The input is kept as `unknown`. |
| `W_UNSUPPORTED_INPUT_TYPE` | The input uses a `COMFY_…_V3` dynamic type this version doesn't know. | The input is kept as `unknown`. |
| `W_INVALID_INPUT_OPTION` | One option of a readable spec is invalid: wrong type, a combo option that isn't a string, number or boolean, a default the backend would reject (e.g. not one of the combo's options), a malformed dynamic-combo option. | That option is ignored, or a documented backend default is used. |
