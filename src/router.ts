/**
 * The dedicated channel router. Routing used to be a worker's job, so the worker's
 * context grew with every message and channels stalled while it worked. Here,
 * messages that need no judgement follow a rule, and the rest get one short model
 * call that starts from nothing each time.
 */
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import type { AgentInfo, ChannelConfig, FleetMessage } from "./hub.ts";
import { PiRpc, piArgv } from "./rpc.ts";

/** Which members must act on a message, and the channel summary after it. */
export interface RouteDecision {
  respond: string[];
  summary?: string;
}

const ROUTER_TIMEOUT_MS = 2 * 60 * 1000;
const RECENT_MESSAGES = 6;

const SYSTEM_PROMPT = `You route messages in a team chat of software agents. Reply with only a JSON object and nothing else:
{"respond": ["names of the members who must act"], "summary": "the updated channel summary, under 500 characters"}
Pick only the members who must act now, usually one. Use [] when nothing needs doing: a final answer, an approval or a status report.`;

const TOOL_TEST_PROMPT = "You check that a model can use tools. Do exactly what you are told.";

/** A decision that needs no model, or null if this message takes judgement. */
export function routeByRules(m: FleetMessage, channel: ChannelConfig, agents: AgentInfo[]): string[] | null {
  if (channel.members.length === 1) return m.from === channel.members[0] ? [] : channel.members;
  if (/^APPROVE\b/.test(m.text)) return [];
  if (/^REQUEST CHANGES\b/.test(m.text)) {
    const implementers = agents.filter((a) => a.role === "implementer" && channel.members.includes(a.name)).map((a) => a.name);
    if (implementers.length > 0) return implementers;
  }
  return null;
}

/** What the router model gets: everything it needs, since it remembers nothing. */
export function routerPrompt(channel: ChannelConfig, m: FleetMessage, agents: AgentInfo[], recent: FleetMessage[]): string {
  const members = agents
    .filter((a) => channel.members.includes(a.name))
    .map((a) => `${a.name} (${a.role ?? "member"}, ${a.status})`)
    .join(", ");
  const earlier = recent
    .filter((r) => r.id !== m.id && r.to === channel.name && r.kind === "chat")
    .slice(-RECENT_MESSAGES)
    .map((r) => `${r.from}: ${r.text}`);
  return [
    `Channel: #${channel.name}`,
    `Members: ${members || "(none)"}`,
    `Summary so far: ${channel.summary?.trim() || "(none)"}`,
    ...(earlier.length > 0 ? ["Recent messages:", ...earlier] : []),
    `New message from ${m.from}: ${m.text}`,
  ].join("\n");
}

/** The decision in the model's reply, keeping only real members, or null if there is none. */
export function parseRouterReply(reply: string, channel: ChannelConfig): RouteDecision | null {
  const json = /\{[\s\S]*\}/.exec(reply);
  if (!json) return null;
  try {
    const { respond, summary } = JSON.parse(json[0]) as { respond?: unknown; summary?: unknown };
    if (!Array.isArray(respond)) return null;
    return {
      respond: respond.filter((name): name is string => typeof name === "string" && channel.members.includes(name)),
      summary: typeof summary === "string" ? summary : undefined,
    };
  } catch {
    return null;
  }
}

/** Who gets a message when the router cannot decide: better one wrong agent than a dead channel. */
export function fallbackRoute(channel: ChannelConfig, agents: AgentInfo[], running: string[]): string[] {
  const available = agents.filter((a) => channel.members.includes(a.name) && running.includes(a.name));
  const pick = available.find((a) => a.role === "planner") ?? available.find((a) => a.role === "implementer") ?? available[0];
  return pick ? [pick.name] : [];
}

export interface ModelTest {
  ok: boolean;
  /** What went wrong, in the words of the model's provider. */
  error?: string;
  ms: number;
  /** Whether it really used a tool. Unknown if the question itself failed, as on a rate limit. */
  tools?: boolean;
}

/** Ask a model for one word: the only way to know a server is up and a key is good. */
export async function testModel(root: string, cwd: string, logFile: string, model: string | undefined): Promise<ModelTest> {
  const started = Date.now();
  const router = new ModelRouter(root, cwd, logFile, model);
  try {
    const reply = await router.ask("Reply with the single word: ok");
    const ms = Date.now() - started;
    if (!reply.trim()) return { ok: false, error: router.failure ?? "the model answered with nothing", ms };
    return { ok: true, ms, tools: await usesTools(root, cwd, logFile, model) };
  } catch (err) {
    return { ok: false, error: (err as Error).message, ms: Date.now() - started };
  } finally {
    router.close();
  }
}

