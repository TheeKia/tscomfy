import { describe, expect, test } from "bun:test";
import {
  ALEFS,
  EMOJI,
  EMOJI_BASES,
  LAMS,
  MODIFIER_BASES,
  TEXT_BASES,
  TRANSPARENT,
} from "../src/text-width-tables.ts";
import { textWidth } from "../src/text-width.ts";
import { oxfmtWidths, probedCodePoints } from "./width-probe.ts";

// textWidth must count as oxfmt does, or generated code breaks lines where oxfmt doesn't
// (docs/plan.md §9). Both suites ask the installed oxfmt; after updating it, run
// test/update-widths.ts.

/** The members of a table of ranges. */
function members(ranges: readonly number[]): number[] {
  const codes: number[] = [];
  for (let index = 0; index < ranges.length; index += 2) {
    for (let code = ranges[index] ?? 0; code <= (ranges[index + 1] ?? -1); code++) {
      codes.push(code);
    }
  }
  return codes;
}

/** The strings whose widths differ from oxfmt's, with both widths. */
async function disagreements(
  strings: readonly string[],
  most: number,
): Promise<[string, number, number][]> {
  const measured = await oxfmtWidths(strings, most);
  return strings.flatMap((text, index): [string, number, number][] => {
    const expected = measured[index] ?? -1;
    const actual = textWidth(text);
    return actual === expected ? [] : [[text, actual, expected]];
  });
}

const char = (code: number): string => String.fromCodePoint(code);
const SKIN_TONES = [0x1f3fb, 0x1f3fc, 0x1f3fd, 0x1f3fe, 0x1f3ff].map(char);

describe("textWidth agrees with oxfmt", () => {
  test("on every code point", async () => {
    const strings = probedCodePoints().map(char);
    expect(await disagreements(strings, 2)).toEqual([]);
  }, 60_000);

  test("on emoji sequences, joined ones and Lam-Alef", async () => {
    const emoji = members(EMOJI).map(char);
    const bases = members(EMOJI_BASES).map(char);
    const sequences = [
      // Variation selectors on every base, and on what isn't one.
      ...bases.map((base) => `${base}\u{FE0F}`),
      ...members(TEXT_BASES).map((base) => `${char(base)}\u{FE0E}`),
      "x\u{FE0F}",
      "\u{4E00}\u{FE0F}",
      "\u{FE0F}",
      // Skin tones on every base, and on what isn't one.
      ...members(MODIFIER_BASES).flatMap((base) => SKIN_TONES.map((tone) => char(base) + tone)),
      ...SKIN_TONES.map((tone) => `a${tone}`),
      // ZWJ sequences: every emoji after one, every base with VS16, tones, keycaps, ends.
      ...emoji.map((each) => `\u{1F468}\u{200D}${each}`),
      ...bases.map((base) => `\u{1F468}\u{200D}${base}\u{FE0F}`),
      ...bases.map((base) => `${base}\u{200D}\u{1F525}`),
      ...bases.map((base) => `${base}\u{FE0F}\u{200D}\u{1F525}`),
      "\u{1F468}\u{200D}\u{1F469}\u{200D}\u{1F467}\u{200D}\u{1F466}",
      "\u{1F926}\u{1F3FD}\u{200D}\u{2642}\u{FE0F}",
      "\u{1F468}\u{200D}\u{1F3FD}",
      "\u{1F468}\u{200D}1\u{FE0F}\u{20E3}",
      "\u{1F468}\u{200D}\u{20E3}",
      "\u{1F468}\u{200D}",
      "\u{200D}\u{1F468}",
      "a\u{200D}\u{1F469}",
      "\u{1F1EF}\u{1F1F5}\u{200D}\u{1F468}",
      "\u{1F1EF}\u{200D}\u{1F468}",
      "\u{1F468}\u{200D}\u{1F1EF}",
      "\u{1F468}\u{200D}\u{1F1EF}\u{1F1F5}",
      "\u{1F468}\u{200D}\u{1F1EF}\u{1F1F5}\u{1F1FA}",
      "\u{1F468}\u{200D}\u{1F1EF}\u{1F1F5}\u{1F1FA}\u{1F1F8}\u{200D}\u{1F468}",
      "\u{1F468}\u{200D}\u{1F3F4}\u{E0067}\u{E0062}\u{E0065}\u{E006E}\u{E0067}\u{E007F}",
      "\u{1F3F4}\u{E0067}\u{E0062}\u{E0065}\u{E006E}\u{E0067}\u{E007F}\u{200D}\u{1F468}",
      // Keycaps, flags and tag sequences.
      ..."#*0123456789".split("").flatMap((key) => [`${key}\u{FE0F}\u{20E3}`, `${key}\u{20E3}`]),
      "\u{1F1EF}",
      "\u{1F1EF}\u{1F1F5}",
      "\u{1F1EF}\u{1F1F5}\u{1F1FA}",
      "\u{1F1EF}\u{1F1F5}\u{1F1FA}\u{1F1F8}",
      "\u{1F3F4}\u{E0067}\u{E0062}\u{E0065}\u{E006E}\u{E0067}\u{E007F}",
      // Lam-Alef, through every mark that may stand between them.
      ...members(LAMS).flatMap((lam) => members(ALEFS).map((alef) => char(lam) + char(alef))),
      ...members(TRANSPARENT).map((mark) => `\u{644}${char(mark)}\u{627}`),
      "\u{644}\u{200D}\u{627}",
      "\u{627}\u{644}",
    ];
    expect(await disagreements(sequences, 8)).toEqual([]);
  }, 60_000);
});
