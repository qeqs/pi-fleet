import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Hub, type FleetMessage } from "../src/hub.ts";
import { buildLookup } from "../src/extension/index.ts";
import { computeWakes } from "../src/wakes.ts";

let dir: string;
let hub: Hub;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "fleet-wakes-"));
  hub = new Hub(dir);
  for (const name of ["sup", "impl", "rev"]) hub.updateAgent(name, { name, pid: 1, cwd: ".", status: "idle" });
  hub.upsertChannel({ name: "group", members: ["sup", "impl", "rev"], supervisor: "sup" });
});

afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

const say = (from: string, to: string, text: string): FleetMessage => hub.appendMessage({ from, to, kind: "chat", text });
const wakes = (messages: FleetMessage[], maxHops = 0) => computeWakes(messages, hub, buildLookup(hub), maxHops);

describe("computeWakes", () => {
  it("wakes only the router for a channel message, with a routing prompt", () => {
    const result = wakes([say("user", "group", "build it")]);
    expect([...result.keys()]).toEqual(["sup"]);
    expect(result.get("sup")).toContain("Routing task for #group");
  });

  it("wakes a mentioned member directly", () => {
    const result = wakes([say("impl", "group", "@rev please review")]);
    expect([...result.keys()]).toEqual(["rev"]);
    expect(result.get("rev")).toContain("please review");
  });

  it("never wakes the sender", () => {
    expect(wakes([say("impl", "impl", "note to self")]).size).toBe(0);
  });

  it("joins several messages for one agent into one wake", () => {
    const result = wakes([say("impl", "rev", "first"), say("sup", "rev", "second")]);
    expect(result.get("rev")).toContain("first");
    expect(result.get("rev")).toContain("second");
  });

  it("wakes nobody while the fleet is paused, and the human lifts the pause", () => {
    hub.pause("stopped by you");
    expect(wakes([say("impl", "rev", "held")]).size).toBe(0);
    expect(wakes([say("user", "rev", "go on")]).has("rev")).toBe(true);
    expect(hub.pausedReason()).toBeNull();
  });

  it("stops at the hop limit", () => {
    const result = wakes([say("impl", "rev", "one"), say("rev", "impl", "two"), say("impl", "rev", "three")], 2);
    expect(result.get("rev")).toContain("one");
    expect(result.get("impl")).toContain("two");
    expect(result.get("rev")).not.toContain("three");
    expect(hub.pausedReason()).toContain("--max-hops");
  });

  describe("with the dedicated router", () => {
    beforeEach(() => hub.upsertChannel({ name: "group", members: ["sup", "impl", "rev"], supervisor: undefined }));
    const route = (messages: FleetMessage[]) => {
      const routed: string[] = [];
      const result = computeWakes(messages, hub, buildLookup(hub), 0, (m) => routed.push(m.text));
      return { routed, woken: [...result.keys()] };
    };

    it("hands a channel message to the router and wakes nobody", () => {
      expect(route([say("user", "group", "build it")])).toEqual({ routed: ["build it"], woken: [] });
    });

    it("sends an @mention straight to the member, past the router", () => {
      expect(route([say("impl", "group", "@rev please look")])).toEqual({ routed: [], woken: ["rev"] });
    });

    it("keeps the summary current when a mention bypasses the router", () => {
      route([say("impl", "group", "@rev please look")]);
      expect(hub.getChannel("group")?.summary).toContain("impl: @rev please look");
    });

    it("leaves a channel with a named supervisor to that agent", () => {
      hub.upsertChannel({ name: "dev", members: ["sup", "rev"], supervisor: "sup" });
      expect(route([say("user", "dev", "over to you")])).toEqual({ routed: [], woken: ["sup"] });
    });

    it("leaves DMs alone", () => {
      expect(route([say("user", "rev", "direct")])).toEqual({ routed: [], woken: ["rev"] });
    });
  });

  it("does not treat a direct-prompt marker as a message to deliver", () => {
    const marker = hub.appendMessage({ from: "user", to: "impl", kind: "activity", text: "direct prompt" });
    expect(wakes([marker]).size).toBe(0);
  });
});
