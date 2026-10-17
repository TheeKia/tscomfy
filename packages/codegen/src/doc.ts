// A small document printer in the style of Wadler's "prettier printer", with Prettier's
// group/indent/line/ifBreak/indentIfBreak semantics. Generated code is built as documents so its
// line breaks match what oxfmt would produce for the constructs codegen emits (tested by
// formatting the generated fixtures and the corpus output).

/** A printable document. Arrays concatenate. */
export type Doc = string | readonly Doc[] | Group | Indent | Line | IfBreak | IndentIfBreak | Fill;

/** Names a group so other documents can follow its decision. */
export interface GroupId {
  readonly description: string;
}

interface Group {
  readonly kind: "group";
  readonly contents: Doc;
  readonly id: GroupId | undefined;
}

interface Indent {
  readonly kind: "indent";
  readonly contents: Doc;
}

interface Line {
  readonly kind: "line";
  /** `line`: a space when flat; `soft`: nothing when flat; `hard`: always a newline. */
  readonly mode: "line" | "soft" | "hard";
}

interface IfBreak {
  readonly kind: "ifBreak";
  readonly broken: Doc;
  readonly flat: Doc;
}

interface IndentIfBreak {
  readonly kind: "indentIfBreak";
  readonly contents: Doc;
  readonly group: GroupId;
}

interface Fill {
  readonly kind: "fill";
  readonly contents: readonly string[];
  /** Printed after the last item when broken, and counted in its fit. */
  readonly trailing: string;
}

/**
 * Prints on one line if the whole group fits, else breaks every line directly inside it. With
 * an `id`, {@link indentIfBreak} can follow the decision.
 */
export function group(contents: Doc, id?: GroupId): Doc {
  return { kind: "group", contents, id };
}

/** A fresh group id. */
export function groupId(description: string): GroupId {
  return { description };
}

/**
 * Prettier's `fill` over text separated by `line`s: as many items on each line as fit. An item
 * goes on the current line when it fits there together with the item before it.
 */
export function fill(contents: readonly string[], trailing = ""): Doc {
  return { kind: "fill", contents, trailing };
}

/** Indents the lines inside by one level. */
export function indent(contents: Doc): Doc {
  return { kind: "indent", contents };
}

/** Indents `contents` only if the group `id` broke (Prettier's assignment layout). */
export function indentIfBreak(contents: Doc, id: GroupId): Doc {
  return { kind: "indentIfBreak", contents, group: id };
}

/** A space, or a newline when its group breaks. */
export const line: Doc = { kind: "line", mode: "line" };
/** Nothing, or a newline when its group breaks. */
export const softline: Doc = { kind: "line", mode: "soft" };
/** Always a newline; its groups break. */
export const hardline: Doc = { kind: "line", mode: "hard" };

/** `broken` when the enclosing group breaks, else `flat`. */
export function ifBreak(broken: Doc, flat: Doc = ""): Doc {
  return { kind: "ifBreak", broken, flat };
}

/** `docs` with `separator` between them. */
export function join(separator: Doc, docs: readonly Doc[]): Doc {
  return docs.flatMap((doc, index) => (index === 0 ? [doc] : [separator, doc]));
}

/**
 * `left = right` as Prettier lays out assignments: `right` stays on the line while its head
 * fits, else it moves to the next line, indented.
 */
export function assignment(left: Doc, right: Doc): Doc {
  const id = groupId("assignment");
  return group([left, " =", group(indent(line), id), indentIfBreak(right, id)]);
}

type Mode = "flat" | "break";

interface Command {
  readonly indent: number;
  readonly mode: Mode;
  readonly doc: Doc;
}

