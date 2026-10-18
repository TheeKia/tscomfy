# @tscomfy/cli

The `tscomfy` command: generates TypeScript types from a ComfyUI server's `/object_info`, checks
them for drift, and transpiles API prompts and UI workflows to typed code. It only sends
`GET` requests; it never queues anything. Runs on Node 24 or later and Bun 1.4 or later.

```sh
npm install @tscomfy/core
npm install --save-dev @tscomfy/cli

npx tscomfy generate --url http://127.0.0.1:8188 --out src/comfy/local
npx tscomfy check --url http://127.0.0.1:8188 --out src/comfy/local
npx tscomfy transpile --workflow my-workflow.json --schema src/comfy/local --out src/my-workflow.ts
```

`generate` writes `nodes.ts` (the types), `index.ts` (the typed schema), the raw
`object_info.json` and a `tscomfy.json` manifest. `tscomfy --help` and
`tscomfy help <command>` list every option. See the [guides](https://github.com/TheeKia/tscomfy/tree/main/docs/guides), starting with
[getting started](https://github.com/TheeKia/tscomfy/tree/main/docs/guides/getting-started.md).

## License

MIT
