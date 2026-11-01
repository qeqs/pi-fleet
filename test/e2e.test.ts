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
import { execFileSync } from "node:child_process";
import { FLEET, MODEL, ROOT, TSX, firstMatch, killTree, startFakeModel, until, type LlmRequest } from "./support.ts";

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

async function startGui(name: string, args: string[]): Promise<{ hub: Hub; port: string; token: string }> {
  const { proc, hub } = startFleet(name, ["serve", ...args]);
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
    killTree(first.proc.pid);
    killTree(first.hub.readAgents().alice.pid);
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
    for (const pid of [first.proc.pid, alice.pid, bob.pid]) killTree(pid);
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
    await until("alice busy", () => first.hub.readAgents().alice.status === "busy");
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
    killTree(first.proc.pid);
    killTree(pid);
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

  it("reports a run that ends in a model error", async () => {
    const { hub } = startFleet("modelerror", ["serve", "--agent", "alice"]);
    await idle(hub, ["alice"]);
    hub.appendMessage({ from: "user", to: "alice", kind: "chat", text: "[[fail]]" });
    await until("the error notice", () => hub.tailMessages(20).find((m) => m.text.includes('agent "alice" stopped on a model error')), 45000);
  }, 60000);

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
