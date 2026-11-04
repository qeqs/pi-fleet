import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { Hub, addressedAgents, messageTooLong, addressLabel, formatMessage, MAX_MESSAGE_LEN, printable, shortId } from "../src/hub.ts";
import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { TSX, until } from "./support.ts";

let dir: string;
let hub: Hub;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "fleet-hub-"));
  hub = new Hub(dir);
});

afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

describe("registry writes under concurrent readers", () => {
  it("does not lose an update while other processes keep reading the file", async () => {
    // on Windows a rename fails while the target is open, which stranded agents in "busy"
    hub.updateAgent("alice", { name: "alice", pid: 1, cwd: ".", status: "idle" });
    const loop = "const fs=require('fs');const end=Date.now()+2500;while(Date.now()<end){try{fs.readFileSync(process.argv[1])}catch{}}";
    const readers = [0, 1, 2].map(() => spawn(process.execPath, ["-e", loop, hub.agentsFile], { stdio: "ignore" }));
    await new Promise((r) => setTimeout(r, 400)); // let the readers start hammering
    for (let i = 0; i < 40; i++) hub.updateAgent("alice", { status: i % 2 === 0 ? "busy" : "idle" });
    expect(hub.readAgents().alice.status).toBe("idle");
    await Promise.all(readers.map((r) => new Promise((resolve) => r.on("exit", resolve))));
    expect(fs.readdirSync(dir).filter((f) => f.endsWith(".tmp"))).toEqual([]);
  }, 10000);
});

describe("pause and hop count", () => {
  const chat = (from: string, to = "group") => hub.appendMessage({ from, to, kind: "chat", text: "hi" });

  it("pauses, announces it once, and resumes", () => {
    expect(hub.pausedReason()).toBeNull();
    hub.pause("too many messages");
    hub.pause("a second reason");
    expect(hub.pausedReason()).toBe("too many messages");
    expect(hub.tailMessages(10).filter((m) => m.kind === "system")).toHaveLength(1);
    hub.resume();
    hub.resume();
    expect(hub.pausedReason()).toBeNull();
  });

  it("knows what a pause is holding back", () => {
    chat("alice");
    const since = Date.now() + 1;
    while (Date.now() < since); // the next message must be newer than the first
    hub.pause("too many", since);
    const held = hub.appendMessage({ from: "bob", to: "alice", kind: "chat", text: "held" });
    expect(hub.heldMessages().map((m) => m.id)).toEqual([held.id]);
  });

  it("holds nothing when it is not paused", () => {
    chat("alice");
    expect(hub.heldMessages()).toEqual([]);
  });

  it("counts agent messages since the human last spoke", () => {
    chat("alice");
    chat("user");
    chat("alice", "bob");
    chat("bob", "alice");
    hub.appendMessage({ from: "system", to: "group", kind: "system", text: "noise" });
    expect(hub.agentHops()).toBe(2);
  });

  it("can count up to a given message, ignoring what came after it", () => {
    chat("user");
    const first = chat("alice");
    chat("bob");
    chat("alice");
    expect(hub.agentHops(first.id)).toBe(1);
  });

  it("counts from the start of the bus when the human never spoke", () => {
    chat("alice");
    chat("bob");
    expect(hub.agentHops()).toBe(2);
  });

  it("a direct prompt restarts the count like any other human message", () => {
    chat("alice");
    hub.appendMessage({ from: "user", to: "alice", kind: "activity", text: "direct prompt" });
    expect(hub.agentHops()).toBe(0);
  });
});

