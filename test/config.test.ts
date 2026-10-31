import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { loadFleetConfig, configPath, isLimit } from "../src/config.ts";

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

  it("leaves unusable limits unset, so the defaults apply", () => {
    write({ maxTurns: "lots", maxHops: -1, agents: [] });
    const cfg = loadFleetConfig(dir);
    expect(cfg?.maxTurns).toBeUndefined();
    expect(cfg?.maxHops).toBeUndefined();
  });
});
