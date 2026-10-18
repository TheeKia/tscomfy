import { oxfmt } from "@tscomfy/fixtures";

// Text widths as oxfmt measures them, read off its line breaking: each string is placed in a
// union type alias padded so the line fits within the print width (100) exactly when the string
// is at most so many columns wide, and oxfmt either keeps the line or breaks it.

/** Strings per oxfmt run; the runs go in parallel. */
const CHUNK = 40_000;

/** The code points `textWidth` must agree with oxfmt on: every one but ASCII and controls. */
export function probedCodePoints(): number[] {
  const codes: number[] = [];
  const add = (from: number, to: number): void => {
    for (let code = from; code <= to; code++) {
      if (code < 0xd800 || code > 0xdfff) codes.push(code);
    }
  };
  // Planes 0 to 3 (assigned characters), then plane 14 (tags and variation selectors).
  add(0xa1, 0x3ffff);
  add(0xe0000, 0xe0fff);
  return codes;
}

/**
 * The width oxfmt gives each string, known to be at most `most` columns: the least width the
 * string fits in, or `most` when it fits in none below it. Strings must not hold `"`, `\` or
 * line breaks.
 */
export async function oxfmtWidths(strings: readonly string[], most: number): Promise<number[]> {
  const chunks: (readonly string[])[] = [];
  for (let start = 0; start < strings.length; start += CHUNK) {
    chunks.push(strings.slice(start, start + CHUNK));
  }
  const measured = await Promise.all(chunks.map((chunk) => measureChunk(chunk, most)));
  return measured.flat();
}

async function measureChunk(strings: readonly string[], most: number): Promise<number[]> {
  // `type Q000000W0 = "` and `" | "b";` take 26 columns.
  const lines: string[] = [];
  strings.forEach((text, index) => {
    for (let width = 0; width < most; width++) {
      lines.push(
        `type Q${String(index).padStart(6, "0")}W${String(width)} = "${"a".repeat(74 - width)}${text}" | "b";`,
      );
    }
  });
  const formatted = await oxfmt("probe.ts", `${lines.join("\n")}\n`);
  if (formatted.code !== 0) throw new Error(`oxfmt failed: ${formatted.stderr}`);
  const least = strings.map(() => most);
  for (const line of formatted.stdout.split("\n")) {
    const fits = /^type Q(\d{6})W(\d) = ".*" \| "b";$/.exec(line);
    if (fits === null) continue;
    const index = Number(fits[1]);
    least[index] = Math.min(least[index] ?? most, Number(fits[2]));
  }
  return least;
}