describe("readBus", () => {
  const say = (text: string) => hub.appendMessage({ from: "a", to: "group", kind: "chat", text });
  const texts = (r: { messages: { text: string }[] }) => r.messages.map((m) => m.text);

  it("reads from a cursor to the end, and the next cursor is the end", () => {
    say("one");
    const mid = hub.busEnd();
    say("two");
    const r = hub.readBus(mid);
    expect(texts(r)).toEqual(["two"]);
    expect(r.next).toEqual(hub.busEnd());
  });

  it("follows a cursor through a rotation without losing what was unread", () => {
    say("read already");
    const mid = hub.busEnd();
    say("unread when it rotated");
    expect(hub.rotateIfLarge(1)).toBe(true);
    say("after the rotation");
    const r = hub.readBus(mid);
    expect(texts(r)).toEqual(["unread when it rotated", "after the rotation"]);
    expect(r.next).toEqual(hub.busEnd());
  });

  it("follows a cursor through several rotations, in order", () => {
    const start = hub.busEnd();
    for (const text of ["first", "second", "third"]) {
      say(text);
      hub.rotateIfLarge(1);
    }
    say("last");
    expect(texts(hub.readBus(start))).toEqual(["first", "second", "third", "last"]);
  });

  it("keeps a message written right after a rotation", () => {
    say("old");
    hub.rotateIfLarge(1);
    say("new");
    expect(hub.tailMessages(5).map((m) => m.text)).toEqual(["new"]);
  });
});

describe("cursor", () => {
  it("is absent until written, then survives a new Hub", () => {
    expect(hub.readCursor()).toBeNull();
    hub.writeCursor({ gen: 2, offset: 40 });
    expect(new Hub(dir).readCursor()).toEqual({ gen: 2, offset: 40 });
  });
});

describe("inbox", () => {
  it("keeps wakes in order, on disk", () => {
    hub.enqueueWake("bob", "first");
    hub.enqueueWake("bob", "second");
    expect(new Hub(dir).readInbox("bob").map((e) => e.text)).toEqual(["first", "second"]);
  });

  it("keeps a delivered wake until the agent settles", () => {
    const a = hub.enqueueWake("bob", "accepted");
    hub.enqueueWake("bob", "not yet");
    hub.markDelivered("bob", a.id);
    expect(hub.readInbox("bob").map((e) => e.delivered)).toEqual([true, false]);
    hub.ackDelivered("bob");
    expect(hub.readInbox("bob").map((e) => e.text)).toEqual(["not yet"]);
  });

  it("removes one entry by id", () => {
    const a = hub.enqueueWake("router", "first");
    hub.enqueueWake("router", "second");
    hub.removeFromInbox("router", a.id);
    expect(hub.readInbox("router").map((e) => e.text)).toEqual(["second"]);
  });

  it("keeps each agent's inbox separate", () => {
    hub.enqueueWake("bob", "for bob");
    expect(hub.readInbox("alice")).toEqual([]);
  });

  it("can be cleared", () => {
    hub.enqueueWake("bob", "dropped");
    hub.clearInbox("bob");
    expect(hub.readInbox("bob")).toEqual([]);
  });
});

describe("GUI token", () => {
  it("creates one token and keeps it across hub instances", () => {
    const token = hub.guiToken();
    expect(token.length).toBeGreaterThanOrEqual(32);
    expect(new Hub(dir).guiToken()).toBe(token);
  });

  it("gives each hub its own token", () => {
    const other = fs.mkdtempSync(path.join(os.tmpdir(), "fleet-hub-"));
    expect(new Hub(other).guiToken()).not.toBe(hub.guiToken());
    fs.rmSync(other, { recursive: true, force: true });
  });
});

