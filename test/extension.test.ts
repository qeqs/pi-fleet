import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { Hub } from "../src/hub.ts";
import { MAX_MESSAGE_LEN } from "../src/hub.ts";
import fleetExtension, { groupWakesAgent, buildLookup, createPoller, fleetPrompt, rolePrompt, admitMessage, TASKBOARD } from "../src/extension/index.ts";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import type { FleetMessage } from "../src/hub.ts";

let dir: string;
let hub: Hub;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "fleet-ext-"));
  hub = new Hub(dir);
});

afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

function lookup() {
  return buildLookup(hub);
}

describe("groupWakesAgent", () => {
  it("wakes on a direct message to itself", () => {
    const m: FleetMessage = { id: "1", ts: 0, from: "alice", to: "bob", kind: "chat", text: "hi" };
    expect(groupWakesAgent(m, "bob", new Map())).toBe(true);
    expect(groupWakesAgent(m, "alice", new Map())).toBe(false);
  });

  it("wakes on a group broadcast (no mention, no reply)", () => {
    const m: FleetMessage = { id: "1", ts: 0, from: "alice", to: "group", kind: "chat", text: "hello all" };
    expect(groupWakesAgent(m, "bob", new Map())).toBe(true);
    expect(groupWakesAgent(m, "carol", new Map())).toBe(true);
  });

  it("wakes only mentioned agents on an @mention", () => {
    const m: FleetMessage = { id: "1", ts: 0, from: "alice", to: "group", kind: "chat", text: "@bob please help" };
    expect(groupWakesAgent(m, "bob", new Map())).toBe(true);
    expect(groupWakesAgent(m, "carol", new Map())).toBe(false);
  });

  it("thread-scopes replies to participants only", () => {
    const orig = hub.appendMessage({ from: "alice", to: "bob", kind: "chat", text: "question" });
    const reply = hub.appendMessage({ from: "bob", to: "group", kind: "chat", text: "answer", replyTo: orig.id });
    const lk = lookup();
    // alice (original sender) and bob (original recipient) are participants
    expect(groupWakesAgent(reply, "alice", lk)).toBe(true);
    expect(groupWakesAgent(reply, "bob", lk)).toBe(true);
    // carol is not in the thread
    expect(groupWakesAgent(reply, "carol", lk)).toBe(false);
  });

  it("a mention inside a reply wakes only the mentioned agent (mention priority)", () => {
    const orig = hub.appendMessage({ from: "alice", to: "bob", kind: "chat", text: "question" });
    const reply = hub.appendMessage({ from: "bob", to: "group", kind: "chat", text: "@carol can you weigh in?", replyTo: orig.id });
    const lk = lookup();
    expect(groupWakesAgent(reply, "carol", lk)).toBe(true); // mentioned
    // mentions take priority over thread-scoping: alice (thread participant) is NOT
    // mentioned, so she does not wake
    expect(groupWakesAgent(reply, "alice", lk)).toBe(false);
  });
});

