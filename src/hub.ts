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
import type { Worktree } from "./worktree.ts";

export type MessageKind = "chat" | "system" | "activity";

/**
 * Longest message a person or agent may post. Very long lines would bloat
 * messages.jsonl and the inbox prompt (especially for small models). Override
 * with the PI_FLEET_MAX_MSG env var.
 */
export const MAX_MESSAGE_LEN: number = (() => {
  const v = parseInt(process.env.PI_FLEET_MAX_MSG ?? "", 10);
  return Number.isFinite(v) && v > 0 ? v : 2000;
})();

/** Why a message is too long to post, or null if it fits. Posting one is refused, never cut. */
export function messageTooLong(text: string, max: number = MAX_MESSAGE_LEN): string | null {
  if (text.length <= max) return null;
  return `message is ${text.length} characters, over the ${max} limit (PI_FLEET_MAX_MSG): split it into several messages`;
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

export type AgentStatus = "starting" | "idle" | "busy" | "waiting" | "stopped";

/** A position on the bus that stays meaningful across rotations. */
export interface BusCursor {
  gen: number;
  offset: number;
}

/** A wake on its way to an agent, kept on disk until the agent has finished with it. */
export interface InboxEntry {
  id: string;
  text: string;
  /** Accepted by the agent, so only a restart mid-work brings it back. */
  delivered: boolean;
}

/** How long a channel's rolling summary may grow. */
const SUMMARY_LEN = 500;

/**
 * A named group chat (channel). Messages are routed to the members who should act,
 * and a rolling summary is kept. By default the dedicated router does that; naming
 * a supervisor gives the job to that agent instead. In detached mode, with no
 * supervisor process to run the router, the first member does it.
 */
export interface ChannelConfig {
  name: string;
  members: string[];
  /** agent that routes + summarizes for this channel, instead of the dedicated router */
  supervisor?: string;
  /** model for the dedicated router on this channel (a cheap one is usually enough) */
  supervisorModel?: string;
  /** the supervisor was chosen by a person, so the fleet must not reset it */
  pinned?: boolean;
  /** messages up to this time are hidden from the channel view */
  clearedAt?: number;
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
  /** pi's session file, so a restart continues the same conversation */
  sessionFile?: string;
  /** how far this agent's own poller got while no supervisor was attached */
  handled?: BusCursor;
  /** the agent's own git worktree and branch, if it works in one */
  worktree?: Worktree;
}

export class Hub {
  constructor(readonly dir: string) {
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 }); // conversations, and the key to the GUI
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
    const archive = path.join(this.dir, `${this.archivePrefix(this.generation())}${ts}.jsonl`);
    fs.renameSync(this.messagesFile, archive);
    fs.appendFileSync(this.messagesFile, "", "utf8"); // append: a writer may already have recreated it
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
    const full: FleetMessage = { id: crypto.randomUUID(), ts: Date.now(), ...msg };
    fs.appendFileSync(this.messagesFile, JSON.stringify(full) + "\n", "utf8");
    return full;
  }

  /** Post for the human, refusing what would be dropped: an unknown address or an over-long text. */
  postUserMessage(to: string, text: string): FleetMessage {
    const tooLong = messageTooLong(text);
    if (tooLong) throw new Error(tooLong);
    if (!this.targetKind(to)) throw new Error(this.unknownTarget(to));
    return this.appendMessage({ from: "user", to, kind: "chat", text });
  }

  /** What an address names: a channel (including the default one), an agent, or nothing. */
  targetKind(to: string): "channel" | "agent" | null {
    if (to === DEFAULT_CHANNEL || this.getChannel(to)) return "channel";
    return this.readAgents()[to] ? "agent" : null;
  }

  /** Error text for an address that names nothing, listing what does exist. */
  unknownTarget(to: string): string {
    const agents = Object.keys(this.readAgents()).join(", ") || "(none)";
    const channels = this.readChannels().map((c) => c.name).join(", ") || "(none)";
    return `no agent or channel "${to}". Agents: ${agents}. Channels: ${channels}.`;
  }

  /** Read complete messages at/after a byte offset. Returns the next offset. */
  readMessagesSince(offset: number): { messages: FleetMessage[]; nextOffset: number } {
    return this.readLogSince(this.messagesFile, offset);
  }

  private archivePrefix(gen: number): string {
    return `messages-g${String(gen).padStart(6, "0")}-`;
  }

  /** Where the bus ends right now. */
  busEnd(): BusCursor {
    return { gen: this.generation(), offset: this.messagesSize() };
  }

  /**
   * Every complete message after a cursor, in order, following the cursor through
   * rotations: what was still unread when the bus rotated is read from the archive.
   */
  readBus(cursor: BusCursor): { messages: FleetMessage[]; next: BusCursor } {
    const messages: FleetMessage[] = [];
    let { gen, offset } = cursor;
    const current = this.generation();
    for (; gen < current; gen++, offset = 0) {
      const archive = fs.readdirSync(this.dir).find((f) => f.startsWith(this.archivePrefix(gen)));
      if (archive) messages.push(...this.readLogSince(path.join(this.dir, archive), offset).messages);
    }
    const rest = this.readMessagesSince(offset);
    // a rotation just now means that offset was applied to the wrong file: read again next time
    if (this.generation() !== current) return { messages, next: { gen, offset } };
    return { messages: [...messages, ...rest.messages], next: { gen, offset: rest.nextOffset } };
  }

  private readLogSince(file: string, offset: number): { messages: FleetMessage[]; nextOffset: number } {
    if (!fs.existsSync(file)) return { messages: [], nextOffset: offset };
    const stat = fs.statSync(file);
    if (stat.size <= offset) return { messages: [], nextOffset: offset };
    const fd = fs.openSync(file, "r");
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

  /** Messages containing `query`, newest first, from the bus and its archives. */
  searchMessages(query: string, limit = 100): FleetMessage[] {
    const needle = query.toLowerCase();
    const archives = fs.readdirSync(this.dir).filter((f) => /^messages-.*\.jsonl$/.test(f)).sort();
    const found: FleetMessage[] = [];
    for (const file of [...archives.map((f) => path.join(this.dir, f)), this.messagesFile]) {
      found.push(...this.readLogSince(file, 0).messages.filter((m) => m.kind === "chat" && m.text.toLowerCase().includes(needle)));
    }
    return found.reverse().slice(0, limit);
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
    return this.withLock(() => {
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
    });
  }

  /** Forget an agent: it leaves the registry and every channel. */
  removeAgent(name: string): void {
    this.withLock(() => {
      const agents = this.readAgents();
      delete agents[name];
      this.writeAgents(agents);
      this.writeChannels(
        this.readChannels().map((c) => ({
          ...c,
          members: c.members.filter((m) => m !== name),
          supervisor: c.supervisor === name ? undefined : c.supervisor,
        })),
      );
    });
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
  // Multiple agents (separate processes) read-modify-write agents.json and
  // channels.json concurrently. The write itself is atomic (tmp+rename), but the
  // read-modify-write is not: two agents could read the same state and one's
  // update would be lost. A simple advisory lock file serializes the
  // critical section. Works cross-platform (O_EXCL create). A stale lock
  // (holder crashed) is broken after a timeout.

  private get lockFile(): string {
    return this.agentsFile + ".lock";
  }

  private withLock<T>(fn: () => T): T {
    this.acquireLock();
    try {
      return fn();
    } finally {
      this.releaseLock();
    }
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

  // ---------- delivery: bus cursor + per-agent inbox ----------
  //
  // The bus says what was said; these say what has been acted on, so a crash at any
  // point loses nothing. The supervisor saves its cursor only after a message's
  // wakes are in the agents' inboxes, and an inbox entry is removed only once the
  // agent has settled. Only the supervisor writes these files.

  get cursorFile(): string {
    return path.join(this.dir, "cursor.json");
  }

  readCursor(): BusCursor | null {
    try {
      const c = JSON.parse(fs.readFileSync(this.cursorFile, "utf8")) as BusCursor;
      return typeof c.gen === "number" && typeof c.offset === "number" ? c : null;
    } catch {
      return null;
    }
  }

  writeCursor(cursor: BusCursor): void {
    this.ensureDir();
    replaceFile(this.cursorFile, JSON.stringify(cursor));
  }

  private inboxFile(name: string): string {
    return path.join(this.dir, "inbox", `${name}.json`);
  }

  readInbox(name: string): InboxEntry[] {
    try {
      return JSON.parse(fs.readFileSync(this.inboxFile(name), "utf8")) as InboxEntry[];
    } catch {
      return [];
    }
  }

  private writeInbox(name: string, entries: InboxEntry[]): void {
    fs.mkdirSync(path.dirname(this.inboxFile(name)), { recursive: true });
    replaceFile(this.inboxFile(name), JSON.stringify(entries, null, 2));
  }

  enqueueWake(name: string, text: string): InboxEntry {
    const entry: InboxEntry = { id: crypto.randomUUID(), text, delivered: false };
    this.writeInbox(name, [...this.readInbox(name), entry]);
    return entry;
  }

  markDelivered(name: string, id: string): void {
    this.writeInbox(name, this.readInbox(name).map((e) => (e.id === id ? { ...e, delivered: true } : e)));
  }

  /** The agent has settled: whatever it had accepted is finished. */
  ackDelivered(name: string): void {
    const entries = this.readInbox(name);
    if (entries.some((e) => e.delivered)) this.writeInbox(name, entries.filter((e) => !e.delivered));
  }

  removeFromInbox(name: string, id: string): void {
    this.writeInbox(name, this.readInbox(name).filter((e) => e.id !== id));
  }

  clearInbox(name: string): void {
    if (this.readInbox(name).length > 0) this.writeInbox(name, []);
  }

  // ---------- pause + hop count ----------
  //
  // A paused fleet stays up, but agent messages wake nobody, which is what breaks
  // a loop for good: aborting one run alone would let the next message restart it.
  // Kept as a file because in detached mode each agent's poller enforces it.

  get pausedFile(): string {
    return path.join(this.dir, "paused");
  }

  /**
   * Pause the fleet and say so on the bus; pausing a paused fleet does nothing.
   * `since` is the time of the first message to hold back.
   */
  pause(reason: string, since: number = Date.now()): void {
    this.ensureDir();
    try {
      fs.writeFileSync(this.pausedFile, JSON.stringify({ reason, since }), { encoding: "utf8", flag: "wx" });
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
    fs.rmSync(this.pausedFile, { force: true });
  }

  private readPause(): { reason: string; since: number } | null {
    try {
      return JSON.parse(fs.readFileSync(this.pausedFile, "utf8")) as { reason: string; since: number };
    } catch {
      return null;
    }
  }

  /** Why the fleet is paused, or null if it is running. */
  pausedReason(): string | null {
    return this.readPause()?.reason ?? null;
  }

  /** The agent messages this pause is holding back. */
  heldMessages(): FleetMessage[] {
    const pause = this.readPause();
    if (!pause) return [];
    return this.tailMessages(HOP_WINDOW).filter((m) => m.kind === "chat" && m.from !== "user" && m.ts >= pause.since);
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

  // ---------- spending per request, for the timeline ----------

  /** What has been spent so far, across every agent and the router. */
  totalSpent(): number {
    return Object.values(this.readStats()).reduce((sum, s) => sum + Number(s.cost ?? 0), 0);
  }

  private get spendFile(): string {
    return path.join(this.dir, "spend.json");
  }

  readSpend(): Record<string, number> {
    try {
      return JSON.parse(fs.readFileSync(this.spendFile, "utf8")) as Record<string, number>;
    } catch {
      return {};
    }
  }

  /** Note the total as a request comes in; the next request's total gives this one's cost. */
  markSpend(messageId: string): void {
    this.ensureDir();
    replaceFile(this.spendFile, JSON.stringify({ ...this.readSpend(), [messageId]: this.totalSpent() }));
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
    return this.withLock(() => {
      const channels = this.readChannels();
      const i = channels.findIndex((c) => c.name === channel.name);
      if (i >= 0) channels[i] = { ...channels[i], ...channel };
      else channels.push(channel);
      this.writeChannels(channels);
      return channel;
    });
  }

  removeChannel(name: string): void {
    this.withLock(() => this.writeChannels(this.readChannels().filter((c) => c.name !== name)));
  }

  setChannelSummary(name: string, summary: string): void {
    this.withLock(() => {
      const channels = this.readChannels();
      const c = channels.find((x) => x.name === name);
      if (c) {
        c.summary = summary;
        this.writeChannels(channels);
      }
    });
  }

  /** Fold a message the router never saw into the summary, so the summary stays current. */
  noteInSummary(name: string, note: string): void {
    this.withLock(() => {
      const channels = this.readChannels();
      const c = channels.find((x) => x.name === name);
      if (!c) return;
      c.summary = `${c.summary ? `${c.summary}\n` : ""}${note.replace(/\s+/g, " ").slice(0, 120)}`.slice(-SUMMARY_LEN);
      this.writeChannels(channels);
    });
  }

  /**
   * Give every channel routed by an agent that is not running a running member,
   * preferring an agent with the supervisor role. A channel with nobody running
   * keeps its router, since it can do nothing until someone comes back. Channels
   * on the dedicated router need nothing. Returns the changes.
   */
  reassignSupervisors(running: string[]): { channel: string; supervisor: string }[] {
    return this.withLock(() => {
      const channels = this.readChannels();
      const agents = this.readAgents();
      const changed: { channel: string; supervisor: string }[] = [];
      for (const c of channels) {
        if (!c.supervisor || running.includes(c.supervisor)) continue;
        const candidates = c.members.filter((m) => running.includes(m));
        const next = candidates.find((m) => agents[m]?.role === "supervisor") ?? candidates[0];
        if (!next) continue;
        c.supervisor = next;
        changed.push({ channel: c.name, supervisor: next });
      }
      if (changed.length > 0) this.writeChannels(channels);
      return changed;
    });
  }

  /**
   * Ensure the default "group" channel exists with all current agents as members.
   * An agent with role "supervisor" routes it; with none, the dedicated router does.
   * Called by the supervisor process on startup and when agents join.
   */
  ensureDefaultChannel(): ChannelConfig {
    const agents = this.readAgents();
    const names = Object.keys(agents).sort();
    const existing = this.getChannel(DEFAULT_CHANNEL);
    const roleSupervisor = names.find((n) => agents[n]?.role === "supervisor");
    const channel: ChannelConfig = {
      name: DEFAULT_CHANNEL,
      members: names.length ? names : existing?.members ?? [],
      supervisor: existing?.pinned ? existing.supervisor : roleSupervisor ? (existing?.supervisor ?? roleSupervisor) : undefined,
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
      fs.writeFileSync(this.supervisorFile, JSON.stringify({ ts: Date.now(), pid: process.pid }), "utf8");
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

  /** Pid of another supervisor attached to this hub, or null if there is none. */
  otherSupervisor(maxAgeMs = 8000): number | null {
    if (!this.supervisorAlive(maxAgeMs)) return null;
    try {
      const { pid } = JSON.parse(fs.readFileSync(this.supervisorFile, "utf8")) as { pid?: number };
      return pid && pid !== process.pid && isPidAlive(pid) ? pid : null;
    } catch {
      return null;
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

/** An address as people read it: `#channel` or `@agent`. */
export function addressLabel(to: string, channels: ChannelConfig[] = []): string {
  return to === DEFAULT_CHANNEL || channels.some((c) => c.name === to) ? `#${to}` : `@${to}`;
}

/** Text from a model, safe to print: no escape sequences to retitle or rewrite a terminal. */
export function printable(text: string): string {
  return text.replace(/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f-\x9f]/g, "");
}

export function formatMessage(m: FleetMessage, lookup?: Map<string, FleetMessage>, channels: ChannelConfig[] = []): string {
  const t = new Date(m.ts).toLocaleTimeString([], { hour12: false });
  const arrow = addressLabel(m.to, channels);
  const prefix = m.kind === "system" ? "·" : m.kind === "activity" ? "⚙" : "•";
  const orig = m.replyTo ? lookup?.get(m.replyTo) : undefined;
  const reply = m.replyTo ? ` ↪${shortId(m.replyTo)}${orig ? `(${orig.from})` : ""}` : "";
  return `${prefix} [${t}] ${m.from} → ${arrow}${reply} ${m.text}`;
}