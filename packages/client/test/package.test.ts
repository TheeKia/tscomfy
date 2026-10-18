import { expect, test } from "bun:test";

test("@tscomfy/client resolves to its source entry under the @tscomfy/source condition", () => {
  expect(import.meta.resolve("@tscomfy/client")).toEndWith("/packages/client/src/index.ts");
});
