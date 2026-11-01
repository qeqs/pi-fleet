import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Hub } from "../src/hub.ts";
import { configCheck, formatCheck, registryCheck, supervisorCheck } from "../src/doctor.ts";

let dir: string;
let hub: Hub;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "fleet-doctor-"));
  hub = new Hub(dir);
});

afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

describe("configCheck", () => {
  it("is fine with no config", () => {
    expect(configCheck(hub).status).toBe("ok");
  });

  it("counts the agents in a valid config", () => {
    fs.writeFileSync(path.join(dir, "fleet.json"), JSON.stringify({ agents: [{ name: "a" }, { name: "b" }] }));
    expect(configCheck(hub).detail).toContain("2 agent(s)");
  });

  it("fails on an invalid config", () => {
    fs.writeFileSync(path.join(dir, "fleet.json"), "{");
    expect(configCheck(hub)).toMatchObject({ status: "fail", detail: expect.stringContaining("invalid fleet config") });
  });
});

describe("formatCheck", () => {
  const formatHub = () => new Hub(fs.mkdtempSync(path.join(os.tmpdir(), "fleet-doctor-format-")));

  it("is fine with a new hub", () => {
    expect(formatCheck(formatHub()).status).toBe("ok");
  });

  it("warns that an older hub will be upgraded", () => {
    const hub = formatHub();
    fs.writeFileSync(hub.messagesFile, "");
    expect(formatCheck(hub)).toMatchObject({ status: "warn", detail: expect.stringContaining("upgrades it") });
  });

  it("fails on a hub from a newer release", () => {
    const hub = formatHub();
    fs.writeFileSync(path.join(hub.dir, "format.json"), JSON.stringify({ format: 999 }));
    expect(formatCheck(hub).status).toBe("fail");
  });
});

describe("registryCheck", () => {
  it("is fine with nothing registered", async () => {
    expect((await registryCheck(hub)).status).toBe("ok");
  });

  it("ignores agents that are stopped", async () => {
    hub.updateAgent("old", { name: "old", pid: 0, cwd: ".", status: "stopped" });
    expect((await registryCheck(hub)).status).toBe("ok");
  });

  it("warns about agents marked running with nothing behind them", async () => {
    hub.updateAgent("ghost", { name: "ghost", pid: 999999999, cwd: ".", status: "idle", pipeIn: path.join(dir, "no-pipe") });
    expect(await registryCheck(hub)).toMatchObject({ status: "warn", detail: expect.stringContaining("ghost") });
  });
});

describe("supervisorCheck", () => {
  it("reports when none is attached", () => {
    expect(supervisorCheck(hub).detail).toBe("none attached");
  });
});
