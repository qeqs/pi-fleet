/**
 * End-to-end: real supervisor, bridges and `pi --mode rpc` processes, with a
 * scripted model server (fake-llm.mjs) in place of an LLM. These cover what the
 * unit tests cannot see: whether a message actually travels through the fleet.
 */
import { describe, it, expect, beforeAll, afterAll, afterEach } from "vitest";
import { spawn, type ChildProcess } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { Hub, isPidAlive } from "../src/hub.ts";
import { bridgeListening } from "../src/rpc.ts";
import { HUB_FORMAT, readHubFormat } from "../src/hubformat.ts";
import { execFileSync, spawnSync } from "node:child_process";
import { DEAD_MODEL, NO_TOOLS_MODEL, crash, FLEET, MODEL, ROOT, TSX, firstMatch, killTree, startFakeModel, until, type LlmRequest } from "./support.ts";

let tmp: string;
let llm: ChildProcess;
let llmLog: () => Promise<LlmRequest[]>;
let env: NodeJS.ProcessEnv;

const running: { proc: ChildProcess; hubDir: string }[] = [];

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Passes only if no model request is made for a few seconds: the scripted loops run far faster. */
async function expectQuiet(): Promise<void> {
  await sleep(2500);
  const settled = (await llmLog()).length;
  await sleep(2500);
  expect((await llmLog()).length).toBe(settled);
}

function startFleet(name: string, args: string[], extraEnv: NodeJS.ProcessEnv = {}): { proc: ChildProcess; hub: Hub } {
  const hubDir = path.join(tmp, name);
  const proc = spawn(process.execPath, [TSX, FLEET, ...args, "--dir", hubDir, "--model", MODEL], {
    cwd: tmp,
    env: { ...env, ...extraEnv },
    stdio: ["pipe", "pipe", "pipe"],
  });
  running.push({ proc, hubDir });
  return { proc, hub: new Hub(hubDir) };
}

/** The GUI's view of the fleet: what a page receives when it connects. */
async function snapshot(port: string, token: string): Promise<Record<string, any>> {
  const controller = new AbortController();
  const res = await fetch(`http://127.0.0.1:${port}/events`, { headers: { Authorization: `Bearer ${token}` }, signal: controller.signal });
  const reader = res.body!.getReader();
  let text = "";
  for (;;) {
    const { value } = await reader.read();
    text += new TextDecoder().decode(value);
    const m = /event: snapshot\ndata: (.*)\n\n/.exec(text);
    if (m) {
      controller.abort();
      return JSON.parse(m[1]);
    }
  }
}

async function guiPost(port: string, token: string, route: string, body: unknown): Promise<Response> {
  return fetch(`http://127.0.0.1:${port}${route}`, { method: "POST", headers: { Authorization: `Bearer ${token}` }, body: JSON.stringify(body) });
}

async function startGui(name: string, args: string[], extraEnv: NodeJS.ProcessEnv = {}): Promise<{ hub: Hub; port: string; token: string }> {
  const { proc, hub } = startFleet(name, ["serve", ...args], extraEnv);
  const [, port, token] = await firstMatch(proc, /GUI: http:\/\/127\.0\.0\.1:(\d+)\/\?token=([\w-]+)/);
  return { hub, port, token };
}

/** Ask an agent something and wait for the model to have been asked and the run to end. */
async function exchange(hub: Hub, agent: string, text: string): Promise<LlmRequest> {
  hub.appendMessage({ from: "user", to: agent, kind: "chat", text });
  const asked = await until(`${agent} to be asked`, async () => (await llmLog()).find((r) => r.agent === agent && r.last.includes(text)));
  await sleep(300);
  await idle(hub, [agent]);
  return asked;
}

async function idle(hub: Hub, names: string[]): Promise<void> {
  await until(`${names.join(", ")} idle`, () => {
    const agents = hub.readAgents();
    return names.every((n) => agents[n]?.status === "idle");
  });
}

beforeAll(async () => {
  const model = await startFakeModel("pi fleet e2e");
  ({ tmp, env } = model);
  llm = model.proc;
  llmLog = model.log;
}, 30000);

afterEach(() => {
  for (const { proc, hubDir } of running.splice(0)) {
    killTree(proc.pid);
    for (const a of Object.values(new Hub(hubDir).readAgents())) killTree(a.pid);
  }
});

