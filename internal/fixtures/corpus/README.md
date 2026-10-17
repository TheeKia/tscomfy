# Local corpus

Real ComfyUI data for local corpus tests. Everything in this directory except this README is
gitignored: it may contain personal data (model names, prompts) and changes whenever the
server does.

| Section | Contents | How to fill |
|---|---|---|
| `object-info/` | `/object_info` responses | `curl -o object-info/local.json http://127.0.0.1:8188/object_info` (later: `tscomfy generate --url …` writes a snapshot) |
| `workflows/api/` | API-format workflows | ComfyUI menu → Export (API) |
| `workflows/ui/` | UI-format workflows | ComfyUI menu → Export, or saved workflows from the server's user data |

Corpus tests (`*.corpus.test.ts`) run with `bun run test:corpus`, never as part of `bun run check`. They
skip a section that is empty or missing. When a corpus run finds something no mock
covers, distill it into a mock in `../mocks/` first (see `../README.md`).
