import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { spawn, execSync, type ChildProcess } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";
import { PiRpcBridge, bridgeListening } from "../src/rpc.ts";

const ROOT = path.resolve(__dirname, "..");
const tsxCli = path.join(ROOT, "node_modules", "tsx", "dist", "cli.mjs");
const bridgeScript = path.join(ROOT, "src", "bridge.ts");
const fakePi = path.join(ROOT, "test", "fake-pi-server.mjs");

function makePipe(kind: string): string {
  const id = crypto.randomBytes(5).toString("hex");
  const base = `pi-fleet-test-${id}-${kind}`;
  return process.platform === "win32" ? `\\\\.\\pipe\\${base}` : path.join(os.tmpdir(), `${base}.sock`);
}

function killTree(pid: number): void {
  if (!pid) return;
  if (process.platform === "win32") {
    try {
      execSync(`taskkill /PID ${pid} /T /F`, { stdio: "ignore" });
    } catch {
      // ignore
    }
  } else {
    try {
      process.kill(pid, "SIGTERM");
    } catch {
      // ignore
    }
  }
}

describe("bridge owner", () => {
  it("exits when its owner dies, so a killed test run leaks no agents", async () => {
    const owner = spawn(process.execPath, ["-e", "setTimeout(() => {}, 60000)"], { stdio: "ignore" });
    const pipeIn = makePipe("in");
    const pipeOut = makePipe("out");
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "pi-fleet-bridge-test-"));
    const bridge = spawn(process.execPath, [tsxCli, bridgeScript], {
      env: {
        ...process.env,
        PI_FLEET_PIPE_IN: pipeIn,
        PI_FLEET_PIPE_OUT: pipeOut,
        PI_FLEET_ARGV: JSON.stringify([process.execPath, fakePi]),
        PI_FLEET_CWD: tmp,
        PI_FLEET_LOG: path.join(tmp, "bridge.log"),
        PI_FLEET_OWNER_PID: String(owner.pid),
      },
      stdio: "ignore",
      detached: true,
    });
    bridge.unref();
    try {
      (await PiRpcBridge.connect(pipeIn, pipeOut, bridge.pid!)).close();
      expect(await bridgeListening(pipeIn)).toBe(true);
      killTree(owner.pid ?? 0);
      for (let i = 0; i < 80 && (await bridgeListening(pipeIn)); i++) await new Promise((r) => setTimeout(r, 100));
      expect(await bridgeListening(pipeIn)).toBe(false);
    } finally {
      killTree(owner.pid ?? 0);
      killTree(bridge.pid ?? 0);
    }
  }, 20000);
});

describe("bridge (named-pipe transport, detached + re-attach)", () => {
  let bridge: ChildProcess;
  let pipeIn: string;
  let pipeOut: string;
  let tmp: string;

  beforeAll(async () => {
    pipeIn = makePipe("in");
    pipeOut = makePipe("out");
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), "pi-fleet-bridge-test-"));
    const logFile = path.join(tmp, "bridge.log");
    bridge = spawn(process.execPath, [tsxCli, bridgeScript], {
      env: {
        ...process.env,
        PI_FLEET_PIPE_IN: pipeIn,
        PI_FLEET_PIPE_OUT: pipeOut,
        PI_FLEET_ARGV: JSON.stringify([process.execPath, fakePi]),
        PI_FLEET_CWD: tmp,
        PI_FLEET_LOG: logFile,
      },
      stdio: "ignore",
      detached: true,
    });
    bridge.unref();
  });

  afterAll(() => {
    killTree(bridge.pid ?? 0);
  });

  it("connects, prompts, survives disconnect, and re-attaches", async () => {
    // 1. connect + prompt
    const client = await PiRpcBridge.connect(pipeIn, pipeOut, bridge.pid!);
    const resp = await client.prompt("ping");
    expect(resp).toMatchObject({ type: "response", ok: true, result: "pong-ping" });
    expect(await bridgeListening(pipeIn)).toBe(true);

    // 2. disconnect (simulate the supervisor exiting)
    client.close();
    await new Promise((r) => setTimeout(r, 400));

    // 3. the bridge (and its fake pi) must still be alive
    let alive = true;
    try {
      process.kill(bridge.pid!, 0);
    } catch {
      alive = false;
    }
    expect(alive).toBe(true);

    // 4. re-attach and prompt again (same fake pi, so it still responds)
    const client2 = await PiRpcBridge.connect(pipeIn, pipeOut, bridge.pid!);
    const resp2 = await client2.prompt("hello");
    expect(resp2).toMatchObject({ ok: true, result: "pong-hello" });
    client2.close();
  }, 20000);

  it("killing the bridge tears down the pipe (reconnect fails)", async () => {
    killTree(bridge.pid!);
    await new Promise((r) => setTimeout(r, 500));
    expect(await bridgeListening(pipeIn)).toBe(false);
    await expect(PiRpcBridge.connect(pipeIn, pipeOut, bridge.pid!, 2000)).rejects.toThrow();
  }, 15000);
});