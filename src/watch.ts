/**
 * Notices a crew that has gone quiet with the work unfinished. A weak model says it will
 * start, or passes the work on, and ends its turn. Nothing has failed, so nothing wakes
 * anyone, and a person is left looking at a silent chat. Rules cannot tell that from a job
 * that is done, so the router is asked, once the crew is quiet, with what was really done.
 */
import type { AgentInfo, ChannelConfig, FleetMessage } from "./hub.ts";
import { countsAsWork } from "./extension/index.ts";

export const WATCH_PROMPT = `You watch a team of software agents that has gone quiet. Reply with only a JSON object and nothing else:
{"finished": true or false, "next": "the member who must act now", "say": "what that member must do, in one or two sentences"}
finished is true when what the person asked for is done or answered, or when the team is waiting for the person. Messages prove nothing: a job that changes files needs write, edit or bash among the tools used.`;

/** How often one job is reminded before a person is told. */
export const MAX_NUDGES = 2;

/** Checks with no answer from the router before a person is told. A free model is often busy for a minute. */
export const MAX_CHECKS = 3;

const RECENT_MESSAGES = 8;
const MESSAGE_CHARS = 400;

/** What a person asked a channel for, and what has been done about it. */
export interface WatchedJob {
  task: FleetMessage;
  /** an agent has run since: with no run there is nothing to check on */
  ran: boolean;
  nudges: number;
  /** checks the router gave no answer to */
  failedChecks: number;
  quietSince: number;
  /** calls that did something, by agent and tool, since the message-level story can be false */
  tools: Record<string, Record<string, number>>;
}

export function startJob(task: FleetMessage): WatchedJob {
  return { task, ran: false, nudges: 0, failedChecks: 0, quietSince: Date.now(), tools: {} };
}

export function noteTool(job: WatchedJob, agent: string, tool: string): void {
  const counts = (job.tools[agent] ??= {});
  counts[tool] = (counts[tool] ?? 0) + 1;
}

/** An approval of someone else's work ends the job. Of nothing, it is more talk. */
export function closesJob(m: FleetMessage, job: WatchedJob): boolean {
  if (m.kind !== "chat" || !/^APPROVE\b/.test(m.text)) return false;
  return Object.entries(job.tools).some(([agent, counts]) => agent !== m.from && Object.keys(counts).some((tool) => countsAsWork(tool, "implementer")));
}

/** What the router gets: it remembers nothing, and the tools are the part no model can talk its way past. */
export function watchPrompt(job: WatchedJob, channel: ChannelConfig, agents: AgentInfo[], recent: FleetMessage[]): string {
  const members = agents.filter((a) => channel.members.includes(a.name));
  const tools = members.map((a) => {
    const counts = Object.entries(job.tools[a.name] ?? {}).map(([tool, n]) => `${tool} ${n}`);
    return `${a.name} (${a.role ?? "member"}): ${counts.join(", ") || "none"}`;
  });
  const said = recent
    .filter((m) => m.kind === "chat" && m.ts >= job.task.ts && m.id !== job.task.id)
    .slice(-RECENT_MESSAGES)
    .map((m) => `${m.from}: ${m.text.slice(0, MESSAGE_CHARS)}`);
  return [
    `The person asked #${channel.name}: ${job.task.text.slice(0, MESSAGE_CHARS)}`,
    "Tools used since then:",
    ...tools,
    ...(said.length > 0 ? ["Messages since then:", ...said] : ["No messages since then."]),
  ].join("\n");
}

export interface WatchVerdict {
  finished: boolean;
  /** a real member, if the router named one */
  next?: string;
  say?: string;
}

/** The router's view, or null if it gave none. */
export function parseWatchReply(reply: string, channel: ChannelConfig): WatchVerdict | null {
  const json = /\{[\s\S]*\}/.exec(reply);
  if (!json) return null;
  try {
    const { finished, next, say } = JSON.parse(json[0]) as { finished?: unknown; next?: unknown; say?: unknown };
    if (typeof finished !== "boolean") return null;
    return {
      finished,
      next: typeof next === "string" && channel.members.includes(next) ? next : undefined,
      say: typeof say === "string" && say.trim() ? say.trim() : undefined,
    };
  } catch {
    return null;
  }
}