describe("fleet tools", () => {
  interface ToolResult {
    content: { text: string }[];
  }
  type Tool = { execute: (id: string, params: Record<string, unknown>) => Promise<ToolResult> };

  /** Load the extension as agent `name` against a stub pi, and hand back its tools. */
  function toolsFor(name: string): Record<string, Tool> {
    const tools: Record<string, Tool> = {};
    const stub = {
      on: () => {},
      registerCommand: () => {},
      registerTool: (t: Tool & { name: string }) => (tools[t.name] = t),
    };
    vi.stubEnv("PI_FLEET_DIR", dir);
    vi.stubEnv("PI_FLEET_AGENT", name);
    fleetExtension(stub as unknown as ExtensionAPI);
    vi.unstubAllEnvs();
    return tools;
  }

  const chat = () => hub.tailMessages(20).filter((m) => m.kind === "chat");

  beforeEach(() => {
    for (const a of ["impl", "rev"]) hub.updateAgent(a, { name: a, pid: 1, cwd: ".", status: "idle" });
    hub.upsertChannel({ name: "group", members: ["impl", "rev"], supervisor: "impl" });
  });

  it("refuses a fleet_mention of yourself, so the model does the work instead of ending its turn", async () => {
    const res = await toolsFor("impl").fleet_mention.execute("1", { agents: ["impl"], text: "create hello.txt" });
    expect(res.content[0].text).toContain("wakes nobody");
    expect(chat()).toHaveLength(0);
  });

  it("drops yourself from a fleet_mention that also names others", async () => {
    await toolsFor("impl").fleet_mention.execute("1", { agents: ["impl", "rev"], text: "take a look" });
    expect(chat().map((m) => m.text)).toEqual(["@rev take a look"]);
  });

  it("refuses a fleet_send to yourself", async () => {
    const res = await toolsFor("impl").fleet_send.execute("1", { to: "impl", text: "note to self" });
    expect(res.content[0].text).toContain("wakes nobody");
    expect(chat()).toHaveLength(0);
  });

  it("refuses a channel post that only @mentions yourself", async () => {
    const res = await toolsFor("impl").fleet_send.execute("1", { to: "group", text: "@impl do it" });
    expect(res.content[0].text).toContain("wakes nobody");
    expect(chat()).toHaveLength(0);
  });

  it("still sends a channel post that mentions you and someone else", async () => {
    await toolsFor("impl").fleet_send.execute("1", { to: "group", text: "@impl and @rev, sync up" });
    expect(chat()).toHaveLength(1);
  });

  it("tells a router that picked itself to do the work now", async () => {
    hub.appendMessage({ from: "user", to: "group", kind: "chat", text: "build it" });
    const res = await toolsFor("impl").route.execute("1", { channel: "group", respond: ["impl"], summary: "s" });
    expect(res.content[0].text).toContain("do that work once, now");
  });

  it("routes a message once, however often the model replays the routing task", async () => {
    const msg = hub.appendMessage({ from: "user", to: "group", kind: "chat", text: "build it" });
    const { route } = toolsFor("impl");
    await route.execute("1", { channel: "group", respond: ["impl", "rev"], messageId: msg.id });
    const again = await route.execute("2", { channel: "group", respond: ["impl", "rev"], messageId: msg.id });
    expect(again.content[0].text).toContain("already routed");
    expect(again.content[0].text).not.toContain("do that work");
    expect(chat().filter((m) => m.to === "rev")).toHaveLength(1);
  });

  it("still routes the next message", async () => {
    const { route } = toolsFor("impl");
    hub.appendMessage({ from: "user", to: "group", kind: "chat", text: "first" });
    await route.execute("1", { channel: "group", respond: ["rev"] });
    hub.appendMessage({ from: "rev", to: "group", kind: "chat", text: "second" });
    const res = await route.execute("2", { channel: "group", respond: [] });
    expect(res.content[0].text).toContain("Routed #group");
  });

  it("refuses an unknown target and lists what exists", async () => {
    const res = await toolsFor("impl").fleet_send.execute("1", { to: "revv", text: "hi" });
    expect(res.content[0].text).toContain('no agent or channel "revv". Agents: impl, rev');
    expect(chat()).toHaveLength(0);
  });

  it("refuses an over-long message, so the model can split it", async () => {
    const long = "x".repeat(MAX_MESSAGE_LEN + 1);
    const tools = toolsFor("impl");
    for (const res of [await tools.fleet_send.execute("1", { to: "rev", text: long }), await tools.fleet_mention.execute("2", { agents: ["rev"], text: long })]) {
      expect(res.content[0].text).toContain("Not sent");
      expect(res.content[0].text).toContain("split it");
    }
    expect(chat()).toHaveLength(0);
  });

  it("names channels as channels when sending", async () => {
    hub.upsertChannel({ name: "dev", members: ["impl", "rev"] });
    const res = await toolsFor("impl").fleet_send.execute("1", { to: "dev", text: "hi" });
    expect(res.content[0].text).toContain("Sent to #dev");
  });

  it("runs the openspec task board on every platform (a .cmd shim cannot be spawned directly)", async () => {
    vi.stubEnv("PI_FLEET_ROOT", path.resolve(__dirname, ".."));
    const tools = toolsFor("impl");
    const res = await tools.openspec.execute("1", { args: "--version" });
    vi.unstubAllEnvs();
    expect(res.content[0].text).toMatch(/^\d+\.\d+/);
  });
});

