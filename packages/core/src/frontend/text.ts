// Text the frontend rewrites when it builds a prompt (ComfyUI_frontend 1.55.17
// `saveImageExtraOutput.ts`, `searchAndReplace.ts` `applyTextReplacements`, read as a
// specification): `%Node.widget%` becomes a widget's value, `%date:…%` the time.

/**
 * The save nodes whose `filename_prefix` the frontend runs through `%…%` replacement when it
 * builds a prompt (`saveImageExtraOutput.ts`).
 */
export const SAVE_NODES: ReadonlySet<string> = new Set([
  "SaveImage",
  "SaveImageAdvanced",
  "SaveSVGNode",
  "SaveVideo",
  "SaveAnimatedWEBP",
  "SaveWEBM",
  "SaveAudio",
  "SaveAudioMP3",
  "SaveAudioOpus",
  "SaveAudioAdvanced",
  "SaveGLB",
  "Save3DAdvanced",
  "SaveGaussianSplat",
  "SavePointCloud",
  "SaveAnimatedPNG",
  "CLIPSave",
  "VAESave",
  "ModelSave",
  "LoraSave",
  "SaveLatent",
]);

/** One `%…%` pattern, as `applyTextReplacements` reads it. */
export type TextPattern =
  /** `%Node.widget%`: exactly one dot. The node is found by search name, then by title. */
  | { readonly kind: "widget"; readonly node: string; readonly widget: string }
  /** `%date:…%`, unless it has exactly one dot: the time the prompt is queued. */
  | { readonly kind: "date" }
  /** Anything else, which the frontend leaves as written. */
  | { readonly kind: "other" };

/**
 * Rewrites every `%…%` in `text` as `replace` says, given the pattern and its text with the
 * percent signs; the frontend's tokenization (`/%([^%]+)%/g`, split on dots).
 */
export function replaceText(
  text: string,
  replace: (pattern: TextPattern, match: string) => string,
): string {
  return text.replaceAll(/%([^%]+)%/g, (match: string, inner: string) =>
    replace(readPattern(inner), match),
  );
}

/** Whether the frontend changes a text when it builds a prompt: a `%date:…%` or `%Node.widget%`. */
export function replacesText(text: string): boolean {
  let changes = false;
  replaceText(text, (pattern, match) => {
    if (pattern.kind !== "other") changes = true;
    return match;
  });
  return changes;
}

/**
 * A widget's value as the frontend puts it into a text: path separators and the characters file
 * systems refuse replaced with `_`.
 */
export function fileNameSafe(text: string): string {
  // oxlint-disable-next-line no-control-regex -- the characters the frontend replaces
  return text.replaceAll(/[/?<>\\:*|"\u0000-\u001f\u007f]/g, "_");
}

function readPattern(inner: string): TextPattern {
  const split = inner.split(".");
  if (split.length === 2) {
    const [node = "", widget = ""] = split;
    return { kind: "widget", node, widget };
  }
  return split[0]?.startsWith("date:") === true ? { kind: "date" } : { kind: "other" };
}