describe("message offset reads", () => {
  it("reads all messages from offset 0", () => {
    hub.appendMessage({ from: "a", to: "group", kind: "chat", text: "one" });
    hub.appendMessage({ from: "b", to: "group", kind: "chat", text: "two" });
    hub.appendMessage({ from: "c", to: "group", kind: "chat", text: "three" });
    const { messages, nextOffset } = hub.readMessagesSince(0);
    expect(messages).toHaveLength(3);
    expect(messages.map((m) => m.text)).toEqual(["one", "two", "three"]);
    expect(nextOffset).toBe(hub.messagesSize());
  });

  it("reads only messages after the given offset", () => {
    hub.appendMessage({ from: "a", to: "group", kind: "chat", text: "one" });
    const offsetAfterFirst = hub.messagesSize(); // byte offset where the next message starts
    hub.appendMessage({ from: "b", to: "group", kind: "chat", text: "two" });
    hub.appendMessage({ from: "c", to: "group", kind: "chat", text: "three" });
    const { messages } = hub.readMessagesSince(offsetAfterFirst);
    expect(messages).toHaveLength(2);
    expect(messages.map((m) => m.text)).toEqual(["two", "three"]);
  });

  it("returns empty when nothing new", () => {
    hub.appendMessage({ from: "a", to: "group", kind: "chat", text: "one" });
    const end = hub.messagesSize();
    const { messages } = hub.readMessagesSince(end);
    expect(messages).toHaveLength(0);
  });

  it("tailMessages returns the last N", () => {
    for (let i = 1; i <= 10; i++) hub.appendMessage({ from: "a", to: "group", kind: "chat", text: `m${i}` });
    const tail = hub.tailMessages(3);
    expect(tail.map((m) => m.text)).toEqual(["m8", "m9", "m10"]);
  });

  it("handles a missing messages file gracefully", () => {
    const { messages } = hub.readMessagesSince(0);
    expect(messages).toHaveLength(0);
  });
});

describe("registry", () => {
  it("updateAgent creates and updates entries", () => {
    hub.updateAgent("alice", { name: "alice", pid: 111, cwd: "/x", status: "starting" });
    hub.updateAgent("alice", { status: "busy" });
    const agents = hub.readAgents();
    expect(agents.alice.status).toBe("busy");
    expect(agents.alice.pid).toBe(111);
    expect(agents.alice.cwd).toBe("/x");
  });

  it("removeAgent deletes an entry", () => {
    hub.updateAgent("alice", { name: "alice", pid: 111, cwd: "/x", status: "idle" });
    hub.removeAgent("alice");
    expect(hub.readAgents().alice).toBeUndefined();
  });

  it("independent agents do not clobber each other", () => {
    hub.updateAgent("alice", { name: "alice", pid: 1, cwd: "/a", status: "idle" });
    hub.updateAgent("bob", { name: "bob", pid: 2, cwd: "/b", status: "busy" });
    const agents = hub.readAgents();
    expect(agents.alice.pid).toBe(1);
    expect(agents.bob.pid).toBe(2);
  });
});

describe("message length", () => {
  it("explains why a message is too long", () => {
    const reason = messageTooLong("x".repeat(MAX_MESSAGE_LEN + 1));
    expect(reason).toContain(String(MAX_MESSAGE_LEN + 1));
    expect(reason).toContain("split it");
  });

  it("accepts a message at the limit", () => {
    expect(messageTooLong("x".repeat(MAX_MESSAGE_LEN))).toBeNull();
  });

  it("never cuts what it stores", () => {
    const long = "y".repeat(MAX_MESSAGE_LEN + 500);
    expect(hub.appendMessage({ from: "system", to: "bob", kind: "chat", text: long }).text).toBe(long);
  });
});

describe("posting as the human", () => {
  it("posts to the default channel, a named channel or an agent", () => {
    hub.upsertChannel({ name: "dev", members: [] });
    hub.updateAgent("alice", { name: "alice", pid: 1, cwd: ".", status: "idle" });
    for (const to of ["group", "dev", "alice"]) expect(hub.postUserMessage(to, "hi").from).toBe("user");
  });

  it("refuses an unknown address, listing what exists", () => {
    hub.updateAgent("alice", { name: "alice", pid: 1, cwd: ".", status: "idle" });
    expect(() => hub.postUserMessage("alcie", "hi")).toThrow(/no agent or channel "alcie"\. Agents: alice/);
    expect(hub.tailMessages(5)).toHaveLength(0);
  });

  it("refuses an over-long message instead of cutting it", () => {
    expect(() => hub.postUserMessage("group", "z".repeat(MAX_MESSAGE_LEN + 1))).toThrow(/split it/);
    expect(hub.tailMessages(5)).toHaveLength(0);
  });
});