/** Prints a document at `width` columns with two-space indentation. */
export function print(doc: Doc, width: number): string {
  // Chunks, not one growing string: trimming trailing spaces must stay O(1) per line.
  const output: string[] = [];
  const modes = new Map<GroupId, Mode>();
  let column = 0;
  const stack: Command[] = [{ indent: 0, mode: "break", doc }];
  for (let command = stack.pop(); command !== undefined; command = stack.pop()) {
    const { indent: level, mode, doc: current } = command;
    if (typeof current === "string") {
      output.push(current);
      column += textWidth(current);
    } else if (isDocArray(current)) {
      for (let index = current.length - 1; index >= 0; index--) {
        const part = current[index];
        if (part !== undefined) stack.push({ indent: level, mode, doc: part });
      }
    } else {
      switch (current.kind) {
        case "group": {
          const flat =
            mode === "flat" ||
            (!containsHardline(current) &&
              fits({ indent: level, mode: "flat", doc: current.contents }, stack, width - column));
          const chosen = flat ? "flat" : "break";
          if (current.id !== undefined) modes.set(current.id, chosen);
          stack.push({ indent: level, mode: chosen, doc: current.contents });
          break;
        }
        case "indent":
          stack.push({ indent: level + 1, mode, doc: current.contents });
          break;
        case "indentIfBreak":
          stack.push({
            indent: modes.get(current.group) === "break" ? level + 1 : level,
            mode,
            doc: current.contents,
          });
          break;
        case "ifBreak":
          stack.push({
            indent: level,
            mode,
            doc: mode === "break" ? current.broken : current.flat,
          });
          break;
        case "fill": {
          const broken = mode === "break";
          const items = current.contents.map((item, index) =>
            broken && index === current.contents.length - 1 ? `${item}${current.trailing}` : item,
          );
          for (const [index, item] of items.entries()) {
            const next = items[index + 1];
            const start = column;
            output.push(item);
            column += textWidth(item);
            if (next === undefined) break;
            if (!broken || start + textWidth(item) + 1 + textWidth(next) <= width) {
              output.push(" ");
              column += 1;
            } else {
              output.push("\n", "  ".repeat(level));
              column = level * 2;
            }
          }
          break;
        }
        case "line":
          if (mode === "flat" && current.mode !== "hard") {
            if (current.mode === "line") {
              output.push(" ");
              column += 1;
            }
          } else {
            trimTrailingSpaces(output);
            output.push("\n", "  ".repeat(level));
            column = level * 2;
          }
          break;
      }
    }
  }
  return output.join("");
}

/**
 * Columns a string takes in a terminal, as oxfmt measures them: East Asian wide and fullwidth
 * characters and emoji take two, combining marks and format characters none.
 */
export function textWidth(text: string): number {
  // Pure ASCII is the overwhelmingly common case.
  if (/^[\x20-\x7e]*$/.test(text)) return text.length;
  let width = 0;
  for (const char of text) {
    const code = char.codePointAt(0) ?? 0;
    if (ZERO_WIDTH.test(char)) continue;
    width += isWide(code) ? 2 : 1;
  }
  return width;
}

const ZERO_WIDTH = /^[\p{Mn}\p{Me}\p{Cf}]$/u;

/** East Asian Wide and Fullwidth ranges (Unicode 15), and emoji presentation blocks. */
const WIDE_RANGES: readonly (readonly [number, number])[] = [
  [0x1100, 0x115f],
  [0x231a, 0x231b],
  [0x2329, 0x232a],
  [0x23e9, 0x23ec],
  [0x23f0, 0x23f0],
  [0x23f3, 0x23f3],
  [0x25fd, 0x25fe],
  [0x2614, 0x2615],
  [0x2648, 0x2653],
  [0x267f, 0x267f],
  [0x2693, 0x2693],
  [0x26a1, 0x26a1],
  [0x26aa, 0x26ab],
  [0x26bd, 0x26be],
  [0x26c4, 0x26c5],
  [0x26ce, 0x26ce],
  [0x26d4, 0x26d4],
  [0x26ea, 0x26ea],
  [0x26f2, 0x26f3],
  [0x26f5, 0x26f5],
  [0x26fa, 0x26fa],
  [0x26fd, 0x26fd],
  [0x2705, 0x2705],
  [0x270a, 0x270b],
  [0x2728, 0x2728],
  [0x274c, 0x274c],
  [0x274e, 0x274e],
  [0x2753, 0x2755],
  [0x2757, 0x2757],
  [0x2795, 0x2797],
  [0x27b0, 0x27b0],
  [0x27bf, 0x27bf],
  [0x2b1b, 0x2b1c],
  [0x2b50, 0x2b50],
  [0x2b55, 0x2b55],
  [0x2e80, 0x303e],
  [0x3041, 0x33ff],
  [0x3400, 0x4dbf],
  [0x4e00, 0x9fff],
  [0xa000, 0xa4cf],
  [0xa960, 0xa97f],
  [0xac00, 0xd7a3],
  [0xf900, 0xfaff],
  [0xfe10, 0xfe19],
  [0xfe30, 0xfe6f],
  [0xff00, 0xff60],
  [0xffe0, 0xffe6],
  [0x16fe0, 0x16fe4],
  [0x17000, 0x18aff],
  [0x1b000, 0x1b2ff],
  [0x1f004, 0x1f004],
  [0x1f0cf, 0x1f0cf],
  [0x1f18e, 0x1f18e],
  [0x1f191, 0x1f19a],
  [0x1f200, 0x1f251],
  [0x1f300, 0x1f64f],
  [0x1f680, 0x1f6ff],
  [0x1f7e0, 0x1f7eb],
  [0x1f90c, 0x1f9ff],
  [0x1fa70, 0x1faff],
  [0x20000, 0x2fffd],
  [0x30000, 0x3fffd],
];

