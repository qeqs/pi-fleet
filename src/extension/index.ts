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
import { Type } from "@earendil-works/pi-ai";
import { defineTool, type ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { execFile } from "node:child_process";
import { Hub, shortId, MAX_MESSAGE_LEN, truncateMessage, DEFAULT_CHANNEL, DEFAULT_MAX_HOPS, DEFAULT_MAX_TURNS, type AgentInfo, type FleetMessage, type ChannelConfig } from "../hub.ts";
import { packageBinArgv } from "../rpc.ts";

const POLL_MS = Number(process.env.PI_FLEET_POLL_MS ?? 3000);

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
    : "Use the openspec tool for planning and tracking work: create change proposals under openspec/changes/, keep tasks.md updated, validate before finishing, archive when done.";

/** Task-board-specific quality gate (for the system prompt). */
const TASKBOARD_GATE =
  TASKBOARD === "beads"
    ? "Quality gate: before marking an issue done, run \"beads list\" to confirm its state and post the result to the thread."
    : "Quality gate: run `openspec validate <id>` and post the result before marking a task done.";

/** Role-specific instructions appended to the fleet prompt (planner/implementer/reviewer). */
export function rolePrompt(role: string | undefined): string {
  const tb = TASKBOARD;
  const validate = tb === "beads" ? 'run the beads tool ("list") to confirm state' : `run \`openspec validate <id>\``;
  switch (role) {
    case "planner":
      return `

Your role: PLANNER.
- Break goals into concrete, verifiable tasks and record them in the ${tb} task board.
- Assign work by @mentioning the right agent (e.g. an implementer). Do NOT implement code yourself.
- Track progress in the bus; when an implementer reports a task done, confirm and move to the next task or request review.`;
    case "implementer":
      return `

Your role: IMPLEMENTER.
- Implement the tasks assigned to you. Follow the quality gate: ${validate} and post the result before marking a task done.
- When a task is complete, @mention the reviewer (or the planner) with a summary of what changed and where.`;
    case "reviewer":
      return `

Your role: REVIEWER.
- When asked to review work, inspect the change (files + ${tb} task board), ${validate}, and smoke-test where practical.
- Reply with exactly \`APPROVE\` or \`REQUEST CHANGES: <specific, actionable reasons>\`. Be concrete.`;
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

export function fleetPrompt(name: string, lean: boolean, roster: string, role?: string): string {
  if (lean) {
    // Compact for small models: same rules, fewer words.
    return `You are "${name}", an agent in a multi-agent fleet with a shared message bus.
Fleet (you are "${name}"): ${roster}
- You are woken when messages arrive (@mentions of you, or a routing supervisor directs one to you).
- Reply with fleet_send: to="group" or to a channel name, or to="<agent>". Keep it short.
- Use fleet_mention to @mention one or more agents — only they wake.
- To reply to a specific message, pass its id (in parentheses) as replyTo.
- ${TASKBOARD_PLAN}
- ${TASKBOARD_GATE}
- Review: when asked to review work, reply "APPROVE" or "REQUEST CHANGES: <reasons>".` + rolePrompt(role);
  }
  return `You are "${name}", one agent in a multi-agent fleet. Other agents and the user talk to you through a shared message bus with named channels.

Fleet members (you are "${name}"):
${roster}

Fleet rules:
- You are woken automatically when new messages arrive. Check them with fleet_inbox if you need history.
- Reply with fleet_send: to="group" or a channel name for a shared channel, to="<agent name>" for a direct message. Keep messages concise and actionable.
- In a supervised channel, a supervisor routes work to you; when you finish, send your result back to that channel.
- Use fleet_mention to @mention one or more agents in the group — only the mentioned agents wake.
- Each message has a short id in parentheses. To reply to a specific message, pass that id as replyTo — this threads the conversation.
- ${TASKBOARD_PLAN}
- **${TASKBOARD_GATE}**
- **Review protocol**: when another agent asks you to review their work, reply with either \`APPROVE\` or \`REQUEST CHANGES: <specific, actionable reasons>\`. Be concrete about what must change.
- Coordinate: when you finish work another agent depends on, or need a decision, send them a message instead of guessing.
- Use fleet_agents to see who is available and what they are doing.` + rolePrompt(role);
}

export function buildLookup(hub: Hub): Map<string, FleetMessage> {
  const map = new Map<string, FleetMessage>();
  for (const m of hub.tailMessages(500)) {
    map.set(m.id, m);
    map.set(shortId(m.id), m);
  }
  return map;
}

/** Agent names @mentioned in a message (e.g. "@bob" -> ["bob"]). */
function mentionedAgents(text: string): string[] {
  const out: string[] = [];
  const re = /@([A-Za-z0-9_-]+)/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text)) !== null) out.push(m[1]);
  return out;
}

