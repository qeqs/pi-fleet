/**
 * End-to-end: real supervisor, bridges and `pi --mode rpc` processes, with a
 * scripted model server (fake-llm.mjs) in place of an LLM. These cover what the
 * unit tests cannot see: whether a message actually travels through the fleet.
 */
import { describe, it, expect, beforeAll, afterAll, afterEach } from "vitest";
import { spawn, execFileSync, type ChildProcess } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Hub } from "../src/hub.ts";

const ROOT = path.resolve(__dirname, "..");
const TSX = path.join(ROOT, "node_modules", "tsx", "dist", "cli.mjs");
const FLEET = path.join(ROOT, "src", "fleet.ts");
const MODEL = "fake/fake-1";

interface LlmRequest {
  agent: string;
  last: string;
  conversation: string;
  decision: string;
}

// a space in the path, because that is what command-line handling breaks on
let tmp: string;
let llm: ChildProcess;
let llmPort: number;
let env: NodeJS.ProcessEnv;

const running: { proc: ChildProcess; hubDir: string }[] = [];

function firstMatch(proc: ChildProcess, re: RegExp): Promise<RegExpExecArray> {
  return new Promise((resolve, reject) => {
    let out = "";
    const timer = setTimeout(() => reject(new Error(`no ${re} in:\n${out}`)), 30000);
    proc.stdout!.on("data", (d) => {
      out += d;
      const m = re.exec(out);
      if (m) {
        clearTimeout(timer);
        resolve(m);
      }
    });
    proc.stderr?.on("data", (d) => (out += d));
  });
}

async function until<T>(what: string, check: () => T | Promise<T>, timeoutMs = 30000): Promise<NonNullable<T>> {
  const end = Date.now() + timeoutMs;
  for (;;) {
    const value = await check();
    if (value) return value;
    if (Date.now() > end) throw new Error(`timed out waiting for ${what}`);
    await new Promise((r) => setTimeout(r, 150));
  }
}

const llmLog = async (): Promise<LlmRequest[]> => (await fetch(`http://127.0.0.1:${llmPort}/__log`)).json() as Promise<LlmRequest[]>;

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Passes only if no model request is made for a few seconds: the scripted loops run far faster. */
async function expectQuiet(): Promise<void> {
  await sleep(2500);
  const settled = (await llmLog()).length;
  await sleep(2500);
  expect((await llmLog()).length).toBe(settled);
}

function startFleet(name: string, args: string[]): { proc: ChildProcess; hub: Hub } {
  const hubDir = path.join(tmp, name);
  const proc = spawn(process.execPath, [TSX, FLEET, ...args, "--dir", hubDir, "--model", MODEL], {
    cwd: tmp,
    env,
    stdio: ["pipe", "pipe", "pipe"],
  });
  running.push({ proc, hubDir });
  return { proc, hub: new Hub(hubDir) };
}

async function idle(hub: Hub, names: string[]): Promise<void> {
  await until(`${names.join(", ")} idle`, () => {
    const agents = hub.readAgents();
    return names.every((n) => agents[n]?.status === "idle");
  });
}

function killTree(pid: number | undefined): void {
  if (!pid) return;
  try {
    if (process.platform === "win32") execFileSync("taskkill", ["/PID", String(pid), "/T", "/F"], { stdio: "ignore" });
    else process.kill(pid, "SIGTERM");
  } catch {
    // already gone
  }
}

beforeAll(async () => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), "pi fleet e2e "));
  llm = spawn(process.execPath, [path.join(ROOT, "test", "fake-llm.mjs")], { stdio: ["ignore", "pipe", "inherit"] });
  llmPort = Number((await firstMatch(llm, /fake llm on (\d+)/))[1]);
  const agentDir = path.join(tmp, "home", ".pi", "agent");
  fs.mkdirSync(agentDir, { recursive: true });
  fs.writeFileSync(
    path.join(agentDir, "models.json"),
    JSON.stringify({
      providers: {
        fake: {
          baseUrl: `http://127.0.0.1:${llmPort}/v1`,
          apiKey: "fake",
          api: "openai-completions",
          models: [{ id: "fake-1", name: "Fake", reasoning: false, input: ["text"], contextWindow: 131072, maxTokens: 2048, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } }],
        },
      },
    }),
  );
  env = {
    ...process.env,
    HOME: path.join(tmp, "home"),
    USERPROFILE: path.join(tmp, "home"),
    PI_CODING_AGENT_DIR: agentDir,
    PI_OFFLINE: "1",
    PI_SKIP_VERSION_CHECK: "1",
    PI_TELEMETRY: "0",
    PI_FLEET_POLL_MS: "300",
  };
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
    const woken = new Set((await llmLog()).map((r) => r.agent));
    expect(woken).toEqual(new Set(["planner", "implementer", "reviewer"]));
    await until("the fleet to settle", async () => {
      const agents = Object.values(hub.readAgents());
      return agents.every((a) => a.status === "idle");
    });
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
    expect(hub.tailMessages(50).some((m) => m.text.includes("not delivered"))).toBe(false);
  }, 60000);

  it("reports a message for an agent that is not running", async () => {
    const { hub } = startFleet("gone", ["serve", "--agent", "alice"]);
    await idle(hub, ["alice"]);
    hub.updateAgent("ghost", { name: "ghost", pid: 0, cwd: tmp, status: "stopped" });
    hub.appendMessage({ from: "user", to: "ghost", kind: "chat", text: "anyone home?" });
    await until("the failed delivery notice", () => hub.tailMessages(50).find((m) => m.kind === "system" && m.text.includes(`"ghost" was not delivered`)));
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

    await until("the turn limit notice", () => hub.tailMessages(20).find((m) => m.text.includes(`"runaway" was stopped after 5 turns`)));
    await idle(hub, ["runaway"]);
    await expectQuiet();
    expect((await llmLog()).filter((r) => r.agent === "runaway").length).toBeLessThanOrEqual(6);
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

    hub.appendMessage({ from: "user", to: "alice", kind: "chat", text: "carry on" });
    await until("the human to get through", async () => (await llmLog()).find((r) => r.agent === "alice" && r.last.includes("carry on")));
    expect(hub.pausedReason()).toBeNull();

    // what Stop all dropped must not come back with the next run
    await expectQuiet();
    const after = (await llmLog()).filter((r) => r.agent === "alice").map((r) => r.conversation).join("\n");
    expect(after).not.toContain("queued behind the job");
  }, 60000);
});