describe("admitMessage", () => {
  const agentMsg = (text = "ping") => hub.appendMessage({ from: "alice", to: "bob", kind: "chat", text });
  const userMsg = () => hub.appendMessage({ from: "user", to: "bob", kind: "chat", text: "go" });

  it("lets agent messages through up to the hop limit", () => {
    userMsg();
    for (let i = 0; i < 3; i++) expect(admitMessage(agentMsg(), hub, 3)).toBe(true);
    expect(hub.pausedReason()).toBeNull();
  });

  it("pauses the fleet at the first message past the limit", () => {
    userMsg();
    for (let i = 0; i < 3; i++) agentMsg();
    expect(admitMessage(agentMsg(), hub, 3)).toBe(false);
    expect(hub.pausedReason()).toContain("--max-hops");
  });

  it("holds every agent message while paused, whatever the limit", () => {
    hub.pause("stopped by you");
    expect(admitMessage(agentMsg(), hub, 0)).toBe(false);
  });

  it("lets the human through, which resumes the fleet and restarts the count", () => {
    for (let i = 0; i < 5; i++) agentMsg();
    hub.pause("too many");
    expect(admitMessage(userMsg(), hub, 3)).toBe(true);
    expect(hub.pausedReason()).toBeNull();
    expect(admitMessage(agentMsg(), hub, 3)).toBe(true);
  });

  it("treats 0 as no limit", () => {
    for (let i = 0; i < 50; i++) agentMsg();
    expect(admitMessage(agentMsg(), hub, 0)).toBe(true);
  });

  it("does not let system notices trip the limit", () => {
    for (let i = 0; i < 5; i++) agentMsg();
    const notice = hub.appendMessage({ from: "system", to: "group", kind: "system", text: "joined" });
    expect(admitMessage(notice, hub, 3)).toBe(false);
    expect(hub.pausedReason()).toBeNull();
  });
});

