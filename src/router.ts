/**
 * The dedicated channel router. Routing used to be a worker's job, so the worker's
 * context grew with every message and channels stalled while it worked. Here,
 * messages that need no judgement follow a rule, and the rest get one short model
 * call that starts from nothing each time.
 */
import fs from "node:fs";
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

/** A bare pi process with no tools or extensions, restarted from nothing for every question. */
export class ModelRouter {
  private rpc: PiRpc | null = null;
  private waiting: { done: () => void; text: string } | null = null;
  /** Tokens and cost across every question so far. */
  spent = { tokens: 0, cost: 0 };

  constructor(
    private root: string,
    private cwd: string,
    private logFile: string,
    private model: string | undefined,
  ) {}

  private start(): PiRpc {
    const args = ["--mode", "rpc", "--no-session", "--no-tools", "--no-extensions", "--no-skills", "--no-prompt-templates", "--no-context-files", "--no-mcp", "--thinking", "off", "--system-prompt", SYSTEM_PROMPT];
    if (this.model) args.push("--model", this.model);
    fs.mkdirSync(this.cwd, { recursive: true });
    const rpc = new PiRpc(piArgv(this.root, args), { cwd: this.cwd, env: process.env, logFile: this.logFile, timeoutMs: ROUTER_TIMEOUT_MS });
    rpc.onEvent = (rec) => {
      const message = rec.message as { role?: string; content?: { type: string; text?: string }[] } | undefined;
      if (rec.type === "message_end" && message?.role === "assistant" && this.waiting) {
        this.waiting.text = (message.content ?? []).map((b) => b.text ?? "").join("");
      }
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
    await rpc.sendCommand({ type: "new_session" });
    const wait = { done: () => {}, text: "" };
    const settled = new Promise<void>((resolve) => (wait.done = resolve));
    this.waiting = wait;
    const timer = setTimeout(() => wait.done(), ROUTER_TIMEOUT_MS);
    try {
      await rpc.prompt(prompt);
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
