import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { Hub, DEFAULT_CHANNEL } from "../src/hub.ts";
import type { FleetMessage, ChannelConfig, AgentInfo } from "../src/hub.ts";
import { defaultSupervisor, wakeDecision, routingPrompt, directedMessageText } from "../src/extension/index.ts";

let dir: string;
let hub: Hub;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "fleet-chan-"));
  hub = new Hub(dir);
});

afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

function agent(name: string, role?: string): AgentInfo {
  return { name, pid: 1, cwd: ".", status: "idle", startedAt: 0, lastReadOffset: 0, role };
}

const CH: ChannelConfig = { name: "dev", members: ["sup", "impl", "rev"], supervisor: "sup" };

describe("defaultSupervisor", () => {
  it("uses the explicit supervisor when set", () => {
    expect(defaultSupervisor(CH)).toBe("sup");
  });
  it("falls back to the first member when unset", () => {
    expect(defaultSupervisor({ name: "x", members: ["a", "b"] })).toBe("a");
  });
  it("returns undefined for an empty channel", () => {
    expect(defaultSupervisor({ name: "x", members: [] })).toBeUndefined();
  });
});

describe("wakeDecision — channels", () => {
  const channels = [CH];
  it("a supervised channel wakes ONLY the supervisor, in route mode", () => {
    const m: FleetMessage = { id: "1", ts: 0, from: "user", to: "dev", kind: "chat", text: "build a feature" };
    expect(wakeDecision(m, "sup", new Map(), channels)).toEqual({ wake: true, mode: "route", channel: CH });
    expect(wakeDecision(m, "impl", new Map(), channels).wake).toBe(false);
    expect(wakeDecision(m, "rev", new Map(), channels).wake).toBe(false);
  });
  it("a channel without an explicit supervisor routes through its first member", () => {
    const ch: ChannelConfig = { name: "open", members: ["a", "b"] }; // no explicit supervisor
    const m: FleetMessage = { id: "1", ts: 0, from: "user", to: "open", kind: "chat", text: "hi" };
    expect(wakeDecision(m, "a", new Map(), [ch])).toEqual({ wake: true, mode: "route", channel: ch }); // a is the de-facto supervisor
    expect(wakeDecision(m, "b", new Map(), [ch]).wake).toBe(false);
  });
  it("a non-member of a channel does not wake", () => {
    const m: FleetMessage = { id: "1", ts: 0, from: "user", to: "dev", kind: "chat", text: "hi" };
    expect(wakeDecision(m, "outsider", new Map(), channels).wake).toBe(false);
  });
  it("a DM always wakes its recipient in normal mode", () => {
    const m: FleetMessage = { id: "1", ts: 0, from: "sup", to: "impl", kind: "chat", text: "do it" };
    expect(wakeDecision(m, "impl", new Map(), channels)).toEqual({ wake: true, mode: "normal" });
    expect(wakeDecision(m, "rev", new Map(), channels).wake).toBe(false);
  });
  it("an @mention of members wakes only them, directly, without a routing turn", () => {
    const m: FleetMessage = { id: "1", ts: 0, from: "impl", to: "dev", kind: "chat", text: "@rev please review" };
    expect(wakeDecision(m, "rev", new Map(), channels)).toEqual({ wake: true, mode: "normal" });
    expect(wakeDecision(m, "sup", new Map(), channels).wake).toBe(false);
  });
  it("an @mention reaches the mentioned member even when the sender is the supervisor", () => {
    // the sdlc deadlock: the supervisor can never wake itself to route its own message
    const m: FleetMessage = { id: "1", ts: 0, from: "sup", to: "dev", kind: "chat", text: "@impl @rev take this" };
    expect(wakeDecision(m, "impl", new Map(), channels)).toEqual({ wake: true, mode: "normal" });
    expect(wakeDecision(m, "rev", new Map(), channels)).toEqual({ wake: true, mode: "normal" });
  });
  it("a name in the middle of an agent's message is not an address", () => {
    const m: FleetMessage = { id: "1", ts: 0, from: "impl", to: "dev", kind: "chat", text: "waiting on @rev for this" };
    expect(wakeDecision(m, "rev", new Map(), channels).wake).toBe(false);
    expect(wakeDecision(m, "sup", new Map(), channels).mode).toBe("route");
  });

  it("an @mention of the supervisor is work for it, not a routing task", () => {
    const m: FleetMessage = { id: "1", ts: 0, from: "user", to: "dev", kind: "chat", text: "@sup what is the status?" };
    expect(wakeDecision(m, "sup", new Map(), channels)).toEqual({ wake: true, mode: "normal" });
  });
  it("an @ that names no member still goes through the supervisor", () => {
    const m: FleetMessage = { id: "1", ts: 0, from: "user", to: "dev", kind: "chat", text: "mail me at dev@example.com" };
    expect(wakeDecision(m, "sup", new Map(), channels).mode).toBe("route");
    expect(wakeDecision(m, "impl", new Map(), channels).wake).toBe(false);
  });
  it("the legacy group (no channel config) still broadcasts", () => {
    const m: FleetMessage = { id: "1", ts: 0, from: "user", to: DEFAULT_CHANNEL, kind: "chat", text: "hello" };
    expect(wakeDecision(m, "anyone", new Map(), []).wake).toBe(true);
  });
});

