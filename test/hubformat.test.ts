import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Hub } from "../src/hub.ts";
import { HUB_FORMAT, readHubFormat, upgradeHub } from "../src/hubformat.ts";

let dir: string;
const channels = (group: object) => fs.writeFileSync(path.join(dir, "channels.json"), JSON.stringify({ channels: [{ name: "group", members: ["a"], ...group }] }));
const readChannels = () => JSON.parse(fs.readFileSync(path.join(dir, "channels.json"), "utf8")).channels;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "fleet-format-"));
});

afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

describe("upgradeHub", () => {
  it("stamps a new hub without calling it an upgrade", () => {
    expect(upgradeHub(dir)).toBeNull();
    expect(readHubFormat(dir)).toBe(HUB_FORMAT);
  });

  it("reports the format an existing hub was in", () => {
    fs.writeFileSync(path.join(dir, "messages.jsonl"), "");
    expect(upgradeHub(dir)).toBe(0);
    expect(readHubFormat(dir)).toBe(HUB_FORMAT);
  });

  it("does nothing the second time", () => {
    fs.writeFileSync(path.join(dir, "messages.jsonl"), "");
    upgradeHub(dir);
    expect(upgradeHub(dir)).toBeNull();
  });

  it("keeps a pause from when the reason was plain text", () => {
    fs.writeFileSync(path.join(dir, "paused"), "stopped by you");
    upgradeHub(dir);
    expect(new Hub(dir).pausedReason()).toBe("stopped by you");
  });

  it("leaves a pause that is already in the current form", () => {
    const pause = JSON.stringify({ reason: "budget", since: 5 });
    fs.writeFileSync(path.join(dir, "paused"), pause);
    upgradeHub(dir);
    expect(fs.readFileSync(path.join(dir, "paused"), "utf8")).toBe(pause);
  });

  it("hands #group from a worker to the dedicated router", () => {
    channels({ supervisor: "a" });
    upgradeHub(dir);
    expect(readChannels()[0].supervisor).toBeUndefined();
  });

  it("keeps a supervisor a person chose", () => {
    channels({ supervisor: "a", pinned: true });
    upgradeHub(dir);
    expect(readChannels()[0].supervisor).toBe("a");
  });

  it.skipIf(process.platform === "win32")("closes a hub other users could read", () => {
    fs.chmodSync(dir, 0o755);
    fs.writeFileSync(path.join(dir, "messages.jsonl"), "");
    upgradeHub(dir);
    expect(fs.statSync(dir).mode & 0o777).toBe(0o700);
  });

  it.skipIf(process.platform === "win32")("creates new hubs for their owner alone", () => {
    const hubDir = path.join(dir, "new-hub");
    new Hub(hubDir);
    expect(fs.statSync(hubDir).mode & 0o777).toBe(0o700);
  });

  it("refuses a hub from a newer release and leaves it alone", () => {
    fs.writeFileSync(path.join(dir, "format.json"), JSON.stringify({ format: HUB_FORMAT + 1 }));
    expect(() => upgradeHub(dir)).toThrow(/written by a newer pi-fleet .*Update pi-fleet/);
    expect(readHubFormat(dir)).toBe(HUB_FORMAT + 1);
  });
});
