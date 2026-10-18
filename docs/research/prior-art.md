# Prior art

A review of existing projects, done 2026-10-17 before starting tscomfy, by reading their source
(nothing was installed or run). Conclusion: none is adoptable as a dependency for type-safe
generation; several are worth learning from. Plan §2 has the borrow/avoid summary.

## Python

- **Chaoses-Ib/ComfyScript**: the inspiration. Python stubs (`.pyi`) generated from a server,
  enums for combos, a transpiler from workflows to scripts, "virtual" (generate) and "real"
  (in-process) modes. Python types are advisory, which is the gap TypeScript closes.

## TypeScript / JavaScript

- **rvion/comfy-ts** (npm `comfy-ts`). The closest design: `comfy-ts gen` writes
  `object_info.json` and `sdk.d.ts` per host, sockets typed via an `Accepts` table, literal unions
  of installed models, V3 support (Autogrow as dotted keys, DynamicCombo as flat dotted keys
  intersected into the node's inputs), API and UI import/export with subgraph expansion. Accepts
  a node with a single output of the right type directly. Drawbacks: ~93k LOC, single maintainer,
  app dependencies (react, ink, mobx, codemirror, sharp) in the runtime; DynamicCombo branches
  don't recurse and multiply into large unions. Its predecessor, rvion/CushyStudio, is AGPL and
  dormant.
- **@saintno/comfyui-sdk** (repo now comfy-addons/comfyui-sdk). Mostly an execution client
  (generation is ~17% of the code). `PromptBuilder` patches JSON by dot-paths; a late-added
  codegen (CLI-only, needs a live server) emits a `WorkflowBuilder` subclass. Phantom-typed tuple
  refs (`NodeRef<T>`); widgets can't take links; no comma or `*` handling; CI publishes on every
  push without tests. Usable as an execution companion for our API JSON. Successor fork:
  `comfyui-node` (igorls).
- **StableCanvas/comfyui-client** (`@stable-canvas/comfyui-client`). ComfyScript-inspired Proxy
  builder; input names typed for built-ins, outputs untyped, UI format TODO. Its transpiler
  (`@stable-canvas/comfyui-client-transpiler`) is the idea worth taking: JSON to code drives
  adoption.
- **stepupgaming/comfy-workflows** (`@stepupgaming/comfy-workflows`). Young, single author, likely
  agent-written. Good parts: a graph IR, index-based slot identity, drift detection by snapshot
  hash, a lossless JSON parser, warnings for file-like combos, a raw escape hatch, CI checking that
  regenerated code is unchanged. Gaps: exact-string type matching, widgets can't take links,
  output filtering that shifts indices, dropped combo defaults, Node-only (`node:crypto`), a
  transpiler emitting untyped refs, tests on a 24-node hand-picked subset.
- **KaruroChori/comfyui-bun-client**: Bun-only codegen to TypeBox; stale.
- **artokun/comfyui-mcp**: an MCP server, not a library; its UI-to-API converter (Get/Set virtual
  nodes, Reroute, subgraphs, bypass) is a useful reference for the UI-format phase.

## Official ComfyUI assets

- **Frontend zod schemas** (GPL-3.0): `src/platform/workflow/validation/schemas/workflowSchema.ts`
  (workflow 0.4 and 1.0, subgraphs, API prompt) and
  `packages/object-info-parser/src/schemas/nodeDefSchema.ts` (`/object_info`, including V3
  dynamic types). The best specification available; used as reference only.
- **`@comfyorg/comfyui-frontend-types`** on npm ships no `.d.ts` since 1.48.4 (July 2026); unusable.
- **`@comfyorg/sdk`**: official execution client for Comfy's hosted API (a plain ComfyUI needs a
  proxy in front). Execution clients are reviewed in `comfyui-execution.md` §9 (2026-10-18).
- **`@comfyorg/comfy-multi-player`** (GPL-3.0): holds the hard rules for `widgets_values`
  ordering; reference for UI format.
- **Backend V3 schema** (`comfy_api/latest/_io.py`): `/object_info` keeps the V1 shape; there is
  no newer node-definition endpoint.
- **Registry API** (api.comfy.org): per-pack node definitions in V1 format, with patchy coverage
  and no core nodes; possible offline fallback only.