/**
 * Whether a model really calls a tool. A server can take a list of tools and ignore it, and agents
 * on such a model can only write text. The answer is in a file, so that it cannot be guessed.
 */
async function usesTools(root: string, cwd: string, logFile: string, model: string | undefined): Promise<boolean | undefined> {
  const word = crypto.randomUUID().slice(0, 8);
  const file = path.join(cwd, `model-test-${word}.txt`);
  const router = new ModelRouter(root, cwd, logFile, model, TOOL_TEST_PROMPT, "read");
  try {
    fs.mkdirSync(cwd, { recursive: true });
    fs.writeFileSync(file, word);
    const reply = await router.ask(`Use the read tool on ${file}, then reply with what the file says.`);
    if (reply.includes(word)) return true;
    // a provider can refuse a model for this very reason: "no endpoints that support tool use"
    return router.failure && !/\btool/i.test(router.failure) ? undefined : false;
  } catch {
    return undefined;
  } finally {
    router.close();
    fs.rmSync(file, { force: true });
  }
}

/** A bare pi process with no extensions, restarted from nothing for every question. */
export class ModelRouter {
  private rpc: PiRpc | null = null;
  private waiting: { done: () => void; text: string } | null = null;
  /** Tokens and cost across every question so far. */
  spent = { tokens: 0, cost: 0 };
  /** Why the last question got no answer, if the model said. */
  failure: string | null = null;

  constructor(
    private root: string,
    private cwd: string,
    private logFile: string,
    private model: string | undefined,
    private systemPrompt = SYSTEM_PROMPT,
    private tools?: string,
  ) {}

  private start(): PiRpc {
    const args = ["--mode", "rpc", "--no-session", ...(this.tools ? ["--tools", this.tools] : ["--no-tools"]), "--no-extensions", "--no-skills", "--no-prompt-templates", "--no-context-files", "--no-mcp", "--thinking", "off", "--system-prompt", this.systemPrompt];
    if (this.model) args.push("--model", this.model);
    fs.mkdirSync(this.cwd, { recursive: true });
    fs.mkdirSync(path.dirname(this.logFile), { recursive: true }); // a new hub has no agents yet
    const rpc = new PiRpc(piArgv(this.root, args), { cwd: this.cwd, env: process.env, logFile: this.logFile, timeoutMs: ROUTER_TIMEOUT_MS });
    rpc.onEvent = (rec) => {
      const message = rec.message as { role?: string; content?: { type: string; text?: string }[]; stopReason?: string; errorMessage?: string } | undefined;
      if (rec.type === "message_end" && message?.role === "assistant" && this.waiting) {
        this.waiting.text = (message.content ?? []).map((b) => b.text ?? "").join("");
        this.failure = message.stopReason === "error" ? (message.errorMessage ?? "the model failed") : null;
      }
      // someone is waiting on this answer: fall back at once rather than after pi's retries
      if (rec.type === "auto_retry_start") void rpc.sendCommand({ type: "abort_retry" }).catch(() => {});
      if (rec.type === "agent_settled") this.waiting?.done();
    };
    rpc.onExit = () => {
      this.rpc = null;
      this.waiting?.done();
    };
    return rpc;
  }

  /** Ask once, from a clean slate. Returns the model's text, empty if it gave none in time. */
  async ask(prompt: string): Promise<string> {
    this.rpc ??= this.start();
    const rpc = this.rpc;
    this.failure = null;
    await rpc.sendCommand({ type: "new_session" });
    const wait = { done: () => {}, text: "" };
    const settled = new Promise<void>((resolve) => (wait.done = resolve));
    this.waiting = wait;
    const timer = setTimeout(() => wait.done(), ROUTER_TIMEOUT_MS);
    try {
      const res = await rpc.prompt(prompt);
      if (res.success === false) {
        // refused, so no run will ever settle: a missing key lands here
        this.failure = String(res.error ?? "pi refused the request").split("\n")[0];
        return "";
      }
      await settled;
    } finally {
      clearTimeout(timer);
      this.waiting = null;
    }
    const stats = (await rpc.getStats().catch(() => null))?.data as { tokens?: { total?: number }; cost?: number } | undefined;
    this.spent.tokens += stats?.tokens?.total ?? 0;
    this.spent.cost += stats?.cost ?? 0;
    return wait.text;
  }

  close(): void {
    void this.rpc?.close();
    this.rpc = null;
  }
}