describe("addresses", () => {
  const dev = [{ name: "dev", members: [] }];

  it("labels channels with # and agents with @", () => {
    expect(addressLabel("group")).toBe("#group");
    expect(addressLabel("dev", dev)).toBe("#dev");
    expect(addressLabel("alice", dev)).toBe("@alice");
  });

  it("shows a named channel as a channel in the terminal", () => {
    const m = hub.appendMessage({ from: "user", to: "dev", kind: "chat", text: "hi" });
    expect(formatMessage(m, undefined, dev)).toContain("user → #dev hi");
  });
});

describe("router failover", () => {
  const agent = (name: string, role?: string) => hub.updateAgent(name, { name, pid: 1, cwd: ".", status: "idle", role });

  it("hands a channel to a running member, leaving healthy channels alone", () => {
    agent("a");
    agent("b");
    hub.upsertChannel({ name: "group", members: ["a", "b"], supervisor: "a" });
    hub.upsertChannel({ name: "dev", members: ["a", "b"], supervisor: "b" });
    expect(hub.reassignSupervisors(["b"])).toEqual([{ channel: "group", supervisor: "b" }]);
    expect(hub.getChannel("group")?.supervisor).toBe("b");
  });

  it("prefers an agent with the supervisor role", () => {
    agent("a");
    agent("b");
    agent("c", "supervisor");
    hub.upsertChannel({ name: "group", members: ["a", "b", "c"], supervisor: "a" });
    hub.reassignSupervisors(["b", "c"]);
    expect(hub.getChannel("group")?.supervisor).toBe("c");
  });

  it("leaves channels on the dedicated router alone", () => {
    agent("a");
    agent("b");
    hub.upsertChannel({ name: "dev", members: ["a", "b"] });
    expect(hub.reassignSupervisors(["b"])).toEqual([]);
  });

  it("keeps the router of a channel with nobody running", () => {
    agent("a");
    hub.upsertChannel({ name: "group", members: ["a"], supervisor: "a" });
    expect(hub.reassignSupervisors([])).toEqual([]);
    expect(hub.getChannel("group")?.supervisor).toBe("a");
  });
});

describe("addressedAgents", () => {
  const from = (who: string, text: string) => addressedAgents({ from: who, text });

  it("takes the names an agent's message opens with", () => {
    expect(from("impl", "@rev please look")).toEqual(["rev"]);
    expect(from("impl", "@rev @plan, @qa: please look")).toEqual(["rev", "plan", "qa"]);
    expect(from("impl", "  @rev please look")).toEqual(["rev"]);
  });

  it("does not take a name an agent mentions in passing", () => {
    expect(from("plan", "Thanks @rev, approval received.")).toEqual([]);
    expect(from("rev", "I will review once @impl reports back.")).toEqual([]);
    expect(from("impl", "@rev done, and @plan can relax")).toEqual(["rev"]);
  });

  it("takes every name a person writes", () => {
    expect(from("user", "thanks, and please ask @rev to look")).toEqual(["rev"]);
  });
});

describe("printable", () => {
  it("drops what a terminal would act on, and keeps the text", () => {
    expect(printable("\x1b]0;owned\x07hello\x1b[2J there\x9b")).toBe("]0;ownedhello[2J there");
  });

  it("keeps line breaks and tabs", () => {
    expect(printable("one\n\ttwo\r\n")).toBe("one\n\ttwo\r\n");
  });
});

describe("spending per request", () => {
  it("records the total as a request comes in", () => {
    hub.saveStats("a", { cost: 0.5 });
    hub.saveStats("b", { cost: 0.25 });
    hub.markSpend("m1");
    expect(hub.readSpend()).toEqual({ m1: 0.75 });
    expect(hub.totalSpent()).toBe(0.75);
  });
});

describe("searchMessages", () => {
  const say = (text: string) => hub.appendMessage({ from: "a", to: "group", kind: "chat", text });

  it("finds messages in the bus and its archives, newest first, ignoring case", () => {
    say("the Parser bug");
    hub.rotateIfLarge(1);
    say("unrelated");
    say("parser fixed");
    expect(hub.searchMessages("parser").map((m) => m.text)).toEqual(["parser fixed", "the Parser bug"]);
  });

  it("leaves out system notices", () => {
    hub.appendMessage({ from: "system", to: "group", kind: "system", text: "parser notice" });
    expect(hub.searchMessages("parser")).toEqual([]);
  });

  it("stops at the limit", () => {
    for (let i = 0; i < 5; i++) say(`match ${i}`);
    expect(hub.searchMessages("match", 2).map((m) => m.text)).toEqual(["match 4", "match 3"]);
  });
});

