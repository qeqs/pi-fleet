import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { Hub, truncateMessage, MAX_MESSAGE_LEN, shortId } from "../src/hub.ts";
import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";

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

describe("truncation", () => {
  it("truncates long messages with a marker", () => {
    const long = "x".repeat(MAX_MESSAGE_LEN + 500);
    const { text, truncated } = truncateMessage(long);
    expect(truncated).toBe(true);
    expect(text.length).toBeLessThanOrEqual(MAX_MESSAGE_LEN + 40);
    expect(text).toContain("…(truncated)");
  });

  it("appendMessage truncates on write", () => {
    const long = "y".repeat(MAX_MESSAGE_LEN + 500);
    const m = hub.appendMessage({ from: "a", to: "group", kind: "chat", text: long });
    expect(m.text.length).toBeLessThan(long.length);
    // on-disk record is valid JSON and truncated
    const raw = fs.readFileSync(path.join(dir, "messages.jsonl"), "utf8").trim().split("\n").pop()!;
    const parsed = JSON.parse(raw);
    expect(parsed.text.length).toBeLessThan(long.length);
  });

  it("does not truncate short messages", () => {
    const { text, truncated } = truncateMessage("short");
    expect(truncated).toBe(false);
    expect(text).toBe("short");
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