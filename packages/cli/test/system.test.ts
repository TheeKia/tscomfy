import { afterAll, describe, expect, test } from "bun:test";
import { lstat, mkdir, mkdtemp, readdir, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type Io, run, systemIo } from "@tscomfy/cli";
import { readMockObjectInfo } from "@tscomfy/fixtures";

// The real Io: HTTP through fetch, files through Bun, and the executable itself.

const basic = await readMockObjectInfo("basic-pipeline");
const temp = await mkdtemp(join(tmpdir(), "tscomfy-cli-"));
const seen: { readonly method: string; readonly path: string; readonly auth: string | null }[] = [];
let status = 200;
const server = Bun.serve({
  port: 0,
  hostname: "127.0.0.1",
  fetch: (request) => {
    const { pathname } = new URL(request.url);
    seen.push({
      method: request.method,
      path: pathname,
      auth: request.headers.get("authorization"),
    });
    if (status !== 200) return new Response("down", { status });
    if (pathname === "/object_info") return new Response(basic);
    if (pathname === "/system_stats") {
      return Response.json({ system: { comfyui_version: "0.41.0" } });
    }
    return new Response("not found", { status: 404 });
  },
});
const url = `http://127.0.0.1:${String(server.port)}`;

afterAll(async () => {
  await server.stop(true);
  await rm(temp, { recursive: true, force: true });
});

/** The system Io with its output captured. */
function captured(): Io & { readonly output: () => string } {
  let output = "";
  const write = (text: string): void => {
    output += text;
  };
  return { ...systemIo(), out: write, err: write, output: () => output };
}

describe("systemIo", () => {
  test("generates from a server with GETs only, then checks against it", async () => {
    const out = join(temp, "comfy");
    const io = captured();
    expect(
      await run(
        ["generate", "--url", `http://user:pw@127.0.0.1:${String(server.port)}/`, "--out", out],
        io,
      ),
    ).toBe(0);
    expect(seen).toEqual([
      { method: "GET", path: "/object_info", auth: `Basic ${btoa("user:pw")}` },
      { method: "GET", path: "/system_stats", auth: `Basic ${btoa("user:pw")}` },
    ]);
    expect(await Bun.file(join(out, "object_info.json")).text()).toBe(basic);
    expect(await Bun.file(join(out, "index.ts")).text()).toContain(`--url ${url} --out`);

    const check = captured();
    expect(await run(["check", "--url", url, "--out", out], check)).toBe(0);
    expect(check.output()).toStartWith("Up to date: 8 node types match");
  });

  test("reports an error status", async () => {
    status = 503;
    try {
      const io = captured();
      const withCredentials = url.replace("//", "//user:pw@");
      expect(
        await run(["generate", "--url", withCredentials, "--out", join(temp, "down")], io),
      ).toBe(1);
      expect(io.output()).toBe(`tscomfy: ${url}/object_info answered 503 Service Unavailable\n`);
    } finally {
      status = 200;
    }
  });

  test("reports a server that isn't there", async () => {
    const io = captured();
    // Port 9 (discard) is closed on any machine running these tests.
    const closed = "http://user:pw@127.0.0.1:9";
    expect(await run(["generate", "--url", closed, "--out", join(temp, "x")], io)).toBe(1);
    expect(io.output()).toStartWith("tscomfy: Could not reach http://127.0.0.1:9/object_info: ");
    expect(io.output()).not.toContain("pw");
  });

  test("reports files it can't write", async () => {
    const file = join(temp, "a-file");
    await Bun.write(file, "");
    const io = captured();
    expect(await run(["generate", "--url", url, "--out", join(file, "sub")], io)).toBe(1);
    expect(io.output()).toStartWith(`tscomfy: Could not write ${join(file, "sub")}/`);
  });
});

describe("systemIo failures", () => {
  test("reports a body that breaks off", async () => {
    // Promises 100,000 bytes, sends one, and hangs up.
    const broken = Bun.listen({
      hostname: "127.0.0.1",
      port: 0,
      socket: {
        data: (socket) => {
          socket.write("HTTP/1.1 200 OK\r\nContent-Length: 100000\r\n\r\n{");
          socket.end();
        },
      },
    });
    try {
      const io = captured();
      const at = `http://127.0.0.1:${String(broken.port)}`;
      expect(await run(["generate", "--url", at, "--out", join(temp, "broken")], io)).toBe(1);
      expect(io.output()).toStartWith(`tscomfy: Could not reach ${at}/object_info: `);
    } finally {
      broken.stop(true);
    }
  });

  test("reports a directory given as a file", async () => {
    const io = captured();
    expect(await run(["generate", "--from", temp, "--out", join(temp, "x")], io)).toBe(1);
    expect(io.output()).toStartWith(`tscomfy: Could not read ${temp}: `);
  });

  test("replaces files whole and leaves no temporary files", async () => {
    const out = join(temp, "atomic");
    const io = captured();
    expect(await run(["generate", "--url", url, "--out", out], io)).toBe(0);
    expect(await run(["generate", "--url", url, "--out", out], io)).toBe(0);
    expect((await readdir(out)).toSorted()).toEqual([
      "index.ts",
      "nodes.ts",
      "object_info.json",
      "tscomfy.json",
    ]);
  });
});

test("writes through a symlinked file, keeping the link", async () => {
  const out = join(temp, "linked");
  const real = join(temp, "real-nodes.ts");
  await Bun.write(real, "");
  await mkdir(out, { recursive: true });
  await symlink(real, join(out, "nodes.ts"));
  expect(await run(["generate", "--url", url, "--out", out], captured())).toBe(0);
  expect((await lstat(join(out, "nodes.ts"))).isSymbolicLink()).toBeTrue();
  expect(await Bun.file(real).text()).toStartWith("// Generated by @tscomfy/codegen");
});

describe("the executable", () => {
  const main = join(import.meta.dir, "..", "src", "main.ts");

  test.each([
    [["--version"], 0],
    [[], 2],
    [["generate", "--from", join(temp, "missing.json"), "--out", join(temp, "x")], 1],
  ])("%p exits with %p", async (args, code) => {
    const child = Bun.spawn([process.execPath, "--conditions=@tscomfy/source", main, ...args], {
      stdout: "pipe",
      stderr: "pipe",
    });
    expect(await child.exited).toBe(code);
  });
});