describe("routingPrompt", () => {
  it("includes the message, summary, members, and the route instruction", () => {
    const m: FleetMessage = { id: "abc12345-xxxx", ts: 0, from: "user", to: "dev", kind: "chat", text: "build the parser" };
    const ch: ChannelConfig = { ...CH, summary: "Previously: discussed the API." };
    const p = routingPrompt(ch, m, [agent("sup", "supervisor"), agent("impl", "implementer"), agent("rev", "reviewer")]);
    expect(p).toContain("#dev");
    expect(p).toContain("build the parser");
    expect(p).toContain("Previously: discussed the API.");
    expect(p).toContain("impl (implementer)");
    expect(p).toContain("rev (reviewer)");
    expect(p).toContain("route");
    expect(p).toContain("summary");
  });
  it("says no summary yet when the channel has none", () => {
    const m: FleetMessage = { id: "1", ts: 0, from: "user", to: "dev", kind: "chat", text: "hi" };
    expect(routingPrompt(CH, m, [agent("sup")])).toContain("(no summary yet)");
  });
});

describe("directedMessageText", () => {
  it("attaches the original message and the channel summary", () => {
    const m: FleetMessage = { id: "1", ts: 0, from: "user", to: "dev", kind: "chat", text: "build the parser" };
    const t = directedMessageText(CH, m, "Previously: discussed the API.");
    expect(t).toContain("#dev");
    expect(t).toContain("build the parser");
    expect(t).toContain("Previously: discussed the API.");
    expect(t).toContain("fleet_send");
  });
  it("tells a planner to pass work on, not to do it", () => {
    const m: FleetMessage = { id: "1", ts: 0, from: "user", to: "dev", kind: "chat", text: "build the parser" };
    const t = directedMessageText(CH, m, "", "impl");
    expect(t).toContain("do not do it yourself: give it to impl");
    expect(t).not.toContain("do it now with your tools");
  });
  it("omits the summary line when there is none", () => {
    const m: FleetMessage = { id: "1", ts: 0, from: "user", to: "dev", kind: "chat", text: "hi" };
    const t = directedMessageText(CH, m, "");
    expect(t).not.toContain("Channel summary:");
  });
});

describe("Hub channel storage", () => {
  it("upserts, reads, and removes channels", () => {
    hub.upsertChannel({ name: "dev", members: ["a", "b"], supervisor: "a" });
    expect(hub.getChannel("dev")?.members).toEqual(["a", "b"]);
    hub.upsertChannel({ name: "dev", members: ["a", "b", "c"] }); // update
    expect(hub.getChannel("dev")?.members).toEqual(["a", "b", "c"]);
    hub.removeChannel("dev");
    expect(hub.getChannel("dev")).toBeUndefined();
  });
  it("updates a channel summary", () => {
    hub.upsertChannel({ name: "dev", members: ["a"] });
    hub.setChannelSummary("dev", "summary text");
    expect(hub.getChannel("dev")?.summary).toBe("summary text");
  });
  it("ensureDefaultChannel creates the group with all agents, on the dedicated router", () => {
    hub.updateAgent("planner", { name: "planner", pid: 1, cwd: ".", status: "idle", startedAt: 0, lastReadOffset: 0, role: "planner" });
    hub.updateAgent("impl", { name: "impl", pid: 2, cwd: ".", status: "idle", startedAt: 0, lastReadOffset: 0, role: "implementer" });
    const ch = hub.ensureDefaultChannel();
    expect(ch.name).toBe(DEFAULT_CHANNEL);
    expect(ch.members.sort()).toEqual(["impl", "planner"]);
    expect(ch.supervisor).toBeUndefined();
  });
  it("ensureDefaultChannel moves a fleet off a worker it had picked as router", () => {
    hub.updateAgent("impl", { name: "impl", pid: 2, cwd: ".", status: "idle", startedAt: 0, lastReadOffset: 0, role: "implementer" });
    hub.upsertChannel({ name: DEFAULT_CHANNEL, members: ["impl"], supervisor: "impl" });
    expect(hub.ensureDefaultChannel().supervisor).toBeUndefined();
  });
  it("ensureDefaultChannel keeps a supervisor a person chose", () => {
    hub.updateAgent("impl", { name: "impl", pid: 2, cwd: ".", status: "idle", startedAt: 0, lastReadOffset: 0, role: "implementer" });
    hub.upsertChannel({ name: DEFAULT_CHANNEL, members: ["impl"], supervisor: "impl", pinned: true });
    expect(hub.ensureDefaultChannel().supervisor).toBe("impl");
  });
  it("ensureDefaultChannel prefers an agent with the supervisor role", () => {
    hub.updateAgent("boss", { name: "boss", pid: 1, cwd: ".", status: "idle", startedAt: 0, lastReadOffset: 0, role: "supervisor" });
    hub.updateAgent("worker", { name: "worker", pid: 2, cwd: ".", status: "idle", startedAt: 0, lastReadOffset: 0 });
    const ch = hub.ensureDefaultChannel();
    expect(ch.supervisor).toBe("boss");
  });
});