function isWide(code: number): boolean {
  return WIDE_RANGES.some(([from, to]) => code >= from && code <= to);
}

/** Drops spaces at the end of the output; a newline before them is a blank line to keep. */
function trimTrailingSpaces(output: string[]): void {
  for (let last = output.at(-1); last !== undefined; last = output.at(-1)) {
    const trimmed = last.replace(/ +$/, "");
    if (trimmed !== "") {
      output[output.length - 1] = trimmed;
      return;
    }
    output.pop();
  }
}

const hardlines = new WeakMap<Group, boolean>();

/** Whether a group must break because it holds a hard line; cached, as groups nest deeply. */
function containsHardline(target: Group): boolean {
  let known = hardlines.get(target);
  if (known === undefined) {
    known = hasHardline(target.contents);
    hardlines.set(target, known);
  }
  return known;
}

/**
 * Whether `next` fits in the remaining `width`, together with whatever follows it on the same
 * line: the rest of the stack, up to its first line break in break mode.
 */
function fits(next: Command, rest: readonly Command[], width: number): boolean {
  let remaining = width;
  const pending: Command[] = [next];
  let restIndex = rest.length - 1;
  while (remaining >= 0) {
    let command = pending.pop();
    if (command === undefined) {
      if (restIndex < 0) return true;
      command = rest[restIndex--];
      if (command === undefined) return true;
    }
    const { mode, doc } = command;
    if (typeof doc === "string") {
      remaining -= textWidth(doc);
    } else if (isDocArray(doc)) {
      for (let index = doc.length - 1; index >= 0; index--) {
        const part = doc[index];
        if (part !== undefined) pending.push({ indent: command.indent, mode, doc: part });
      }
    } else {
      switch (doc.kind) {
        case "group":
        case "indent":
        case "indentIfBreak":
          pending.push({ indent: command.indent, mode, doc: doc.contents });
          break;
        case "ifBreak":
          pending.push({
            indent: command.indent,
            mode,
            doc: mode === "break" ? doc.broken : doc.flat,
          });
          break;
        case "fill":
          if (mode === "break") {
            remaining -= textWidth(doc.contents[0] ?? "");
            if (doc.contents.length > 1) return true;
          } else {
            remaining -= textWidth(doc.contents.join(" "));
          }
          break;
        case "line":
          if (mode === "break" || doc.mode === "hard") return true;
          if (doc.mode === "line") remaining -= 1;
          break;
      }
    }
  }
  return false;
}

function hasHardline(doc: Doc): boolean {
  if (typeof doc === "string") return false;
  if (isDocArray(doc)) return doc.some(hasHardline);
  switch (doc.kind) {
    case "line":
      return doc.mode === "hard";
    case "fill":
      return false;
    case "ifBreak":
      return hasHardline(doc.broken) || hasHardline(doc.flat);
    case "group":
    case "indent":
    case "indentIfBreak":
      return hasHardline(doc.contents);
  }
}

// `Array.isArray` doesn't narrow readonly arrays out of a union.
function isDocArray(doc: Doc): doc is readonly Doc[] {
  return Array.isArray(doc);
}