describe("turn limit", () => {
  type Handler = (event: unknown, ctx: { abort: () => void }) => void;

  function load(maxTurns: string): Record<string, Handler> {
    const handlers: Record<string, Handler> = {};
    const stub = {
      on: (event: string, handler: Handler) => (handlers[event] = handler),
      registerCommand: () => {},
      registerTool: () => {},
    };
    vi.stubEnv("PI_FLEET_DIR", dir);
    vi.stubEnv("PI_FLEET_AGENT", "bob");
    vi.stubEnv("PI_FLEET_MAX_TURNS", maxTurns);
    fleetExtension(stub as unknown as ExtensionAPI);
    vi.unstubAllEnvs();
    return handlers;
  }

  function endTurns(handlers: Record<string, Handler>, n: number): number {
    let aborts = 0;
    for (let i = 0; i < n; i++) handlers.turn_end({}, { abort: () => aborts++ });
    return aborts;
  }

  const notices = () => hub.tailMessages(20).filter((m) => m.text.includes("was stopped"));

  it("aborts the run at the limit, once, and says so on the bus", () => {
    const h = load("3");
    h.agent_start({}, { abort: () => {} });
    expect(endTurns(h, 2)).toBe(0);
    expect(endTurns(h, 5)).toBe(1);
    expect(notices()).toHaveLength(1);
    expect(notices()[0].text).toContain("bob");
  });

  it("stops a run that keeps making the same fleet call", () => {
    const h = load("0");
    const call = { message: { content: [{ type: "toolCall", name: "fleet_send", arguments: { to: "group", text: "Already done" } }] } };
    let aborts = 0;
    const ctx = { abort: () => aborts++ };
    h.agent_start({}, ctx);
    h.turn_end(call, ctx);
    h.turn_end(call, ctx);
    expect(aborts).toBe(0);
    h.turn_end(call, ctx);
    expect(aborts).toBe(1);
    expect(notices()[0].text).toContain("same fleet call 3 times");
  });

  it("lets a run repeat ordinary work, and varied fleet messages", () => {
    const h = load("0");
    let aborts = 0;
    const ctx = { abort: () => aborts++ };
    h.agent_start({}, ctx);
    const test = { message: { content: [{ type: "toolCall", name: "bash", arguments: { command: "npm test" } }] } };
    for (let i = 0; i < 6; i++) h.turn_end(test, ctx);
    for (let i = 0; i < 6; i++) h.turn_end({ message: { content: [{ type: "toolCall", name: "fleet_send", arguments: { to: "group", text: `step ${i}` } }] } }, ctx);
    expect(aborts).toBe(0);
  });

  it("forgets repeated calls between runs", () => {
    const h = load("0");
    const call = { message: { content: [{ type: "toolCall", name: "route", arguments: { channel: "group" } }] } };
    let aborts = 0;
    const ctx = { abort: () => aborts++ };
    h.agent_start({}, ctx);
    h.turn_end(call, ctx);
    h.turn_end(call, ctx);
    h.agent_start({}, ctx);
    h.turn_end(call, ctx);
    h.turn_end(call, ctx);
    expect(aborts).toBe(0);
  });

  it("counts each run from zero", () => {
    const h = load("3");
    h.agent_start({}, { abort: () => {} });
    endTurns(h, 2);
    h.agent_start({}, { abort: () => {} });
    expect(endTurns(h, 2)).toBe(0);
  });

  it("treats 0 as no limit", () => {
    const h = load("0");
    h.agent_start({}, { abort: () => {} });
    expect(endTurns(h, 500)).toBe(0);
    expect(notices()).toHaveLength(0);
  });
});

describe("a silent or failing model", () => {
  type Handler = (event: unknown, ctx: { abort: () => void }) => void;

  function load(): Record<string, Handler> {
    const handlers: Record<string, Handler> = {};
    const stub = {
      on: (event: string, handler: Handler) => (handlers[event] = handler),
      registerCommand: () => {},
      registerTool: () => {},
    };
    vi.stubEnv("PI_FLEET_DIR", dir);
    vi.stubEnv("PI_FLEET_AGENT", "bob");
    fleetExtension(stub as unknown as ExtensionAPI);
    vi.unstubAllEnvs();
    return handlers;
  }

  const ctx = { abort: () => {} };
  const notes = (text: string) => hub.tailMessages(20).filter((m) => m.text.includes(text));
  const FIVE_MINUTES = 5 * 60 * 1000;

  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("reports a model that has said nothing, once", () => {
    load().turn_start({}, ctx);
    vi.advanceTimersByTime(FIVE_MINUTES * 3);
    expect(notes("no answer from its model")).toHaveLength(1);
  });

  it("does not report a model that is still streaming", () => {
    const h = load();
    h.turn_start({}, ctx);
    vi.advanceTimersByTime(FIVE_MINUTES - 1000);
    h.message_update({}, ctx);
    vi.advanceTimersByTime(FIVE_MINUTES - 1000);
    expect(notes("no answer from its model")).toHaveLength(0);
  });

  it("does not time a tool: they may run as long as they like", () => {
    const h = load();
    h.turn_start({}, ctx);
    h.tool_execution_start({}, ctx);
    vi.advanceTimersByTime(FIVE_MINUTES * 3);
    expect(notes("no answer from its model")).toHaveLength(0);
  });

  it("reports a run that ended on a model error", () => {
    const h = load();
    h.message_end({ message: { role: "assistant", stopReason: "error", errorMessage: "Connection error." } }, ctx);
    h.agent_settled({}, ctx);
    expect(notes('agent "bob" stopped on a model error: Connection error.')).toHaveLength(1);
  });

  it("stays quiet when a retry succeeds", () => {
    const h = load();
    h.message_end({ message: { role: "assistant", stopReason: "error", errorMessage: "Connection error." } }, ctx);
    h.message_end({ message: { role: "assistant", stopReason: "stop" } }, ctx);
    h.agent_settled({}, ctx);
    expect(notes("model error")).toHaveLength(0);
  });

  it("ignores user messages when looking for the outcome", () => {
    const h = load();
    h.message_end({ message: { role: "assistant", stopReason: "error", errorMessage: "boom" } }, ctx);
    h.message_end({ message: { role: "user" } }, ctx);
    h.agent_settled({}, ctx);
    expect(notes("boom")).toHaveLength(1);
  });
});

