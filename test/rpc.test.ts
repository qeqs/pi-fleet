import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { PiRpc, packageBinArgv, piArgv } from "../src/rpc.ts";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const server = path.join(here, "fake-pi-server.mjs");

let dir: string;
let rpc: PiRpc | undefined;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "fleet-rpc-"));
});

afterEach(async () => {
  if (rpc) await rpc.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

function makeRpc(timeoutMs = 3000): PiRpc {
  const logFile = path.join(dir, "log.txt");
  const r = new PiRpc([process.execPath, server], { cwd: dir, env: process.env, logFile, timeoutMs });
  rpc = r;
  return r;
}

describe("packageBinArgv", () => {
  function installed(layout: string): { root: string } {
    const top = fs.mkdtempSync(path.join(os.tmpdir(), "fleet-bin-"));
    const pkg = path.join(top, layout, "node_modules", "@scope", "tool");
    fs.mkdirSync(pkg, { recursive: true });
    fs.writeFileSync(path.join(pkg, "package.json"), JSON.stringify({ bin: { tool: "./cli.js" } }));
    return { root: path.join(top, "node_modules", "pi-fleet") };
  }

  it("finds a dependency npm hoisted above pi-fleet", () => {
    const { root } = installed(".");
    fs.mkdirSync(root, { recursive: true });
    expect(packageBinArgv(root, "@scope/tool", "tool")[1]).toMatch(/node_modules[\\/]@scope[\\/]tool[\\/]cli\.js$/);
  });

  it("finds a dependency nested inside pi-fleet", () => {
    const { root } = installed("node_modules/pi-fleet");
    expect(packageBinArgv(root, "@scope/tool", "tool")[1]).toContain("pi-fleet");
  });

  it("reads a package with a single command", () => {
    expect(packageBinArgv(path.join(here, ".."), "tsx", "tsx")[1]).toMatch(/cli.mjs$/);
  });

  it("says what to do when one is missing", () => {
    expect(() => packageBinArgv(os.tmpdir(), "@scope/not-there", "tool")).toThrow("@scope/not-there is not installed: reinstall pi-fleet");
  });
});

describe("rpc framing", () => {
  it("reassembles a response split across multiple writes", async () => {
    const r = makeRpc();
    const resp = await r.prompt("ping");
    expect(resp.ok).toBe(true);
    expect(resp.result).toBe("pong-ping");
  });

  it("delivers events separately from responses", async () => {
    const r = makeRpc();
    const events: Record<string, unknown>[] = [];
    r.onEvent = (rec) => events.push(rec);
    await r.prompt("ping");
    expect(events.some((e) => e.type === "event" && e.name === "test_event")).toBe(true);
  });

  it("matches responses to requests by id", async () => {
    const r = makeRpc();
    const [a, b] = await Promise.all([r.prompt("first"), r.prompt("second")]);
    expect(a.result).toBe("pong-first");
    expect(b.result).toBe("pong-second");
  });

  it("get_state round-trips", async () => {
    const r = makeRpc();
    const resp = await r.getState();
    expect(resp.ok).toBe(true);
    expect((resp.state as { agents: unknown[] }).agents).toEqual([]);
  });

  it("times out when no response arrives", async () => {
    // Point at a server that never responds to prompt (use a no-op command).
    const logFile = path.join(dir, "log2.txt");
    const silent = new PiRpc([process.execPath, "-e", "process.stdin.resume()"], {
      cwd: dir,
      env: process.env,
      logFile,
      timeoutMs: 300,
    });
    await expect(silent.prompt("ping")).rejects.toThrow(/RPC timeout/);
    await silent.close();
  });

  it("sends the streaming behavior only when asked", async () => {
    const r = makeRpc();
    expect((await r.prompt("queued", "followUp")).streamingBehavior).toBe("followUp");
    expect((await r.prompt("plain")).streamingBehavior).toBeUndefined();
  });

  it("hands arguments to the program verbatim, with no shell in between", async () => {
    const out = path.join(dir, "argv.txt");
    const hostile = `x" & mkdir pwned & rem "%PATH%`;
    const script = "require('fs').writeFileSync(process.argv[1], process.argv[2])";
    const child = new PiRpc([process.execPath, "-e", script, out, hostile], {
      cwd: dir,
      env: process.env,
      logFile: path.join(dir, "log3.txt"),
    });
    await new Promise<void>((resolve) => (child.onExit = () => resolve()));
    expect(fs.readFileSync(out, "utf8")).toBe(hostile);
    expect(fs.existsSync(path.join(dir, "pwned"))).toBe(false);
  });
});

describe("piArgv", () => {
  it("resolves pi's own entry point and runs it with this node", () => {
    const argv = piArgv(path.resolve(here, ".."), ["--mode", "rpc"]);
    expect(argv[0]).toBe(process.execPath);
    expect(fs.existsSync(argv[1])).toBe(true);
    expect(argv.slice(2)).toEqual(["--mode", "rpc"]);
  });
});