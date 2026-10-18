// Bundled for the browser by browser.live.test.ts and run in headless Chromium, on an origin other
// than the server's: core reads the server's /object_info and builds a workflow, the client runs
// it, and the page checks what a browser does with the results (decodes a preview and the saved
// image, loads the image by its URL, uploads a file). It answers with a JSON summary.

import { connect, fetchFile, fileUrl, outputFiles, submit, uploadFile } from "@tscomfy/client";
import { normalizeObjectInfo, typedSchema, workflow } from "@tscomfy/core";
import type { LooseNodes } from "./loose.ts";

// The browser APIs this page uses that the test project's types (Bun's) don't declare.
declare function createImageBitmap(
  image: Blob,
): Promise<{ readonly width: number; readonly height: number }>;
declare class Image {
  src: string;
  readonly naturalWidth: number;
  addEventListener(type: "load" | "error", listener: () => void): void;
}

/** An image element's width once its URL has loaded. */
function loadedWidth(url: string): Promise<number> {
  return new Promise((resolve, reject) => {
    const image = new Image();
    image.addEventListener("load", () => {
      resolve(image.naturalWidth);
    });
    image.addEventListener("error", () => {
      reject(new Error(`the browser couldn't load ${url}`));
    });
    image.src = url;
  });
}

async function run(url: string): Promise<string> {
  const text = await (await fetch(`${url}/object_info`)).text();
  const schema = typedSchema<LooseNodes>(normalizeObjectInfo(text).schema);
  const comfy = await connect({ url });
  try {
    const built = workflow(schema, ({ n }) => {
      const color = Math.floor(Math.random() * 0xffffff);
      const image = n["EmptyImage"]!({ width: 40, height: 24, batch_size: 1, color });
      return {
        save: n["SaveImage"]!({
          images: n["ImageInvert"]!({ image }),
          filename_prefix: "tscomfy-live/browser",
        }),
        socket: n["SaveImageWebsocket"]!({ images: image }),
      };
    });
    const job = submit(comfy, built);
    const types: string[] = [];
    let preview: { readonly width: number; readonly height: number } | undefined;
    for await (const event of job.events) {
      types.push(event.type);
      if (event.type === "preview") {
        preview = await createImageBitmap(new Blob([event.bytes], { type: event.mime }));
      }
    }
    const outcome = await job.outcome;
    const [file] = outputFiles(outcome, built.handles.save);
    if (file === undefined) throw new Error(`no saved file: ${outcome.status}`);
    const data = await fetchFile(comfy, file);
    const saved = await createImageBitmap(new Blob([data.bytes], { type: data.mime }));
    const uploaded = await uploadFile(
      comfy,
      { name: "browser.png", bytes: data.bytes, mime: data.mime },
      { type: "temp", subfolder: "tscomfy-live" },
    );
    return JSON.stringify({
      status: outcome.status,
      types: [...new Set(types)],
      preview: preview === undefined ? null : [preview.width, preview.height],
      saved: [saved.width, saved.height],
      mime: data.mime,
      loaded: await loadedWidth(fileUrl(comfy, file)),
      uploaded: uploaded.value,
    });
  } finally {
    await comfy.close();
  }
}

Reflect.set(globalThis, "runLive", run);