describe("role presets", () => {
  it("injects the planner role prompt", () => {
    expect(fleetPrompt("alice", false, "roster", "planner")).toContain("Your role: PLANNER");
    expect(fleetPrompt("alice", false, "roster", "planner")).toContain("Do NOT implement code");
  });

  it("injects the implementer role prompt (lean + full)", () => {
    expect(fleetPrompt("bob", true, "roster", "implementer")).toContain("Your role: IMPLEMENTER");
    expect(fleetPrompt("bob", false, "roster", "implementer")).toContain("Your role: IMPLEMENTER");
  });

  it("injects the reviewer role prompt", () => {
    expect(rolePrompt("reviewer")).toContain("Your role: REVIEWER");
    expect(rolePrompt("reviewer")).toContain("APPROVE");
  });

  it("adds nothing when no role is set", () => {
    expect(fleetPrompt("alice", false, "roster")).not.toContain("Your role:");
    expect(rolePrompt(undefined)).toBe("");
  });
});

describe("task board selection", () => {
  it("defaults to the openspec task board", () => {
    expect(TASKBOARD).toBe("openspec");
    expect(fleetPrompt("a", false, "roster")).toContain("openspec");
  });

  it("switches to beads when PI_FLEET_TASKBOARD=beads", async () => {
    const prev = process.env.PI_FLEET_TASKBOARD;
    process.env.PI_FLEET_TASKBOARD = "beads";
    vi.resetModules();
    const mod = await import("../src/extension/index.ts");
    if (prev === undefined) delete process.env.PI_FLEET_TASKBOARD;
    else process.env.PI_FLEET_TASKBOARD = prev;
    expect(mod.TASKBOARD).toBe("beads");
    expect(mod.fleetPrompt("a", false, "roster")).toContain("beads");
    expect(mod.fleetPrompt("a", false, "roster", "implementer")).toContain("beads");
    vi.resetModules();
  });
});

