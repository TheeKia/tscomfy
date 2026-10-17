# Fixtures

Hand-written mock data for tests. Everything here is written by us: no real server dumps, no
personal data, no text copied from upstream projects. The shapes follow what ComfyUI actually
serves; the coverage list below comes from analysing real `/object_info` output.

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

## `mocks/object-info/`

Each file is a complete `/object_info` response containing a few nodes around one theme. Adding a
file means adding its name to `MOCK_OBJECT_INFO_NAMES` in `src/index.ts`; a test enforces this.
Node class names start with `Mock` unless the name itself is the thing being tested.

| File | Covers |
|---|---|
| `basic-pipeline.json` | A txt2img pipeline with realistic fields: legacy combos, widgets with defaults, seed max 2⁶⁴−1, multi-output loader, output node, hidden inputs |
| `combos.json` | Legacy `[[…]]` and v2 `["COMBO",{options}]` forms, numeric and mixed options, empty lists, upload and remote combos, multiselect with a list default, option-list outputs, a custom widget-like type that is not a COMBO |
| `dynamic-combo.json` | `COMFY_DYNAMICCOMBO_V3`: options without inputs, required and optional option inputs, three levels of nesting (`format.codec.encoding`), a top-level name colliding with a nested one, option keys with spaces and brackets, Autogrow and MatchType inside options, an optional dynamic combo |
| `autogrow.json` | `COMFY_AUTOGROW_V3`: prefix form (min 1 and min 0), names form with a comma-union template, an optional Autogrow whose template sits in `optional` |
| `dynamic-group.json` | `COMFY_DYNAMICGROUP_V3`: required group with mixed widget fields, optional group with required and optional fields |
| `match-type.json` | `COMFY_MATCHTYPE_V3`: any-typed lazy switch, a template restricted to `IMAGE,MASK`, two templates with `output_matchtypes` containing nulls |
| `sockets.json` | Socket-only inputs: custom, `*`, comma union, `forceInput` widgets, `lazy`, `rawLink`, `socketless`, `defaultInput`; any-typed outputs |
| `outputs.json` | No outputs, list outputs, node-level `is_input_list`, duplicate output names, names clashing with array/handle members, numeric-like and spaced names |
| `names.json` | Class names with spaces, parentheses, dots, emoji; ordinary input names containing dots (must never be split); input names that are not identifiers |
| `hidden.json` | Hidden inputs in every observed shape: server-filled names, tuple specs, `*`, empty string, plain widget type, object |
| `numbers.json` | Integer bounds beyond 2⁵³ (exact in the file), also as FLOAT bounds and on an `INT:seed` type, widgets with no default, list-valued defaults, every widget option variant |
| `malformed.json` | Inputs that must produce diagnostics instead of crashes: null, string, numeric type, empty tuple, bad options, V3 types missing their payload, unknown V3 type, non-record section, mismatched output arrays, dangling `input_order`, missing fields, `name` disagreeing with its key |
| `legacy-and-flags.json` | Older servers: no `input_order`, `output_name` or `output_is_list`; empty `input`; `deprecated`, `experimental`, `dev_only`, `advanced`, `essentials_category` |

Note: integers beyond 2⁵³ are written exactly in these files. `JSON.parse` without source-text
access rounds them, which is precisely what the lossless parser is tested against.
