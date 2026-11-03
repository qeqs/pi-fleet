/**
 * pi-fleet extension — makes a pi session a fleet agent.
 *
 * Loaded by the fleet supervisor via:
 *   pi --mode rpc --name <name> --extension <this file>
 * with env:
 *   PI_FLEET_DIR   hub directory (messages.jsonl + agents.json)
 *   PI_FLEET_AGENT this agent's name
 *   PI_FLEET_ROOT  pi-fleet project root (to find the openspec CLI)
 *
 * Provides:
 *  - tools: fleet_send, fleet_inbox, fleet_agents, openspec
 *  - commands: /agents, /send, /group
 *  - a "fleet" system-prompt section
 *  - inbox polling: new messages addressed to this agent (or the group)
 *    are injected as a user message when the agent is idle
 */
import { isRetryableAssistantError, Type, type AssistantMessage } from "@earendil-works/pi-ai";
import { defineTool, type ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { execFile } from "node:child_process";
import path from "node:path";
import { onPath } from "../programs.ts";
import { Hub, shortId, messageTooLong, addressLabel, DEFAULT_CHANNEL, DEFAULT_MAX_HOPS, DEFAULT_MAX_TURNS, MAX_MESSAGE_LEN, type AgentInfo, type FleetMessage, type ChannelConfig, addressedAgents, mentionedAgents } from "../hub.ts";
import { packageBinArgv } from "../rpc.ts";
import { answerText, askInDialogs, declinedAll, questionsIn } from "./ask-user.ts";

const POLL_MS = Number(process.env.PI_FLEET_POLL_MS ?? 3000);

/** How long a model may stay silent mid-turn before the fleet is told (0 = never). */
const STALL_MS = Number(process.env.PI_FLEET_STALL_MS ?? 5 * 60 * 1000);

/**
 * A run stops when it makes the same fleet call this many times. Only fleet calls
 * count: nothing changes between identical messages, but running the same build
 * or test again after an edit is ordinary work.
 */
const REPEAT_LIMIT = 3;
const FLEET_TOOLS = new Set(["fleet_send", "fleet_mention", "route"]);

/**
 * Messages a run may send with nothing new coming in. A report too long for one message
 * still fits, at 12,000 characters. A model talking to itself does not: one real run went
 * round 11 times after its handoff, with each text a little different, for 606k tokens.
 */
const SEND_LIMIT = 6;

/** Refused sends before the run is stopped: a model that ignores them would go on to the turn limit. */
const REFUSED_SEND_LIMIT = 2;

/**
 * The waits before each of the fleet's own tries after a run ends in a model error, in ms
 * (PI_FLEET_RETRY_WAITS). pi's retries are over in seconds, which does not outlast a server
 * that is down for a minute, and then the chain would wait for a person.
 */
const RETRY_WAITS = "30000,120000,300000";

/** Tools that only talk, plan or look something up: a run with nothing else in it did no work. */
const TALK_TOOLS = new Set([...FLEET_TOOLS, "fleet_inbox", "fleet_agents", "openspec", "beads"]);
const LOOK_TOOLS = new Set(["read", "grep", "find", "ls"]);

/** Whether a tool call is work for this role: reading is most of a review, but an implementer has to change something. */
export function countsAsWork(tool: string, role: string | undefined): boolean {
  if (TALK_TOOLS.has(tool)) return false;
  return role !== "implementer" || !LOOK_TOOLS.has(tool);
}

/** Who a planner gives its work to. Without one, it has to do the work itself. */
function implementerIn(agents: Record<string, AgentInfo>): string | undefined {
  return Object.values(agents).find((a) => a.role === "implementer" && a.status !== "stopped")?.name;
}

/** A path as seen from a folder, or undefined if it leads out of it. pi reads /c/x as C:\x on Windows, as Git Bash does. */
export function pathInside(cwd: string, file: string): string | undefined {
  const native = process.platform === "win32" ? file.replace(/^\/(?:mnt\/|cygdrive\/)?([a-z])(?=\/)/i, "$1:") : file;
  const from = path.relative(cwd, path.resolve(cwd, native));
  return from === ".." || from.startsWith(`..${path.sep}`) || path.isAbsolute(from) ? undefined : from;
}

/** Tools this agent may only run once a person agrees (PI_FLEET_APPROVE, comma-separated). */
export const APPROVE_TOOLS = new Set((process.env.PI_FLEET_APPROVE ?? "").split(",").map((t) => t.trim()).filter(Boolean));

function buildRoster(hub: Hub, name: string, lean: boolean): string {
  const agents = Object.values(hub.readAgents()).filter((a) => a.name !== name);
  if (agents.length === 0) return lean ? "(no other agents yet)" : "(no other agents registered yet)";
  if (lean) return agents.map((a) => `${a.name}[${a.status}]`).join(", ");
  return agents.map((a) => `- ${a.name} [${a.status}] — cwd: ${a.cwd}`).join("\n");
}

/**
 * Task board: the tool agents use to plan/track work. OpenSpec is the default;
 * "beads" (the `bd` CLI) is an alternative, selected via PI_FLEET_TASKBOARD=beads.
 */
export const TASKBOARD: "openspec" | "beads" = process.env.PI_FLEET_TASKBOARD === "beads" ? "beads" : "openspec";

/** Task-board-specific planning guidance (for the system prompt). */
const TASKBOARD_PLAN =
  TASKBOARD === "beads"
    ? "Use the beads tool (bd CLI) to plan/track work: create issues (\"create <title>\"), list them (\"list\"), show one (\"show <id>\"), and close them when done (\"close <id>\"). Run `bd init` once in the project if there is no beads database yet."
    : "For work of several steps, use the openspec tool for planning and tracking: create change proposals under openspec/changes/, keep tasks.md updated, validate before finishing. A small job needs no change proposal.";

/** Task-board-specific quality gate (for the system prompt). */
const TASKBOARD_GATE =
  TASKBOARD === "beads"
    ? "Quality gate: before marking an issue done, run \"beads list\" to confirm its state and post the result to the thread."
    : "Quality gate: if the work has a change proposal, run `openspec validate <id>` before marking a task done.";

/** A message that opens with who it is for. Models often write the names themselves too. */
export function mentionText(targets: string[], text: string): string {
  const body = text.replace(/^(?:\s*@[A-Za-z0-9_-]+[\s,:]*)+/, (names) => (mentionedAgents(names).every((a) => targets.includes(a)) ? "" : names));
  return `${targets.map((a) => `@${a}`).join(" ")} ${body}`;
}

/** `openspec init` also writes skills and prompts for each AI tool it detects: a dozen files nobody asked for. */
export function openspecArgs(args: string[]): string[] {
  return args[0] === "init" && !args.includes("--tools") ? [...args, "--tools", "none"] : args;
}

/** Role-specific instructions appended to the fleet prompt (planner/implementer/reviewer). */
export function rolePrompt(role: string | undefined): string {
  const tb = TASKBOARD;
  const validate = tb === "beads" ? 'run the beads tool ("list") to confirm state' : `run \`openspec validate <id>\``;
  switch (role) {
    case "planner":
      return `

Your role: PLANNER.
- Break goals into concrete, verifiable tasks. Record them in the ${tb} task board if there are several. Check any worked example or number you put in a plan.
- Give the work to the implementer with fleet_mention, in one message with everything it needs, so that the group can see it. Do NOT implement code yourself, and leave the reviewer out: the implementer asks for review when there is something to review.
- That handoff ends your run, so check your plan before you send it. You are then finished unless someone asks you something. The reviewer's verdict ends the job, so never announce that it is done.`;
    case "implementer":
      return `

Your role: IMPLEMENTER.
- Implement the tasks assigned to you yourself, in this run: write the files with your tools and run them. Do not announce the work, ask to start or pass it on.
- Follow the quality gate: ${validate} before marking a task done.
- When everything assigned to you is done, @mention the reviewer once, with a summary of what changed and where.`;
    case "reviewer":
      return `

Your role: REVIEWER.
- You act when asked to review, and only then. Do not announce a review or report on one in progress.
- Inspect the change (files + ${tb} task board), ${validate}, and smoke-test where practical. Finish all of it before you reply.
- Then send one verdict, starting with \`APPROVE\` or \`REQUEST CHANGES: <specific, actionable reasons>\`. APPROVE means nothing is left to check and ends the job. If the work has a change proposal, archive it first.`;
    case "supervisor":
      return `

Your role: SUPERVISOR (router + summarizer for your channels).
- You are woken when a message arrives in a channel you supervise. Your job is NOT to do the work — it is to route it.
- On each wake: (1) fold the new message into the channel summary (factual, compact, under ~500 chars), and (2) call the route tool choosing ONLY the members who genuinely need to act. Use an empty list if nobody should respond.
- Be conservative with routing — waking a member costs tokens. Do not wake members who only need to be informed; the summary carries that.
- You may include yourself in respond only when you should answer directly.`;
    default:
      return "";
  }
}

/** For an agent in its own worktree: how its work reaches everyone else. */
export function worktreePrompt(branch: string | undefined): string {
  if (!branch) return "";
  return `

You work in your own git worktree on branch ${branch}. Stay in your working directory and commit your work there. Do not merge: a person does that after review. When you ask for a review, give the full path of your working directory, because other agents are not in it.`;
}

export function fleetPrompt(name: string, lean: boolean, roster: string, role?: string): string {
  const closing = rolePrompt(role) + worktreePrompt(process.env.PI_FLEET_BRANCH);
  if (lean) {
    // Compact for small models: same rules, fewer words.
    return `You are "${name}", an agent in a multi-agent fleet with a shared message bus.
Fleet (you are "${name}"): ${roster}
- You are woken when messages arrive (@mentions of you, or a routing supervisor directs one to you).
- Messages do no work: only your tools do (read, write, edit, bash). Never say you will do something: do it in this run, then report what you did.
- Reply with fleet_send: to="group" or to a channel name, or to="<agent>". Keep it short.
- Hand work to an agent with fleet_mention, or start your message with their @name. A name later in a message wakes nobody.
- Send a message only to hand off work, ask something that blocks you, or report a finished result. Never just acknowledge: if a message asks nothing of you, end your turn.
- To reply to a specific message, pass its id (in parentheses) as replyTo.
- ${TASKBOARD_PLAN}
- ${TASKBOARD_GATE}
- Review: when asked to review work, reply "APPROVE" or "REQUEST CHANGES: <reasons>".` + closing;
  }
  return `You are "${name}", one agent in a multi-agent fleet. Other agents and the user talk to you through a shared message bus with named channels.

Fleet members (you are "${name}"):
${roster}

Fleet rules:
- You are woken automatically when new messages arrive. Check them with fleet_inbox if you need history.
- Messages do no work: only your tools do (read, write, edit, bash). Never say you will do something: do it in this run, then report what you did.
- Reply with fleet_send: to="group" or a channel name for a shared channel, to="<agent name>" for a direct message. Keep messages concise and actionable.
- In a supervised channel, a supervisor routes work to you; when you finish, send your result back to that channel.
- To hand work to an agent, use fleet_mention, or start your message with their @name. A name later in a message wakes nobody.
- Send a message only to hand off work, to ask something that blocks you, or to report a finished result. Do not acknowledge, thank, confirm or repeat yourself: if a message asks nothing of you, end your turn without sending anything.
- Each message has a short id in parentheses. To reply to a specific message, pass that id as replyTo — this threads the conversation.
- ${TASKBOARD_PLAN}
- **${TASKBOARD_GATE}**
- **Review protocol**: when another agent asks you to review their work, reply with either \`APPROVE\` or \`REQUEST CHANGES: <specific, actionable reasons>\`. Be concrete about what must change.
- Coordinate: when you finish work another agent depends on, or need a decision, send them a message instead of guessing.
- Use fleet_agents to see who is available and what they are doing.` + closing;
}

export function buildLookup(hub: Hub): Map<string, FleetMessage> {
  const map = new Map<string, FleetMessage>();
  for (const m of hub.tailMessages(500)) {
    map.set(m.id, m);
    map.set(shortId(m.id), m);
  }
  return map;
}

/** The channel's routing supervisor: explicit, else the first member. */
export function defaultSupervisor(channel: ChannelConfig): string | undefined {
  if (channel.supervisor) return channel.supervisor;
  return channel.members[0];
}

/**
 * How (and whether) an agent is woken by a message, given the channel set.
 *  - DM (to === name): wake, normal mode.
 *  - channel message addressed to members: ONLY those members wake, normal mode
 *    (the sender already chose the addressee, so no routing turn is spent).
 *  - channel with a supervisor: ONLY the supervisor wakes, in "route" mode
 *    (it decides who else should see the message and updates the summary).
 *  - channel without a supervisor: all members wake, normal mode.
 *  - legacy "group" with no channel config: broadcast (old behavior).
 */
export interface WakeDecision {
  wake: boolean;
  mode: "route" | "normal";
  channel?: ChannelConfig;
}

export function wakeDecision(
  m: FleetMessage,
  name: string,
  lookup: Map<string, FleetMessage>,
  channels: ChannelConfig[],
): WakeDecision {
  if (m.to === name) return { wake: true, mode: "normal" };
  const channel = channels.find((c) => c.name === m.to);
  if (channel) {
    const addressed = addressedAgents(m).filter((a) => channel.members.includes(a));
    if (addressed.length > 0) return { wake: addressed.includes(name), mode: "normal" };
    const sup = defaultSupervisor(channel);
    if (sup) {
      return name === sup ? { wake: true, mode: "route", channel } : { wake: false, mode: "normal" };
    }
    return channel.members.includes(name) ? { wake: true, mode: "normal", channel } : { wake: false, mode: "normal" };
  }
  // legacy "group" with no channel config: broadcast (backward compatible)
  if (m.to === DEFAULT_CHANNEL) {
    const addressed = addressedAgents(m);
    if (addressed.length > 0) return { wake: addressed.includes(name), mode: "normal" };
    if (m.replyTo) {
      const orig = lookup.get(m.replyTo);
      if (orig) {
        const participants = new Set<string>([orig.from]);
        if (orig.to !== DEFAULT_CHANNEL) participants.add(orig.to);
        for (const a of addressedAgents(orig)) participants.add(a);
        return { wake: participants.has(name), mode: "normal" };
      }
    }
    return { wake: true, mode: "normal" };
  }
  return { wake: false, mode: "normal" };
}

/**
 * The fleet's brake: whether a bus message may wake anyone. The human always gets
 * through, and their message resumes a paused fleet and restarts the hop count.
 * Agent messages wake nobody while paused, and past the hop limit they pause it.
 */
export function admitMessage(m: FleetMessage, hub: Hub, maxHops: number): boolean {
  if (m.from === "user") {
    hub.resume();
    return true;
  }
  if (m.kind !== "chat" || hub.pausedReason() !== null) return false;
  if (maxHops === 0 || hub.agentHops(m.id) <= maxHops) return true;
  hub.pause(`${maxHops} agent messages since your last message (limit: --max-hops)`, m.ts);
  return false;
}

/** Backward-compatible boolean wrapper (used by older call sites / tests). */
export function groupWakesAgent(m: FleetMessage, name: string, lookup: Map<string, FleetMessage>, channels?: ChannelConfig[]): boolean {
  return wakeDecision(m, name, lookup, channels ?? []).wake;
}

/**
 * The routing prompt sent to a channel supervisor when a message arrives.
 * Compact on purpose — the supervisor usually runs a small model.
 */
export function routingPrompt(channel: ChannelConfig, m: FleetMessage, members: AgentInfo[]): string {
  const summary = channel.summary ? channel.summary.trim() : "(no summary yet)";
  const roster = members
    .filter((a) => channel.members.includes(a.name))
    .map((a) => `${a.name} (${a.role ?? "member"})`)
    .join(", ") || "(no members)";
  return [
    `Routing task for #${channel.name}.`,
    `New message (id ${shortId(m.id)}): ${m.from} said: "${m.text}"`,
    `Current summary: ${summary}`,
    `Members: ${roster}`,
    `Do two things:`,
    `1. Update the summary to fold in this message — factual, compact (under ~500 chars), no fluff.`,
    `2. Call route with: channel="${channel.name}", respond=[<members who genuinely need to act>], summary="<new summary>".`,
    `   Pick ONLY the members whose role/expertise is needed. Include yourself only if the work is yours; then do it right after calling route, in this same turn.`,
    `   If this message completes the task (a final answer, an APPROVE, or a done-report), respond=[] to end the turn.`,
    `   If it is a question or a request for work, route it to the one or two members best suited — not the whole room.`,
  ].join("\n");
}

/**
 * Carry out a routing decision: update the summary, DM each chosen member, and leave
 * a mark in the channel so routing is not a black box. Returns who was messaged.
 */
export function applyRoute(hub: Hub, by: string, channel: ChannelConfig, target: FleetMessage, respond: string[], summary: string): string[] {
  if (summary.trim()) hub.setChannelSummary(channel.name, summary.trim());
  const sent = respond.filter((member) => member !== by); // a supervisor answers in its own turn, not by DM
  const agents = hub.readAgents();
  for (const member of sent) {
    const handOffTo = agents[member]?.role === "planner" ? implementerIn(agents) : undefined;
    hub.appendMessage({ from: by, to: member, kind: "chat", text: directedMessageText(channel, target, summary, handOffTo), replyTo: target.id });
  }
  hub.appendMessage({ from: by, to: channel.name, kind: "activity", text: `routed to ${respond.join(", ") || "nobody"}` });
  return sent;
}

/**
 * The context attached to a directed message the supervisor routes to a member:
 * the original message plus the channel summary, so the member has context
 * without reading the full transcript.
 */
export function directedMessageText(channel: ChannelConfig, m: FleetMessage, summary: string, handOffTo?: string): string {
  const parts = [`[#${channel.name}] ${m.from} said: "${m.text}"`];
  if (summary && summary.trim() && summary.trim() !== "(no summary yet)") {
    parts.push(`Channel summary: ${summary.trim()}`);
  }
  if (handOffTo) parts.push(`If this is work, do not do it yourself: give it to ${handOffTo} now, with fleet_mention. If it only needs an answer, send that with fleet_send to "${channel.name}".`);
  else parts.push(`If this is work for you, do it now with your tools: a message does no work. Then respond with fleet_send to "${channel.name}" if a reply is needed.`);
  return parts.join("\n");
}

export function formatInbox(messages: FleetMessage[], lookup: Map<string, FleetMessage>, channels: ChannelConfig[] = []): string {
  const lines = messages.map((m) => {
    const t = new Date(m.ts).toLocaleTimeString([], { hour12: false });
    const target = addressLabel(m.to, channels);
    const orig = m.replyTo ? lookup.get(m.replyTo) : undefined;
    const reply = m.replyTo ? ` (↪ replying to ${orig ? orig.from : shortId(m.replyTo)})` : "";
    return `(${shortId(m.id)}) [${t}] ${m.from} → ${target}${reply}: ${m.text}`;
  });
  return (
    `New fleet messages for you:\n${lines.join("\n")}\n\n` +
    `Reply with fleet_send (to="group" or to a specific agent) only if this needs something from you. ` +
    `To reply to a specific message, pass its id (in parentheses) as replyTo. ` +
    `If this asks you to do something, do that first, now, with your tools: a message does no work.`
  );
}

/**
 * The channel message a wake came from, going by the messages it carries, last one first.
 * The router hands a member its work as a DM, so that DM counts by the message it replies to.
 */
export function wakeOrigin(text: string, hub: Hub): FleetMessage | undefined {
  const lookup = buildLookup(hub);
  const carried = [...text.matchAll(/^\((\S+)\) \[/gm)].map(([, id]) => lookup.get(id));
  for (const m of carried.reverse()) {
    const origin = [m, m?.replyTo ? lookup.get(m.replyTo) : undefined].find((o) => o && hub.targetKind(o.to) === "channel");
    if (origin) return origin;
  }
  return undefined;
}

/**
 * Whether a model error may be gone in a few minutes. pi knows the transient ones, except
 * what OpenRouter reports when a free model's provider fails. A bad key or an unknown model
 * stays that way, even when a gateway words it as a provider error, and a limit per day
 * outlasts every wait here.
 */
export function waitingHelps(error: string): boolean {
  if (/(?<![a-z0-9])(?:401|403|404)(?![a-z0-9])|per[- ]day|daily/i.test(error)) return false;
  return /finish_reason: error/i.test(error) || isRetryableAssistantError({ stopReason: "error", errorMessage: error } as AssistantMessage);
}

const VERDICT = /^[\s*_#>`]*(APPROVE|REQUEST CHANGES)\b[*_`]*/;

/** A final text that is a verdict, in the form the routing rules read, or null if it is anything else. */
export function verdictMessage(text: string, name: string): string | null {
  if (!VERDICT.test(text)) return null;
  const verdict = text.replace(VERDICT, "$1").trim();
  const rest = ` … (the rest is in ${name}'s chat)`;
  return messageTooLong(verdict) ? verdict.slice(0, MAX_MESSAGE_LEN - rest.length) + rest : verdict;
}

export interface PollerDeps {
  hub: Hub;
  name: string;
  isBusy: () => boolean;
  wake: (text: string) => void;
  pollMs: number;
  /**
   * True while the fleet supervisor is attached. While true, the supervisor
   * pushes wakes directly (rpc.prompt), so the poller must NOT self-wake
   * (avoids double-wakes). When false (supervisor gone / detached), the
   * poller resumes self-waking. The read offset still advances either way.
   */
  supervisorAlive?: () => boolean;
  /** Hop limit to enforce while detached; attached, the supervisor enforces it (0 = no limit). */
  maxHops?: number;
}

export interface Poller {
  tick: () => void;
  start: () => void;
  stop: () => void;
  flushPending: () => void;
  seekToEnd: () => void;
}

/**
 * The agent-side poller: watches the hub for new messages that wake this
 * agent, buffers them while the agent is busy, and flushes when idle. Extracted
 * from the extension so it can be unit-tested without a live pi session.
 */
export function createPoller(deps: PollerDeps): Poller {
  let cursor = deps.hub.busEnd();
  let pending = "";
  let timer: ReturnType<typeof setInterval> | undefined;

  function flushPending() {
    if (pending) {
      const p = pending;
      pending = "";
      if (deps.hub.pausedReason() === null) deps.wake(p);
    }
  }

  function tick() {
    try {
      if (deps.supervisorAlive?.()) {
        // It wakes everyone. Keep to its position, so nothing falls between us if it dies.
        cursor = deps.hub.readCursor() ?? cursor;
        return;
      }
      const { messages, next } = deps.hub.readBus(cursor);
      cursor = next;
      if (messages.length > 0) {
        const lookup = buildLookup(deps.hub);
        const channels = deps.hub.readChannels();
        const agents = Object.values(deps.hub.readAgents());
        const relevant: FleetMessage[] = [];
        let routeText = "";
        for (const m of messages) {
          if (!admitMessage(m, deps.hub, deps.maxHops ?? 0)) continue;
          if (m.from === deps.name || m.kind !== "chat") continue;
          const d = wakeDecision(m, deps.name, lookup, channels);
          if (!d.wake) continue;
          if (d.mode === "route" && d.channel) {
            // this agent is the channel supervisor — wake with a routing prompt
            routeText = routeText ? `${routeText}\n\n${routingPrompt(d.channel, m, agents)}` : routingPrompt(d.channel, m, agents);
          } else {
            relevant.push(m);
          }
        }
        if (relevant.length > 0 || routeText) {
          const inbox = relevant.length > 0 ? formatInbox(relevant, lookup, channels) : "";
          const combined = routeText && inbox ? `${routeText}\n\n${inbox}` : routeText || inbox;
          if (deps.isBusy()) {
            pending = pending ? `${pending}\n\n${combined}` : combined;
          } else {
            deps.wake(combined);
          }
        }
        deps.hub.updateAgent(deps.name, { handled: cursor });
      }
    } catch {
      // ignore poll errors
    }
  }

  function start() {
    if (timer) return;
    timer = setInterval(tick, deps.pollMs);
  }

  function stop() {
    if (timer) clearInterval(timer);
    timer = undefined;
  }

  // Skip everything already on the bus (e.g. an agent re-joining an existing
  // fleet) so it only wakes on messages posted after it joined.
  function seekToEnd() {
    cursor = deps.hub.busEnd();
  }

  return { tick, start, stop, flushPending, seekToEnd };
}

export default function (pi: ExtensionAPI) {
  const dir = process.env.PI_FLEET_DIR;
  const maybeName = process.env.PI_FLEET_AGENT;
  if (!dir || !maybeName) return; // loaded outside a fleet — stay silent
  const name: string = maybeName;
  const lean = process.env.PI_FLEET_LEAN === "1";
  const role = process.env.PI_FLEET_ROLE || undefined;
  const hub = new Hub(dir);
  const root = process.env.PI_FLEET_ROOT ?? "";
  const maxTurns = Number(process.env.PI_FLEET_MAX_TURNS ?? DEFAULT_MAX_TURNS);

  let busy = false;
  let turns = 0;
  const fleetCalls = new Map<string, number>(); // how often this run made each exact fleet call
  let stallTimer: ReturnType<typeof setTimeout> | undefined;
  let modelError: string | undefined;
  // What a run needs for its verdict to reach the group. Kept until it settles, past pi's retries.
  let wokenIn: FleetMessage | undefined;
  let lastText = "";
  let sentSinceWake = 0; // pi's retries bring nothing new, so they do not start this again
  let refusedSends = 0;
  let worked = false; // since the last wake
  let askedToWork = false; // this wake's reminder is spent
  const handedTo = new Set<string>(); // who has work from this agent, since the last wake
  const doubted = new Set<string>(); // files it has been warned about, since the last wake
  let braked = false; // the fleet has stopped this run
  let dialogShown = false; // since ask_user was called
  const retryWaits = (process.env.PI_FLEET_RETRY_WAITS ?? RETRY_WAITS).split(",").filter(Boolean).map(Number);
  let failedRuns = 0; // in a row
  let retryTimer: ReturnType<typeof setTimeout> | undefined;
  const poller = createPoller({
    hub,
    name,
    isBusy: () => busy,
    wake: (text) => pi.sendUserMessage(text),
    pollMs: POLL_MS,
    // While the supervisor is attached it pushes wakes directly (rpc.prompt);
    // the poller only self-wakes when the supervisor is gone (detached mode).
    supervisorAlive: () => hub.supervisorAlive(8000),
    maxHops: Number(process.env.PI_FLEET_MAX_HOPS ?? DEFAULT_MAX_HOPS),
  });

  function setBusy(b: boolean) {
    busy = b;
    try {
      hub.updateAgent(name, { status: b ? "busy" : "idle" });
    } catch {
      // hub write failure should not break the agent
    }
    if (!b) poller.flushPending();
  }

  pi.on("session_start", async (_event, ctx) => {
    // Preserve the bridge pid the supervisor registered (used to kill the whole
    // tree); only fall back to this process's pid if none was set.
    const existing = hub.readAgents()[name];
    const pid = existing && existing.pid > 0 ? existing.pid : process.pid;
    hub.updateAgent(name, {
      name,
      pid,
      cwd: ctx.cwd,
      status: "idle",
      startedAt: Date.now(),
      lastReadOffset: hub.messagesSize(),
      sessionFile: ctx.sessionManager.getSessionFile(),
    });
    hub.appendMessage({
      from: "system",
      to: "group",
      kind: "system",
      text: `agent "${name}" joined (cwd: ${ctx.cwd})`,
    });
    poller.seekToEnd();
    poller.start();
  });

  /**
   * What pi could not get past in seconds may pass in minutes, so try again later, through
   * the bus like any message. That way the wake is kept in the inbox, a run in progress is
   * left alone, and a pause holds it. Any new run tries the model anyway, so it replaces this.
   */
  function afterModelError(error: string, origin: FleetMessage | undefined): void {
    const reason = error.replace(/\.$/, "");
    const giveUp = () => {
      failedRuns = 0;
      hub.appendMessage({ from: "system", to: "group", kind: "system", text: `agent "${name}" stopped on a model error: ${reason}. Test the model in Settings → Models, or with fleet doctor.` });
    };
    const wait = waitingHelps(error) ? retryWaits[failedRuns] : undefined;
    if (wait === undefined) return giveUp();
    failedRuns++;
    const asked = Date.now();
    hub.updateAgent(name, { waitingUntil: asked + wait });
    const words = wait < 60000 ? `${wait / 1000}s` : `${wait / 60000}m`;
    hub.appendMessage({ from: "system", to: "group", kind: "system", text: `agent "${name}" got a model error: ${reason}. It tries again in ${words} (${failedRuns} of ${retryWaits.length}), unless you write first or use Stop all.` });
    retryTimer = setTimeout(() => {
      if (hub.pausedReason() !== null || hub.tailMessages(500).some((m) => m.from === "user" && m.ts >= asked)) return giveUp();
      if (hub.readInbox(name).length > 0) return; // a wake is on its way
      hub.appendMessage({ from: "system", to: name, kind: "chat", text: `Your model failed before you finished (${reason}). Check what is already done, then carry on.`, replyTo: origin?.id });
    }, wait);
    retryTimer.unref();
  }

  pi.on("agent_start", () => {
    turns = 0;
    braked = false;
    fleetCalls.clear();
    clearTimeout(retryTimer);
    setBusy(true);
  });
  pi.on("agent_settled", (event) => {
    clearTimeout(stallTimer);
    // an abort reaches a model call in progress as an error, but nothing went wrong with the model
    if (modelError && !event.aborted) {
      afterModelError(modelError, wokenIn);
    } else {
      failedRuns = 0;
      if (wokenIn && sentSinceWake === 0 && worked && !event.aborted) {
        // a weak model can write its verdict here instead of sending it, and the chain then just stops
        const verdict = verdictMessage(lastText, name);
        if (verdict) hub.appendMessage({ from: name, to: wokenIn.to, kind: "chat", text: verdict });
      }
    }
    modelError = undefined;
    wokenIn = undefined;
    lastText = "";
    setBusy(false);
  });

  const textIn = (content: unknown): string => (Array.isArray(content) ? content.filter((b) => b.type === "text").map((b) => b.text).join("") : String(content ?? ""));

  // pi retries failed requests by itself, so only the last answer of a run counts.
  pi.on("message_end", (event) => {
    const m = event.message as { role: string; stopReason?: string; errorMessage?: string; content?: unknown };
    if (m.role === "user") {
      wokenIn = wakeOrigin(textIn(m.content), hub);
      sentSinceWake = 0;
      refusedSends = 0;
      worked = false;
      askedToWork = false;
      handedTo.clear();
      doubted.clear();
    }
    if (m.role === "assistant") {
      modelError = m.stopReason === "error" ? (m.errorMessage ?? "unknown error") : undefined;
      lastText = textIn(m.content);
    }
  });

  // A model that goes quiet looks exactly like a slow one, and the turn limit below only
  // counts finished turns. Only the wait for the model is timed: tools may take as long as they like.
  function watchModel(): void {
    clearTimeout(stallTimer);
    if (STALL_MS === 0) return;
    stallTimer = setTimeout(() => {
      hub.appendMessage({
        from: "system",
        to: "group",
        kind: "system",
        text: `agent "${name}" has had no answer from its model for ${Math.round(STALL_MS / 1000)}s. It is still waiting; Stop or Stop all ends the wait.`,
      });
    }, STALL_MS);
    stallTimer.unref();
  }
  pi.on("turn_start", watchModel);
  pi.on("message_update", watchModel);
  pi.on("tool_execution_start", () => clearTimeout(stallTimer));

  /** The run's fleet calls repeat with no end in sight. */
  function repeatsItself(message: unknown): boolean {
    const content = (message as { content?: { type: string; name?: string; arguments?: unknown }[] } | undefined)?.content ?? [];
    let repeated = false;
    for (const block of content) {
      if (block.type !== "toolCall" || !FLEET_TOOLS.has(block.name ?? "")) continue;
      const call = `${block.name} ${JSON.stringify(block.arguments)}`;
      const count = (fleetCalls.get(call) ?? 0) + 1;
      fleetCalls.set(call, count);
      if (count === REPEAT_LIMIT) repeated = true;
    }
    return repeated;
  }

  // A weak model writes to a path it made up, or does the implementer's job itself, and reports the
  // work done. The person then finds nothing, or work nobody looked at. Refused once per file and
  // wake, because it may be what was asked for.
  function doubtfulWrite(tool: string, input: { path?: unknown }, cwd: string): string | undefined {
    if ((tool !== "write" && tool !== "edit") || typeof input.path !== "string" || doubted.has(input.path)) return undefined;
    const from = pathInside(cwd, input.path);
    const implementer = role === "planner" && !from?.startsWith(`openspec${path.sep}`) ? implementerIn(hub.readAgents()) : undefined;
    if (from !== undefined && !implementer) return undefined;
    doubted.add(input.path);
    if (from === undefined) return `Not written: ${input.path} is outside your working directory, ${cwd}. Use a path relative to it. If you really mean that place, write it again.`;
    return `Not written: ${implementer} writes the code, not you. Give it the work with fleet_mention. If this file really is part of your plan, write it again.`;
  }

  // pi reports a call before it asks here, so this is where a refused call can still not count as work.
  pi.on("tool_call", async (event, ctx) => {
    if (handoffDone()) return { block: true, reason: `Not done: ${[...handedTo].join(", ")} has the work, so your run is over.`, terminate: true };
    const doubt = doubtfulWrite(event.toolName, event.input as { path?: unknown }, ctx.cwd);
    if (doubt) return { block: true, reason: doubt };
    if (APPROVE_TOOLS.has(event.toolName)) {
      const allowed = await ctx.ui.confirm(`Allow ${event.toolName}?`, JSON.stringify(event.input).slice(0, 300), { signal: ctx.signal });
      if (!allowed) return { block: true, reason: "A person declined this tool call." };
    }
    if (event.toolName === "ask_user") dialogShown = false;
    if (countsAsWork(event.toolName, role)) worked = true;
    return undefined;
  });

  // pix-ask's ask_user cannot show its questionnaire here, so it reports the questions turned
  // down without showing them. Ask them as dialogs instead, unless the tool showed one itself.
  pi.on("ui_prompt_start", (event) => {
    if (event.kind !== "custom") dialogShown = true;
  });
  pi.on("tool_result", async (event, ctx) => {
    const questions = event.toolName === "ask_user" && !dialogShown && !ctx.signal?.aborted ? questionsIn(event.input) : undefined;
    if (!questions || !declinedAll(event.details)) return undefined;
    const result = await askInDialogs(ctx.ui, questions, ctx.signal);
    return { content: [{ type: "text" as const, text: answerText(result, questions) }], details: result, isError: false };
  });

  /** Everyone who can take a planner's work has it. The implementer brings in the reviewer. */
  function handoffDone(): boolean {
    if (role !== "planner" || handedTo.size === 0) return false;
    return Object.values(hub.readAgents()).every((a) => a.name === name || handedTo.has(a.name) || a.status === "stopped" || a.role === "reviewer" || a.role === "supervisor");
  }

  // Some models never end a run on their own. Counted here, not in the supervisor,
  // so the limits also hold in detached mode, when nobody is watching.
  pi.on("turn_end", (event, ctx) => {
    clearTimeout(stallTimer);
    const stop = (reason: string) => {
      if (braked) return;
      braked = true;
      hub.appendMessage({ from: "system", to: "group", kind: "system", text: `agent "${name}" was stopped: ${reason}. Send it a message to continue.` });
      ctx.abort();
    };
    if (repeatsItself(event.message)) stop(`it made the same fleet call ${REPEAT_LIMIT} times in one run`);
    else if (refusedSends >= REFUSED_SEND_LIMIT) stop("it kept sending messages after it was told to end its turn");
    else if (++turns === maxTurns) stop(`${maxTurns} turns in one run (limit: --max-turns)`);
  });

  pi.on("session_shutdown", () => {
    poller.stop();
    clearTimeout(retryTimer);
    try {
      hub.updateAgent(name, { status: "stopped" });
      hub.appendMessage({
        from: "system",
        to: "group",
        kind: "system",
        text: `agent "${name}" left`,
      });
    } catch {
      // ignore
    }
  });

  // System prompt section, present for every run (roster is live — rebuilt each turn)
  pi.on("before_agent_start", (event) => {
    const roster = buildRoster(hub, name, lean);
    event.systemPromptOptions.sections["fleet"] = fleetPrompt(name, lean, roster, role);
  });

  // ---------- tools ----------

  // A message to yourself wakes nobody, yet the tool call reads like a successful
  // handoff and the model ends its turn. Refusing it keeps the work in this turn.
  const selfAddressed = () => ({
    content: [{ type: "text" as const, text: `You are "${name}": a message to yourself wakes nobody. Do the work now, in this turn.` }],
    details: undefined,
  });

  const refused = (text: string) => ({ content: [{ type: "text" as const, text }], details: undefined });

  // Weaker models keep inventing work after a handoff, so the way out is the last thing they read.
  const WOKEN_BY_REPLY = "you will be woken when someone replies, so do not wait for them, check on them or do their work.";
  const END_OF_HANDOFF = ` If nothing else is assigned to you, end your turn now: ${WOKEN_BY_REPLY}`;

  const overSendLimit = () => {
    refusedSends++;
    return refused(`Not sent: that makes ${SEND_LIMIT + 1} messages since anything arrived for you. End your turn now: ${WOKEN_BY_REPLY}`);
  };

  // A weak model reports work instead of doing it, and everyone else takes the report at its
  // word. Once per wake, so that a question or a real blocker still gets through.
  const nothingDoneYet = () => {
    if (worked || askedToWork || (role !== "implementer" && role !== "reviewer")) return undefined;
    askedToWork = true;
    return refused("Not sent: you have not used a tool on this yet, and a message does no work. Do what was asked now, with your tools, in this run, then report what you did. If it really needs no work, or you are blocked, send this again.");
  };

  // A planner that stays on after its handoff goes over its plan again and sends the same work
  // a second time, and its status posts wake the others. That was half the tokens of a real run.
  const alreadyHandedOff = (targets: string[]) => {
    if (role !== "planner" || handedTo.size === 0 || targets.some((t) => !handedTo.has(t))) return undefined;
    refusedSends++;
    return refused(`Not sent: ${[...handedTo].join(", ")} already has the work. End your turn now: ${WOKEN_BY_REPLY}`);
  };

  // Nothing is left to say after these, and a real reviewer went on to send the same APPROVE twice.
  const lastWord = (text: string) => handoffDone() || (role === "reviewer" && VERDICT.test(text));

  const fleetSend = defineTool({
    name: "fleet_send",
    label: "Fleet send",
    description:
      'Send a message on the fleet bus. to="group" broadcasts to the shared channel; to="<agent name>" sends a direct message to that agent.',
    parameters: Type.Object({
      to: Type.String({ description: '"group" or an agent name (see fleet_agents)' }),
      text: Type.String({ description: "Message text (concise, actionable)" }),
      replyTo: Type.Optional(
        Type.String({ description: "Optional id of a message you are replying to (shown in parentheses in the inbox) — threads the conversation" }),
      ),
    }),
    async execute(_id, params) {
      const to = params.to.trim();
      const mentions = mentionedAgents(params.text);
      if (to === name || (mentions.length > 0 && mentions.every((a) => a === name))) return selfAddressed();
      if (!hub.targetKind(to)) return refused(hub.unknownTarget(to));
      const tooLong = messageTooLong(params.text);
      if (tooLong) return refused(`Not sent: ${tooLong}`);
      const notYet = nothingDoneYet();
      if (notYet) return notYet;
      if (sentSinceWake >= SEND_LIMIT) return overSendLimit();
      const targets = hub.targetKind(to) === "agent" ? [to] : addressedAgents({ from: name, text: params.text });
      const again = alreadyHandedOff(targets);
      if (again) return again;
      const msg = hub.appendMessage({ from: name, to, kind: "chat", text: params.text, replyTo: params.replyTo });
      sentSinceWake++;
      for (const t of targets) handedTo.add(t);
      return {
        content: [{ type: "text" as const, text: `Sent to ${addressLabel(to, hub.readChannels())}: ${msg.text}${END_OF_HANDOFF}` }],
        details: { messageId: msg.id, to },
        terminate: lastWord(params.text),
      };
    },
  });

  const fleetInbox = defineTool({
    name: "fleet_inbox",
    label: "Fleet inbox",
    description: "Read recent fleet messages addressed to you or to the group.",
    parameters: Type.Object({
      limit: Type.Optional(Type.Number({ description: "Max messages (default 20)" })),
    }),
    async execute(_id, params) {
      const limit = params.limit ?? 20;
      const all = hub.tailMessages(limit * 5);
      const relevant = all.filter(
        (m) => m.kind !== "activity" && (m.to === name || m.to === "group"),
      );
      const msgs = relevant.slice(-limit);
      if (msgs.length === 0) {
        return { content: [{ type: "text" as const, text: "No fleet messages." }], details: undefined };
      }
      return {
        content: [{ type: "text" as const, text: formatInbox(msgs, buildLookup(hub), hub.readChannels()).replace(/^New fleet messages for you:\n/, "") }],
        details: { count: msgs.length },
      };
    },
  });

  const fleetAgents = defineTool({
    name: "fleet_agents",
    label: "Fleet agents",
    description: "List all agents in the fleet with their status and working directory.",
    parameters: Type.Object({}),
    async execute() {
      const agents = Object.values(hub.readAgents()) as AgentInfo[];
      if (agents.length === 0) {
        return { content: [{ type: "text" as const, text: "No agents registered." }], details: undefined };
      }
      const lines = agents.map(
        (a) => `- ${a.name} [${a.status}] cwd: ${a.cwd}${a.name === name ? " (you)" : ""}`,
      );
      return { content: [{ type: "text" as const, text: lines.join("\n") }], details: { agents } };
    },
  });

  const fleetMention = defineTool({
    name: "fleet_mention",
    label: "Fleet mention",
    description:
      "Post to the group channel @mentioning one or more agents. Only the mentioned agents are woken (everyone else stays idle). Use this to direct work to specific teammates by name.",
    parameters: Type.Object({
      agents: Type.Array(Type.String({ description: "Agent name(s) to @mention (see fleet_agents)" })),
      text: Type.String({ description: "Message text (concise, actionable)" }),
      replyTo: Type.Optional(
        Type.String({ description: "Optional id of a message you are replying to (threads the conversation)" }),
      ),
    }),
    async execute(_id, params) {
      const targets = params.agents.filter((a) => a !== name);
      if (targets.length === 0) return selfAddressed();
      const agents = hub.readAgents();
      const unknown = targets.filter((a) => !agents[a]);
      if (unknown.length > 0) {
        return {
          content: [
            {
              type: "text" as const,
              text: `Unknown agent(s): ${unknown.join(", ")}. Available: ${Object.keys(agents).join(", ") || "(none)"}`,
            },
          ],
          details: undefined,
        };
      }
      const mentions = targets.map((a) => `@${a}`).join(" ");
      const text = mentionText(targets, params.text);
      const tooLong = messageTooLong(text);
      if (tooLong) return refused(`Not sent: ${tooLong}`);
      const notYet = nothingDoneYet();
      if (notYet) return notYet;
      if (sentSinceWake >= SEND_LIMIT) return overSendLimit();
      const again = alreadyHandedOff(targets);
      if (again) return again;
      const msg = hub.appendMessage({
        from: name,
        to: "group",
        kind: "chat",
        text,
        replyTo: params.replyTo,
      });
      sentSinceWake++;
      for (const t of targets) handedTo.add(t);
      return {
        content: [{ type: "text" as const, text: `Mentioned ${mentions} in #group: ${msg.text}${END_OF_HANDOFF}` }],
        details: { messageId: msg.id, mentioned: targets },
        terminate: lastWord(params.text),
      };
    },
  });

  // Task-board tool: runs the selected CLI (openspec by default, or `bd` for beads).
  const makeTaskBoardTool = (name: string, label: string, description: string, bin: () => string[], prepare = (args: string[]) => args) =>
    defineTool({
      name,
      label,
      description,
      parameters: Type.Object({
        args: Type.String({ description: `${label} CLI arguments` }),
      }),
      async execute(_id, params) {
        const [file, ...prefix] = bin();
        const result = await new Promise<{ ok: boolean; output: string }>((resolve) => {
          const child = execFile(
            file,
            [...prefix, ...prepare(params.args.split(/\s+/).filter(Boolean))],
            { cwd: process.cwd(), timeout: 120000, maxBuffer: 1024 * 1024, windowsHide: true },
            (err, stdout, stderr) => {
              const output = [stdout, stderr].filter(Boolean).join("\n").trim() || "(no output)";
              resolve({ ok: !err, output });
            },
          );
          child.stdin?.end(); // nobody can answer a CLI prompt here: fail at once, not at the timeout
        });
        return {
          content: [{ type: "text" as const, text: result.ok ? result.output : `${name} failed:\n${result.output}` }],
          details: { ok: result.ok },
        };
      },
    });

  const taskBoardTool =
    TASKBOARD === "beads"
      ? makeTaskBoardTool(
          "beads",
          "Beads",
          "Run the beads (bd) issue tracker in the working directory. Requires `bd` on PATH (run `bd init` once in the project first). Examples: \"create <title>\", \"list\", \"show <id>\", \"close <id>\" (mark done), \"update <id> -s in_progress\", \"comment <id> <text>\". Use it to create and track issues/tasks.",
          () => [onPath("bd") ?? "bd"],
        )
      : makeTaskBoardTool(
          "openspec",
          "OpenSpec",
          "Run the OpenSpec CLI in the working directory. Examples: \"list\", \"show <change-id>\", \"validate <change-id>\", \"archive <change-id>\", \"init\". Use it to create and track change proposals (openspec/changes/<id>/ with proposal.md, tasks.md, specs/).",
          () => packageBinArgv(root, "@fission-ai/openspec", "openspec"),
          openspecArgs,
        );

  // Supervisor routing tool: route a channel message to the members who should
  // respond, and update the channel's rolling summary. Directed messages carry
  // the summary so members have context without reading the full transcript.
  // Models can replay a routing task within one turn: each message is routed once,
  // or the DMs would go out again and a self-routed model would redo the work.
  const routedIds = new Set<string>();
  const routeTool = defineTool({
    name: "route",
    label: "Route message",
    description:
      "Supervisor tool: route a channel message to the members who should respond and update the channel summary. Only the channel's supervisor should call this. respond may be empty (nobody needs to act).",
    parameters: Type.Object({
      channel: Type.String({ description: "Channel name to route in" }),
      respond: Type.Array(Type.String({ description: "Member names who should respond (empty list if nobody)" })),
      summary: Type.Optional(Type.String({ description: "Updated rolling summary of the channel (factual, compact, under ~500 chars)" })),
      messageId: Type.Optional(Type.String({ description: "id of the message being routed (from the routing task)" })),
    }),
    async execute(_id, params) {
      const channel = hub.getChannel(params.channel);
      if (!channel) {
        return {
          content: [{ type: "text" as const, text: `Unknown channel "${params.channel}". Channels: ${hub.readChannels().map((c) => c.name).join(", ") || "(none)"}.` }],
          details: undefined,
        };
      }
      const all = hub.tailMessages(80);
      let target = params.messageId
        ? all.find((m) => m.id === params.messageId || shortId(m.id) === params.messageId)
        : undefined;
      if (!target) {
        target = [...all].reverse().find((m) => m.to === params.channel && m.kind === "chat" && m.from !== name);
      }
      if (!target) {
        return { content: [{ type: "text" as const, text: `No message found to route in #${params.channel}.` }], details: undefined };
      }
      if (routedIds.has(target.id)) {
        return {
          content: [{ type: "text" as const, text: `Message ${shortId(target.id)} is already routed, so do not route it again. Finish any work you took on and end your turn.` }],
          details: undefined,
        };
      }
      routedIds.add(target.id);
      const agents = hub.readAgents();
      const valid = params.respond.filter((a) => agents[a]);
      const unknown = params.respond.filter((a) => !agents[a]);
      const summary = (params.summary && params.summary.trim()) || channel.summary || "";
      const sent = applyRoute(hub, name, channel, target, valid, summary);
      if (params.respond.includes(name)) wokenIn = target; // it took the channel's work on itself
      const note = unknown.length ? ` (unknown: ${unknown.join(", ")})` : "";
      const selfNote = params.respond.includes(name) ? ". You picked yourself: do that work once, now, then end your turn" : "";
      return {
        content: [{ type: "text" as const, text: `Routed #${params.channel} message to: ${sent.join(", ") || "(nobody)"}${note}${selfNote}` }],
        details: { channel: params.channel, routed: sent, summary: summary || undefined },
      };
    },
  });

  pi.registerTool(fleetSend);
  pi.registerTool(fleetMention);
  pi.registerTool(fleetInbox);
  pi.registerTool(fleetAgents);
  pi.registerTool(routeTool);
  pi.registerTool(taskBoardTool);

  // ---------- commands ----------

  pi.registerCommand("agents", {
    description: "List fleet agents and their status",
    handler: async (_args, ctx) => {
      const agents = Object.values(hub.readAgents());
      const text = agents.length
        ? agents.map((a) => `- ${a.name} [${a.status}] cwd: ${a.cwd}`).join("\n")
        : "No agents registered.";
      ctx.ui.notify(text, "info");
    },
  });

  pi.registerCommand("send", {
    description: 'Send a fleet message (usage: /send <group|agent> <text>)',
    handler: async (args, ctx) => {
      const m = args.match(/^(\S+)\s+([\s\S]+)$/);
      if (!m) {
        ctx.ui.notify("Usage: /send <group|agent-name> <text>", "error");
        return;
      }
      if (!hub.targetKind(m[1])) {
        ctx.ui.notify(hub.unknownTarget(m[1]), "error");
        return;
      }
      hub.appendMessage({ from: name, to: m[1], kind: "chat", text: m[2].trim() });
      ctx.ui.notify(`Sent to ${addressLabel(m[1], hub.readChannels())}`, "info");
    },
  });

  pi.registerCommand("group", {
    description: "Send a message to the fleet group channel (usage: /group <text>)",
    handler: async (args, ctx) => {
      if (!args.trim()) {
        ctx.ui.notify("Usage: /group <text>", "error");
        return;
      }
      hub.appendMessage({ from: name, to: "group", kind: "chat", text: args.trim() });
      ctx.ui.notify("Sent to #group", "info");
    },
  });
}