describe("createPoller", () => {
  it("wakes on a new group message when idle", () => {
    const wakes: string[] = [];
    const poller = createPoller({ hub, name: "bob", isBusy: () => false, wake: (t) => wakes.push(t), pollMs: 60000 });
    poller.seekToEnd();
    hub.appendMessage({ from: "alice", to: "group", kind: "chat", text: "hello bob" });
    poller.tick();
    expect(wakes).toHaveLength(1);
    expect(wakes[0]).toContain("hello bob");
  });

  it("does not wake on its own messages", () => {
    const wakes: string[] = [];
    const poller = createPoller({ hub, name: "bob", isBusy: () => false, wake: (t) => wakes.push(t), pollMs: 60000 });
    poller.seekToEnd();
    hub.appendMessage({ from: "bob", to: "group", kind: "chat", text: "my own note" });
    poller.tick();
    expect(wakes).toHaveLength(0);
  });

  it("buffers while busy and flushes when idle", () => {
    let busy = true;
    const wakes: string[] = [];
    const poller = createPoller({ hub, name: "bob", isBusy: () => busy, wake: (t) => wakes.push(t), pollMs: 60000 });
    poller.seekToEnd();
    hub.appendMessage({ from: "alice", to: "group", kind: "chat", text: "msg while busy" });
    poller.tick();
    expect(wakes).toHaveLength(0); // buffered, not delivered
    busy = false;
    poller.flushPending();
    expect(wakes).toHaveLength(1);
    expect(wakes[0]).toContain("msg while busy");
  });

  it("seekToEnd skips pre-existing messages", () => {
    const wakes: string[] = [];
    hub.appendMessage({ from: "alice", to: "group", kind: "chat", text: "old message" });
    const poller = createPoller({ hub, name: "bob", isBusy: () => false, wake: (t) => wakes.push(t), pollMs: 60000 });
    poller.seekToEnd();
    poller.tick();
    expect(wakes).toHaveLength(0); // old message skipped
  });

  it("reads what was still unread when the bus rotated", () => {
    const wakes: string[] = [];
    const poller = createPoller({ hub, name: "bob", isBusy: () => false, wake: (t) => wakes.push(t), pollMs: 60000 });
    poller.seekToEnd();
    for (let i = 0; i < 20; i++) hub.appendMessage({ from: "alice", to: "group", kind: "chat", text: `pad ${i} padding padding padding` });
    expect(hub.rotateIfLarge(100)).toBe(true);
    hub.appendMessage({ from: "alice", to: "group", kind: "chat", text: "after rotation" });
    poller.tick();
    expect(wakes).toHaveLength(1);
    expect(wakes[0]).toContain("pad 0");
    expect(wakes[0]).toContain("after rotation");
  });

  it("follows the supervisor's position, so nothing falls between them if it dies", () => {
    let attached = true;
    const wakes: string[] = [];
    const poller = createPoller({ hub, name: "bob", isBusy: () => false, wake: (t) => wakes.push(t), pollMs: 60000, supervisorAlive: () => attached });
    hub.appendMessage({ from: "alice", to: "bob", kind: "chat", text: "handled by the supervisor" });
    hub.writeCursor(hub.busEnd());
    poller.tick();
    hub.appendMessage({ from: "alice", to: "bob", kind: "chat", text: "posted as it died" });
    attached = false;
    poller.tick();
    expect(wakes).toHaveLength(1);
    expect(wakes[0]).toContain("posted as it died");
    expect(wakes[0]).not.toContain("handled by the supervisor");
  });

  it("records how far it got alone, for the next supervisor", () => {
    hub.updateAgent("bob", { name: "bob", pid: 1, cwd: ".", status: "idle" });
    const poller = createPoller({ hub, name: "bob", isBusy: () => false, wake: () => {}, pollMs: 60000 });
    hub.appendMessage({ from: "alice", to: "bob", kind: "chat", text: "hi" });
    poller.tick();
    expect(hub.readAgents().bob.handled).toEqual(hub.busEnd());
  });

  it("does NOT self-wake while the supervisor is attached (supervisor pushes instead)", () => {
    const wakes: string[] = [];
    const poller = createPoller({
      hub,
      name: "bob",
      isBusy: () => false,
      wake: (t) => wakes.push(t),
      pollMs: 60000,
      supervisorAlive: () => true,
    });
    poller.seekToEnd();
    hub.appendMessage({ from: "alice", to: "group", kind: "chat", text: "hello bob" });
    poller.tick();
    expect(wakes).toHaveLength(0); // supervisor will push the wake, not the poller
  });

  it("stops self-waking at the hop limit when detached", () => {
    const wakes: string[] = [];
    const poller = createPoller({ hub, name: "bob", isBusy: () => false, wake: (t) => wakes.push(t), pollMs: 60000, maxHops: 2 });
    poller.seekToEnd();
    for (let i = 0; i < 4; i++) hub.appendMessage({ from: "alice", to: "bob", kind: "chat", text: `ping ${i}` });
    poller.tick();
    expect(wakes.join()).toContain("ping 1");
    expect(wakes.join()).not.toContain("ping 3");
    expect(hub.pausedReason()).toContain("--max-hops");
  });

  it("leaves the hop limit to the supervisor while it is attached", () => {
    const poller = createPoller({ hub, name: "bob", isBusy: () => false, wake: () => {}, pollMs: 60000, maxHops: 1, supervisorAlive: () => true });
    poller.seekToEnd();
    for (let i = 0; i < 4; i++) hub.appendMessage({ from: "alice", to: "bob", kind: "chat", text: "ping" });
    poller.tick();
    expect(hub.pausedReason()).toBeNull();
  });

  it("drops buffered wakes when the fleet was paused meanwhile", () => {
    let busy = true;
    const wakes: string[] = [];
    const poller = createPoller({ hub, name: "bob", isBusy: () => busy, wake: (t) => wakes.push(t), pollMs: 60000 });
    poller.seekToEnd();
    hub.appendMessage({ from: "alice", to: "bob", kind: "chat", text: "buffered" });
    poller.tick();
    hub.pause("stopped by you");
    busy = false;
    poller.flushPending();
    expect(wakes).toHaveLength(0);
  });

  it("wakes a channel supervisor on a routing-only message when detached", () => {
    hub.upsertChannel({ name: "group", members: ["bob", "carol"], supervisor: "bob" });
    const wakes: string[] = [];
    const poller = createPoller({ hub, name: "bob", isBusy: () => false, wake: (t) => wakes.push(t), pollMs: 60000 });
    poller.seekToEnd();
    hub.appendMessage({ from: "user", to: "group", kind: "chat", text: "who can take this?" });
    poller.tick();
    expect(wakes).toHaveLength(1);
    expect(wakes[0]).toContain("Routing task for #group");
    expect(wakes[0]).toContain("who can take this?");
    expect(wakes[0]).not.toContain("New fleet messages");
  });

  it("carries both a routing task and direct messages in one wake", () => {
    hub.upsertChannel({ name: "group", members: ["bob", "carol"], supervisor: "bob" });
    const wakes: string[] = [];
    const poller = createPoller({ hub, name: "bob", isBusy: () => false, wake: (t) => wakes.push(t), pollMs: 60000 });
    poller.seekToEnd();
    hub.appendMessage({ from: "user", to: "group", kind: "chat", text: "for the room" });
    hub.appendMessage({ from: "carol", to: "bob", kind: "chat", text: "just for you" });
    poller.tick();
    expect(wakes).toHaveLength(1);
    expect(wakes[0]).toContain("for the room");
    expect(wakes[0]).toContain("just for you");
  });

  it("self-wakes again once the supervisor goes away (detached mode)", () => {
    let alive = true;
    const wakes: string[] = [];
    const poller = createPoller({
      hub,
      name: "bob",
      isBusy: () => false,
      wake: (t) => wakes.push(t),
      pollMs: 60000,
      supervisorAlive: () => alive,
    });
    poller.seekToEnd();
    hub.appendMessage({ from: "alice", to: "group", kind: "chat", text: "while attached" });
    poller.tick();
    expect(wakes).toHaveLength(0); // suppressed while attached
    alive = false; // supervisor exits / detaches
    hub.appendMessage({ from: "alice", to: "group", kind: "chat", text: "while detached" });
    poller.tick();
    expect(wakes).toHaveLength(1);
    expect(wakes[0]).toContain("while detached");
  });
});