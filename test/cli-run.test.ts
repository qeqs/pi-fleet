/**
 * The fleet command as a person meets it: bad input must end in a sentence and a
 * non-zero exit, never a stack trace. These run the real entry point, with no agents.
 */
import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { Hub } from "../src/hub.ts";

const ROOT = path.resolve(__dirname, "..");
const TSX = path.join(ROOT, "node_modules", "tsx", "dist", "cli.mjs");
const FLEET = path.join(ROOT, "src", "fleet.ts");

vi.setConfig({ testTimeout: 60000 }); // each case boots node and tsx, some of them several times

let tmp: string;

function fleet(...args: string[]): { code: number | null; stdout: string; stderr: string } {
  const r = spawnSync(process.execPath, [TSX, FLEET, ...args], { cwd: tmp, encoding: "utf8", timeout: 60000 });
  return { code: r.status, stdout: r.stdout, stderr: r.stderr };
}

function expectCleanFailure(r: ReturnType<typeof fleet>, code: number, message: string): void {
  expect(r.stderr).toContain(message);
  expect(r.code).toBe(code);
  expect(r.stderr).not.toMatch(/\n\s+at /);
}

function hubWith(name: string, fleetJson?: string): string {
  const dir = path.join(tmp, name);
  fs.mkdirSync(dir, { recursive: true });
  if (fleetJson !== undefined) fs.writeFileSync(path.join(dir, "fleet.json"), fleetJson);
  return dir;
}

beforeAll(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), "fleet-cli-"));
});

afterAll(() => {
  fs.rmSync(tmp, { recursive: true, force: true });
});

describe("the installed command", () => {
  it("runs from any folder and knows its version", () => {
    const r = spawnSync(process.execPath, [path.join(ROOT, "bin", "fleet.mjs"), "--version"], { cwd: os.tmpdir(), encoding: "utf8", timeout: 60000 });
    expect(r.stdout.trim()).toBe(JSON.parse(fs.readFileSync(path.join(ROOT, "package.json"), "utf8")).version);
  });

  it("is what the usage text tells people to type", () => {
    expect(fleet("help").stdout).toContain("  fleet up ");
    expect(fleet("help").stdout).not.toContain("npm run");
  });
});

describe("fleet on bad input", () => {
  it("names an unknown option and points to help", () => {
    const r = fleet("up", "--detatch");
    expectCleanFailure(r, 2, 'fleet: unknown option "--detatch"');
    expect(r.stderr).toContain("help");
  });

  it("refuses a bad port", () => {
    expectCleanFailure(fleet("up", "--port", "abc"), 2, '--port needs a number from 0 to 65535, got "abc"');
  });

  it("refuses a stray argument to up", () => {
    expectCleanFailure(fleet("up", "alice"), 2, 'unexpected argument "alice"');
  });

  it("names an unknown command", () => {
    expectCleanFailure(fleet("upp"), 2, 'unknown command "upp"');
  });

  it("names an unknown template and lists the real ones", () => {
    const r = fleet("up", "--template", "nope", "--dir", hubWith("template"));
    expectCleanFailure(r, 2, 'unknown template "nope"');
    expect(r.stderr).toContain("sdlc");
  });

  it("names the file when fleet.json is invalid", () => {
    const dir = hubWith("badjson", "{ not json");
    expectCleanFailure(fleet("up", "--dir", dir), 1, `invalid fleet config ${path.join(dir, "fleet.json")}`);
  });

  it("explains a port that is taken", async () => {
    const taken = net.createServer();
    await new Promise<void>((resolve) => taken.listen(0, "127.0.0.1", resolve));
    const { port } = taken.address() as net.AddressInfo;
    expectCleanFailure(fleet("serve", "--port", String(port), "--dir", hubWith("port")), 1, `could not start the GUI on port ${port}`);
    taken.close();
  });
});

describe("fleet help and stop", () => {
  it("prints usage for help, --help and no command", () => {
    for (const args of [["help"], ["--help"], ["-h"], []]) {
      const r = fleet(...args);
      expect(r.code).toBe(0);
      expect(r.stdout).toContain("Usage:");
    }
  });

  it("says so when there is nothing to stop", () => {
    const r = fleet("stop", "--dir", hubWith("empty"));
    expect(r.code).toBe(0);
    expect(r.stdout).toContain("no agents registered");
    expect(r.stdout).not.toContain("undefined");
  });

  it("names the agents when asked to stop one that does not exist", () => {
    const dir = hubWith("one");
    new Hub(dir).updateAgent("alice", { name: "alice", pid: 0, cwd: ".", status: "stopped" });
    expectCleanFailure(fleet("stop", "bob", "--dir", dir), 1, 'no agent "bob". Agents: alice.');
  });
});

describe("fleet doctor", () => {
  it("passes on a healthy setup and shows what it checked", () => {
    const r = fleet("doctor", "--dir", hubWith("healthy"));
    expect(r.code).toBe(0);
    for (const label of ["node", "pi", "openspec", "hub", "config", "supervisor", "agents"]) expect(r.stdout).toMatch(new RegExp(`^ok\\s+${label}\\s`, "m"));
  });

  it("fails on an invalid config and says why", () => {
    const r = fleet("doctor", "--dir", hubWith("doctor-bad", "{ not json"));
    expect(r.code).toBe(1);
    expect(r.stdout).toMatch(/^fail\s+config\s+invalid fleet config/m);
  });
});
