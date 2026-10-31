/**
 * Fleet hub — file-based message bus + agent registry.
 *
 * Everything lives in a plain directory (default: <cwd>/.pi-fleet):
 *   messages.jsonl  append-only message log (the group chat + DMs)
 *   agents.json     agent registry (name -> pid, cwd, status, read offset)
 *
 * File-based so it works across processes (fleet supervisor + pi agents),
 * is human-readable/debuggable, and survives restarts.
 */
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";

export type MessageKind = "chat" | "system" | "activity";

/**
 * Hard cap on a single bus message's text length. Very long lines would bloat
 * messages.jsonl and the inbox prompt (especially for small models). Override
 * with the PI_FLEET_MAX_MSG env var. Agents can split longer content into
 * several messages.
 */
export const MAX_MESSAGE_LEN: number = (() => {
  const v = parseInt(process.env.PI_FLEET_MAX_MSG ?? "", 10);
  return Number.isFinite(v) && v > 0 ? v : 2000;
})();

export function truncateMessage(text: string, max: number = MAX_MESSAGE_LEN): { text: string; truncated: boolean } {
  if (text.length <= max) return { text, truncated: false };
  return { text: text.slice(0, max) + "…(truncated)", truncated: true };
}

/** Turns one agent may take in a single run before it is aborted (0 = no limit). */
export const DEFAULT_MAX_TURNS = 100;

/** Messages agents may exchange since the human last spoke before the fleet pauses (0 = no limit). */
export const DEFAULT_MAX_HOPS = 40;

/** How far back the hop count looks; well past any sensible --max-hops. */
const HOP_WINDOW = 2000;

/** How long (ms) a shared file may stay locked by readers before a write gives up. */
const REPLACE_TIMEOUT_MS = 1500;

/**
 * Atomically replace `target`. On Windows the rename fails (EPERM) while any
 * process has the target open, and the supervisor and every agent keep reading
 * these files, so a write has to wait out the readers.
 */