/** The channel's routing supervisor: explicit, else the first member. */
export function defaultSupervisor(channel: ChannelConfig): string | undefined {
  if (channel.supervisor) return channel.supervisor;
  return channel.members[0];
}

/**
 * How (and whether) an agent is woken by a message, given the channel set.
 *  - DM (to === name): wake, normal mode.
 *  - channel message @mentioning members: ONLY those members wake, normal mode
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
    const mentions = mentionedAgents(m.text).filter((a) => channel.members.includes(a));
    if (mentions.length > 0) return { wake: mentions.includes(name), mode: "normal" };
    const sup = defaultSupervisor(channel);
    if (sup) {
      return name === sup ? { wake: true, mode: "route", channel } : { wake: false, mode: "normal" };
    }
    return channel.members.includes(name) ? { wake: true, mode: "normal", channel } : { wake: false, mode: "normal" };
  }
  // legacy "group" with no channel config: broadcast (backward compatible)
  if (m.to === DEFAULT_CHANNEL) {
    const mentions = mentionedAgents(m.text);
    if (mentions.length > 0) return { wake: mentions.includes(name), mode: "normal" };
    if (m.replyTo) {
      const orig = lookup.get(m.replyTo);
      if (orig) {
        const participants = new Set<string>([orig.from]);
        if (orig.to !== DEFAULT_CHANNEL) participants.add(orig.to);
        for (const a of mentionedAgents(orig.text)) participants.add(a);
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
  hub.pause(`${maxHops} agent messages since your last message (limit: --max-hops)`);
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
 * The context attached to a directed message the supervisor routes to a member:
 * the original message plus the channel summary, so the member has context
 * without reading the full transcript.
 */
export function directedMessageText(channel: ChannelConfig, m: FleetMessage, summary: string): string {
  const parts = [`[#${channel.name}] ${m.from} said: "${m.text}"`];
  if (summary && summary.trim() && summary.trim() !== "(no summary yet)") {
    parts.push(`Channel summary: ${summary.trim()}`);
  }
  parts.push(`Respond with fleet_send to "${channel.name}" if a reply is needed.`);
  return parts.join("\n");
}

