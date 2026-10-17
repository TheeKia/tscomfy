import { describe, expect, test } from "bun:test";
import { hashSchema, normalizeObjectInfo, parse, stringify } from "@tscomfy/core";
import { MOCK_OBJECT_INFO_NAMES, readMockObjectInfo } from "@tscomfy/fixtures";
import { sha256Hex, utf8 } from "../src/hash/sha256.ts";
import { isJsonObject } from "../src/json/value.ts";

const native = (bytes: Uint8Array): string =>
  new Bun.CryptoHasher("sha256").update(bytes).digest("hex");

describe("sha256Hex", () => {
  // FIPS 180-4 example vectors.
  test.each([
    ["", "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855"],
    ["abc", "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad"],
    [
      "abcdbcdecdefdefgefghfghighijhijkijkljklmklmnlmnomnopnopq",
      "248d6a61d20638b8e5c026930c3e6039a33ce45964ff2167f6ecedd419db06c1",
    ],
  ])("hashes %p", (text, expected) => {
    expect(sha256Hex(utf8(text))).toBe(expected);
  });

  test("matches the native hasher at every padding boundary", () => {
    for (let length = 0; length <= 130; length++) {
      const bytes = Uint8Array.from({ length }, (_, index) => (index * 31 + length) & 0xff);
      expect(sha256Hex(bytes)).toBe(native(bytes));
    }
  });
});

describe("utf8", () => {
  test.each(["plain", "é ü ß", "🐍 emoji", " ", "lone \ud800 surrogate", "\udc00 end \ud83d"])(
    "encodes %p like TextEncoder",
    (text) => {
      expect(utf8(text)).toEqual(new TextEncoder().encode(text));
    },
  );
});

describe("hashSchema", () => {
  test.each(MOCK_OBJECT_INFO_NAMES)("matches the native hasher on the %s schema", async (name) => {
    const { schema } = normalizeObjectInfo(await readMockObjectInfo(name));
    const expected = native(
      new TextEncoder().encode(stringify({ formatVersion: 1, nodes: schema.nodes })),
    );
    expect(hashSchema(schema)).toBe(`sha256:${expected}`);
  });

  test("ignores comfyVersion, whitespace and node order, and sees every change", async () => {
    const text = await readMockObjectInfo("basic-pipeline");
    const root = parse(text).value;
    if (!isJsonObject(root)) throw new Error("expected an object");
    const reordered = stringify(Object.fromEntries(Object.entries(root).toReversed()));
    const base = hashSchema(normalizeObjectInfo(text).schema);
    expect(hashSchema(normalizeObjectInfo(text, { comfyVersion: "0.41.0" }).schema)).toBe(base);
    expect(hashSchema(normalizeObjectInfo(reordered).schema)).toBe(base);
    const changed = text.replace('"default": 20, "min": 1', '"default": 21, "min": 1');
    expect(changed).not.toBe(text);
    expect(hashSchema(normalizeObjectInfo(changed).schema)).not.toBe(base);
  });
});