function replaceFile(target: string, content: string): void {
  const tmp = `${target}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, content, "utf8");
  const deadline = Date.now() + REPLACE_TIMEOUT_MS;
  for (;;) {
    try {
      fs.renameSync(tmp, target);
      return;
    } catch (e) {
      const code = (e as NodeJS.ErrnoException).code;
      if ((code !== "EPERM" && code !== "EACCES" && code !== "EBUSY") || Date.now() > deadline) throw e;
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 5); // ~5ms sleep
    }
  }
}

export interface FleetMessage {
  id: string;
  ts: number;
  /** "user", "system", or an agent name */
  from: string;
  /** "group" or an agent name */
  to: string;
  kind: MessageKind;
  text: string;
  /** id of the message this one replies to (threading) */
  replyTo?: string;
}

export type AgentStatus = "starting" | "idle" | "busy" | "stopped";

/**
 * A named group chat (channel). Members are agent names; the supervisor is the
 * member that routes each message to the relevant members and maintains the
 * rolling summary. If supervisor is unset, the first member is used.
 */
export interface ChannelConfig {
  name: string;
  members: string[];
  /** agent name that routes + summarizes for this channel (default: first member) */
  supervisor?: string;
  /** optional model override for the supervisor (e.g. a cheap router model) */
  supervisorModel?: string;
  /** rolling summary of the channel, maintained by the supervisor */
  summary?: string;
}

/** The default channel name (the legacy "group" broadcast room). */
export const DEFAULT_CHANNEL = "group";

export interface AgentInfo {
  name: string;
  pid: number;
  cwd: string;
  status: AgentStatus;
  startedAt: number;
  /** byte offset in messages.jsonl the agent has consumed */
  lastReadOffset: number;
  model?: string;
  role?: string;
  logFile?: string;
  /** named pipe paths (bridge transport); present when the agent runs via a bridge */
  pipeIn?: string;
  pipeOut?: string;
}

export class Hub {
  constructor(readonly dir: string) {
    fs.mkdirSync(dir, { recursive: true });
  }

  get messagesFile(): string {
    return path.join(this.dir, "messages.jsonl");
  }

  get agentsFile(): string {
    return path.join(this.dir, "agents.json");
  }

  get genFile(): string {
    return path.join(this.dir, "gen");
  }

  /**
   * Bus generation counter. Bumped on rotation so readers (agents + supervisor)
   * can detect that messages.jsonl was archived+recreated and reset their byte
   * offset to 0. Readers keep their own copy and compare each poll.
   */
  generation(): number {
    try {
      return parseInt(fs.readFileSync(this.genFile, "utf8").trim(), 10) || 0;
    } catch {
      return 0;
    }
  }

  private bumpGeneration(): void {
    fs.writeFileSync(this.genFile, String(this.generation() + 1), "utf8");
  }

  /**
   * Rotate messages.jsonl to a timestamped archive if it exceeds maxBytes, then
   * start a fresh bus and bump the generation. Keeps at most `keepArchives`
   * old files. Returns true if a rotation happened.
   */
  rotateIfLarge(maxBytes: number, keepArchives = 5): boolean {
    if (this.messagesSize() <= maxBytes) return false;
    const ts = new Date().toISOString().replace(/[:.]/g, "-");
    const archive = path.join(this.dir, `messages-${ts}.jsonl`);
    fs.renameSync(this.messagesFile, archive);
    fs.writeFileSync(this.messagesFile, "", "utf8");
    this.bumpGeneration();
    const archives = fs
      .readdirSync(this.dir)
      .filter((f) => f.startsWith("messages-") && f.endsWith(".jsonl"))
      .sort();
    while (archives.length > keepArchives) {
      const oldest = archives.shift();
      if (oldest) fs.unlinkSync(path.join(this.dir, oldest));
    }
    return true;
  }

  // ---------- messages ----------

  appendMessage(msg: Omit<FleetMessage, "id" | "ts">): FleetMessage {
    this.ensureDir();
    const { text } = truncateMessage(msg.text);
    const full: FleetMessage = { id: crypto.randomUUID(), ts: Date.now(), ...msg, text };
    fs.appendFileSync(this.messagesFile, JSON.stringify(full) + "\n", "utf8");
    return full;
  }

  /** Read complete messages at/after a byte offset. Returns the next offset. */
  readMessagesSince(offset: number): { messages: FleetMessage[]; nextOffset: number } {
    if (!fs.existsSync(this.messagesFile)) return { messages: [], nextOffset: offset };
    const stat = fs.statSync(this.messagesFile);
    if (stat.size <= offset) return { messages: [], nextOffset: offset };
    const fd = fs.openSync(this.messagesFile, "r");
    const length = stat.size - offset;
    const buf = Buffer.alloc(length);
    fs.readSync(fd, buf, 0, length, offset);
    fs.closeSync(fd);
    const text = buf.toString("utf8");
    const lines = text.split("\n");
    const messages: FleetMessage[] = [];
    let consumed = 0;
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      const lineBytes = Buffer.byteLength(line, "utf8") + 1; // +1 for \n
      const isLast = i === lines.length - 1;
      if (isLast && line === "") break; // trailing newline, no partial line
      if (isLast && !text.endsWith("\n")) break; // partial line still being written
      try {
        messages.push(JSON.parse(line) as FleetMessage);
      } catch {
        // corrupt line — skip but still advance
      }
      consumed += lineBytes;
    }
    return { messages, nextOffset: offset + consumed };
  }

  /** Last N messages (whole file, tail). */
  tailMessages(n: number): FleetMessage[] {
    if (!fs.existsSync(this.messagesFile)) return [];
    const text = fs.readFileSync(this.messagesFile, "utf8");
    const lines = text.split("\n").filter((l) => l.trim() !== "");
    const out: FleetMessage[] = [];
    for (const line of lines.slice(-n)) {
      try {
        out.push(JSON.parse(line) as FleetMessage);
      } catch {
        // skip
      }
    }
    return out;
  }

  messagesSize(): number {
    try {
      return fs.statSync(this.messagesFile).size;
    } catch {
      return 0;
    }
  }

  // ---------- registry ----------

  readAgents(): Record<string, AgentInfo> {
    try {
      return JSON.parse(fs.readFileSync(this.agentsFile, "utf8")) as Record<string, AgentInfo>;
    } catch {
      return {};
    }
  }

  updateAgent(name: string, patch: Partial<AgentInfo>): AgentInfo {
    this.acquireLock();
    try {
      const agents = this.readAgents();
      const prev = agents[name] ?? {
        name,
        pid: 0,
        cwd: "",
        status: "starting" as AgentStatus,
        startedAt: Date.now(),
        lastReadOffset: 0,
      };
      const next: AgentInfo = { ...prev, ...patch };
      agents[name] = next;
      this.writeAgents(agents);
      return next;
    } finally {
      this.releaseLock();
    }
  }

  removeAgent(name: string): void {
    this.acquireLock();
    try {
      const agents = this.readAgents();
      delete agents[name];
      this.writeAgents(agents);
    } finally {
      this.releaseLock();
    }
  }

  private writeAgents(agents: Record<string, AgentInfo>): void {
    this.ensureDir();
    replaceFile(this.agentsFile, JSON.stringify(agents, null, 2));
  }

  private ensureDir(): void {
    try {
      fs.mkdirSync(this.dir, { recursive: true });
    } catch {
      // ignore — a failed mkdir will surface on the next real fs op
    }
  }

  // ---------- registry locking ----------
  //
  // Multiple agents (separate processes) read-modify-write agents.json
  // concurrently. The write itself is atomic (tmp+rename), but the
  // read-modify-write is not: two agents could read the same state and one's
  // update would be lost. A simple advisory lock file serializes the
  // critical section. Works cross-platform (O_EXCL create). A stale lock
  // (holder crashed) is broken after a timeout.

  private get lockFile(): string {
    return this.agentsFile + ".lock";
  }

  private acquireLock(timeoutMs = 2000): void {
    const start = Date.now();
    for (;;) {
      try {
        const fd = fs.openSync(this.lockFile, fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_WRONLY);
        fs.closeSync(fd);
        return;
      } catch (e) {
        if ((e as NodeJS.ErrnoException).code !== "EEXIST") throw e;
        if (Date.now() - start > timeoutMs) {
          try {
            fs.unlinkSync(this.lockFile); // break a stale lock
          } catch {
            // ignore
          }
          continue;
        }
        Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 10); // ~10ms sleep
      }
    }
  }

  private releaseLock(): void {
    try {
      fs.unlinkSync(this.lockFile);
    } catch {
      // ignore
    }
  }

  // ---------- helpers ----------

  logFileFor(name: string): string {
    return path.join(this.dir, `agents`, `${name}.log`);
  }

  // ---------- pause + hop count ----------
  //
  // A paused fleet stays up, but agent messages wake nobody, which is what breaks
  // a loop for good: aborting one run alone would let the next message restart it.
  // Kept as a file because in detached mode each agent's poller enforces it.

  get pausedFile(): string {
    return path.join(this.dir, "paused");
  }

  /** Pause the fleet and say so on the bus; pausing a paused fleet does nothing. */
  pause(reason: string): void {
    this.ensureDir();
    try {
      fs.writeFileSync(this.pausedFile, reason, { encoding: "utf8", flag: "wx" });
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === "EEXIST") return; // only the first caller announces it
      throw e;
    }
    this.appendMessage({
      from: "system",
      to: "group",
      kind: "system",
      text: `fleet paused: ${reason}. Agent messages wake nobody until you send a message.`,
    });
  }

  resume(): void {
    try {
      fs.unlinkSync(this.pausedFile);
    } catch {
      // not paused
    }
  }

  /** Why the fleet is paused, or null if it is running. */
  pausedReason(): string | null {
    try {
      return fs.readFileSync(this.pausedFile, "utf8");
    } catch {
      return null;
    }
  }

  /** Messages agents exchanged since the human last spoke, counted up to message `upTo` if given. */
  agentHops(upTo?: string): number {
    const recent = this.tailMessages(HOP_WINDOW);
    let i = recent.length - 1;
    if (upTo) while (i >= 0 && recent[i].id !== upTo) i--;
    let hops = 0;
    for (; i >= 0 && recent[i].from !== "user"; i--) {
      if (recent[i].kind === "chat") hops++;
    }
    return hops;
  }

  // ---------- GUI access token ----------

  get guiTokenFile(): string {
    return path.join(this.dir, "gui-token");
  }

  /** Token guarding the web UI. Kept in the hub so links and cookies survive restarts. */
  guiToken(): string {
    try {
      const saved = fs.readFileSync(this.guiTokenFile, "utf8").trim();
      if (saved) return saved;
    } catch {
      // first run
    }
    const token = crypto.randomBytes(24).toString("base64url");
    this.ensureDir();
    fs.writeFileSync(this.guiTokenFile, token, { encoding: "utf8", mode: 0o600 });
    return token;
  }

  // ---------- per-agent session stats (cost / tokens) ----------

  get statsFile(): string {
    return path.join(this.dir, "stats.json");
  }

  // ---------- channels (named group chats) ----------

  get channelsFile(): string {
    return path.join(this.dir, "channels.json");
  }

  readChannels(): ChannelConfig[] {
    try {
      const raw = JSON.parse(fs.readFileSync(this.channelsFile, "utf8")) as { channels?: ChannelConfig[] };
      return Array.isArray(raw.channels) ? raw.channels : [];
    } catch {
      return [];
    }
  }

  writeChannels(channels: ChannelConfig[]): void {
    this.ensureDir();
    replaceFile(this.channelsFile, JSON.stringify({ channels }, null, 2));
  }

  getChannel(name: string): ChannelConfig | undefined {
    return this.readChannels().find((c) => c.name === name);
  }

  upsertChannel(channel: ChannelConfig): ChannelConfig {
    const channels = this.readChannels();
    const i = channels.findIndex((c) => c.name === channel.name);
    if (i >= 0) channels[i] = { ...channels[i], ...channel };
    else channels.push(channel);
    this.writeChannels(channels);
    return channel;
  }

  removeChannel(name: string): void {
    this.writeChannels(this.readChannels().filter((c) => c.name !== name));
  }

  setChannelSummary(name: string, summary: string): void {
    const channels = this.readChannels();
    const c = channels.find((x) => x.name === name);
    if (c) {
      c.summary = summary;
      this.writeChannels(channels);
    }
  }

  /**
   * Ensure the default "group" channel exists with all current agents as members.
   * The supervisor is the agent with role "supervisor" if present, else the first
   * agent. Called by the supervisor process on startup and when agents join.
   */
  ensureDefaultChannel(): ChannelConfig {
    const agents = Object.keys(this.readAgents()).sort();
    const existing = this.getChannel(DEFAULT_CHANNEL);
    const supervisor =
      agents.find((n) => this.readAgents()[n]?.role === "supervisor") ?? agents[0];
    const channel: ChannelConfig = {
      name: DEFAULT_CHANNEL,
      members: agents.length ? agents : existing?.members ?? [],
      supervisor: existing?.supervisor ?? (supervisor ?? undefined),
      summary: existing?.summary,
    };
    this.upsertChannel(channel);
    return channel;
  }

  // ---------- supervisor heartbeat ----------
  //
  // The supervisor writes a timestamp here while it is attached. Agents use it
  // to decide who is the wake authority: while the heartbeat is fresh the
  // supervisor pushes wakes directly (rpc.prompt, real-time); once it goes
  // stale (supervisor exited / detached) the agent's own poller resumes
  // self-waking. This avoids double-wakes while still working in detached mode.

  get supervisorFile(): string {
    return path.join(this.dir, "supervisor.json");
  }

  writeSupervisorHeartbeat(): void {
    this.ensureDir();
    try {
      fs.writeFileSync(this.supervisorFile, JSON.stringify({ ts: Date.now() }), "utf8");
    } catch {
      // ignore
    }
  }

  clearSupervisorHeartbeat(): void {
    try {
      fs.unlinkSync(this.supervisorFile);
    } catch {
      // ignore
    }
  }

  readSupervisorHeartbeat(): number {
    try {
      const obj = JSON.parse(fs.readFileSync(this.supervisorFile, "utf8")) as { ts?: number };
      return typeof obj.ts === "number" ? obj.ts : 0;
    } catch {
      return 0;
    }
  }

  /** True if the supervisor wrote a heartbeat within maxAgeMs. */
  supervisorAlive(maxAgeMs = 8000): boolean {
    const ts = this.readSupervisorHeartbeat();
    return ts > 0 && Date.now() - ts < maxAgeMs;
  }

  saveStats(name: string, stats: Record<string, unknown>): void {
    this.ensureDir();
    const all = this.readStats();
    all[name] = { ...stats, at: Date.now() };
    replaceFile(this.statsFile, JSON.stringify(all, null, 2));
  }

  readStats(): Record<string, Record<string, unknown>> {
    try {
      return JSON.parse(fs.readFileSync(this.statsFile, "utf8")) as Record<string, Record<string, unknown>>;
    } catch {
      return {};
    }
  }
}

export function isPidAlive(pid: number): boolean {
  if (!pid || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === "EPERM";
  }
}

export function shortId(id: string): string {
  return id.slice(0, 8);
}

export function formatMessage(m: FleetMessage, lookup?: Map<string, FleetMessage>): string {
  const t = new Date(m.ts).toLocaleTimeString([], { hour12: false });
  const arrow = m.to === "group" ? "#" : `@${m.to}`;
  const prefix = m.kind === "system" ? "·" : m.kind === "activity" ? "⚙" : "•";
  const orig = m.replyTo ? lookup?.get(m.replyTo) : undefined;
  const reply = m.replyTo ? ` ↪${shortId(m.replyTo)}${orig ? `(${orig.from})` : ""}` : "";
  return `${prefix} [${t}] ${m.from} → ${arrow}${reply} ${m.text}`;
}