afterAll(() => {
  killTree(llm.pid);
  try {
    fs.rmSync(tmp, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
  } catch {
    // a just-killed process may still hold a log file on Windows
  }
});

describe("fleet end to end", () => {
  it("runs the sdlc chain from the user's message to the reviewer's verdict", async () => {
    const { proc, hub } = startFleet("sdlc", ["serve", "--template", "sdlc"]);
    const [, url, port, token] = await firstMatch(proc, /GUI: (http:\/\/127\.0\.0\.1:(\d+)\/\?token=([\w-]+))/);
    await idle(hub, ["planner", "implementer", "reviewer"]);
    expect((await fetch(`http://127.0.0.1:${port}/`)).status).toBe(401);
    expect((await fetch(url)).status).toBe(200);

    const res = await fetch(`http://127.0.0.1:${port}/message`, {
      method: "POST",
      headers: { Authorization: `Bearer ${token}` },
      body: JSON.stringify({ to: "group", text: "build the feature" }),
    });
    expect(res.status).toBe(200);

    await until("the reviewer's verdict", () => hub.tailMessages(50).find((m) => m.from === "reviewer" && m.text === "APPROVE"));
    await until("the fleet to settle", async () => {
      const agents = Object.values(hub.readAgents());
      return agents.every((a) => a.status === "idle");
    });
    await expectQuiet();
    const log = await llmLog();
    expect(new Set(log.map((r) => r.agent))).toEqual(new Set(["router", "planner", "implementer", "reviewer"]));
    expect(log.filter((r) => r.agent !== "router" && r.last.includes("Routing task"))).toEqual([]); // no worker routes
    expect(log.filter((r) => r.agent === "router")).toHaveLength(1); // APPROVE needed no model
  }, 60000);

  it("brings a verdict left in a model's own chat to the group, and nothing else", async () => {
    const { proc, hub } = startFleet("verdict", ["serve", "--template", "sdlc"]);
    await firstMatch(proc, /GUI: http/);
    await idle(hub, ["planner", "implementer", "reviewer"]);
    const fromReviewer = () => hub.tailMessages(100).filter((m) => m.from === "reviewer" && m.kind === "chat");

    await exchange(hub, "reviewer", "[[inspect APPROVE from a direct message]]");
    expect(fromReviewer()).toEqual([]); // nobody in the group asked

    hub.appendMessage({ from: "user", to: "group", kind: "chat", text: "route=reviewer [[say It all looks fine.]]" });
    await until("the reviewer to answer", async () => (await llmLog()).find((r) => r.agent === "reviewer" && r.last.includes("It all looks fine")));
    await sleep(300);
    await idle(hub, ["reviewer"]);
    expect(fromReviewer()).toEqual([]);

    hub.appendMessage({ from: "user", to: "group", kind: "chat", text: "route=reviewer [[inspect REQUEST CHANGES: add a test]]" });
    await until("the verdict in the group", () => fromReviewer().find((m) => m.to === "group" && m.text === "REQUEST CHANGES: add a test"));
    await until("the implementer to get it", async () => (await llmLog()).find((r) => r.agent === "implementer" && r.last.includes("REQUEST CHANGES: add a test")));
    await until("its next verdict, sent the proper way", () => fromReviewer().find((m) => m.text === "APPROVE"));
    await expectQuiet();
    expect(fromReviewer().map((m) => m.text)).toEqual(["REQUEST CHANGES: add a test", "APPROVE"]);
  }, 90000);

  it("gives a busy agent what arrived during its run in one wake", async () => {
    const { hub } = startFleet("merged", ["serve", "--agent", "alice", "--agent", "bob"]);
    await idle(hub, ["alice", "bob"]);
    hub.appendMessage({ from: "user", to: "alice", kind: "chat", text: "[[slow 5]] a long job" });
    await until("alice busy", () => hub.readAgents().alice.status === "busy");
    hub.appendMessage({ from: "bob", to: "alice", kind: "chat", text: "one meanwhile" });
    await sleep(1000); // past one tick of the bus, so these are two wakes to merge
    hub.appendMessage({ from: "bob", to: "alice", kind: "chat", text: "two meanwhile" });
    const waiting = () => hub.readInbox("alice").filter((e) => e.text.includes("meanwhile"));
    await until("both in the inbox", () => waiting().length === 2);
    expect(waiting().some((e) => e.delivered)).toBe(false); // a crash now would interrupt neither
    await until("the wake", async () => (await llmLog()).find((r) => r.agent === "alice" && r.last.includes("two meanwhile")));
    await sleep(300);
    await idle(hub, ["alice"]);
    // not by position in the log: the model can hear of the long job after alice shows as busy
    const wakes = (await llmLog()).filter((r) => r.agent === "alice" && r.last.includes("meanwhile"));
    expect(wakes.map((r) => r.last)).toEqual([expect.stringContaining("one meanwhile")]);
    expect(wakes[0].last).toContain("two meanwhile");
  }, 60000);

  it("leaves a repository tidy when an agent sets up the task board", async () => {
    const folder = path.join(tmp, "board-init");
    fs.mkdirSync(folder, { recursive: true });
    const { hub } = startFleet("board-init", ["up", "--agent", `alice:${folder}`]);
    await idle(hub, ["alice"]);
    await exchange(hub, "alice", "[[openspec init]]");
    await until("the board", () => fs.existsSync(path.join(folder, "openspec")));
    expect(fs.existsSync(path.join(folder, ".pi", "skills"))).toBe(false);
    expect(fs.existsSync(path.join(folder, ".pi", "prompts"))).toBe(false);
  }, 60000);

  it("queues messages for a busy agent instead of losing them", async () => {
    const { hub } = startFleet("busy", ["serve", "--agent", "alice", "--agent", "bob"]);
    await idle(hub, ["alice", "bob"]);
    hub.appendMessage({ from: "user", to: "alice", kind: "chat", text: "[[slow 3]] start" });
    await until("alice busy", () => hub.readAgents().alice.status === "busy");
    hub.appendMessage({ from: "bob", to: "alice", kind: "chat", text: "first while busy" });
    await new Promise((r) => setTimeout(r, 900)); // separate supervisor ticks, so separate prompts
    hub.appendMessage({ from: "bob", to: "alice", kind: "chat", text: "second while busy" });

    const seen = await until("both messages in alice's session", async () => {
      const convo = (await llmLog()).filter((r) => r.agent === "alice").map((r) => r.conversation);
      return convo.find((c) => c.includes("first while busy") && c.includes("second while busy"));
    });
    expect(seen).toBeTruthy();
    expect(hub.tailMessages(50).some((m) => m.kind === "system" && /deliver|not running/.test(m.text))).toBe(false);
  }, 60000);

  it("reports a message for an agent that is not running", async () => {
    const { hub } = startFleet("gone", ["serve", "--agent", "alice"]);
    await idle(hub, ["alice"]);
    hub.updateAgent("ghost", { name: "ghost", pid: 0, cwd: tmp, status: "stopped" });
    hub.appendMessage({ from: "user", to: "ghost", kind: "chat", text: "anyone home?" });
    await until("the waiting notice", () => hub.tailMessages(50).find((m) => m.kind === "system" && m.text.includes(`"ghost" is not running`)));
  }, 60000);

  it("keeps channels working after the supervisor detaches", async () => {
    const { proc, hub } = startFleet("detached", ["up", "--agent", "alice", "--agent", "bob", "--detach"]);
    await idle(hub, ["alice", "bob"]);
    proc.stdin!.write("/quit\n");
    await until("the supervisor to detach", () => !hub.supervisorAlive());

    hub.appendMessage({ from: "user", to: "group", kind: "chat", text: "while nobody supervises route=bob" });
    await until("the router's turn", async () => (await llmLog()).find((r) => r.agent === "alice" && r.last.includes("Routing task for #group") && r.last.includes("while nobody supervises")));
    await until("bob to receive the routed message", async () => (await llmLog()).find((r) => r.agent === "bob" && r.conversation.includes("while nobody supervises")));
  }, 60000);

  it("marks a crashed agent stopped, says so, and hands its channel to another router", async () => {
    const { hub } = startFleet("crash", ["serve", "--agent", "alice:::supervisor", "--agent", "bob", "--no-restart"]);
    await idle(hub, ["alice", "bob"]);
    expect(hub.getChannel("group")?.supervisor).toBe("alice");
    killTree(hub.readAgents().alice.pid);

    await until("the crash notice", () => hub.tailMessages(20).find((m) => m.text.includes('agent "alice" stopped unexpectedly')));
    await until("the router handover", () => hub.tailMessages(20).find((m) => m.text.includes('#group is now routed by "bob"')));
    expect(hub.readAgents().alice.status).toBe("stopped");

    hub.appendMessage({ from: "user", to: "group", kind: "chat", text: "still there? route=bob" });
    await until("the new router to take the message", async () => (await llmLog()).find((r) => r.agent === "bob" && r.last.includes("Routing task for #group")));
  }, 60000);

  it("brings a crashed agent back with its conversation", async () => {
    const { hub } = startFleet("revive", ["serve", "--agent", "alice"]);
    await idle(hub, ["alice"]);
    await exchange(hub, "alice", "remember the word CHERRY");
    const crashed = hub.readAgents().alice.pid;
    killTree(crashed);

    await until("the restart notice", () => hub.tailMessages(20).find((m) => m.text.includes('restarting agent "alice"')));
    await until("alice to be back", () => hub.readAgents().alice.pid !== crashed && hub.readAgents().alice.status === "idle");
    const after = await exchange(hub, "alice", "still with me?");
    expect(after.conversation).toContain("CHERRY");
  }, 60000);

  it("/restart keeps the agent's conversation", async () => {
    const { proc, hub } = startFleet("restart", ["up", "--agent", "alice"]);
    await idle(hub, ["alice"]);
    await exchange(hub, "alice", "remember the word BANANA");
    const restarted = firstMatch(proc, /↻ \[alice\] restarted/);
    proc.stdin!.write("/restart alice\n");
    await restarted;
    await idle(hub, ["alice"]);
    const after = await exchange(hub, "alice", "what was the word?");
    expect(after.conversation).toContain("BANANA");
  }, 60000);

  it("starts a new conversation with --fresh", async () => {
    const first = startFleet("fresh", ["up", "--agent", "alice"]);
    await idle(first.hub, ["alice"]);
    await exchange(first.hub, "alice", "remember the word MANGO");
    crash(first.hub.otherSupervisor());
    crash(first.hub.readAgents().alice.pid);
    const second = startFleet("fresh", ["up", "--agent", "alice", "--fresh"]);
    await until("the fresh agent", () => second.hub.readAgents().alice.status === "idle" && !second.hub.otherSupervisor(0));
    await idle(second.hub, ["alice"]);
    const after = await exchange(second.hub, "alice", "what was the word again?");
    expect(after.conversation).not.toContain("MANGO");
  }, 60000);

  it("holds a message for a stopped agent and delivers it when the agent returns", async () => {
    const { proc, hub } = startFleet("hold", ["up", "--agent", "alice", "--agent", "bob"]);
    await idle(hub, ["alice", "bob"]);
    proc.stdin!.write("/stop alice\n");
    await until("alice to stop", () => hub.readAgents().alice.status === "stopped");
    hub.appendMessage({ from: "bob", to: "alice", kind: "chat", text: "for when you are back" });
    await until("the waiting notice", () => hub.tailMessages(20).find((m) => m.text.includes('"alice" is not running')));
    proc.stdin!.write("/restart alice\n");
    await until("the message to arrive", async () => (await llmLog()).find((r) => r.agent === "alice" && r.last.includes("for when you are back")));
  }, 60000);

  it("resumes the task after every process is killed, and loses no message", async () => {
    const first = startFleet("killall", ["up", "--agent", "alice", "--agent", "bob"]);
    await idle(first.hub, ["alice", "bob"]);
    await exchange(first.hub, "alice", "remember the word DATE");

    first.hub.appendMessage({ from: "user", to: "alice", kind: "chat", text: "[[slow 4]] the long job" });
    await until("alice busy", () => first.hub.readAgents().alice.status === "busy");
    await sleep(1000);
    const { alice, bob } = first.hub.readAgents();
    for (const pid of [first.hub.otherSupervisor(), alice.pid, bob.pid]) crash(pid);
    await until("alice's bridge to go", async () => !(await bridgeListening(alice.pipeIn!)));

    first.hub.appendMessage({ from: "bob", to: "alice", kind: "chat", text: "sent while everything was down" });
    startFleet("killall", ["up", "--agent", "alice", "--agent", "bob"]);

    const resumed = await until("the interrupted job to resume", async () => (await llmLog()).find((r) => r.agent === "alice" && r.last.includes("You were restarted") && r.last.includes("the long job")));
    expect(resumed.conversation).toContain("DATE");
    await until("the message from while it was down", async () => (await llmLog()).find((r) => r.agent === "alice" && r.conversation.includes("sent while everything was down")));
    const finished = (await llmLog()).filter((r) => r.agent === "alice" && r.last.includes("remember the word DATE"));
    expect(finished).toHaveLength(1); // what was already done is not replayed
  }, 90000);

  it("a clean stop does not resume work by itself", async () => {
    const first = startFleet("cleanstop", ["up", "--agent", "alice"]);
    await idle(first.hub, ["alice"]);
    first.hub.appendMessage({ from: "user", to: "alice", kind: "chat", text: "[[slow 8]] abandoned job" });
    await until("the model to be asked", async () => (await llmLog()).find((r) => r.agent === "alice" && r.last.includes("abandoned job")));
    first.proc.stdin!.write("/quit\n");
    await new Promise((resolve) => first.proc.on("exit", resolve));
    const seen = (await llmLog()).filter((r) => r.agent === "alice" && r.last.includes("abandoned job")).length;

    const second = startFleet("cleanstop", ["up", "--agent", "alice"]);
    await firstMatch(second.proc, /spawned/);
    await idle(second.hub, ["alice"]);
    await expectQuiet();
    expect((await llmLog()).filter((r) => r.agent === "alice" && r.last.includes("abandoned job"))).toHaveLength(seen);
  }, 60000);

  it("refuses a second supervisor on the same hub", async () => {
    const { proc, hub } = startFleet("two", ["serve", "--agent", "alice"]);
    await firstMatch(proc, /GUI: /);
    const second = startFleet("two", ["serve"]);
    const stderr: string[] = [];
    second.proc.stderr!.on("data", (d) => stderr.push(String(d)));
    const code = await new Promise((resolve) => second.proc.on("exit", resolve));
    expect(code).toBe(1);
    expect(stderr.join("")).toContain("another supervisor");
    expect(stderr.join("")).not.toMatch(/\n\s+at /);
    expect(isPidAlive(proc.pid ?? 0)).toBe(true);
    expect(hub.readAgents().alice.status).not.toBe("stopped");
  }, 60000);

  it("leaves no agent behind when a later one fails to start", async () => {
    const missing = path.join(tmp, "no-such-dir");
    const { proc, hub } = startFleet("rollback", ["up", "--agent", "alice", "--agent", `bob:${missing}`]);
    const stderr: string[] = [];
    proc.stderr!.on("data", (d) => stderr.push(String(d)));
    const code = await new Promise((resolve) => proc.on("exit", resolve));
    expect(code).toBe(1);
    expect(stderr.join("")).toContain("cwd does not exist");
    expect(stderr.join("")).not.toMatch(/\n\s+at /);

    const alice = hub.readAgents().alice;
    await until("alice's bridge to go", async () => !(await bridgeListening(alice.pipeIn!)));
    expect(hub.readAgents().alice.status).toBe("stopped");
    expect(hub.supervisorAlive()).toBe(false);
  }, 60000);

  it("rejects typos at the terminal instead of sending them to agents", async () => {
    const { proc, hub } = startFleet("typos", ["up", "--agent", "alice"]);
    await idle(hub, ["alice"]);
    const banner = firstMatch(proc, /unknown command "\/stat"[\s\S]*no agent or channel "nosuch"/);
    proc.stdin!.write("/stat\n@nosuch hello\n");
    await banner;
    expect(hub.tailMessages(20).filter((m) => m.kind === "chat")).toHaveLength(0);
  }, 60000);

  it("reports a model that goes silent", async () => {
    const { hub } = startFleet("stall", ["serve", "--agent", "alice"], { PI_FLEET_STALL_MS: "1500" });
    await idle(hub, ["alice"]);
    hub.appendMessage({ from: "user", to: "alice", kind: "chat", text: "[[hang]]" });
    await until("the stall notice", () => hub.tailMessages(20).find((m) => m.text.includes('"alice" has had no answer from its model')));
    expect(hub.readAgents().alice.status).toBe("busy");
  }, 60000);

  it("routes a channel message without waking anyone it does not concern", async () => {
    const { hub } = startFleet("router", ["serve", "--agent", "alice", "--agent", "bob"]);
    await idle(hub, ["alice", "bob"]);
    hub.appendMessage({ from: "user", to: "group", kind: "chat", text: "for bob please route=bob" });
    await until("bob to get it", async () => (await llmLog()).find((r) => r.agent === "bob" && r.last.includes("for bob please")));
    await idle(hub, ["alice", "bob"]);
    const log = (await llmLog()).filter((r) => r.conversation.includes("for bob please"));
    expect(log.some((r) => r.agent === "alice")).toBe(false);
    expect(hub.tailMessages(20).some((m) => m.kind === "activity" && m.text === "routed to bob")).toBe(true);
    expect(hub.getChannel("group")?.summary).toContain("latest from user");
  }, 60000);

  it("still gets a message to someone when the router gives no usable answer", async () => {
    const { hub } = startFleet("routerfail", ["serve", "--agent", "alice", "--agent", "bob"]);
    await idle(hub, ["alice", "bob"]);
    hub.appendMessage({ from: "user", to: "group", kind: "chat", text: "[[router-garbage]] anyone?" });
    await until("the fallback notice", () => hub.tailMessages(20).find((m) => m.text.includes("the router gave no usable answer")));
    await until("a member to get it", async () => (await llmLog()).find((r) => r.agent !== "router" && r.conversation.includes("[[router-garbage]]")));
  }, 60000);

  it("resumes routing after a crash: what waited for the router is not lost", async () => {
    const hubDir = path.join(tmp, "routercrash");
    const first = startFleet("routercrash", ["up", "--agent", "alice"]);
    await idle(first.hub, ["alice"]);
    const { pid } = first.hub.readAgents().alice;
    crash(first.hub.otherSupervisor());
    crash(pid);
    await until("the supervisor to go", () => !isPidAlive(first.proc.pid ?? 0));
    first.hub.enqueueWake("router", JSON.stringify({ id: "x", ts: Date.now(), from: "user", to: "group", kind: "chat", text: "left waiting route=alice" }));
    expect(fs.existsSync(hubDir)).toBe(true);
    startFleet("routercrash", ["up", "--agent", "alice"]);
    await until("the waiting message to be routed", async () => (await llmLog()).find((r) => r.agent === "alice" && r.conversation.includes("left waiting")));
  }, 60000);

  describe("agents on one repository", () => {
    function makeRepo(name: string): string {
      const repo = path.join(tmp, name);
      fs.mkdirSync(repo, { recursive: true });
      const git = (...args: string[]) => execFileSync("git", args, { cwd: repo, stdio: "ignore" });
      git("init", "-b", "main");
      git("config", "user.name", "Test");
      git("config", "user.email", "test@example.com");
      fs.writeFileSync(path.join(repo, "README.md"), "hello\n");
      git("add", "-A");
      git("commit", "-m", "First");
      return repo;
    }
    const inRepo = (repo: string, ...args: string[]) => execFileSync("git", args, { cwd: repo, encoding: "utf8" });
    const crew = (repo: string) => ["--agent", `impl1:${repo}::implementer`, "--agent", `impl2:${repo}::implementer`, "--agent", `reviewer:${repo}::reviewer`, "--worktrees"];
    /** Requests sent together reach the reviewer in one wake, so count what it read, not its replies. */
    const reviewedBoth = (after: number) => async () => (await llmLog()).slice(after).some((r) => r.agent === "reviewer" && r.decision.startsWith("fleet_send") && r.conversation.includes("impl1 →") && r.conversation.includes("impl2 →"));

    it("two implementers change it at once, and both results merge after review", async () => {
      const repo = makeRepo("repo-both");
      const { hub, port, token } = await startGui("worktrees", crew(repo));
      await idle(hub, ["impl1", "impl2", "reviewer"]);
      const { impl1, impl2, reviewer } = hub.readAgents();
      expect(impl1.worktree?.branch).toBe("fleet/impl1");
      expect(impl1.cwd).not.toBe(impl2.cwd);
      expect(reviewer.worktree).toBeUndefined();

      const before = (await llmLog()).length;
      hub.appendMessage({ from: "user", to: "impl1", kind: "chat", text: "[[write one.txt from one]]" });
      hub.appendMessage({ from: "user", to: "impl2", kind: "chat", text: "[[write two.txt from two]]" });
      await until("both reviews", reviewedBoth(before), 45000);
      await idle(hub, ["impl1", "impl2", "reviewer"]);
      expect(fs.existsSync(path.join(impl1.cwd, "one.txt"))).toBe(true);
      expect(fs.existsSync(path.join(impl1.cwd, "two.txt"))).toBe(false);
      expect(fs.existsSync(path.join(repo, "one.txt"))).toBe(false); // nothing lands before the merge

      const diff = await (await fetch(`http://127.0.0.1:${port}/diff?agent=impl1`, { headers: { Authorization: `Bearer ${token}` } })).json();
      expect(diff.result).toMatchObject({ branch: "fleet/impl1", base: "main", files: ["one.txt"] });
      expect(diff.result.patch).toContain("+from one");

      for (const name of ["impl1", "impl2"]) {
        expect((await (await guiPost(port, token, "/merge", { name })).json()).result).toEqual({ merged: true, conflicts: [] });
      }
      expect(fs.readFileSync(path.join(repo, "one.txt"), "utf8")).toBe("from one");
      expect(fs.readFileSync(path.join(repo, "two.txt"), "utf8")).toBe("from two");
      expect(inRepo(repo, "log", "--oneline")).toContain("Merge fleet/impl2");
      expect(hub.tailMessages(50).some((m) => m.text === "fleet/impl1 was merged into main")).toBe(true);

      const timeline = (await (await fetch(`http://127.0.0.1:${port}/timeline`, { headers: { Authorization: `Bearer ${token}` } })).json()).result;
      expect(timeline.length).toBeGreaterThanOrEqual(2);
      expect(timeline.some((t: { steps: { why: string }[] }) => t.steps.some((s) => s.why === "mention"))).toBe(true);
      expect(timeline[0].cost).toBeTypeOf("number");
      const told = (await llmLog()).slice(before).find((r) => r.agent === "impl1");
      expect(told?.conversation).toContain("on branch fleet/impl1");
    }, 90000);

    it("a conflict goes back to the agent, who resolves it, and the merge then succeeds", async () => {
      const repo = makeRepo("repo-conflict");
      const { hub, port, token } = await startGui("conflict", crew(repo));
      await idle(hub, ["impl1", "impl2", "reviewer"]);
      const before = (await llmLog()).length;
      hub.appendMessage({ from: "user", to: "impl1", kind: "chat", text: "[[write same.txt from one]]" });
      hub.appendMessage({ from: "user", to: "impl2", kind: "chat", text: "[[write same.txt from two]]" });
      await until("both reviews", reviewedBoth(before), 45000);
      await idle(hub, ["impl1", "impl2", "reviewer"]);

      await guiPost(port, token, "/merge", { name: "impl1" });
      const clash = (await (await guiPost(port, token, "/merge", { name: "impl2" })).json()).result;
      expect(clash).toEqual({ merged: false, conflicts: ["same.txt"] });
      expect(inRepo(repo, "status", "--porcelain")).toBe(""); // the failed merge left nothing behind
      expect(fs.readFileSync(path.join(repo, "same.txt"), "utf8")).toBe("from one");

      await until("the agent to resolve it", async () => (await llmLog()).find((r) => r.agent === "impl2" && r.decision.startsWith("bash")));
      await sleep(500);
      await idle(hub, ["impl2"]);
      expect((await (await guiPost(port, token, "/merge", { name: "impl2" })).json()).result).toEqual({ merged: true, conflicts: [] });
    }, 90000);

    it("keeps its worktree and subfolder across a restart", async () => {
      const repo = makeRepo("repo-restart");
      const sub = path.join(repo, "packages", "a");
      fs.mkdirSync(sub, { recursive: true });
      const { proc, hub } = startFleet("wt-restart", ["up", "--agent", `impl1:${sub}::implementer`, "--worktrees"]);
      await idle(hub, ["impl1"]);
      const first = hub.readAgents().impl1.cwd;
      expect(first).toMatch(/worktrees[\\/]impl1[\\/]packages[\\/]a[\\/]?$/);
      const restarted = firstMatch(proc, /↻ \[impl1\] restarted/);
      proc.stdin!.write("/restart impl1\n");
      await restarted;
      await idle(hub, ["impl1"]);
      expect(hub.readAgents().impl1.cwd).toBe(first);
      expect(hub.readAgents().impl1.worktree?.branch).toBe("fleet/impl1");
    }, 60000);

    it("works from the terminal too", async () => {
      const repo = makeRepo("repo-terminal");
      const { proc, hub } = startFleet("wt-terminal", ["up", "--agent", `impl1:${repo}::implementer`, "--agent", `reviewer:${repo}::reviewer`, "--worktrees"]);
      await idle(hub, ["impl1", "reviewer"]);
      const before = (await llmLog()).length;
      hub.appendMessage({ from: "user", to: "impl1", kind: "chat", text: "[[write term.txt from the terminal]]" });
      await until("the file", async () => (await llmLog()).slice(before).some((r) => r.agent === "impl1" && r.decision === "text"), 30000);
      await idle(hub, ["impl1"]);
      const listed = firstMatch(proc, /fleet\/impl1 changes, against main:\s+term\.txt/);
      proc.stdin!.write("/diff impl1\n");
      await listed;
      const merged = firstMatch(proc, /^\s*merged\s*$/m);
      proc.stdin!.write("/merge impl1\n");
      await merged;
      expect(fs.readFileSync(path.join(repo, "term.txt"), "utf8")).toBe("from the terminal");
    }, 60000);

    it("will not merge while the agent is working", async () => {
      const repo = makeRepo("repo-busy");
      const { hub, port, token } = await startGui("wt-busy", ["--agent", `impl1:${repo}::implementer`, "--worktrees"]);
      await idle(hub, ["impl1"]);
      hub.appendMessage({ from: "user", to: "impl1", kind: "chat", text: "[[slow 3]]" });
      await until("impl1 to start", () => hub.readAgents().impl1.status === "busy");
      expect(await (await guiPost(port, token, "/merge", { name: "impl1" })).json()).toMatchObject({ ok: false, error: '"impl1" is still working: merge when it has finished' });
    }, 60000);

    it("says so at once when the repository cannot be branched", async () => {
      const empty = path.join(tmp, "repo-empty");
      fs.mkdirSync(empty, { recursive: true });
      execFileSync("git", ["init"], { cwd: empty, stdio: "ignore" });
      const { proc } = startFleet("wt-empty", ["up", "--agent", `impl1:${empty}::implementer`, "--worktrees"]);
      const stderr: string[] = [];
      proc.stderr!.on("data", (d) => stderr.push(String(d)));
      await new Promise((resolve) => proc.on("exit", resolve));
      expect(stderr.join("")).toContain("has no commits yet");
    }, 30000);

    it("runs in place when the folder is not a git repository, and says so", async () => {
      const plain = path.join(tmp, "not-a-repo");
      fs.mkdirSync(plain, { recursive: true });
      const { proc, hub } = startFleet("no-repo", ["up", "--agent", `impl1:${plain}::implementer`, "--worktrees"]);
      await firstMatch(proc, /is not a git repository, so it works in place/);
      await idle(hub, ["impl1"]);
      expect(hub.readAgents().impl1.worktree).toBeUndefined();
    }, 60000);
  });

  it("keeps the GUI's key out of what an agent can see", async () => {
    env.PI_FLEET_GUI_TOKEN = "the-gui-key";
    try {
      const { hub } = startFleet("no-key", ["up", "--agent", "alice"]);
      await idle(hub, ["alice"]);
      await exchange(hub, "alice", '[[run node -p "process.env.PI_FLEET_GUI_TOKEN ?? String(process.env.PATH).length"]]');
      await until("the command's answer", async () => (await llmLog()).find((r) => r.agent === "alice" && r.last.match(/^\d+/)));
      expect((await llmLog()).filter((r) => r.agent === "alice").some((r) => r.conversation.includes("the-gui-key"))).toBe(false);
    } finally {
      delete env.PI_FLEET_GUI_TOKEN;
    }
  }, 60000);

  it("does not let a message rewrite the terminal", async () => {
    const { proc, hub } = startFleet("escapes", ["up", "--agent", "alice"]);
    await idle(hub, ["alice"]);
    let printed = "";
    proc.stdout!.on("data", (d) => (printed += d));
    hub.appendMessage({ from: "user", to: "alice", kind: "chat", text: "\x1b]0;retitled\x07 marked message" });
    await until("the message", () => printed.includes("marked message"));
    expect(printed).not.toContain("\x1b]0;");
  }, 60000);

  it.skipIf(process.platform === "win32")("takes its agents with it when it is told to stop", async () => {
    const { proc, hub } = startFleet("sigterm", ["up", "--agent", "alice"]);
    await idle(hub, ["alice"]);
    const { pid } = hub.readAgents().alice;
    proc.kill("SIGTERM");
    await until("the agent to stop", () => !isPidAlive(pid));
    expect(hub.readAgents().alice.status).toBe("stopped");
  }, 60000);

  describe("a model that cannot be reached", () => {
    it("says so in the channel, and where to look", async () => {
      const { hub } = startFleet("dead-agent", ["up", "--agent", `alice::${DEAD_MODEL}`], { PI_FLEET_RETRY_WAITS: "" });
      await idle(hub, ["alice"]);
      hub.appendMessage({ from: "user", to: "alice", kind: "chat", text: "are you there" });
      const notice = await until("the notice", () => hub.tailMessages(20).find((m) => m.text.includes("stopped on a model error")));
      expect(notice.text).toBe('agent "alice" stopped on a model error: Connection error. Test the model in Settings → Models, or with fleet doctor.');
    }, 60000);

    it("has the router say why it could not decide, without waiting out pi's retries", async () => {
      const { hub } = startFleet("dead-router", ["up", "--agent", "alice", "--agent", "bob", "--router-model", DEAD_MODEL]);
      await idle(hub, ["alice", "bob"]);
      const started = Date.now();
      hub.appendMessage({ from: "user", to: "group", kind: "chat", text: "anyone there" });
      const notice = await until("the notice", () => hub.tailMessages(20).find((m) => m.text.startsWith("the router")));
      expect(notice.text).toContain("could not reach its model (Connection error)");
      expect(Date.now() - started).toBeLessThan(10000); // pi alone would retry for about 15 s
    }, 60000);

    it("fails fleet doctor, which used to pass as long as pi knew the name", () => {
      const hubDir = path.join(tmp, "doctor-dead");
      fs.mkdirSync(hubDir, { recursive: true });
      fs.writeFileSync(path.join(hubDir, "fleet.json"), JSON.stringify({ defaultModel: DEAD_MODEL, agents: [] }));
      const down = spawnSync(process.execPath, [TSX, FLEET, "doctor", "--dir", hubDir], { env, encoding: "utf8", timeout: 60000 });
      expect(down.status).toBe(1);
      expect(down.stdout).toContain(`${DEAD_MODEL} does not answer: Connection error`);
      fs.writeFileSync(path.join(hubDir, "fleet.json"), JSON.stringify({ defaultModel: MODEL, agents: [] }));
      const up = spawnSync(process.execPath, [TSX, FLEET, "doctor", "--dir", hubDir], { env, encoding: "utf8", timeout: 60000 });
      expect(up.status).toBe(0);
      expect(up.stdout).toContain(`${MODEL} answers and uses tools`);
      fs.writeFileSync(path.join(hubDir, "fleet.json"), JSON.stringify({ defaultModel: NO_TOOLS_MODEL, agents: [] }));
      const noTools = spawnSync(process.execPath, [TSX, FLEET, "doctor", "--dir", hubDir], { env, encoding: "utf8", timeout: 60000 });
      expect(noTools.status).toBe(0);
      expect(noTools.stdout).toMatch(new RegExp(`warn\\s+model\\s+${NO_TOOLS_MODEL} answers but did not use a tool`));
      expect(fs.readdirSync(hubDir).filter((f) => f.startsWith("model-test"))).toEqual([]);
    }, 90000);

    it("does not call a model tool-less over a failure that has nothing to do with tools", () => {
      const hubDir = path.join(tmp, "doctor-tools");
      fs.mkdirSync(hubDir, { recursive: true });
      const doctor = (model: string) => {
        fs.writeFileSync(path.join(hubDir, "fleet.json"), JSON.stringify({ defaultModel: model, agents: [] }));
        return spawnSync(process.execPath, [TSX, FLEET, "doctor", "--dir", hubDir], { env, encoding: "utf8", timeout: 60000 }).stdout;
      };
      expect(doctor("fake/tool-refused")).toContain("answers but did not use a tool");
      const cutOff = doctor("fake/cut-off");
      expect(cutOff).toContain("fake/cut-off answers (");
      expect(cutOff).not.toContain("did not use a tool");
      expect(cutOff).not.toContain("uses tools");
    }, 90000);
  });

  it("gives agents the task board fleet.json names", async () => {
    const hubDir = path.join(tmp, "board-config");
    fs.mkdirSync(hubDir, { recursive: true });
    fs.writeFileSync(path.join(hubDir, "fleet.json"), JSON.stringify({ taskboard: "beads", agents: [{ name: "bea" }] }));
    const { hub } = startFleet("board-config", ["up"]);
    await idle(hub, ["bea"]);
    const asked = await exchange(hub, "bea", "which board");
    expect(asked.conversation).toContain("beads");
    expect(asked.conversation).not.toContain("openspec");
  }, 60000);

  it("still takes the task board from the environment", async () => {
    env.PI_FLEET_TASKBOARD = "beads";
    try {
      const { hub } = startFleet("board-env", ["up", "--agent", "ben"]);
      await idle(hub, ["ben"]);
      expect((await exchange(hub, "ben", "which board now")).conversation).toContain("beads");
    } finally {
      delete env.PI_FLEET_TASKBOARD;
    }
  }, 60000);

  it("reads the task board for the GUI", async () => {
    const { hub, port, token } = await startGui("board", ["--agent", "alice"]);
    await idle(hub, ["alice"]);
    const res = await fetch(`http://127.0.0.1:${port}/tasks`, { headers: { Authorization: `Bearer ${token}` } });
    expect(await res.json()).toEqual({ ok: true, result: [] }); // no board in this project yet, which is not an error
  }, 60000);

  describe("a hub from an earlier release", () => {
    const fixtures = path.join(ROOT, "test", "fixtures", "hubs");

    it.each(fs.readdirSync(fixtures))("opens one written by %s and carries on", async (tag) => {
      fs.cpSync(path.join(fixtures, tag), path.join(tmp, `upgrade-${tag}`), { recursive: true });
      const before = (await llmLog()).length;
      const { proc, hub } = startFleet(`upgrade-${tag}`, ["up", "--agent", "alice", "--agent", "bob"]);
      await firstMatch(proc, /hub upgraded from format 0 to 1[\s\S]*pi-fleet group chat/); // the old registry already says idle
      expect(readHubFormat(hub.dir)).toBe(HUB_FORMAT);
      expect(hub.pausedReason()).toBe(tag === "v0.6.0" ? null : "stopped by you");
      expect(hub.readChannels().find((c) => c.name === "group")?.supervisor).toBeUndefined();
      expect(hub.searchMessages("hello from an old release")).toHaveLength(1); // rotated into an archive by that release

      await exchange(hub, "alice", `still there after ${tag}`);
      await idle(hub, ["alice", "bob"]);
      expect(hub.pausedReason()).toBeNull();
      const log = (await llmLog()).slice(before);
      expect(log.some((r) => r.conversation.includes("after the rotation"))).toBe(false); // nothing is replayed
    }, 60000);

    it("refuses one from a newer release", async () => {
      const hubDir = path.join(tmp, "from-the-future");
      fs.mkdirSync(hubDir, { recursive: true });
      fs.writeFileSync(path.join(hubDir, "format.json"), JSON.stringify({ format: HUB_FORMAT + 1 }));
      const { proc } = startFleet("from-the-future", ["up", "--agent", "alice"]);
      const stderr: string[] = [];
      proc.stderr!.on("data", (d) => stderr.push(String(d)));
      const code = await new Promise((resolve) => proc.on("exit", resolve));
      expect(code).toBe(1);
      expect(stderr.join("")).toContain("written by a newer pi-fleet");
    }, 30000);
  });

  it("reports a run that ends in a model error", async () => {
    const { hub } = startFleet("modelerror", ["serve", "--agent", "alice"]);
    await idle(hub, ["alice"]);
    hub.appendMessage({ from: "user", to: "alice", kind: "chat", text: "[[fail]]" });
    await until("the error notice", () => hub.tailMessages(20).find((m) => m.text.includes('agent "alice" stopped on a model error')), 45000);
    expect(hub.tailMessages(20).filter((m) => m.text.includes("tries again"))).toEqual([]); // a bad request stays bad
  }, 60000);

  describe("a model that is away for a while", () => {
    /** pi's own retries are over at once here, so that a test reaches the fleet's. */
    function away(waits: string): NodeJS.ProcessEnv {
      const agentDir = path.join(tmp, "quick-retries");
      fs.mkdirSync(agentDir, { recursive: true });
      fs.copyFileSync(path.join(env.PI_CODING_AGENT_DIR!, "models.json"), path.join(agentDir, "models.json"));
      fs.writeFileSync(path.join(agentDir, "settings.json"), JSON.stringify({ retry: { baseDelayMs: 20 } }));
      return { PI_CODING_AGENT_DIR: agentDir, PI_FLEET_RETRY_WAITS: waits };
    }

    const notices = (hub: Hub, text: string) => hub.tailMessages(50).filter((m) => m.text.includes(text));
    const pickedUp = (name: string) => async () => (await llmLog()).filter((r) => r.agent === name && r.last.includes("Your model failed") && r.decision === "text");

    it("tries again by itself, and the work carries on", async () => {
      const { hub } = startFleet("away-back", ["serve", "--agent", "wobbly"], away("400,400"));
      await idle(hub, ["wobbly"]);
      hub.appendMessage({ from: "user", to: "wobbly", kind: "chat", text: "[[flaky 4]] the job" });
      await until("the notice", () => notices(hub, 'agent "wobbly" got a model error'));
      await until("it to carry on", async () => (await pickedUp("wobbly")()).length > 0);
      await sleep(300);
      await idle(hub, ["wobbly"]);
      expect(notices(hub, "stopped on a model error")).toEqual([]);
    }, 60000);

    it("gives up with the usual notice once the tries are spent", async () => {
      const { hub } = startFleet("away-gone", ["serve", "--agent", "doomed"], away("100,100"));
      await idle(hub, ["doomed"]);
      hub.appendMessage({ from: "user", to: "doomed", kind: "chat", text: "[[flaky 999]] the job" });
      await until("the last word", () => notices(hub, 'agent "doomed" stopped on a model error').length > 0);
      expect(notices(hub, "It tries again")).toHaveLength(2);
      await expectQuiet();
    }, 60000);

    it("a wake takes the place of the retry, and nothing runs twice", async () => {
      const { hub } = startFleet("away-wake", ["serve", "--agent", "woken"], away("2500"));
      await idle(hub, ["woken"]);
      hub.appendMessage({ from: "user", to: "woken", kind: "chat", text: "[[flaky 4]] the job" });
      await until("the notice", () => notices(hub, 'agent "woken" got a model error').length > 0);
      hub.appendMessage({ from: "planner", to: "woken", kind: "chat", text: "how is it going?" }); // not a person: they cancel it anyway
      await until("the new message to be answered", async () => (await llmLog()).find((r) => r.agent === "woken" && r.last.includes("how is it going") && r.decision === "text"));
      await sleep(3500);
      expect(await pickedUp("woken")()).toEqual([]);
      expect(hub.tailMessages(50).filter((m) => m.to === "woken" && m.from === "system")).toEqual([]);
    }, 60000);

    it("Stop all cancels a waiting retry", async () => {
      const { hub, port, token } = await startGui("away-stop", ["--agent", "halted"], away("2500"));
      await idle(hub, ["halted"]);
      hub.appendMessage({ from: "user", to: "halted", kind: "chat", text: "[[flaky 4]] the job" });
      await until("the notice", () => notices(hub, 'agent "halted" got a model error').length > 0);
      await guiPost(port, token, "/stop-all", {});
      await until("the last word", () => notices(hub, 'agent "halted" stopped on a model error').length > 0);
      await sleep(500);
      expect(hub.tailMessages(50).filter((m) => m.to === "halted" && m.from === "system")).toEqual([]);
    }, 60000);

    it("delivers the retry through the inbox, so a crash in that run does not lose it", async () => {
      const { hub } = startFleet("away-inbox", ["serve", "--agent", "kept"], away("200"));
      await idle(hub, ["kept"]);
      hub.appendMessage({ from: "user", to: "kept", kind: "chat", text: "[[flaky 4]] the job" });
      await until("the retry", async () => (await pickedUp("kept")()).length > 0);
      const retry = (await pickedUp("kept")())[0];
      expect(retry.last).toContain("New fleet messages for you");
      expect(retry.conversation).toContain("the job"); // it still has the work in front of it
    }, 60000);
  });

  it("honours lean in fleet.json", async () => {
    const hubDir = path.join(tmp, "lean");
    fs.mkdirSync(hubDir, { recursive: true });
    fs.writeFileSync(path.join(hubDir, "fleet.json"), JSON.stringify({ agents: [{ name: "small", lean: true }, { name: "big" }] }));
    const { hub } = startFleet("lean", ["serve"]);
    await idle(hub, ["small", "big"]);
    hub.appendMessage({ from: "user", to: "small", kind: "chat", text: "hello small" });
    hub.appendMessage({ from: "user", to: "big", kind: "chat", text: "hello big" });
    const asked = async (agent: string) => (await llmLog()).find((r) => r.agent === agent);
    const small = await until("small to be asked", () => asked("small"));
    const big = await until("big to be asked", () => asked("big"));
    expect(small.conversation).toContain('Fleet (you are "small")');
    expect(big.conversation).not.toContain('Fleet (you are "big")');
  }, 60000);

  it("lets a person answer an agent's question from the GUI", async () => {
    const hubDir = path.join(tmp, "ask");
    fs.mkdirSync(hubDir, { recursive: true });
    const extensions = [path.join(ROOT, "test", "ask-extension.ts")];
    fs.writeFileSync(path.join(hubDir, "fleet.json"), JSON.stringify({ agents: [{ name: "alice", extensions }] }));
    const { hub, port, token } = await startGui("ask", []);
    await idle(hub, ["alice"]);
    hub.appendMessage({ from: "user", to: "alice", kind: "chat", text: "[[ask]]" });

    const question = await until("the question to reach the GUI", async () => (await snapshot(port, token)).questions[0]);
    expect(question).toMatchObject({ agent: "alice", method: "select", title: "Which colour?", options: ["red", "green"] });
    await until("alice to show as waiting", () => hub.readAgents().alice.status === "waiting");
    expect(hub.tailMessages(20).some((m) => m.text.includes('agent "alice" is waiting for you: Which colour?'))).toBe(true);

    expect((await guiPost(port, token, "/answer", { id: question.id, value: "green" })).status).toBe(200);
    await until("the agent to get the answer", async () => (await llmLog()).find((r) => r.agent === "alice" && r.conversation.includes("the human chose green")));
    await until("the question to clear", async () => (await snapshot(port, token)).questions.length === 0);
    await idle(hub, ["alice"]);
  }, 60000);

  it("puts an ask_user questionnaire pi cannot draw in front of the person", async () => {
    const hubDir = path.join(tmp, "ask-user");
    fs.mkdirSync(hubDir, { recursive: true });
    const extensions = [path.join(ROOT, "test", "ask-extension.ts")];
    fs.writeFileSync(path.join(hubDir, "fleet.json"), JSON.stringify({ agents: [{ name: "alice", extensions }] }));
    const { hub, port, token } = await startGui("ask-user", []);
    await idle(hub, ["alice"]);
    hub.appendMessage({ from: "user", to: "alice", kind: "chat", text: "[[ask-user]]" });

    const first = await until("the first question", async () => (await snapshot(port, token)).questions[0]);
    expect(first).toMatchObject({ agent: "alice", method: "select", title: "Next work: Which direction should we start on next?" });
    expect(first.options).toEqual([
      "Prompt caching — Most tokens are context sent again each turn.",
      "Extensions marketplace — Browse and install pi extensions from the GUI.",
      "Answer in my own words",
    ]);
    await guiPost(port, token, "/answer", { id: first.id, value: first.options[1] });

    const second = await until("the second question", async () => (await snapshot(port, token)).questions.find((q: { id: string }) => q.id !== first.id));
    expect(second).toMatchObject({ method: "input" });
    expect(second.title).toContain("1. GUI\n2. CLI\n3. Config");
    await guiPost(port, token, "/answer", { id: second.id, value: "3, gui" });

    const told = 'User answered: "Which direction should we start on next?"="Extensions marketplace". "Which parts need docs?"="Config, GUI".';
    await until("the agent to get both answers", async () => (await llmLog()).find((r) => r.agent === "alice" && r.conversation.includes(told)));
    await idle(hub, ["alice"]);
  }, 60000);

  it("makes approved tools wait for a person, and blocks what a person declines", async () => {
    const { hub, port, token } = await startGui("approve", ["--agent", "alice", "--approve", "fleet_agents"]);
    await idle(hub, ["alice"]);
    hub.appendMessage({ from: "user", to: "alice", kind: "chat", text: "[[guarded]]" });
    const question = await until("the approval request", async () => (await snapshot(port, token)).questions[0]);
    expect(question).toMatchObject({ method: "confirm", title: "Allow fleet_agents?" });

    await guiPost(port, token, "/answer", { id: question.id, confirmed: false });
    const after = await until("the tool to be blocked", async () => (await llmLog()).find((r) => r.agent === "alice" && r.conversation.includes("A person declined this tool call")));
    expect(after.conversation).not.toContain("alice [");
  }, 60000);

  it("shows real token counts and pauses at the spending limit", async () => {
    const { hub, port, token } = await startGui("budget", ["--agent", "alice", "--max-cost", "0.001"]);
    await idle(hub, ["alice"]);
    hub.appendMessage({ from: "user", to: "alice", kind: "chat", text: "hello there" });
    await until("the budget pause", () => hub.pausedReason()?.includes("spending limit reached"));
    const stats = hub.readStats().alice as { cost: number; tokens: { total: number } };
    expect(stats.tokens.total).toBeGreaterThan(100);
    expect(stats.cost).toBeGreaterThanOrEqual(0.001);
    expect((await snapshot(port, token)).stats.alice.tokens.total).toBe(stats.tokens.total);

    expect((await guiPost(port, token, "/budget", { dollars: 50 })).status).toBe(200);
    hub.appendMessage({ from: "user", to: "alice", kind: "chat", text: "keep going" });
    await until("the run after raising the limit", async () => (await llmLog()).find((r) => r.agent === "alice" && r.last.includes("keep going")));
    await idle(hub, ["alice"]);
    expect(hub.pausedReason()).toBeNull();
  }, 60000);

  it("delivers held messages on request, so a chain continues where it stopped", async () => {
    const { hub, port, token } = await startGui("held", ["--agent", "alice", "--agent", "bob", "--max-hops", "4"]);
    await idle(hub, ["alice", "bob"]);
    hub.appendMessage({ from: "user", to: "alice", kind: "chat", text: "[[pingpong alice bob]] go" });
    await until("the pause", () => hub.pausedReason());
    await until("a held message", async () => (await snapshot(port, token)).held > 0);
    await idle(hub, ["alice", "bob"]);
    const before = (await llmLog()).length;

    const res = await guiPost(port, token, "/resume", {});
    expect((await res.json()).delivered).toBeGreaterThan(0);
    await until("the chain to continue", async () => (await llmLog()).length > before);
    await until("the next pause", () => hub.pausedReason());
    const messages = hub.tailMessages(200);
    const resumedAt = messages.findIndex((m) => m.kind === "activity" && m.text === "resumed");
    const after = messages.slice(resumedAt).filter((m) => m.kind === "chat");
    expect(after.length).toBeGreaterThanOrEqual(3); // the hop count restarted, so the chain got a full run
  }, 60000);

  it("pauses a ping-pong at the hop limit, and the human restarts the fleet", async () => {
    const { hub } = startFleet("hops", ["serve", "--agent", "alice", "--agent", "bob", "--max-hops", "4"]);
    await idle(hub, ["alice", "bob"]);
    hub.appendMessage({ from: "user", to: "alice", kind: "chat", text: "[[pingpong alice bob]] go" });

    await until("the pause", () => hub.pausedReason());
    await expectQuiet();
    expect(hub.tailMessages(50).filter((m) => m.text.startsWith("fleet paused"))).toHaveLength(1);

    hub.appendMessage({ from: "user", to: "bob", kind: "chat", text: "back to work" });
    await until("the human to get through", async () => (await llmLog()).find((r) => r.agent === "bob" && r.last.includes("back to work")));
    expect(hub.pausedReason()).toBeNull();
  }, 60000);

  it("holds the hop limit when detached, with nobody watching", async () => {
    const { proc, hub } = startFleet("detached-hops", ["up", "--agent", "alice", "--agent", "bob", "--detach", "--max-hops", "4"]);
    await idle(hub, ["alice", "bob"]);
    proc.stdin!.write("/quit\n");
    await until("the supervisor to detach", () => !hub.supervisorAlive());

    hub.appendMessage({ from: "user", to: "alice", kind: "chat", text: "[[pingpong alice bob]] go" });
    await until("the pause", () => hub.pausedReason());
    await expectQuiet();
  }, 60000);

  describe("a crew that stops before the work is done", () => {
    const QUIET = { PI_FLEET_QUIET_MS: "1500" };
    const checksOf = async (job: string) => (await llmLog()).filter((r) => r.agent === "watcher" && r.last.includes(job));
    const notices = (hub: Hub, text: string) => hub.tailMessages(100).filter((m) => m.from === "system" && m.text.includes(text));
    const fromTheRouter = (hub: Hub) => hub.tailMessages(100).filter((m) => m.from === "router" && m.kind === "chat" && m.text.startsWith("The team has gone quiet"));

    async function crew(name: string, extra: NodeJS.ProcessEnv = QUIET): Promise<Hub> {
      const { proc, hub } = startFleet(name, ["serve", "--template", "sdlc"], extra);
      await firstMatch(proc, /GUI: http/);
      await idle(hub, ["planner", "implementer", "reviewer"]);
      return hub;
    }

    const ask = (hub: Hub, text: string) => hub.appendMessage({ from: "user", to: "group", kind: "chat", text });

    it("sends the one who must act back to work, and the chain carries on", async () => {
      const hub = await crew("stalled");
      ask(hub, "job-stalled route=implementer [[stalled implementer]] [[say I will start on it now.]]");
      await until("the reminder", () => notices(hub, "the router asked implementer to carry on (1 of 2)")[0]);
      await until("the file", () => fs.existsSync(path.join(tmp, "nudged.txt")));
      await until("the verdict", () => hub.tailMessages(100).find((m) => m.from === "reviewer" && m.text === "APPROVE"));
      await sleep(1500 + 1500);
      const checks = await checksOf("job-stalled");
      expect(checks).toHaveLength(1);
      expect(checks[0].last).toContain("implementer (implementer): none");
      expect(fromTheRouter(hub)).toHaveLength(1);
    }, 60000);

    it("tells the person when reminders do not help, and then leaves the crew alone", async () => {
      const hub = await crew("hopeless");
      ask(hub, "job-hopeless route=implementer [[stalled implementer hopeless]] [[say I will start on it now.]]");
      await until("the notice", () => notices(hub, "the crew has stopped with the work unfinished")[0], 45000);
      await expectQuiet();
      expect(await checksOf("job-hopeless")).toHaveLength(3);
      expect(fromTheRouter(hub)).toHaveLength(2);
      expect(notices(hub, "try a stronger model")).toHaveLength(1);
    }, 90000);

    it("says nothing when the router sees that the job is done", async () => {
      const hub = await crew("answered");
      ask(hub, "job-answered route=planner [[say It has three modules.]]");
      await until("the check", async () => (await checksOf("job-answered")).length === 1);
      await sleep(1500 + 1500);
      expect(await checksOf("job-answered")).toHaveLength(1);
      expect(fromTheRouter(hub)).toEqual([]);
      expect(notices(hub, "the crew")).toEqual([]);
    }, 60000);

    it("has nothing to ask when the crew finished with a real approval", async () => {
      const hub = await crew("approved");
      ask(hub, "job-approved route=implementer [[write approved.txt done]]");
      await until("the verdict", () => hub.tailMessages(100).find((m) => m.from === "reviewer" && m.text === "APPROVE"));
      await sleep(1500 + 1500);
      expect(await checksOf("job-approved")).toEqual([]);
    }, 60000);

    it("still looks when an approval has nothing behind it", async () => {
      const hub = await crew("empty-approval");
      ask(hub, "job-empty route=reviewer please approve");
      await until("the verdict", () => hub.tailMessages(100).find((m) => m.from === "reviewer" && m.text === "APPROVE"));
      await until("the check", async () => (await checksOf("job-empty")).length === 1);
    }, 60000);

    it("has nothing to ask when nobody was woken", async () => {
      const hub = await crew("unrouted");
      ask(hub, "job-unrouted route=nobody-here");
      await until("the routing", () => hub.tailMessages(20).find((m) => m.kind === "activity" && m.text === "routed to nobody"));
      await sleep(1500 + 1500);
      expect(await checksOf("job-unrouted")).toEqual([]);
    }, 60000);

    it("leaves the crew alone after Stop all", async () => {
      const hub = await crew("stopped-crew");
      ask(hub, "job-stopped route=planner [[say It has three modules.]]");
      await until("the planner to answer", async () => (await llmLog()).find((r) => r.agent === "planner" && r.last.includes("job-stopped")));
      hub.pause("stopped by you");
      await sleep(1500 + 1500);
      expect(await checksOf("job-stopped")).toEqual([]);
    }, 60000);

    it("waits for a run in progress", async () => {
      const hub = await crew("long-run");
      ask(hub, "job-long route=planner [[slow 6]]");
      await until("the run", async () => (await llmLog()).find((r) => r.agent === "planner" && r.last.includes("job-long")));
      await sleep(4000);
      expect(await checksOf("job-long")).toEqual([]);
      await idle(hub, ["planner"]);
      const settled = Date.now();
      await until("the check after the run", async () => (await checksOf("job-long")).length === 1);
      expect(Date.now() - settled).toBeGreaterThan(1000); // a quiet spell of its own
    }, 60000);

    it("waits for a run a person started directly, which no inbox shows", async () => {
      const { hub, port, token } = await startGui("direct-run", ["--template", "sdlc"], QUIET);
      await idle(hub, ["planner", "implementer", "reviewer"]);
      ask(hub, "job-direct route=planner [[say Noted.]]");
      await until("the planner to answer", async () => (await llmLog()).find((r) => r.agent === "planner" && r.last.includes("job-direct")));
      await sleep(300);
      await idle(hub, ["planner"]);
      await guiPost(port, token, "/rpc", { agent: "planner", command: "prompt", payload: { message: "[[slow 6]]" } });
      await sleep(4000);
      expect(await checksOf("job-direct")).toEqual([]);
    }, 60000);

    it("waits for the router to finish with a message", async () => {
      const hub = await crew("slow-router");
      ask(hub, "job-routing [[router-slow 6]] [[say Noted.]]");
      await until("the router", async () => (await llmLog()).find((r) => r.agent === "router" && r.last.includes("job-routing")));
      await sleep(4000);
      expect(await checksOf("job-routing")).toEqual([]);
      await until("the check after the work it went to", async () => (await checksOf("job-routing")).length === 1);
    }, 60000);

    it("drops what it was asking when a person writes meanwhile", async () => {
      const hub = await crew("overtaken");
      ask(hub, "job-first route=planner [[watcher-slow 4]] [[say Noted.]]");
      await until("the first check", async () => (await checksOf("job-first")).length === 1);
      ask(hub, "job-second route=planner [[say Noted again.]]");
      await until("a check of the new job", async () => (await checksOf("job-second")).length === 1);
    }, 60000);

    it("tells a person when the router cannot say if the crew has finished", async () => {
      const hub = await crew("no-answer");
      ask(hub, "job-silent route=planner [[watcher-fail 9]] [[say Noted.]]");
      await until("the first check", async () => (await checksOf("job-silent")).length === 1);
      const first = Date.now();
      await until("the notice", () => notices(hub, "so it cannot tell if the crew has finished")[0]);
      expect(Date.now() - first).toBeGreaterThan(2500); // a quiet spell before each try: a busy model needs the time
      expect(notices(hub, "so it cannot tell if the crew has finished")[0].text).toMatch(/could not reach its model (.*Rate limited upstream)/);
      expect(await checksOf("job-silent")).toHaveLength(3);
      await sleep(2500);
      expect(await checksOf("job-silent")).toHaveLength(3); // that was the last try
    }, 60000);

    it("says so too when the router's answer makes no sense", async () => {
      const hub = await crew("nonsense");
      ask(hub, "job-nonsense route=planner [[watcher-garbage]] [[say Noted.]]");
      await until("the notice", () => notices(hub, "gave no usable answer, so it cannot tell")[0]);
    }, 60000);

    it("asks again when the router's model was busy", async () => {
      const hub = await crew("busy");
      ask(hub, "job-busy route=planner [[stalled implementer]] [[watcher-fail 1]] [[say Noted.]]");
      await until("the reminder", () => notices(hub, "the router asked implementer to carry on")[0]);
      expect(notices(hub, "so it cannot tell")).toEqual([]);
    }, 60000);

    it("does not count a write it refused as work done", async () => {
      const hub = await crew("refused-write");
      ask(hub, "job-refused route=planner [[write ../outside.txt done]]");
      await until("the check", async () => (await checksOf("job-refused")).length === 1);
      const used = (await checksOf("job-refused"))[0].last.split("\n").find((line: string) => line.startsWith("planner ("));
      expect(used).not.toContain("write");
      expect(fs.existsSync(path.join(tmp, "..", "outside.txt"))).toBe(false);
    }, 60000);

    it("falls back on someone who can act when the router names nobody real", async () => {
      const hub = await crew("no-such-member");
      ask(hub, "job-ghost route=planner [[stalled ghost]] [[say Noted.]]");
      await until("the reminder", () => notices(hub, "the router asked planner to carry on")[0]);
    }, 60000);

    it("can be turned off", async () => {
      const hub = await crew("watch-off", { PI_FLEET_QUIET_MS: "0" });
      ask(hub, "job-off route=planner [[stalled planner]] [[say Noted.]]");
      await until("the planner to answer", async () => (await llmLog()).find((r) => r.agent === "planner" && r.last.includes("job-off")));
      await sleep(3000);
      expect(await checksOf("job-off")).toEqual([]);
    }, 60000);

    it("keeps to what the person asked, whatever the crew says after it", async () => {
      const hub = await crew("kept-task");
      ask(hub, "job-kept route=planner [[repeat]]");
      await until("the check", async () => (await checksOf("job-kept")).length === 1);
      expect((await checksOf("job-kept"))[0].last).toContain("planner: Already done.");
    }, 60000);

    it("ends a planner's run at its handoff, and the job still gets done", async () => {
      const hub = await crew("handoff-once", { PI_FLEET_QUIET_MS: "0" });
      ask(hub, "job-once route=planner [[handoff-again]]");
      await until("the verdict", () => hub.tailMessages(100).find((m) => m.from === "reviewer" && m.text === "APPROVE"));
      await idle(hub, ["planner", "implementer", "reviewer"]);
      expect(hub.tailMessages(100).filter((m) => m.from === "planner" && m.kind === "chat")).toHaveLength(1);
      expect((await llmLog()).filter((r) => r.agent === "planner" && r.conversation.includes("job-once"))).toHaveLength(1);
      expect(hub.tailMessages(100).filter((m) => m.from === "system" && /was stopped|model error/.test(m.text))).toEqual([]); // nothing went wrong
    }, 60000);

    it("does not take a reviewer's word when it looked at nothing", async () => {
      const hub = await crew("rubber-stamp");
      ask(hub, "job-stamp route=reviewer [[say APPROVE]]");
      await until("the check", async () => (await checksOf("job-stamp")).length === 1);
      expect(hub.tailMessages(50).filter((m) => m.from === "reviewer" && m.kind === "chat")).toEqual([]);
    }, 60000);
  });

  it("does not take an agent waiting to try its model again for a stalled one", async () => {
    const agentDir = path.join(tmp, "quick-retries-quiet");
    fs.mkdirSync(agentDir, { recursive: true });
    fs.copyFileSync(path.join(env.PI_CODING_AGENT_DIR!, "models.json"), path.join(agentDir, "models.json"));
    fs.writeFileSync(path.join(agentDir, "settings.json"), JSON.stringify({ retry: { baseDelayMs: 20 } }));
    const { hub } = startFleet("retry-quiet", ["serve", "--agent", "waiter"], { PI_CODING_AGENT_DIR: agentDir, PI_FLEET_RETRY_WAITS: "6000", PI_FLEET_QUIET_MS: "300" });
    await idle(hub, ["waiter"]);
    hub.appendMessage({ from: "user", to: "group", kind: "chat", text: "route=waiter [[flaky 4]] hello" });
    await until("the retry notice", () => hub.tailMessages(20).find((m) => m.text.includes('"waiter" got a model error')), 30000);
    expect(hub.readAgents().waiter.waitingUntil).toBeGreaterThan(Date.now());
    await sleep(2000);
    expect((await llmLog()).filter((r) => r.agent === "watcher" && r.last.includes("[[flaky 4]]"))).toEqual([]);
  }, 60000);

  it("stops an agent that never ends its run", async () => {
    const { hub } = startFleet("turns", ["serve", "--agent", "runaway", "--max-turns", "5"]);
    await idle(hub, ["runaway"]);
    hub.appendMessage({ from: "user", to: "runaway", kind: "chat", text: "[[runon]]" });

    await until("the turn limit notice", () => hub.tailMessages(20).find((m) => m.text.includes(`"runaway" was stopped: 5 turns in one run`)));
    await idle(hub, ["runaway"]);
    await expectQuiet();
    expect((await llmLog()).filter((r) => r.agent === "runaway").length).toBeLessThanOrEqual(6);
  }, 60000);

  it("stops an agent that keeps repeating itself", async () => {
    const { hub } = startFleet("repeat", ["serve", "--agent", "parrot"]);
    await idle(hub, ["parrot"]);
    hub.appendMessage({ from: "user", to: "parrot", kind: "chat", text: "[[repeat]]" });
    await until("the repeat notice", () => hub.tailMessages(20).find((m) => m.text.includes("same fleet call 3 times")));
    await idle(hub, ["parrot"]);
    await expectQuiet();
    expect(hub.tailMessages(20).filter((m) => m.from === "parrot")).toHaveLength(3);
    expect(hub.tailMessages(20).filter((m) => m.text.includes("model error"))).toEqual([]); // that was the brake, not the model
  }, 60000);

  it("stops an agent that keeps talking, however it words it", async () => {
    const { hub } = startFleet("chatter", ["serve", "--agent", "talker"]);
    await idle(hub, ["talker"]);
    hub.appendMessage({ from: "user", to: "talker", kind: "chat", text: "[[chatter]]" });
    await until("the notice", () => hub.tailMessages(30).find((m) => m.text.includes('"talker" was stopped: it kept sending')));
    await idle(hub, ["talker"]);
    await expectQuiet();
    const sent = hub.tailMessages(30).filter((m) => m.from === "talker" && m.kind === "chat");
    expect(sent).toHaveLength(6);
    expect(new Set(sent.map((m) => m.text)).size).toBe(6); // none of them an exact repeat
    expect((await llmLog()).filter((r) => r.agent === "talker").length).toBeLessThanOrEqual(9);
    expect(hub.tailMessages(30).filter((m) => m.text.includes("model error"))).toEqual([]);
  }, 60000);

  it("Stop all aborts every run, drops what is queued, and holds the fleet", async () => {
    const { proc, hub } = startFleet("stopall", ["serve", "--agent", "alice", "--agent", "bob"]);
    const [, port, token] = await firstMatch(proc, /GUI: http:\/\/127\.0\.0\.1:(\d+)\/\?token=([\w-]+)/);
    await idle(hub, ["alice", "bob"]);
    hub.appendMessage({ from: "user", to: "alice", kind: "chat", text: "[[slow 30]] long job" });
    await until("alice busy", () => hub.readAgents().alice.status === "busy");
    hub.appendMessage({ from: "bob", to: "alice", kind: "chat", text: "queued behind the job" });
    await sleep(1200); // one supervisor tick: pi now holds it as a follow-up

    const res = await fetch(`http://127.0.0.1:${port}/stop-all`, { method: "POST", headers: { Authorization: `Bearer ${token}` } });
    expect(await res.json()).toEqual({ ok: true, stopped: 2 });
    await until("alice to stop long before her 30s job ends", () => hub.readAgents().alice.status === "idle", 5000);
    expect(hub.pausedReason()).toContain("stopped by you");

    hub.appendMessage({ from: "bob", to: "alice", kind: "chat", text: "held by the pause" });
    await sleep(2000);
    const alice = (await llmLog()).filter((r) => r.agent === "alice").map((r) => r.conversation).join("\n");
    expect(alice).not.toContain("queued behind the job");
    expect(alice).not.toContain("held by the pause");

    hub.appendMessage({ from: "user", to: "alice", kind: "chat", text: "resume with the plan" });
    await until("the human to get through", async () => (await llmLog()).find((r) => r.agent === "alice" && r.last.includes("resume with the plan")));
    expect(hub.pausedReason()).toBeNull();

    // what Stop all dropped must not come back with the next run
    await expectQuiet();
    const after = (await llmLog()).filter((r) => r.agent === "alice").map((r) => r.conversation).join("\n");
    expect(after).not.toContain("queued behind the job");
  }, 60000);
});