describe("removing an agent", () => {
  it("takes it out of the registry and every channel", () => {
    hub.updateAgent("a", { name: "a", pid: 1, cwd: ".", status: "idle" });
    hub.upsertChannel({ name: "dev", members: ["a", "b"], supervisor: "a" });
    hub.removeAgent("a");
    expect(hub.readAgents().a).toBeUndefined();
    expect(hub.getChannel("dev")).toMatchObject({ members: ["b"] });
    expect(hub.getChannel("dev")?.supervisor).toBeUndefined();
  });
});

describe("channel summary notes", () => {
  it("adds a note to the summary, on one line", () => {
    hub.upsertChannel({ name: "dev", members: [], summary: "so far" });
    hub.noteInSummary("dev", "impl: first\nsecond line");
    expect(hub.getChannel("dev")?.summary).toBe("so far\nimpl: first second line");
  });

  it("keeps the summary short, dropping the oldest part", () => {
    hub.upsertChannel({ name: "dev", members: [], summary: "old ".repeat(200) });
    hub.noteInSummary("dev", "newest note");
    const summary = hub.getChannel("dev")!.summary!;
    expect(summary.length).toBeLessThanOrEqual(500);
    expect(summary.endsWith("newest note")).toBe(true);
  });

  it("ignores a channel that does not exist", () => {
    hub.noteInSummary("nosuch", "note");
    expect(hub.readChannels()).toEqual([]);
  });
});

describe("one supervisor per hub", () => {
  it("sees nothing on a fresh hub, and does not count itself", () => {
    expect(hub.otherSupervisor()).toBeNull();
    hub.writeSupervisorHeartbeat();
    expect(hub.otherSupervisor()).toBeNull();
  });

  it("names another live supervisor", async () => {
    const other = spawn(process.execPath, ["-e", "setTimeout(() => {}, 20000)"], { stdio: "ignore" });
    fs.writeFileSync(hub.supervisorFile, JSON.stringify({ ts: Date.now(), pid: other.pid }));
    expect(hub.otherSupervisor()).toBe(other.pid);
    other.kill();
  });

  it("ignores a heartbeat left by a dead process", () => {
    fs.writeFileSync(hub.supervisorFile, JSON.stringify({ ts: Date.now(), pid: 999999999 }));
    expect(hub.otherSupervisor()).toBeNull();
  });
});

describe("channel writes across processes", () => {
  it("loses no update when several processes write at once", async () => {
    const tsx = path.join(__dirname, "..", "node_modules", "tsx", "dist", "cli.mjs");
    const worker = path.join(__dirname, "hub-worker.ts");
    const procs = [0, 1, 2].map((id) => spawn(process.execPath, [tsx, worker, dir, String(id)], { stdio: "ignore" }));
    await Promise.all(procs.map((p) => new Promise((resolve) => p.on("exit", resolve))));
    expect(hub.readChannels()).toHaveLength(45);
  }, 30000);
});

