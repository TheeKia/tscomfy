# Local corpus

Real ComfyUI data for local corpus tests. Everything in this directory except this README is
gitignored: it may contain personal data (model names, prompts) and changes whenever the
server does.

| Section | Contents | How to fill |
|---|---|---|
| `object-info/` | `/object_info` responses | `curl -o object-info/local.json http://127.0.0.1:8188/object_info`, or copy the `object_info.json` snapshot `tscomfy generate --url …` writes |
| `workflows/api/` | API-format workflows | ComfyUI menu → Export (API) |
| `workflows/ui/` | UI-format workflows | ComfyUI menu → Export, or saved workflows from the server's user data |
| `workflows/ui-api/` | The prompts the frontend builds for `workflows/ui/`, under the same names | `bun internal/fixtures/scripts/frontend.ts --out internal/fixtures/corpus/workflows/ui-api internal/fixtures/corpus/workflows/ui/*.json` |
| `workflows/ui-differences.json` | Optional. Nodes whose prompt pack JavaScript changes at queue time, which `importUi` can't reproduce: `{"<file>": {"<node id>": "why"}}` | By hand, from the corpus test's report |
| `generated/` | Written by the codegen corpus test: the generated types of each dump and the transpiled API workflows, type-checked in place | Nothing to do; delete it freely |

Corpus tests (`*.corpus.test.ts`) run with `bun run test:corpus`, never as part of `bun run check`. They
skip a section that is empty or missing. When a corpus run finds something no mock
covers, distill it into a mock in `../mocks/` first (see `../README.md`).
