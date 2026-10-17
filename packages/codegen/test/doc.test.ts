import { describe, expect, test } from "bun:test";
import {
  type Doc,
  group,
  hardline,
  ifBreak,
  indent,
  join,
  line,
  print,
  softline,
} from "../src/doc.ts";

const list = (items: readonly Doc[]): Doc =>
  group(["[", indent([softline, join([",", line], items)]), ifBreak(","), softline, "]"]);

describe("print", () => {
  test("keeps a group that fits on one line, up to the last column", () => {
    expect(print(list(["a", "b"]), 6)).toBe("[a, b]");
    expect(print(["x", list(["a", "b"])], 6)).toBe("x[\n  a,\n  b,\n]");
  });

  test("breaks only the groups that don't fit", () => {
    const doc = list(["alpha", list(["b", "c"]), "omega"]);
    expect(print(doc, 12)).toBe("[\n  alpha,\n  [b, c],\n  omega,\n]");
  });

  test("counts what follows a group on its line", () => {
    expect(print([list(["a", "b"]), " = long tail"], 10)).toBe("[\n  a,\n  b,\n] = long tail");
  });

  test("breaks a group that holds a hard line and keeps blank lines", () => {
    expect(print(group(["a", line, "b", hardline, hardline, "c"]), 80)).toBe("a\nb\n\nc");
  });

  test("drops spaces before a newline", () => {
    expect(print(group(["a", indent([line, "b"]), line]), 2)).toBe("a\n  b\n");
  });
});
