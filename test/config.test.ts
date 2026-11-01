import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { loadFleetConfig, configPath, isLimit, checkFleetConfig } from "../src/config.ts";

let dir: string;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "fleet-config-"));
});

afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

const write = (cfg: unknown) => fs.writeFileSync(configPath(dir), JSON.stringify(cfg));

describe("isLimit", () => {
  it("accepts whole numbers, with 0 meaning no limit", () => {
    for (const n of [0, 1, 40]) expect(isLimit(n)).toBe(true);
  });

  it("refuses everything else", () => {
    for (const n of [-1, 1.5, NaN, Infinity, "40", null, undefined]) expect(isLimit(n)).toBe(false);
  });
});

describe("fleet.json limits", () => {
  it("reads the limits, keeping an explicit 0", () => {
    write({ maxTurns: 25, maxHops: 0, agents: [] });
    expect(loadFleetConfig(dir)).toMatchObject({ maxTurns: 25, maxHops: 0 });
  });

  it("refuses an unusable limit, naming the field", () => {
    write({ maxTurns: "lots", agents: [] });
    expect(() => loadFleetConfig(dir)).toThrow(/"maxTurns" must be a whole number/);
  });
});

describe("fleet.json budget and approvals", () => {
  it("reads them", () => {
    write({ maxCost: 2.5, agents: [{ name: "a", approve: ["bash"] }] });
    expect(loadFleetConfig(dir)).toMatchObject({ maxCost: 2.5, agents: [{ name: "a", approve: ["bash"] }] });
  });

  it("refuses a budget that is not a positive number", () => {
    write({ maxCost: 0, agents: [] });
    expect(() => loadFleetConfig(dir)).toThrow(/"maxCost" must be a positive number/);
  });
});

describe("fleet.json worktrees and task board", () => {
  it("reads them", () => {
    write({ worktrees: true, taskboard: "beads", agents: [{ name: "a", worktree: false }] });
    expect(loadFleetConfig(dir)).toMatchObject({ worktrees: true, taskboard: "beads", agents: [{ name: "a", worktree: false }] });
  });

  it("refuses an unknown task board", () => {
    write({ taskboard: "jira", agents: [] });
    expect(() => loadFleetConfig(dir)).toThrow(/"taskboard" must be "openspec" or "beads"/);
  });
});

describe("checkFleetConfig", () => {
  it("accepts what the GUI sends", () => {
    expect(checkFleetConfig({ defaultModel: "a/b", maxTurns: 10, agents: [{ name: "x", role: "planner" }] }, "form")).toMatchObject({ maxTurns: 10 });
  });

  it("refuses a bad agent name, saying where it came from", () => {
    expect(() => checkFleetConfig({ agents: [{ name: "not ok" }] }, "fleet config")).toThrow('invalid fleet config: "not ok" is not a valid agent name');
  });
});

describe("an invalid fleet.json", () => {
  it("is an error naming the file, not an empty fleet", () => {
    fs.writeFileSync(configPath(dir), "{ not json");
    expect(() => loadFleetConfig(dir)).toThrow(configPath(dir));
  });

  it("needs a list of named agents", () => {
    write({ agents: "planner" });
    expect(() => loadFleetConfig(dir)).toThrow(/"agents" must be a list/);
    write({ agents: [{ model: "x" }] });
    expect(() => loadFleetConfig(dir)).toThrow(/every agent needs a "name"/);
  });

  it("no file at all is simply no config", () => {
    expect(loadFleetConfig(dir)).toBeNull();
  });
});