export function formatInbox(messages: FleetMessage[], lookup: Map<string, FleetMessage>): string {
  const lines = messages.map((m) => {
    const t = new Date(m.ts).toLocaleTimeString([], { hour12: false });
    const target = m.to === "group" ? "#group" : `@${m.to}`;
    const orig = m.replyTo ? lookup.get(m.replyTo) : undefined;
    const reply = m.replyTo ? ` (↪ replying to ${orig ? orig.from : shortId(m.replyTo)})` : "";
    return `(${shortId(m.id)}) [${t}] ${m.from} → ${target}${reply}: ${m.text}`;
  });
  return (
    `New fleet messages for you:\n${lines.join("\n")}\n\n` +
    `Respond with fleet_send (to="group" or to a specific agent) if a reply is needed. ` +
    `To reply to a specific message, pass its id (in parentheses) as replyTo.`
  );
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
  let lastOffset = 0;
  let myGen = deps.hub.generation();
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
      const gen = deps.hub.generation();
      if (gen !== myGen) {
        // bus was rotated — reset our read offset to the start of the new file
        lastOffset = 0;
        myGen = gen;
      }
      const { messages, nextOffset } = deps.hub.readMessagesSince(lastOffset);
      lastOffset = nextOffset;
      if (messages.length > 0) {
        const lookup = buildLookup(deps.hub);
        const channels = deps.hub.readChannels();
        const agents = Object.values(deps.hub.readAgents());
        const attached = deps.supervisorAlive?.() ?? false;
        const relevant: FleetMessage[] = [];
        let routeText = "";
        for (const m of messages) {
          if (!attached && !admitMessage(m, deps.hub, deps.maxHops ?? 0)) continue;
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
          const inbox = relevant.length > 0 ? formatInbox(relevant, lookup) : "";
          const combined = routeText && inbox ? `${routeText}\n\n${inbox}` : routeText || inbox;
          if (attached) {
            // supervisor is attached and will push this wake directly — don't
            // self-wake (the offset already advanced above, so no double-wake).
          } else if (deps.isBusy()) {
            pending = pending ? `${pending}\n\n${combined}` : combined;
          } else {
            deps.wake(combined);
          }
        }
      }
      try {
        deps.hub.updateAgent(deps.name, { lastReadOffset: nextOffset });
      } catch {
        // ignore
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
    lastOffset = deps.hub.messagesSize();
    myGen = deps.hub.generation();
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

  pi.on("agent_start", () => {
    turns = 0;
    setBusy(true);
  });
  pi.on("agent_settled", () => setBusy(false));

  // Some models never end a run on their own. Counted here, not in the supervisor,
  // so the limit also holds in detached mode, when nobody is watching.
  pi.on("turn_end", (_event, ctx) => {
    if (++turns !== maxTurns) return;
    hub.appendMessage({
      from: "system",
      to: "group",
      kind: "system",
      text: `agent "${name}" was stopped after ${maxTurns} turns in one run (limit: --max-turns). Send it a message to continue.`,
    });
    ctx.abort();
  });

  pi.on("session_shutdown", () => {
    poller.stop();
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

  // Weaker models keep inventing work after a handoff, so the way out is the last thing they read.
  const END_OF_HANDOFF = " If nothing else is assigned to you, end your turn now.";

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
      if (to !== "group" && to !== DEFAULT_CHANNEL) {
        const agents = hub.readAgents();
        const isChannel = hub.readChannels().some((c) => c.name === to);
        if (!agents[to] && !isChannel) {
          return {
            content: [
              {
                type: "text" as const,
                text: `Unknown target "${to}". Agents: ${Object.keys(agents).join(", ") || "(none)"}. Channels: ${hub.readChannels().map((c) => c.name).join(", ") || "(none)"}.`,
              },
            ],
            details: undefined,
          };
        }
      }
      const msg = hub.appendMessage({ from: name, to, kind: "chat", text: params.text, replyTo: params.replyTo });
      const { truncated } = truncateMessage(params.text);
      const note = truncated
        ? `\n(note: message was longer than ${MAX_MESSAGE_LEN} chars and was truncated — split long content into several messages)`
        : "";
      const targetLabel = to === "group" || to === DEFAULT_CHANNEL ? "#" + to : hub.readChannels().some((c) => c.name === to) ? "#" + to : "@" + to;
      return {
        content: [{ type: "text" as const, text: `Sent to ${targetLabel}: ${msg.text}${note}${END_OF_HANDOFF}` }],
        details: { messageId: msg.id, to, truncated },
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
        content: [{ type: "text" as const, text: formatInbox(msgs, buildLookup(hub)).replace(/^New fleet messages for you:\n/, "") }],
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
      const msg = hub.appendMessage({
        from: name,
        to: "group",
        kind: "chat",
        text: `${mentions} ${params.text}`,
        replyTo: params.replyTo,
      });
      return {
        content: [{ type: "text" as const, text: `Mentioned ${mentions} in #group: ${msg.text}${END_OF_HANDOFF}` }],
        details: { messageId: msg.id, mentioned: targets },
      };
    },
  });

  // Task-board tool: runs the selected CLI (openspec by default, or `bd` for beads).
  const makeTaskBoardTool = (name: string, label: string, description: string, bin: () => string[]) =>
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
            [...prefix, ...params.args.split(/\s+/).filter(Boolean)],
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
          () => [process.platform === "win32" ? "bd.exe" : "bd"],
        )
      : makeTaskBoardTool(
          "openspec",
          "OpenSpec",
          "Run the OpenSpec CLI in the working directory. Examples: \"list\", \"show <change-id>\", \"validate <change-id>\", \"archive <change-id>\", \"init\". Use it to create and track change proposals (openspec/changes/<id>/ with proposal.md, tasks.md, specs/).",
          () => packageBinArgv(root, "@fission-ai/openspec", "openspec"),
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
      if (params.summary && params.summary.trim()) hub.setChannelSummary(params.channel, params.summary.trim());
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
      const sent: string[] = [];
      for (const member of valid) {
        if (member === name) continue; // supervisor responds directly in-turn, no self-DM
        hub.appendMessage({
          from: name,
          to: member,
          kind: "chat",
          text: directedMessageText(channel, target, summary),
          replyTo: target.id,
        });
        sent.push(member);
      }
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
      hub.appendMessage({ from: name, to: m[1], kind: "chat", text: m[2].trim() });
      ctx.ui.notify(`Sent to ${m[1] === "group" ? "#group" : "@" + m[1]}`, "info");
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