import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { Hub } from "../src/hub.ts";
import { MAX_MESSAGE_LEN } from "../src/hub.ts";
import fleetExtension, { applyRoute, groupWakesAgent, buildLookup, createPoller, fleetPrompt, formatInbox, rolePrompt, worktreePrompt, admitMessage, mentionText, openspecArgs, TASKBOARD, waitingHelps } from "../src/extension/index.ts";
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

  it("records routing decisions where the channel view can show them", async () => {
    hub.appendMessage({ from: "user", to: "group", kind: "chat", text: "build it" });
    await toolsFor("impl").route.execute("1", { channel: "group", respond: ["rev"] });
    const mark = hub.tailMessages(20).find((m) => m.kind === "activity");
    expect(mark).toMatchObject({ from: "impl", to: "group", text: "routed to rev" });
  });

  it("records a decision to route to nobody", async () => {
    hub.appendMessage({ from: "rev", to: "group", kind: "chat", text: "APPROVE" });
    await toolsFor("impl").route.execute("1", { channel: "group", respond: [] });
    expect(hub.tailMessages(20).find((m) => m.kind === "activity")?.text).toBe("routed to nobody");
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

  it("pauses the fleet at the first message past the limit, and holds that message", () => {
    userMsg();
    for (let i = 0; i < 3; i++) agentMsg();
    const fourth = agentMsg();
    expect(admitMessage(fourth, hub, 3)).toBe(false);
    expect(hub.pausedReason()).toContain("--max-hops");
    expect(hub.heldMessages().map((m) => m.id)).toContain(fourth.id);
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
    vi.stubEnv("PI_FLEET_RETRY_WAITS", ""); // the fleet's own tries have tests of their own
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

describe("errors worth waiting out", () => {
  it.each(["Connection error.", "fetch failed", "Request timed out.", "429 Rate limit reached", "500 Internal Server Error", "502 Bad Gateway", "503 status code (no body)", "Provider returned error", "Provider finish_reason: error", "Overloaded"])("tries again after: %s", (error) => {
    expect(waitingHelps(error)).toBe(true);
  });

  it.each(["401 Incorrect API key provided", "403 Forbidden", "404 The model `x` does not exist", "401 Provider returned error", "No API key found for openrouter", "400 Bad request", "insufficient_quota", "429: Rate limit exceeded: free-models-per-day. Add 10 credits", "Provider finish_reason: content_filter", "This operation was aborted."])("gives up at once on: %s", (error) => {
    expect(waitingHelps(error)).toBe(false);
  });
});

describe("a model that is away for a while", () => {
  type Handler = (event: unknown, ctx: { abort: () => void }) => void;
  type Tool = { execute: (id: string, params: Record<string, unknown>) => Promise<unknown> };

  function load(): { on: Record<string, Handler>; tools: Record<string, Tool> } {
    const on: Record<string, Handler> = {};
    const tools: Record<string, Tool> = {};
    const stub = {
      on: (event: string, handler: Handler) => (on[event] = handler),
      registerCommand: () => {},
      registerTool: (t: Tool & { name: string }) => (tools[t.name] = t),
    };
    vi.stubEnv("PI_FLEET_DIR", dir);
    vi.stubEnv("PI_FLEET_AGENT", "bob");
    fleetExtension(stub as unknown as ExtensionAPI);
    vi.unstubAllEnvs();
    return { on, tools };
  }

  const ctx = { abort: () => {} };
  const THIRTY_SECONDS = 30 * 1000;
  const TWO_MINUTES = 2 * 60 * 1000;
  const FIVE_MINUTES = 5 * 60 * 1000;
  const prompt = (text: string) => ({ message: { role: "user", content: [{ type: "text", text }] } });
  const failed = (errorMessage = "Connection error.") => ({ message: { role: "assistant", stopReason: "error", errorMessage } });

  function failRun(on: Record<string, Handler>, text = "work to do", error?: string): void {
    on.agent_start({}, ctx);
    on.message_end(prompt(text), ctx);
    on.message_end(failed(error), ctx);
    on.agent_settled({ aborted: false }, ctx);
  }

  const notes = (text: string) => hub.tailMessages(50).filter((m) => m.text.includes(text));
  const retries = () => hub.tailMessages(50).filter((m) => m.to === "bob" && m.kind === "chat" && m.from === "system");
  const gaveUp = () => notes("stopped on a model error");

  beforeEach(() => {
    vi.useFakeTimers();
    for (const a of ["bob", "ann"]) hub.updateAgent(a, { name: a, pid: 1, cwd: ".", status: "idle" });
    hub.upsertChannel({ name: "group", members: ["bob", "ann"] });
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("says why and when, then asks the agent to carry on", () => {
    const { on } = load();
    failRun(on);
    expect(notes('agent "bob" got a model error: Connection error. It tries again in 30s (1 of 3)')).toHaveLength(1);
    expect(gaveUp()).toEqual([]);
    vi.advanceTimersByTime(THIRTY_SECONDS - 1000);
    expect(retries()).toEqual([]);
    vi.advanceTimersByTime(1000);
    expect(retries()).toHaveLength(1);
    expect(retries()[0].text).toContain("Check what is already done");
    expect(retries()[0].text).toContain("Connection error");
  });

  it("waits longer each time, then gives up with the usual notice", () => {
    const { on } = load();
    for (const [wait, words] of [[THIRTY_SECONDS, "30s (1 of 3)"], [TWO_MINUTES, "2m (2 of 3)"], [FIVE_MINUTES, "5m (3 of 3)"]] as const) {
      failRun(on);
      expect(notes(`It tries again in ${words}`)).toHaveLength(1);
      vi.advanceTimersByTime(wait);
    }
    expect(retries()).toHaveLength(3);
    failRun(on);
    expect(gaveUp().map((m) => m.text)).toEqual(['agent "bob" stopped on a model error: Connection error. Test the model in Settings → Models, or with fleet doctor.']);
    vi.advanceTimersByTime(FIVE_MINUTES * 2);
    expect(retries()).toHaveLength(3);
  });

  it("starts counting again after a run that worked", () => {
    const { on } = load();
    failRun(on);
    vi.advanceTimersByTime(THIRTY_SECONDS);
    on.agent_start({}, ctx);
    on.message_end({ message: { role: "assistant", stopReason: "stop", content: [{ type: "text", text: "done" }] } }, ctx);
    on.agent_settled({ aborted: false }, ctx);
    failRun(on);
    expect(notes("It tries again in 30s (1 of 3)")).toHaveLength(2);
  });

  it("gives up at once on an error waiting cannot fix", () => {
    const { on } = load();
    failRun(on, "work to do", "401 Incorrect API key provided");
    expect(gaveUp()).toHaveLength(1);
    expect(notes("tries again")).toEqual([]);
    vi.advanceTimersByTime(FIVE_MINUTES);
    expect(retries()).toEqual([]);
  });

  it("does not run on top of a new wake", () => {
    const { on } = load();
    failRun(on);
    on.agent_start({}, ctx);
    on.message_end(prompt("something new arrived"), ctx);
    vi.advanceTimersByTime(THIRTY_SECONDS);
    expect(retries()).toEqual([]);
  });

  it("leaves it to a wake that is on its way", () => {
    const { on } = load();
    failRun(on);
    hub.enqueueWake("bob", "a message waiting to be delivered");
    vi.advanceTimersByTime(THIRTY_SECONDS);
    expect(retries()).toEqual([]);
    expect(gaveUp()).toEqual([]); // that run tries the model anyway
  });

  it("is cancelled by a person's message, even to someone else", () => {
    const { on } = load();
    failRun(on);
    vi.advanceTimersByTime(1000);
    hub.appendMessage({ from: "user", to: "ann", kind: "chat", text: "what now?" });
    vi.advanceTimersByTime(THIRTY_SECONDS);
    expect(retries()).toEqual([]);
    expect(gaveUp()).toHaveLength(1);
  });

  it("is not cancelled by what agents say", () => {
    const { on } = load();
    failRun(on);
    hub.appendMessage({ from: "ann", to: "group", kind: "chat", text: "still working" });
    vi.advanceTimersByTime(THIRTY_SECONDS);
    expect(retries()).toHaveLength(1);
  });

  it("is cancelled by a pause, and Stop all is one", () => {
    const { on } = load();
    failRun(on);
    hub.pause("stopped by you");
    vi.advanceTimersByTime(THIRTY_SECONDS);
    expect(retries()).toEqual([]);
    expect(gaveUp()).toHaveLength(1);
  });

  it("is forgotten when the agent shuts down", () => {
    const { on } = load();
    failRun(on);
    on.session_shutdown({}, ctx);
    vi.advanceTimersByTime(THIRTY_SECONDS);
    expect(retries()).toEqual([]);
  });

  it("stays out of a run that was aborted", () => {
    const { on } = load();
    on.agent_start({}, ctx);
    on.message_end(prompt("work to do"), ctx);
    on.message_end(failed("This operation was aborted."), ctx);
    on.agent_settled({ aborted: true }, ctx);
    vi.advanceTimersByTime(FIVE_MINUTES);
    expect(hub.tailMessages(50).filter((m) => m.text.includes("model error"))).toEqual([]);
    expect(retries()).toEqual([]);
  });

  it("forgets the error of an aborted run", () => {
    const { on } = load();
    on.agent_start({}, ctx);
    on.message_end(prompt("work to do"), ctx);
    on.message_end(failed("Connection error."), ctx);
    on.agent_settled({ aborted: true }, ctx);
    on.agent_start({}, ctx);
    on.message_end(prompt("next"), ctx);
    on.agent_settled({ aborted: false }, ctx); // refused before the model was asked
    expect(hub.tailMessages(50).filter((m) => m.text.includes("model error"))).toEqual([]);
  });

  it("does not call the brake's own abort a model error, or try again", () => {
    const { on } = load();
    const call = { message: { content: [{ type: "toolCall", name: "fleet_send", arguments: { to: "group", text: "Done" } }] } };
    on.agent_start({}, ctx);
    on.message_end(prompt("work to do"), ctx);
    for (let i = 0; i < 3; i++) on.turn_end(call, ctx);
    on.message_end(failed("This operation was aborted."), ctx);
    on.agent_settled({ aborted: true }, ctx);
    vi.advanceTimersByTime(FIVE_MINUTES);
    expect(notes("same fleet call 3 times")).toHaveLength(1);
    expect(hub.tailMessages(50).filter((m) => m.text.includes("model error"))).toEqual([]);
    expect(retries()).toEqual([]);
  });

  it("keeps the channel the work came from, so the verdict still gets there", () => {
    const { on } = load();
    hub.upsertChannel({ name: "dev", members: ["bob", "ann"] });
    const asked = hub.appendMessage({ from: "ann", to: "dev", kind: "chat", text: "@bob please review" });
    failRun(on, formatInbox([asked], lookup(), hub.readChannels()));
    vi.advanceTimersByTime(THIRTY_SECONDS);
    const [retry] = retries();
    expect(retry.replyTo).toBe(asked.id);
    on.agent_start({}, ctx);
    on.message_end(prompt(formatInbox([retry], lookup(), hub.readChannels())), ctx);
    on.tool_execution_start({ toolName: "read" }, ctx);
    on.message_end({ message: { role: "assistant", stopReason: "stop", content: [{ type: "text", text: "APPROVE" }] } }, ctx);
    on.agent_settled({ aborted: false }, ctx);
    expect(hub.tailMessages(50).filter((m) => m.from === "bob")).toMatchObject([{ to: "dev", text: "APPROVE" }]);
  });
});

describe("a run that keeps talking", () => {
  type Handler = (event: unknown, ctx: { abort: () => void }) => void;
  interface ToolResult {
    content: { text: string }[];
  }
  type Tool = { execute: (id: string, params: Record<string, unknown>) => Promise<ToolResult> };

  function load(): { on: Record<string, Handler>; tools: Record<string, Tool> } {
    const on: Record<string, Handler> = {};
    const tools: Record<string, Tool> = {};
    const stub = {
      on: (event: string, handler: Handler) => (on[event] = handler),
      registerCommand: () => {},
      registerTool: (t: Tool & { name: string }) => (tools[t.name] = t),
    };
    vi.stubEnv("PI_FLEET_DIR", dir);
    vi.stubEnv("PI_FLEET_AGENT", "impl");
    fleetExtension(stub as unknown as ExtensionAPI);
    vi.unstubAllEnvs();
    return { on, tools };
  }

  const LIMIT = 6;
  const ctx = { abort: () => {} };
  const sent = () => hub.tailMessages(50).filter((m) => m.from === "impl" && m.kind === "chat");
  const send = (tools: Record<string, Tool>, i: number) => tools.fleet_send.execute(String(i), { to: "group", text: `part ${i}` });
  const arrived = { message: { role: "user", content: [{ type: "text", text: "New fleet messages for you" }] } };

  beforeEach(() => {
    for (const a of ["impl", "rev"]) hub.updateAgent(a, { name: a, pid: 1, cwd: ".", status: "idle" });
    hub.upsertChannel({ name: "group", members: ["impl", "rev"] });
  });

  it("is told after each handoff that a reply will wake it", async () => {
    const { tools } = load();
    for (const res of [await tools.fleet_send.execute("1", { to: "rev", text: "over to you" }), await tools.fleet_mention.execute("2", { agents: ["rev"], text: "over to you" })]) {
      expect(res.content[0].text).toContain("end your turn now");
      expect(res.content[0].text).toContain("you will be woken when someone replies");
      expect(res.content[0].text).toContain("do not wait for them, check on them or do their work");
    }
  });

  it("can send a long report in parts", async () => {
    const { tools } = load();
    for (let i = 0; i < LIMIT; i++) await send(tools, i);
    expect(sent()).toHaveLength(LIMIT);
  });

  it("is refused past that, and told to end its turn", async () => {
    const { tools } = load();
    for (let i = 0; i < LIMIT; i++) await send(tools, i);
    const res = await send(tools, LIMIT);
    expect(res.content[0].text).toContain("Not sent");
    expect(res.content[0].text).toContain("End your turn now");
    expect(res.content[0].text).toContain("you will be woken when someone replies");
    expect(sent()).toHaveLength(LIMIT);
  });

  it("counts mentions the same as messages", async () => {
    const { tools } = load();
    for (let i = 0; i < LIMIT; i++) await tools.fleet_mention.execute(String(i), { agents: ["rev"], text: `part ${i}` });
    const res = await send(tools, LIMIT);
    expect(res.content[0].text).toContain("Not sent");
    expect((await tools.fleet_mention.execute("x", { agents: ["rev"], text: "again" })).content[0].text).toContain("Not sent");
  });

  it("does not count what was refused for another reason", async () => {
    const { tools } = load();
    for (let i = 0; i < LIMIT + 2; i++) await tools.fleet_send.execute(String(i), { to: "nobody", text: "hi" });
    expect((await send(tools, 0)).content[0].text).toContain("Sent to");
  });

  it("starts counting again when something arrives", async () => {
    const { on, tools } = load();
    for (let i = 0; i < LIMIT; i++) await send(tools, i);
    on.message_end(arrived, ctx);
    expect((await send(tools, LIMIT)).content[0].text).toContain("Sent to");
  });

  it("counts on through pi's own retries, which bring nothing new", async () => {
    const { on, tools } = load();
    for (let i = 0; i < LIMIT; i++) await send(tools, i);
    on.agent_start({}, ctx);
    expect((await send(tools, LIMIT)).content[0].text).toContain("Not sent");
  });

  it("is stopped when it ignores the refusal, however varied its messages", async () => {
    const { on, tools } = load();
    let aborts = 0;
    const counting = { abort: () => aborts++ };
    on.agent_start({}, counting);
    for (let i = 0; i < LIMIT + 1; i++) await send(tools, i);
    on.turn_end({}, counting);
    expect(aborts).toBe(0); // one refusal may still be heeded
    await send(tools, LIMIT + 1);
    on.turn_end({}, counting);
    on.turn_end({}, counting);
    expect(aborts).toBe(1);
    expect(hub.tailMessages(50).filter((m) => m.text.includes("kept sending"))).toHaveLength(1);
  });
});

describe("a verdict left in an agent's own chat", () => {
  type Handler = (event: unknown, ctx: { abort: () => void }) => void;
  type Tool = { execute: (id: string, params: Record<string, unknown>) => Promise<unknown> };

  function load(name = "rev", role?: string): { on: Record<string, Handler>; tools: Record<string, Tool> } {
    const on: Record<string, Handler> = {};
    const tools: Record<string, Tool> = {};
    const stub = {
      on: (event: string, handler: Handler) => (on[event] = handler),
      registerCommand: () => {},
      registerTool: (t: Tool & { name: string }) => (tools[t.name] = t),
    };
    vi.stubEnv("PI_FLEET_DIR", dir);
    vi.stubEnv("PI_FLEET_AGENT", name);
    if (role) vi.stubEnv("PI_FLEET_ROLE", role);
    fleetExtension(stub as unknown as ExtensionAPI);
    vi.unstubAllEnvs();
    return { on, tools };
  }

  const ctx = { abort: () => {} };
  const inbox = (m: FleetMessage) => formatInbox([m], lookup(), hub.readChannels());
  const said = (text: string) => ({ message: { role: "assistant", stopReason: "stop", content: [{ type: "thinking", thinking: "hm" }, { type: "text", text }] } });

  /** One whole run: pi says the prompt came in, the model answers, and the run settles. */
  function run(on: Record<string, Handler>, prompt: string, answer: string, settled = { aborted: false }): void {
    on.agent_start({}, ctx);
    on.message_end({ message: { role: "user", content: [{ type: "text", text: prompt }] } }, ctx);
    on.tool_execution_start({ toolName: "read" }, ctx);
    on.message_end(said(answer), ctx);
    on.agent_settled(settled, ctx);
  }

  /** How the dedicated router hands a channel message to a member: a DM that replies to it. */
  function routed(text: string, channel = "group"): string {
    const posted = hub.appendMessage({ from: "impl", to: channel, kind: "chat", text });
    applyRoute(hub, "router", hub.getChannel(channel)!, posted, ["rev"], "");
    return inbox(hub.tailMessages(5).reverse().find((m) => m.to === "rev")!);
  }

  const fromRev = () => hub.tailMessages(20).filter((m) => m.from === "rev" && m.kind === "chat");

  beforeEach(() => {
    for (const a of ["impl", "rev"]) hub.updateAgent(a, { name: a, pid: 1, cwd: ".", status: "idle" });
    hub.upsertChannel({ name: "group", members: ["impl", "rev"] });
    hub.upsertChannel({ name: "dev", members: ["impl", "rev"] });
  });

  it("is not taken from an agent that looked at nothing", () => {
    const { on } = load();
    on.agent_start({}, ctx);
    on.message_end({ message: { role: "user", content: [{ type: "text", text: routed("please review") }] } }, ctx);
    on.tool_execution_start({ toolName: "fleet_agents" }, ctx);
    on.message_end(said("APPROVE"), ctx);
    on.agent_settled({ aborted: false }, ctx);
    expect(fromRev()).toEqual([]);
  });

  describe("a message from an agent that has not started", () => {
    const wake = (on: Record<string, Handler>) => on.message_end({ message: { role: "user", content: [{ type: "text", text: "(abc) work for you" }] } }, ctx);
    const send = (tools: Record<string, Tool>, text = "I will start now") => tools.fleet_send.execute("1", { to: "group", text }) as Promise<{ content: { text: string }[] }>;
    const posted = () => hub.tailMessages(20).filter((m) => m.kind === "chat" && m.text === "I will start now");

    it("is refused the first time, and says what to do instead", async () => {
      const { on, tools } = load("impl", "implementer");
      wake(on);
      const res = await send(tools);
      expect(res.content[0].text).toContain("you have not used a tool");
      expect(posted()).toEqual([]);
    });

    it("goes through the second time: it may be a question, or a real blocker", async () => {
      const { on, tools } = load("impl", "implementer");
      wake(on);
      await send(tools);
      await send(tools);
      expect(posted()).toHaveLength(1);
    });

    it("is refused through a mention too", async () => {
      const { on, tools } = load("impl", "implementer");
      wake(on);
      const res = (await tools.fleet_mention.execute("1", { agents: ["rev"], text: "done" })) as { content: { text: string }[] };
      expect(res.content[0].text).toContain("you have not used a tool");
      expect(hub.tailMessages(20).filter((m) => m.from === "impl")).toEqual([]);
    });

    it("goes through once the agent has done something", async () => {
      const { on, tools } = load("impl", "implementer");
      wake(on);
      on.tool_execution_start({ toolName: "write" }, ctx);
      await send(tools);
      expect(posted()).toHaveLength(1);
    });

    it("is not excused by reading, for an implementer", async () => {
      const { on, tools } = load("impl", "implementer");
      wake(on);
      on.tool_execution_start({ toolName: "read" }, ctx);
      expect((await send(tools)).content[0].text).toContain("you have not used a tool");
    });

    it("is excused by reading, for a reviewer", async () => {
      const { on, tools } = load("rev", "reviewer");
      wake(on);
      on.tool_execution_start({ toolName: "read" }, ctx);
      await send(tools);
      expect(posted()).toHaveLength(1);
    });

    it("needs doing again after the next wake", async () => {
      const { on, tools } = load("impl", "implementer");
      wake(on);
      on.tool_execution_start({ toolName: "write" }, ctx);
      await send(tools);
      wake(on);
      expect((await send(tools)).content[0].text).toContain("you have not used a tool");
    });

    it("gets a new reminder after the next wake", async () => {
      const { on, tools } = load("impl", "implementer");
      wake(on);
      await send(tools);
      await send(tools);
      wake(on);
      expect((await send(tools)).content[0].text).toContain("you have not used a tool");
    });

    it("is left alone for a planner, whose work is the message", async () => {
      const { on, tools } = load("impl", "planner");
      wake(on);
      await send(tools);
      expect(posted()).toHaveLength(1);
    });
  });

  it("reaches the group when the router handed over the work, as in the real run", () => {
    run(load().on, routed("please review"), "APPROVE\n\nIt meets all requirements.");
    expect(fromRev()).toMatchObject([{ to: "group", text: "APPROVE\n\nIt meets all requirements." }]);
  });

  it("goes to the channel the work came from", () => {
    run(load().on, routed("please review", "dev"), "REQUEST CHANGES: add a test");
    expect(fromRev()).toMatchObject([{ to: "dev", text: "REQUEST CHANGES: add a test" }]);
  });

  it("reaches the channel when the agent was addressed there", () => {
    run(load().on, inbox(hub.appendMessage({ from: "impl", to: "dev", kind: "chat", text: "@rev please review" })), "APPROVE");
    expect(fromRev()).toMatchObject([{ to: "dev", text: "APPROVE" }]);
  });

  it("starts with the verdict, so that the routing rules can read it", () => {
    run(load().on, routed("please review"), "**APPROVE**: nothing to change");
    expect(fromRev()[0].text).toBe("APPROVE: nothing to change");
  });

  it("still arrives after a restart, when the wake opens with a note", () => {
    run(load().on, `You were restarted before you finished the work below.\n\n${routed("please review")}`, "APPROVE");
    expect(fromRev()).toHaveLength(1);
  });

  it("uses the channel of the last message when one wake carries several", () => {
    const first = routed("the first job", "group");
    run(load().on, `${first}\n\n${routed("please review", "dev")}`, "APPROVE");
    expect(fromRev()).toMatchObject([{ to: "dev" }]);
  });

  it("stays out of the group when it is anything but a verdict", () => {
    const { on } = load();
    for (const answer of ["Reviewed, and I APPROVE.", "Approve", "APPROVED", "I'll wait for the implementer."]) run(on, routed("please review"), answer);
    expect(fromRev()).toEqual([]);
  });

  it("stays out of the group when no channel asked", () => {
    const { on } = load();
    run(on, inbox(hub.appendMessage({ from: "user", to: "rev", kind: "chat", text: "what do you think?" })), "APPROVE");
    run(on, "typed straight into its chat", "APPROVE");
    expect(fromRev()).toEqual([]);
  });

  it("is not sent twice when the agent sent something itself", async () => {
    const { on, tools } = load();
    on.agent_start({}, ctx);
    on.message_end({ message: { role: "user", content: [{ type: "text", text: routed("please review") }] } }, ctx);
    await tools.fleet_send.execute("1", { to: "group", text: "APPROVE" });
    on.message_end(said("APPROVE"), ctx);
    on.agent_settled({ aborted: false }, ctx);
    expect(fromRev()).toHaveLength(1);
  });

  it("counts fleet_mention as sending", async () => {
    const { on, tools } = load();
    on.agent_start({}, ctx);
    on.message_end({ message: { role: "user", content: [{ type: "text", text: routed("please review") }] } }, ctx);
    await tools.fleet_mention.execute("1", { agents: ["impl"], text: "APPROVE" });
    on.message_end(said("APPROVE"), ctx);
    on.agent_settled({ aborted: false }, ctx);
    expect(fromRev()).toHaveLength(1);
  });

  it("does not count a send that was refused", async () => {
    const { on, tools } = load();
    on.agent_start({}, ctx);
    on.message_end({ message: { role: "user", content: [{ type: "text", text: routed("please review") }] } }, ctx);
    await tools.fleet_send.execute("1", { to: "nobody", text: "APPROVE" });
    on.tool_execution_start({ toolName: "read" }, ctx);
    on.message_end(said("APPROVE"), ctx);
    on.agent_settled({ aborted: false }, ctx);
    expect(fromRev()).toMatchObject([{ to: "group" }]);
  });

  it("remembers the wake and what was sent across pi's retries", async () => {
    const { on, tools } = load();
    on.agent_start({}, ctx);
    on.message_end({ message: { role: "user", content: [{ type: "text", text: routed("please review") }] } }, ctx);
    await tools.fleet_send.execute("1", { to: "group", text: "APPROVE" });
    on.message_end({ message: { role: "assistant", stopReason: "error", errorMessage: "overloaded" } }, ctx);
    on.agent_start({}, ctx); // the retry is a new low-level run, with no new prompt
    on.message_end(said("APPROVE"), ctx);
    on.agent_settled({ aborted: false }, ctx);
    expect(fromRev()).toHaveLength(1);
  });

  it("arrives after a retry that succeeds", () => {
    const { on } = load();
    on.agent_start({}, ctx);
    on.message_end({ message: { role: "user", content: [{ type: "text", text: routed("please review") }] } }, ctx);
    on.tool_execution_start({ toolName: "read" }, ctx);
    on.message_end({ message: { role: "assistant", stopReason: "error", errorMessage: "overloaded" } }, ctx);
    on.agent_start({}, ctx);
    on.message_end(said("APPROVE"), ctx);
    on.agent_settled({ aborted: false }, ctx);
    expect(fromRev()).toHaveLength(1);
  });

  it("is dropped when the run was stopped or failed: it may be half a thought", () => {
    const { on } = load();
    run(on, routed("please review"), "APPROVE", { aborted: true });
    on.agent_start({}, ctx);
    on.message_end({ message: { role: "user", content: [{ type: "text", text: routed("please review") }] } }, ctx);
    on.message_end({ message: { role: "assistant", stopReason: "error", errorMessage: "boom", content: [{ type: "text", text: "APPROVE" }] } }, ctx);
    on.agent_settled({ aborted: false }, ctx);
    expect(fromRev()).toEqual([]);
  });

  it("forgets the channel when the run is over", () => {
    const { on } = load();
    run(on, routed("please review"), "It looks fine.");
    on.agent_start({}, ctx);
    on.message_end(said("APPROVE"), ctx); // a run with no prompt of its own, such as a follow-up from pi
    on.agent_settled({ aborted: false }, ctx);
    expect(fromRev()).toEqual([]);
  });

  it("says where the rest is when it is too long for the bus", () => {
    run(load().on, routed("please review"), `REQUEST CHANGES: ${"x".repeat(MAX_MESSAGE_LEN)}`);
    const { text } = fromRev()[0];
    expect(text.length).toBeLessThanOrEqual(MAX_MESSAGE_LEN);
    expect(text.startsWith("REQUEST CHANGES: xxx")).toBe(true);
    expect(text).toContain("the rest is in rev's chat");
  });

  it("leaves a routing agent's own remarks in its chat", async () => {
    const { on, tools } = load();
    hub.upsertChannel({ name: "group", members: ["impl", "rev"], supervisor: "rev" });
    const msg = hub.appendMessage({ from: "impl", to: "group", kind: "chat", text: "APPROVE" });
    on.agent_start({}, ctx);
    on.message_end({ message: { role: "user", content: [{ type: "text", text: `Routing task for #group.\nNew message (id ${msg.id.slice(0, 8)}): impl said: "APPROVE"` }] } }, ctx);
    await tools.route.execute("1", { channel: "group", respond: [], messageId: msg.id });
    on.message_end(said("APPROVE noted."), ctx);
    on.agent_settled({ aborted: false }, ctx);
    expect(fromRev()).toEqual([]);
  });

  it("reaches the channel when a routing agent took the work itself", async () => {
    const { on, tools } = load();
    hub.upsertChannel({ name: "dev", members: ["impl", "rev"], supervisor: "rev" });
    const msg = hub.appendMessage({ from: "impl", to: "dev", kind: "chat", text: "please review" });
    on.agent_start({}, ctx);
    on.message_end({ message: { role: "user", content: [{ type: "text", text: `Routing task for #dev.\nNew message (id ${msg.id.slice(0, 8)}): impl said: "please review"` }] } }, ctx);
    await tools.route.execute("1", { channel: "dev", respond: ["rev"], messageId: msg.id });
    on.tool_execution_start({ toolName: "read" }, ctx);
    on.message_end(said("APPROVE"), ctx);
    on.agent_settled({ aborted: false }, ctx);
    expect(fromRev()).toMatchObject([{ to: "dev", text: "APPROVE" }]);
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

describe("mentionText", () => {
  it("opens with the names", () => {
    expect(mentionText(["rev", "plan"], "please look")).toBe("@rev @plan please look");
  });

  it("does not repeat names the model also wrote", () => {
    expect(mentionText(["rev"], "@rev please look")).toBe("@rev please look");
  });

  it("keeps a name that is not a target, and any later in the text", () => {
    expect(mentionText(["rev"], "@qa and I are done, thanks @rev")).toBe("@rev @qa and I are done, thanks @rev");
  });
});

describe("openspecArgs", () => {
  it("keeps init from writing files for other AI tools", () => {
    expect(openspecArgs(["init"])).toEqual(["init", "--tools", "none"]);
  });

  it("leaves a choice alone, and every other command", () => {
    expect(openspecArgs(["init", "--tools", "pi"])).toEqual(["init", "--tools", "pi"]);
    expect(openspecArgs(["list"])).toEqual(["list"]);
  });
});

describe("what agents are told about messages", () => {
  it.each([[false], [true]])("says how to hand off and not to acknowledge (lean: %s)", (lean) => {
    const prompt = fleetPrompt("alice", lean, "alice", "implementer");
    expect(prompt).toContain("A name later in a message wakes nobody");
    expect(prompt).toMatch(/[Nn]ever just acknowledge|Do not acknowledge/);
  });

  it("makes the reviewer's verdict the end of the job", () => {
    expect(rolePrompt("reviewer")).toContain("APPROVE means nothing is left to check");
    expect(rolePrompt("planner")).toContain("leave the reviewer out");
  });
});

describe("working in a worktree", () => {
  it("tells the agent how its work reaches everyone else", () => {
    const prompt = worktreePrompt("fleet/alice");
    expect(prompt).toContain("fleet/alice");
    expect(prompt).toContain("Do not merge");
    expect(prompt).toContain("full path");
  });

  it("says nothing to an agent with no worktree", () => {
    expect(worktreePrompt(undefined)).toBe("");
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