import {
  ALEFS,
  EMOJI,
  EMOJI_BASES,
  LAMS,
  MODIFIER_BASES,
  TEXT_BASES,
  TRANSPARENT,
  WIDE,
  ZERO_WIDTH,
} from "./text-width-tables.ts";

// Columns a string takes, as oxfmt measures them for line breaking (unicode-width 0.2's string
// width). The character classes come from oxfmt itself (text-width-tables.ts); the sequences it
// treats specially are folded right to left, as it reads them: variation selectors, emoji joined
// by ZWJ or toned by a skin tone, keycaps, flags (regional indicators and tag sequences) and
// Arabic Lam-Alef. Its rarer ligatures (Hebrew, Khmer, Buginese, Tifinagh, Lisu, Old Turkic,
// Kirat Rai) aren't modeled, and a tag sequence inside a ZWJ sequence joins whatever its length:
// such text counts as its characters do.

const VS15 = 0xfe0e;
const VS16 = 0xfe0f;
const ZWJ = 0x200d;
const KEYCAP = 0x20e3;
const BLACK_FLAG = 0x1f3f4;
const CANCEL_TAG = 0xe007f;

/** What the text to the right of a character makes of it. */
type Next =
  | "plain"
  | "vs15"
  | "vs16"
  | "emoji"
  | "zwjEmoji"
  | "vs16ZwjEmoji"
  | "keycapZwjEmoji"
  | "vs16KeycapZwjEmoji"
  | "skinTone"
  | "regional"
  | "regionals"
  | "zwjRegional"
  | "zwjRegionalsEven"
  | "zwjRegionalsOdd"
  | "zwjTag"
  | "alef";

/** The columns `text` takes, as oxfmt counts them. */
export function textWidth(text: string): number {
  // Pure ASCII is the overwhelmingly common case.
  if (/^[\x20-\x7e]*$/.test(text)) return text.length;
  const codes = Array.from(text, (char) => char.codePointAt(0) ?? 0);
  let width = 0;
  let next: Next = "plain";
  for (let index = codes.length - 1; index >= 0; index--) {
    const [columns, state] = step(codes[index] ?? 0, next);
    width += columns;
    next = state;
  }
  return width;
}

/** One character's columns, given what follows it, and what it makes of the one before. */
function step(code: number, following: Next): readonly [number, Next] {
  let next = following;
  if (next === "vs16" || next === "vs16ZwjEmoji" || next === "vs16KeycapZwjEmoji") {
    // An emoji presentation sequence: wide, or nothing when a ZWJ joins it to the one after.
    if (inRanges(EMOJI_BASES, code)) return [next === "vs16" ? 2 : 0, "emoji"];
    next = "plain";
  }
  // ASCII and the Latin-1 controls count one each, and join nothing.
  if (code <= 0xa0) return [1, "plain"];
  if (next !== "plain") {
    // Variation selectors don't break a ligature.
    if (next === "alef" && (code === VS15 || code === VS16)) return [0, "alef"];
    if (code === VS16) {
      if (next === "zwjEmoji") return [0, "vs16ZwjEmoji"];
      return [0, next === "keycapZwjEmoji" ? "vs16KeycapZwjEmoji" : "vs16"];
    }
    if (code === VS15) return [0, "vs15"];
    if (next === "vs15") {
      if (inRanges(TEXT_BASES, code)) return [1, "plain"];
      next = "plain";
    }
    const joined = joinedWidth(code, next);
    if (joined !== undefined) return joined;
  }
  return lookup(code);
}

/** A character that joins what follows it into one sequence. */
function joinedWidth(code: number, next: Next): readonly [number, Next] | undefined {
  switch (next) {
    case "alef":
      if (inRanges(LAMS, code)) return [0, "plain"];
      return inRanges(TRANSPARENT, code) ? [0, "alef"] : undefined;
    case "skinTone":
      if (inRanges(MODIFIER_BASES, code)) return [0, "emoji"];
      return code === ZWJ ? [0, "zwjEmoji"] : undefined;
    case "regional":
      return isRegionalIndicator(code) ? [1, "regionals"] : undefined;
    case "regionals":
      if (isRegionalIndicator(code)) return [1, "regionals"];
      return code === ZWJ ? [0, "zwjEmoji"] : undefined;
    // Regional indicators a ZWJ joins: each pair takes two columns, an odd one out one.
    case "zwjRegional":
    case "zwjRegionalsOdd":
      return isRegionalIndicator(code) ? [-1, "zwjRegionalsEven"] : undefined;
    case "zwjRegionalsEven":
      if (isRegionalIndicator(code)) return [3, "zwjRegionalsOdd"];
      return code === ZWJ ? [0, "zwjEmoji"] : undefined;
    case "zwjTag":
      if (isTag(code)) return [0, "zwjTag"];
      return code === BLACK_FLAG ? [0, "emoji"] : undefined;
    case "emoji":
      return code === ZWJ ? [0, "zwjEmoji"] : undefined;
    case "zwjEmoji":
      if (code === KEYCAP) return [0, "keycapZwjEmoji"];
      if (isSkinTone(code)) return [0, "skinTone"];
      if (isRegionalIndicator(code)) return [1, "zwjRegional"];
      if (code === CANCEL_TAG) return [0, "zwjTag"];
      return inRanges(EMOJI, code) ? [0, "emoji"] : undefined;
    case "plain":
    case "vs15":
    case "vs16":
    case "vs16ZwjEmoji":
    case "keycapZwjEmoji":
    case "vs16KeycapZwjEmoji":
      return undefined;
  }
}

/** A character on its own, and what it makes of the one before. */
function lookup(code: number): readonly [number, Next] {
  if (code === VS16) return [0, "vs16"];
  if (code === VS15) return [0, "vs15"];
  if (isRegionalIndicator(code)) return [1, "regional"];
  if (isSkinTone(code)) return [2, "skinTone"];
  if (inRanges(ALEFS, code)) return [1, "alef"];
  if (inRanges(ZERO_WIDTH, code)) return [0, "plain"];
  if (!inRanges(WIDE, code)) return [1, "plain"];
  return [2, inRanges(EMOJI, code) ? "emoji" : "plain"];
}

function isRegionalIndicator(code: number): boolean {
  return code >= 0x1f1e6 && code <= 0x1f1ff;
}

/** A tag character: what follows the black flag in a subdivision flag (`🏴` + `gbeng` + cancel). */
function isTag(code: number): boolean {
  return code >= 0xe0020 && code <= 0xe007e;
}

function isSkinTone(code: number): boolean {
  return code >= 0x1f3fb && code <= 0x1f3ff;
}

/** Whether `code` is in a table of inclusive ranges, start and end in turn: a binary search. */
function inRanges(ranges: readonly number[], code: number): boolean {
  let low = 0;
  let high = ranges.length / 2 - 1;
  while (low <= high) {
    const middle = (low + high) >>> 1;
    const start = ranges[2 * middle] ?? 0;
    const end = ranges[2 * middle + 1] ?? 0;
    if (code < start) high = middle - 1;
    else if (code > end) low = middle + 1;
    else return true;
  }
  return false;
}