describe("the hub lock", () => {
  const lockFile = () => `${hub.agentsFile}.lock`;
  const sleeper = () => spawn(process.execPath, ["-e", "setTimeout(() => {}, 30000)"], { stdio: "ignore" });

  it("waits for a live holder, however long it takes", async () => {
    // a writer that had waited 2 seconds used to take the lock while its holder was still writing
    const holder = sleeper();
    const token = `${holder.pid} 0 held`;
    fs.writeFileSync(lockFile(), token);
    const ready = path.join(dir, "ready");
    const writer = spawn(process.execPath, [TSX, path.join(__dirname, "hub-worker.ts"), dir, "w", ready], { stdio: "ignore" });
    const done = new Promise((resolve) => writer.on("exit", resolve));
    await until("the writer to start", () => fs.existsSync(ready), 20000);
    await new Promise((r) => setTimeout(r, 3000));
    expect(fs.readFileSync(lockFile(), "utf8")).toBe(token);
    expect(hub.readChannels()).toEqual([]);
    fs.unlinkSync(lockFile());
    await done;
    expect(hub.readChannels()).toHaveLength(15);
    holder.kill();
  }, 30000);

  it("takes the lock of a holder that died", () => {
    fs.writeFileSync(lockFile(), "999999999 0 dead");
    hub.upsertChannel({ name: "dev", members: [] });
    expect(hub.getChannel("dev")).toBeDefined();
    expect(fs.existsSync(lockFile())).toBe(false);
  });

  it("takes a lock held far too long", () => {
    const holder = sleeper();
    fs.writeFileSync(lockFile(), `${holder.pid} 0 hung`);
    const old = new Date(Date.now() - 60000);
    fs.utimesSync(lockFile(), old, old);
    hub.upsertChannel({ name: "dev", members: [] });
    expect(hub.getChannel("dev")).toBeDefined();
    holder.kill();
  });

  it("leaves a lock that is no longer its own", () => {
    // as if this writer had hung, lost its lock as stale, and another writer had taken it
    const channel = { name: "dev", members: [], get supervisor() { fs.writeFileSync(lockFile(), "1 0 other"); return undefined; } };
    hub.upsertChannel(channel);
    expect(fs.readFileSync(lockFile(), "utf8")).toBe("1 0 other");
  });
});

describe("rotation", () => {
  it("rotateIfLarge archives and bumps generation", () => {
    const small = new Hub(dir);
    for (let i = 0; i < 20; i++) small.appendMessage({ from: "a", to: "group", kind: "chat", text: `message number ${i} with some padding text` });
    const genBefore = small.generation();
    const rotated = small.rotateIfLarge(100);
    expect(rotated).toBe(true);
    expect(small.generation()).toBe(genBefore + 1);
    // an archive file exists
    const archives = fs.readdirSync(dir).filter((f) => f.startsWith("messages-") && f.endsWith(".jsonl"));
    expect(archives.length).toBeGreaterThanOrEqual(1);
    // new messages go to a fresh file
    small.appendMessage({ from: "a", to: "group", kind: "chat", text: "after rotation" });
    expect(small.tailMessages(1)[0].text).toBe("after rotation");
  });

  it("does not rotate when under threshold", () => {
    const small = new Hub(dir);
    small.appendMessage({ from: "a", to: "group", kind: "chat", text: "tiny" });
    expect(small.rotateIfLarge(100000)).toBe(false);
    expect(small.generation()).toBe(0);
  });
});

describe("shortId", () => {
  it("returns a stable short prefix", () => {
    const id = "abcdef1234567890";
    expect(shortId(id)).toBe(id.slice(0, 8));
    expect(shortId(id)).toBe(shortId(id));
  });
});

describe("supervisor heartbeat", () => {
  it("is absent (not alive) until written", () => {
    expect(hub.readSupervisorHeartbeat()).toBe(0);
    expect(hub.supervisorAlive()).toBe(false);
  });

  it("writeSupervisorHeartbeat makes it alive", () => {
    hub.writeSupervisorHeartbeat();
    expect(hub.readSupervisorHeartbeat()).toBeGreaterThan(0);
    expect(hub.supervisorAlive()).toBe(true);
  });

  it("clearSupervisorHeartbeat makes it not alive", () => {
    hub.writeSupervisorHeartbeat();
    hub.clearSupervisorHeartbeat();
    expect(hub.supervisorAlive()).toBe(false);
  });

  it("goes stale after maxAgeMs", () => {
    // write a heartbeat with an old timestamp directly
    fs.writeFileSync(hub.supervisorFile, JSON.stringify({ ts: Date.now() - 20000 }), "utf8");
    expect(hub.supervisorAlive(8000)).toBe(false); // 20s old > 8s threshold
    expect(hub.supervisorAlive(30000)).toBe(true); // 20s old < 30s threshold
  });
});