/**
 * fleet — multi-agent supervisor + group chat for pi.
 *
 * Usage:
 *   fleet up [--dir DIR] [--agent name[:cwd][:model][:role]]... [--model MODEL] [--lean|--no-lean] [--max-turns N] [--max-hops N]
 *   fleet list [--dir DIR]
 *   fleet stop [name|all] [--dir DIR]
 *   fleet log [name] [--dir DIR]
 *
 * `up` spawns one `pi --mode rpc` process per agent (each named, each with
 * the fleet extension loaded), tails the shared message bus, and gives you a
 * group chat:
 *   # text            -> broadcast to group
 *   @name text        -> direct message to one agent
 *   /agents           -> list agents
 *   /new name [cwd] [model] [role]  -> spawn another agent live
 *   /stop name        -> stop one agent
 *   /stopall          -> abort every run and pause the fleet until the next message
 *   /quit             -> stop all, exit
 *
 * Agent spec is `name[:cwd][:model][:role]`; the per-agent model overrides `--model`.
 * Role (planner/implementer/reviewer) injects a role-specific prompt preset.
 * Lean mode (smaller prompt for weak/local models) is auto-detected from each
 * model's context window (<16k); override with `--lean` / `--no-lean`.
 */
import { execSync, spawn } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import readline from "node:readline";
import { fileURLToPath } from "node:url";
import { Hub, isPidAlive, formatMessage, shortId, DEFAULT_MAX_HOPS, DEFAULT_MAX_TURNS, type AgentInfo, type FleetMessage } from "./hub.ts";
import { PiRpc, PiRpcBridge, piArgv, bridgeListening, type StreamingBehavior } from "./rpc.ts";
import { formatInbox, wakeDecision, routingPrompt, admitMessage } from "./extension/index.ts";
import { agentNameFromSpec, agentCwdFromSpec, agentModelFromSpec, agentRoleFromSpec, isValidAgentName } from "./spec.ts";
import { GuiServer } from "./gui.ts";
import { loadFleetConfig, agentSpecFromConfig, saveFleetConfig, templateConfig, configPath, isLimit } from "./config.ts";
import { expandTemplate, templateNames, templateDescription, TEMPLATES } from "./templates.ts";
import { discoverExtensions, readMcpConfig, writeMcpConfig } from "./pi-resources.ts";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const EXTENSION = path.join(ROOT, "src", "extension", "index.ts");

/** A wake pi refuses (e.g. mid-compaction) is retried for about a minute before it is reported lost. */
const WAKE_RETRIES = 12;
const WAKE_RETRY_MS = 5000;

/** Common surface of the two RPC transports (child-process pipe vs bridge named pipes). */
interface RpcClient {
  pid: number;
  alive: boolean;
  onEvent: (rec: Record<string, unknown>) => void;
  onExit: (code: number | null) => void;
  prompt(message: string, streamingBehavior?: StreamingBehavior): Promise<Record<string, unknown>>;
  sendCommand(cmd: Record<string, unknown>): Promise<Record<string, unknown>>;
  getState(): Promise<Record<string, unknown>>;
  getStats(): Promise<Record<string, unknown>>;
  setSessionName(name: string): Promise<Record<string, unknown>>;
  close(): void | Promise<void>;
}

interface AgentHandle {
  name: string;
  cwd: string;
  rpc: RpcClient;
  model?: string;
}

/** Runaway limits, handed to each agent at spawn. */
interface Limits {
  maxTurns: number;
  maxHops: number;
}

function limitArg(flag: string, value: string | undefined): number {
  const n = Number(value);
  if (value === undefined || value === "" || !isLimit(n)) {
    console.error(`${flag} needs a whole number (0 means no limit), got "${value}"`);
    process.exit(1);
  }
  return n;
}

function parseArgs(argv: string[]): { dir?: string; agents: string[]; model?: string; lean?: boolean; detach?: boolean; gui?: boolean; port?: number; host?: string; open?: boolean; template?: string; maxTurns?: number; maxHops?: number; rest: string[] } {
  const out: { dir?: string; agents: string[]; model?: string; lean?: boolean; detach?: boolean; gui?: boolean; port?: number; host?: string; open?: boolean; template?: string; maxTurns?: number; maxHops?: number; rest: string[] } = { agents: [], rest: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--dir") out.dir = argv[++i];
    else if (a === "--agent") out.agents.push(argv[++i]);
    else if (a === "--model") out.model = argv[++i];
    else if (a === "--template") out.template = argv[++i];
    else if (a === "--lean") out.lean = true;
    else if (a === "--no-lean") out.lean = false;
    else if (a === "--detach") out.detach = true;
    else if (a === "--gui") out.gui = true;
    else if (a === "--open") out.open = true;
    else if (a === "--port") out.port = parseInt(argv[++i], 10);
    else if (a === "--host") out.host = argv[++i];
    else if (a === "--max-turns") out.maxTurns = limitArg(a, argv[++i]);
    else if (a === "--max-hops") out.maxHops = limitArg(a, argv[++i]);
    else out.rest.push(a);
  }
  return out;
}

/**
 * Extra pi flags for weak/local models. pi's default system prompt embeds every
 * installed skill (~15-20KB) and 10 built-in tools, which alone exceeds the
 * context of a 4B model on a small GPU. Lean mode drops the skills section and
 * the web/research tools the fleet rarely needs, keeping the prompt small.
 */
const LEAN_PI_ARGS = [
  "--no-skills",
  "--no-context-files",
  "--exclude-tools", "web_search,source_check,fetch_content,get_search_content,ask_user",
];

/**
 * Models whose configured context window is below this get lean mode
 * auto-applied. pi's prompt+tools alone is ~3000 tokens, so a model needs a
 * comfortable window to run the full prompt. 16k cleanly separates small local
 * models (e.g. 4B @ 8k) from capable ones (27B @ 128k, cloud @ 200k).
 */
const LEAN_CONTEXT_THRESHOLD = 16384;

/**
 * Probe a model's context window via a short-lived `pi --mode rpc` process
 * (get_state returns the resolved Model object; no model server needed).
 * Ephemeral session so it doesn't pollute the session directory.
 */
async function probeContextWindow(model: string): Promise<number | undefined> {
  const rpc = new PiRpc(piArgv(ROOT, ["--mode", "rpc", "--no-session", "--model", model]), {
    cwd: process.cwd(),
    env: { ...process.env },
    logFile: path.join(os.tmpdir(), `pi-fleet-probe-${Date.now()}.log`),
  });
  try {
    // give pi time to boot before the first RPC
    await new Promise((r) => setTimeout(r, 2500));
    const res = await rpc.getState();
    const data = (res as { data?: { model?: { contextWindow?: number } } }).data;
    return data?.model?.contextWindow;
  } catch {
    return undefined;
  } finally {
    await rpc.close();
  }
}

/**
 * Decide whether an agent runs lean. Explicit `--lean`/`--no-lean` wins; otherwise
 * auto-detect from the model's context window (probed + cached per model).
 */
async function resolveLean(
  model: string | undefined,
  explicit: boolean | undefined,
  cache: Map<string, number | undefined>,
): Promise<boolean> {
  if (explicit !== undefined) return explicit;
  if (!model) return false;
  if (!cache.has(model)) {
    cache.set(model, await probeContextWindow(model));
  }
  const cw = cache.get(model);
  return cw !== undefined && cw < LEAN_CONTEXT_THRESHOLD;
}

/** Stable, unique named-pipe path per (hub dir, agent, direction). */
function pipePath(kind: "in" | "out", name: string, hubDir: string): string {
  const id = crypto.createHash("sha1").update(hubDir + "|" + name).digest("hex").slice(0, 10);
  const base = `pi-fleet-${id}-${kind}`;
  return process.platform === "win32" ? `\\\\.\\pipe\\${base}` : path.join(os.tmpdir(), `${base}.sock`);
}

/** Kill a process and its whole tree (taskkill /T on Windows). */
function killProcessTree(pid: number): void {
  if (!pid || pid <= 0) return;
  if (process.platform === "win32") {
    try {
      execSync(`taskkill /PID ${pid} /T /F`, { stdio: "ignore" });
    } catch {
      // ignore
    }
  } else {
    try {
      process.kill(pid, "SIGTERM");
    } catch {
      // ignore
    }
  }
}

/**
 * Spawn an agent: launch a detached bridge (which owns the pi child and exposes
 * it over named pipes), then connect a PiRpcBridge client to those pipes.
 * The bridge survives the supervisor exiting, enabling detached mode + re-attach.
 */
async function spawnAgent(hub: Hub, name: string, cwd: string, limits: Limits, model?: string, lean = false, role?: string, extensions?: string[]): Promise<AgentHandle> {
  if (!isValidAgentName(name)) throw new Error(`invalid agent name "${name}": use letters, digits, "_" and "-" (not group, user or system)`);
  if (!fs.existsSync(cwd)) throw new Error(`cwd does not exist: ${cwd}`);
  const logFile = path.resolve(hub.logFileFor(name)); // absolute: the bridge's cwd is hub.dir
  fs.mkdirSync(path.dirname(logFile), { recursive: true });
  const args = [
    "--mode", "rpc",
    "--name", name,
    "--extension", EXTENSION,
  ];
  // Extra pi extensions (plugins) selected per agent in the GUI / fleet config.
  for (const ext of extensions ?? []) args.push("--extension", ext);
  if (model) args.push("--model", model);
  if (lean) args.push(...LEAN_PI_ARGS);
  const pipeIn = pipePath("in", name, hub.dir);
  const pipeOut = pipePath("out", name, hub.dir);
  const bridgeScript = path.join(ROOT, "src", "bridge.ts");
  // Spawn the bridge as a single node process (no npx/shell wrapper) so the
  // process tree is clean: supervisor -> node(bridge) -> pi. The registry pid
  // is then the bridge, and taskkill /T on it takes pi down with it.
  const tsxCli = path.join(ROOT, "node_modules", "tsx", "dist", "cli.mjs");
  const bridge = spawn(process.execPath, [tsxCli, bridgeScript], {
    cwd: hub.dir,
    env: {
      ...process.env,
      PI_FLEET_PIPE_IN: pipeIn,
      PI_FLEET_PIPE_OUT: pipeOut,
      PI_FLEET_ARGV: JSON.stringify(piArgv(ROOT, args)),
      PI_FLEET_CWD: cwd,
      PI_FLEET_LOG: logFile,
      PI_FLEET_DIR: hub.dir,
      PI_FLEET_AGENT: name,
      PI_FLEET_ROOT: ROOT,
      PI_FLEET_MAX_TURNS: String(limits.maxTurns),
      PI_FLEET_MAX_HOPS: String(limits.maxHops),
      ...(role ? { PI_FLEET_ROLE: role } : {}),
      ...(lean ? { PI_FLEET_LEAN: "1" } : {}),
    },
    stdio: "ignore",
    detached: true,
    windowsHide: true,
  });
  bridge.unref();
  const bridgePid = bridge.pid ?? 0;
  hub.updateAgent(name, { name, pid: bridgePid, cwd, status: "starting", startedAt: Date.now(), logFile, pipeIn, pipeOut, model, role });
  const rpc = await PiRpcBridge.connect(pipeIn, pipeOut, bridgePid);
  return { name, cwd, rpc, model };
}

function printBanner() {
  console.log("");
  console.log("  pi-fleet group chat");
  console.log("  # text            broadcast to group");
  console.log("  @name text        direct message");
  console.log("  /agents /new /stop /stopall /stats /quit");
  console.log("");
}

async function cmdUp(args: ReturnType<typeof parseArgs>, baseCwd: string, headless = false) {
  const hub = new Hub(args.dir ?? path.join(baseCwd, ".pi-fleet"));
  const agents = new Map<string, AgentHandle>();
  const leanCache = new Map<string, number | undefined>();
  let shuttingDown = false;
  let gui: GuiServer | null = null;
  let rl: readline.Interface | null = null;
  // readline only echoes and draws a prompt on a real terminal; the desktop app
  // runs the supervisor with stdio pipes.
  const interactive = !headless && !!process.stdin.isTTY && !!process.stdout.isTTY;

  // Fleet template: --template expands to a set of agents (sugar for --agent flags).
  if (args.agents.length === 0 && args.template) {
    const t = expandTemplate(args.template);
    if (!t) {
      console.error(`unknown template "${args.template}" (available: ${templateNames().join(", ")})`);
      process.exit(1);
    }
    args.agents = t.map(agentSpecFromConfig);
    console.log(`  ⚙ template "${args.template}": ${t.length} agent(s) — ${templateDescription(args.template)}`);
  }

  // Fleet config: with no --agent flags, load the composition from <hub>/fleet.json.
  // This is what the desktop app relies on — it launches `fleet up` with no agents
  // and the config decides what to spawn. We also keep the config around so we can
  // look up per-agent extensions (plugins) by name for any spawn.
  const fleetCfg = loadFleetConfig(hub.dir);
  if (args.agents.length === 0) {
    if (fleetCfg && fleetCfg.agents.length > 0) {
      args.agents = fleetCfg.agents.map(agentSpecFromConfig);
      if (!args.model && fleetCfg.defaultModel) args.model = fleetCfg.defaultModel;
      console.log(`  ⚙ fleet config: ${fleetCfg.agents.length} agent(s) from ${configPath(hub.dir)}`);
    }
  }
  // Look up per-agent extensions (plugins) from the config by name.
  const extensionsFor = (name: string): string[] | undefined =>
    fleetCfg?.agents.find((a) => a.name === name)?.extensions;
  const limits: Limits = {
    maxTurns: args.maxTurns ?? fleetCfg?.maxTurns ?? DEFAULT_MAX_TURNS,
    maxHops: args.maxHops ?? fleetCfg?.maxHops ?? DEFAULT_MAX_HOPS,
  };

  // Pre-probe context windows for all unique initial models (parallel, cached)
  // so lean auto-detection is instant by the time we spawn.
  const uniqueModels = [
    ...new Set(
      args.agents
        .map((s) => agentModelFromSpec(s) ?? args.model)
        .filter((m): m is string => !!m),
    ),
  ];
  await Promise.all(
    uniqueModels.map(async (m) => {
      if (!leanCache.has(m)) leanCache.set(m, await probeContextWindow(m));
    }),
  );

  // Bus output arrives while the user types: print above the input line, then redraw it.
  const print = (s: string) => {
    if (!rl || !interactive || shuttingDown) {
      console.log(s);
      return;
    }
    readline.clearLine(process.stdout, 0);
    readline.cursorTo(process.stdout, 0);
    console.log(s);
    rl.prompt(true);
  };

  function listAgentsLine(): string {
    const reg = Object.values(hub.readAgents()).filter((a) => isPidAlive(a.pid));
    return reg.map((a) => `${a.name}[${a.status}]`).join("  ") || "(no agents)";
  }

  function wire(handle: AgentHandle, name: string) {
    handle.rpc.onEvent = (rec) => {
      const t = rec.type as string;
      if (t === "agent_start") {
        print(`  ⟳ [${name}] working…`);
      } else if (t === "tool_execution_start") {
        const tool = String(rec.toolName ?? "");
        print(`  ⚙ [${name}] ${tool}`);
      } else if (t === "agent_settled") {
        print(`  ✓ [${name}] settled — ${listAgentsLine()}`);
      }
      // keep the GUI status badge in sync with the run state
      if (t === "agent_start") gui?.broadcast("status", { name, status: "busy" });
      else if (t === "agent_settled") gui?.broadcast("status", { name, status: "idle" });
      // stream every RPC event to the GUI (validates the event data flow)
      gui?.broadcast("agent_event", { name, event: rec });
    };
    handle.rpc.onExit = (code) => {
      agents.delete(name);
      print(`  ✕ [${name}] exited (${code})`);
      gui?.broadcast("status", { name, status: "stopped" });
    };
  }

  async function spawnAndTrack(name: string, cwd: string, model?: string, role?: string, extensions?: string[]) {
    if (agents.has(name)) throw new Error(`agent "${name}" already running`);
    const lean = await resolveLean(model, args.lean, leanCache);
    const handle = await spawnAgent(hub, name, cwd, limits, model, lean, role, extensions);
    agents.set(name, handle);
    wire(handle, name);
    const modelLabel = model ? ` model=${model}` : "";
    const leanLabel = lean ? " lean" : "";
    const roleLabel = role ? ` role=${role}` : "";
    const extLabel = extensions && extensions.length ? ` plugins=${extensions.length}` : "";
    print(`  + [${name}] spawned (pid ${handle.rpc.pid}, cwd ${cwd}${modelLabel}${leanLabel}${roleLabel}${extLabel})`);
    gui?.broadcast("agent_added", hub.readAgents()[name]);
    // pi answers its first RPC once booted, which is when the agent turns idle
    handle.rpc.getState().then(
      () => gui?.broadcast("status", { name, status: "idle" }),
      () => {},
    );
  }

  // Re-attach to a bridge that is still alive from a previous (detached) run.
  async function reattachAndTrack(info: AgentInfo) {
    if (agents.has(info.name) || !info.pipeIn || !info.pipeOut) return;
    const handle = await PiRpcBridge.connect(info.pipeIn, info.pipeOut, info.pid).then(
      (rpc) => ({ name: info.name, cwd: info.cwd, rpc, model: info.model } as AgentHandle),
    );
    agents.set(info.name, handle);
    wire(handle, info.name);
    print(`  ↻ [${info.name}] re-attached (pid ${handle.rpc.pid}, cwd ${info.cwd})`);
  }

  // initial agents — auto-resume: re-attach to live bridges, spawn the rest
  const live: AgentInfo[] = [];
  for (const a of Object.values(hub.readAgents())) {
    if (a.pipeIn && a.pipeOut && isPidAlive(a.pid) && (await bridgeListening(a.pipeIn))) live.push(a);
  }
  const liveByName = new Map(live.map((a) => [a.name, a]));
  for (const spec of args.agents) {
    const name = agentNameFromSpec(spec);
    if (agents.has(name)) continue;
    const existing = liveByName.get(name);
    if (existing) {
      await reattachAndTrack(existing);
    } else {
      await spawnAndTrack(name, agentCwdFromSpec(spec, baseCwd), agentModelFromSpec(spec) ?? args.model, agentRoleFromSpec(spec), extensionsFor(name));
    }
  }
  if (args.agents.length === 0) {
    // no agents specified: re-attach to whatever is still alive
    for (const a of live) await reattachAndTrack(a);
  }
  if (agents.size === 0) {
    print("  (no agents running — use /new name [cwd] to spawn one)");
  }

  /** Abort every run and drop what is queued; the pause stops their last messages waking anyone. */
  async function stopAllRuns(): Promise<number> {
    hub.pause("stopped by you");
    syncPaused();
    const running = [...agents.values()];
    await Promise.allSettled(
      running.map(async (a) => {
        // in this order: pi carries on with whatever is still queued after an abort
        await a.rpc.sendCommand({ type: "clear_queue" });
        await a.rpc.sendCommand({ type: "abort" });
      }),
    );
    return running.length;
  }

  // Keep the GUI's paused banner in step with the hub.
  let shownPaused = hub.pausedReason();
  function syncPaused(): void {
    const reason = hub.pausedReason();
    if (reason !== shownPaused) gui?.broadcast("paused", { reason });
    shownPaused = reason;
  }

  // Ensure the default "group" channel exists (all agents as members, a
  // supervisor for routing). Re-run whenever the membership changes.
  function refreshDefaultChannel(): void {
    try {
      const c = hub.ensureDefaultChannel();
      gui?.broadcast("channels", hub.readChannels());
      print(`  # channel "${c.name}" (supervisor: ${c.supervisor ?? "(none)"}, members: ${c.members.join(", ") || "(none)"})`);
    } catch {
      // ignore
    }
  }
  refreshDefaultChannel();

  // GUI (optional): a web UI that streams group chat + per-agent RPC events.
  if (args.gui) {
    // Per-agent extension (plugin) selection, persisted to the fleet config.
    function setAgentExtensionsInConfig(name: string, extensions: string[]): void {
      const cfg = loadFleetConfig(hub.dir) ?? { agents: [] };
      const existing = cfg.agents.find((a) => a.name === name);
      if (existing) {
        existing.extensions = extensions;
      } else {
        const info = hub.readAgents()[name];
        cfg.agents.push({
          name,
          cwd: info?.cwd,
          model: info?.model,
          role: info?.role,
          extensions,
        });
      }
      saveFleetConfig(hub.dir, cfg);
    }

    function selectedExtensionsMap(): Record<string, string[]> {
      const cfg = loadFleetConfig(hub.dir);
      const out: Record<string, string[]> = {};
      for (const a of cfg?.agents ?? []) if (a.extensions?.length) out[a.name] = a.extensions;
      return out;
    }

    gui = new GuiServer({
      port: args.port,
      host: args.host,
      token: process.env.PI_FLEET_GUI_TOKEN || hub.guiToken(),
      getSnapshot: () => ({
        agents: Object.values(hub.readAgents()),
        messages: hub.tailMessages(200),
        channels: hub.readChannels(),
        paused: hub.pausedReason(),
      }),
      stopAll: stopAllRuns,
      onMessage: ({ to, text }) => {
        hub.appendMessage({ from: "user", to, kind: "chat", text });
      },
      onSessionName: async (name, sessionName) => {
        const handle = agents.get(name);
        if (!handle) throw new Error(`no running agent "${name}"`);
        await handle.rpc.setSessionName(sessionName);
      },
      onRpc: async (agent, command, payload) => {
        const handle = agents.get(agent);
        if (!handle) throw new Error(`no running agent "${agent}"`);
        // a direct prompt is the human speaking too: it counts as such for the brake
        if (command === "prompt") hub.appendMessage({ from: "user", to: agent, kind: "activity", text: "direct prompt" });
        const res = await handle.rpc.sendCommand({ type: command, ...payload });
        return res;
      },
      getExtensions: () => {
        // user extensions + project extensions for each running agent's cwd
        const cwds = [...new Set(Object.values(hub.readAgents()).map((a) => a.cwd).filter(Boolean))];
        const seen = new Set<string>();
        const available = [];
        for (const cwd of [undefined, ...cwds]) {
          for (const e of discoverExtensions(cwd)) {
            if (!seen.has(e.path)) {
              seen.add(e.path);
              available.push(e);
            }
          }
        }
        return { available, selected: selectedExtensionsMap() };
      },
      setAgentExtensions: (name, extensions) => setAgentExtensionsInConfig(name, extensions),
      getMcp: () => readMcpConfig(),
      setMcp: (cfg) => writeMcpConfig(cfg),
      spawnAgent: async (spec) => {
        const cwd = spec.cwd ? path.resolve(baseCwd, spec.cwd) : baseCwd;
        await spawnAndTrack(spec.name, cwd, spec.model ?? args.model, spec.role, extensionsFor(spec.name));
        refreshDefaultChannel();
      },
      getChannels: () => hub.readChannels(),
      upsertChannel: (ch) => {
        hub.upsertChannel(ch);
        gui?.broadcast("channels", hub.readChannels());
      },
      removeChannel: (name) => {
        if (name !== "group") hub.removeChannel(name);
        gui?.broadcast("channels", hub.readChannels());
      },
    });
    const port = await gui.start();
    print(`  🖥  GUI: ${gui.url}  (${port})`);
    if (args.host && !["127.0.0.1", "localhost", "::1"].includes(args.host)) {
      print(`  ⚠ GUI is exposed on ${args.host} over plain HTTP: whoever has this link controls the agents`);
    }
    if (args.open) {
      try {
        const cmd = process.platform === "win32" ? `start "" "${gui.url}"` : process.platform === "darwin" ? `open "${gui.url}"` : `xdg-open "${gui.url}"`;
        execSync(cmd, { stdio: "ignore" });
      } catch {
        // ignore — the URL is printed above
      }
    }
  }

  // tail the bus
  let offset = hub.messagesSize();
  const lookup = new Map<string, FleetMessage>();
  const ROTATE_BYTES = 2 * 1024 * 1024; // 2 MB

  /** Hand one agent its wake text; anything that cannot land is reported on the bus. */
  async function deliverWake(name: string, text: string): Promise<void> {
    let reason = "agent is not running";
    for (let attempt = 0; attempt < WAKE_RETRIES; attempt++) {
      if (hub.pausedReason() !== null) return; // a retry must not outlive Stop all
      const handle = agents.get(name);
      if (!handle || !handle.rpc.alive) break;
      try {
        const res = await handle.rpc.prompt(text, "followUp");
        if (res.success !== false) return;
        reason = String(res.error ?? "refused by pi");
      } catch (err) {
        // a timed-out prompt may still land, so sending it again could double it
        reason = (err as Error).message;
        break;
      }
      await new Promise((r) => setTimeout(r, WAKE_RETRY_MS));
    }
    hub.appendMessage({ from: "system", to: "group", kind: "system", text: `message for "${name}" was not delivered: ${reason}` });
  }

  // One queue per agent, so a retry cannot let a later message overtake it.
  const wakeQueues = new Map<string, Promise<void>>();

  // Direct wake: while attached, the supervisor is the wake authority. For each
  // new chat message it computes which agents it wakes (channel-aware: a
  // supervised channel wakes only its router, in "route" mode) and pushes the
  // wake straight over RPC — no 3s poll delay. A busy agent gets it as a
  // follow-up to its current run. The agent's own poller stays dormant while
  // the heartbeat is fresh (see below), so there is no double-wake.
  function pushDirectWakes(messages: FleetMessage[]): void {
    if (messages.length === 0) return;
    const channels = hub.readChannels();
    const agentList = Object.values(hub.readAgents());
    const perAgent = new Map<string, string>(); // name -> accumulated wake text
    for (const m of messages) {
      if (!admitMessage(m, hub, limits.maxHops) || m.kind !== "chat") continue;
      for (const info of agentList) {
        const name = info.name;
        if (m.from === name) continue; // never wake self
        const d = wakeDecision(m, name, lookup, channels);
        if (!d.wake) continue;
        const text =
          d.mode === "route" && d.channel
            ? routingPrompt(d.channel, m, agentList)
            : formatInbox([m], lookup);
        perAgent.set(name, perAgent.has(name) ? `${perAgent.get(name)}\n\n${text}` : text);
      }
    }
    for (const [name, text] of perAgent) {
      wakeQueues.set(name, (wakeQueues.get(name) ?? Promise.resolve()).then(() => deliverWake(name, text)));
    }
  }

  const tailer = setInterval(() => {
    try {
      if (hub.rotateIfLarge(ROTATE_BYTES)) {
        offset = 0;
        lookup.clear();
      }
      const { messages, nextOffset } = hub.readMessagesSince(offset);
      offset = nextOffset;
      for (const m of messages) {
        lookup.set(m.id, m);
        lookup.set(shortId(m.id), m);
        print(formatMessage(m, lookup));
        gui?.broadcast("message", m);
      }
      pushDirectWakes(messages);
      syncPaused();
    } catch {
      // ignore
    }
  }, 700);

  // Supervisor heartbeat: agents read this to know the supervisor is attached
  // (and will push wakes) vs. detached (they must self-wake via polling).
  const heartbeat = setInterval(() => hub.writeSupervisorHeartbeat(), 2000);
  hub.writeSupervisorHeartbeat();

  printBanner();
  if (!headless) {
    rl = readline.createInterface({ input: process.stdin, output: process.stdout, terminal: interactive });
    if (interactive) {
      rl.setPrompt("fleet> ");
      rl.prompt();
      // With no listener readline answers Ctrl+C / Ctrl+D by closing input and nothing else.
      rl.on("SIGINT", () => void shutdown());
      rl.on("close", () => void shutdown());
    }
  } else {
    print(`  ⚙ headless — serving the web UI; press Ctrl+C to stop`);
  }

  async function stopAgent(name: string) {
    const handle = agents.get(name);
    if (!handle) {
      print(`  no running agent "${name}"`);
      return;
    }
    print(`  - stopping [${name}]…`);
    handle.rpc.close();
    killProcessTree(handle.rpc.pid); // kill the bridge (and its pi child)
    agents.delete(name);
  }

  if (rl) rl.on("line", async (line) => {
    const input = line.trim();
    if (!input) {
      if (interactive) rl!.prompt();
      return;
    }
    (async () => {
      try {
        if (input === "/quit" || input === "/exit") {
          return shutdown();
        } else if (input === "/agents") {
          const reg = Object.values(hub.readAgents());
          print(reg.length ? reg.map((a) => `  ${a.name} [${a.status}] pid ${a.pid} alive=${isPidAlive(a.pid)} cwd ${a.cwd}`).join("\n") : "  (none)");
        } else if (input === "/stats") {
          print("  querying session stats…");
          const rows: string[] = [];
          for (const [name, handle] of agents) {
            try {
              const resp = await handle.rpc.getStats();
              const data = ((resp.data ?? resp) as Record<string, any>) ?? {};
              const tokens = (data.tokens ?? {}) as Record<string, number>;
              const cost = Number(data.cost ?? 0);
              const ctx = (data.contextUsage ?? {}) as Record<string, number>;
              hub.saveStats(name, data);
              rows.push(`  ${name.padEnd(14)} tokens=${String(tokens.total ?? 0).padStart(8)}  cost=$${cost.toFixed(4)}  ctx=${String(ctx.tokens ?? 0)}/${String(ctx.contextWindow ?? "?")}`);
            } catch (e) {
              rows.push(`  ${name.padEnd(14)} (error: ${(e as Error).message})`);
            }
          }
          print(rows.length ? rows.join("\n") : "  (no agents)");
        } else if (input.startsWith("/new ")) {
          const parts = input.slice(5).trim().split(/\s+/);
          const name = parts[0];
          const cwd = parts[1] ? path.resolve(parts[1]) : baseCwd;
          const model = parts[2];
          const role = parts[3];
          const reg = hub.readAgents()[name];
          if (reg && isPidAlive(reg.pid) && reg.pipeIn && reg.pipeOut && !agents.has(name)) {
            await reattachAndTrack(reg);
          } else {
            await spawnAndTrack(name, cwd, model ?? args.model, role);
          }
          refreshDefaultChannel();
        } else if (input === "/stopall") {
          print(`  stopped ${await stopAllRuns()} agent(s); your next message resumes the fleet`);
        } else if (input.startsWith("/stop ")) {
          await stopAgent(input.slice(6).trim());
        } else if (input.startsWith("@")) {
          const m = input.match(/^@(\S+)\s+([\s\S]+)$/);
          if (!m) print("  usage: @name message");
          else hub.appendMessage({ from: "user", to: m[1], kind: "chat", text: m[2] });
        } else if (input.startsWith("#")) {
          if (input.startsWith("# ")) {
            const text = input.slice(2).trim();
            if (text) hub.appendMessage({ from: "user", to: "group", kind: "chat", text });
          } else {
            const m = input.match(/^#(\S+)\s+([\s\S]+)$/);
            if (m) hub.appendMessage({ from: "user", to: m[1], kind: "chat", text: m[2] });
            else print("  usage: #name message   (or '# message' for the group)");
          }
        } else if (input === "/channel" || input.startsWith("/channel ")) {
          const parts = input.slice(8).trim().split(/\s+/).filter(Boolean);
          if (parts.length === 0) {
            const channels = hub.readChannels();
            print(channels.length ? channels.map((c) => `  #${c.name}  supervisor=${c.supervisor ?? "(first)"}  members=${c.members.join(", ") || "(none)"}${c.summary ? "  [summary]" : ""}`).join("\n") : "  (no channels)");
          } else if (parts[0] === "add") {
            const name = parts[1];
            const members = (parts[2] ?? "").split(",").map((s) => s.trim()).filter(Boolean);
            const supervisor = parts[3];
            if (!name || members.length === 0) { print("  usage: /channel add <name> <m1,m2,...> [supervisor]"); }
            else {
              hub.upsertChannel({ name, members, supervisor });
              gui?.broadcast("channels", hub.readChannels());
              print(`  created #${name} (members: ${members.join(", ")}, supervisor: ${supervisor ?? members[0]})`);
            }
          } else if (parts[0] === "rm") {
            const name = parts[1];
            if (name && name !== "group") { hub.removeChannel(name); gui?.broadcast("channels", hub.readChannels()); print(`  removed #${name}`); }
            else print("  (cannot remove the default 'group' channel)");
          } else {
            print("  usage: /channel | /channel add <name> <m1,m2,...> [supervisor] | /channel rm <name>");
          }
        } else {
          hub.appendMessage({ from: "user", to: "group", kind: "chat", text: input });
        }
      } catch (err) {
        print(`  error: ${(err as Error).message}`);
      } finally {
        if (!shuttingDown && interactive) rl!.prompt();
      }
    })();
  });

  async function shutdown() {
    if (shuttingDown) return;
    shuttingDown = true;
    clearInterval(tailer);
    clearInterval(heartbeat);
    hub.clearSupervisorHeartbeat(); // tell agents the supervisor is gone (they self-wake now)
    gui?.close();
    rl?.close();
    if (args.detach) {
      print("\n  detaching — agents keep running; re-attach with `fleet up`");
      for (const a of agents.values()) {
        try {
          a.rpc.close();
          hub.updateAgent(a.name, { status: "idle" });
        } catch {
          // ignore
        }
      }
    } else {
      print("\n  shutting down…");
      await Promise.allSettled([...agents.values()].map((a) => a.rpc.close()));
      for (const a of agents.values()) {
        killProcessTree(a.rpc.pid);
        try {
          hub.updateAgent(a.name, { status: "stopped" });
        } catch {
          // ignore
        }
      }
    }
    process.exit(0);
  }

  process.on("SIGINT", () => void shutdown());
}

function cmdList(dir: string | undefined, baseCwd: string) {
  const hub = new Hub(dir ?? path.join(baseCwd, ".pi-fleet"));
  const agents = Object.values(hub.readAgents());
  if (agents.length === 0) {
    console.log("(no agents registered)");
    return;
  }
  const stats = hub.readStats();
  for (const a of agents) {
    const alive = isPidAlive(a.pid);
    const s = stats[a.name];
    const tokens = s ? ((s.tokens as Record<string, number>)?.total ?? 0) : 0;
    const cost = s ? Number(s.cost ?? 0) : 0;
    const statLabel = s ? `  tokens=${tokens} cost=$${cost.toFixed(4)}` : "";
    console.log(`${a.name.padEnd(16)} [${a.status.padEnd(8)}] pid ${String(a.pid).padEnd(7)} ${alive ? "alive" : "dead"}  cwd ${a.cwd}${statLabel}`);
  }
}

async function cmdStop(target: string | undefined, dir: string | undefined, baseCwd: string) {
  const hub = new Hub(dir ?? path.join(baseCwd, ".pi-fleet"));
  const agents = Object.values(hub.readAgents());
  const targets = target === "all" || !target ? agents : agents.filter((a) => a.name === target);
  if (targets.length === 0) {
    console.log(`no agent "${target}"`);
    return;
  }
  for (const a of targets) {
    if (!isPidAlive(a.pid)) {
      console.log(`${a.name}: not running (pid ${a.pid})`);
      continue;
    }
    if (!a.pipeIn || !(await bridgeListening(a.pipeIn))) {
      console.log(`${a.name}: pid ${a.pid} is not this agent's bridge any more (stale registry entry), left it alone`);
      hub.updateAgent(a.name, { status: "stopped" });
      continue;
    }
    try {
      if (process.platform === "win32") {
        // /T kills the process tree (pi spawns children)
        execSync(`taskkill /PID ${a.pid} /T /F`, { stdio: "ignore" });
      } else {
        process.kill(a.pid, "SIGTERM");
      }
      console.log(`${a.name}: stopped (pid ${a.pid})`);
    } catch (err) {
      console.log(`${a.name}: ${String(err)}`);
    }
    hub.updateAgent(a.name, { status: "stopped" });
  }
}

function cmdLog(name: string | undefined, dir: string | undefined, baseCwd: string) {
  const hub = new Hub(dir ?? path.join(baseCwd, ".pi-fleet"));
  const agents = Object.values(hub.readAgents());
  const a = name ? agents.find((x) => x.name === name) : agents[agents.length - 1];
  if (!a) {
    console.log("no agent log found");
    return;
  }
  const file = a.logFile ?? hub.logFileFor(a.name);
  if (!fs.existsSync(file)) {
    console.log(`no log file: ${file}`);
    return;
  }
  console.log(`--- ${file} ---`);
  console.log(fs.readFileSync(file, "utf8"));
}

/** `fleet init [dir]` — create a starter fleet.json (does not overwrite). */
function cmdInit(dir: string | undefined, baseCwd: string) {
  const hubDir = dir ?? path.join(baseCwd, ".pi-fleet");
  const p = configPath(hubDir);
  if (fs.existsSync(p)) {
    console.log(`config already exists: ${p}`);
    return;
  }
  saveFleetConfig(hubDir, templateConfig());
  console.log(`wrote ${p}`);
  console.log("edit it to set defaultModel and your agents, then run: fleet up");
}

/** `fleet config [dir]` — show the fleet.json. */
function cmdConfig(dir: string | undefined, baseCwd: string) {
  const hubDir = dir ?? path.join(baseCwd, ".pi-fleet");
  const p = configPath(hubDir);
  if (!fs.existsSync(p)) {
    console.log(`no config at ${p} (run: fleet init)`);
    return;
  }
  console.log(`--- ${p} ---`);
  console.log(fs.readFileSync(p, "utf8"));
}

/** `fleet templates` — list the available --template presets. */
function cmdTemplates(): void {
  console.log("Available fleet templates:\n");
  for (const [name, tpl] of Object.entries(TEMPLATES)) {
    const agents = tpl.agents.map((a) => `${a.name}(${a.role ?? "-"})`).join(", ");
    console.log(`  ${name.padEnd(10)} ${tpl.description}`);
    console.log(`             agents: ${agents}`);
  }
  console.log("\nUsage: npm run fleet -- up --template <name> [--model <model>] [--dir <dir>]");
}

/**
 * `fleet rename <agent> <session-name> [dir]` — set the pi session display name
 * for a running agent (forwards set_session_name over RPC). The name shows up in
 * pi's session listings.
 */
async function cmdRename(agent: string | undefined, sessionName: string | undefined, dir: string | undefined, baseCwd: string) {
  if (!agent || !sessionName) {
    console.log("usage: fleet rename <agent> <session-name> [--dir DIR]");
    return;
  }
  const hub = new Hub(dir ?? path.join(baseCwd, ".pi-fleet"));
  const a = Object.values(hub.readAgents()).find((x) => x.name === agent);
  if (!a) {
    console.log(`no agent "${agent}"`);
    return;
  }
  if (!a.pipeIn || !a.pipeOut || !isPidAlive(a.pid)) {
    console.log(`agent "${agent}" is not running (pid ${a.pid})`);
    return;
  }
  const rpc = await PiRpcBridge.connect(a.pipeIn, a.pipeOut, a.pid);
  try {
    const res = await rpc.setSessionName(sessionName);
    console.log(res.success === false ? `rename failed: ${JSON.stringify(res)}` : `session for "${agent}" named: ${sessionName}`);
  } finally {
    await rpc.close();
  }
}

function main() {
  const [cmd, ...rest] = process.argv.slice(2);
  const baseCwd = process.cwd();
  switch (cmd) {
    case "up":
      void cmdUp(parseArgs(rest), baseCwd);
      break;
    case "serve": {
      // headless: spawn the fleet (from --agent/--template/fleet.json) and serve the web UI
      const p = parseArgs(rest);
      if (!p.gui) p.gui = true; // serve implies the web UI
      void cmdUp(p, baseCwd, true);
      break;
    }
    case "list": {
      const p = parseArgs(rest);
      cmdList(p.dir, baseCwd);
      break;
    }
    case "stop": {
      const p = parseArgs(rest);
      void cmdStop(p.rest[0], p.dir, baseCwd);
      break;
    }
    case "log": {
      const p = parseArgs(rest);
      cmdLog(p.rest[0], p.dir, baseCwd);
      break;
    }
    case "init": {
      const p = parseArgs(rest);
      cmdInit(p.dir, baseCwd);
      break;
    }
    case "config": {
      const p = parseArgs(rest);
      cmdConfig(p.dir, baseCwd);
      break;
    }
    case "templates": {
      cmdTemplates();
      break;
    }
    case "rename": {
      const p = parseArgs(rest);
      void cmdRename(p.rest[0], p.rest[1], p.dir, baseCwd);
      break;
    }
    default:
      console.log(`pi-fleet — multi-agent supervisor for pi

Usage:
  npm run fleet -- up --agent name[:cwd][:model][:role] [--agent name2[:cwd2][:model2]] [--model M] [--lean] [--detach] [--gui [--open] [--port N]] [--max-turns N] [--max-hops N] [--dir DIR]
  npm run fleet -- list [--dir DIR]
  npm run fleet -- stop [name|all] [--dir DIR]
  npm run fleet -- log [name] [--dir DIR]
  npm run fleet -- init [--dir DIR]         # create a starter fleet.json
  npm run fleet -- templates                 # list --template presets (sdlc, pair, solo)
  npm run fleet -- config [--dir DIR]        # show fleet.json
  npm run fleet -- rename <agent> <name>     # set an agent's pi session display name
  npm run fleet -- serve [--agent ... | --template ...] [--port N] [--host H]   # headless web UI

  With no --agent flags, up reads the fleet from <dir>/fleet.json (see: fleet init).

  Agent spec: name[:cwd][:model][:role] — per-agent model overrides --model; role (planner|implementer|reviewer) sets a prompt preset.
  --lean: smaller prompt for weak/local models (no skills, no web/research tools).
  --detach: agents keep running after /quit; re-attach later with: fleet up (auto-resume).
  --gui: open a web UI (group chat + per-agent live RPC-event activity); --open launches the browser.
         Open the link printed at startup: it carries the access token (kept in <dir>/gui-token).
  --host H: GUI bind address (default 127.0.0.1; use 0.0.0.0 for LAN access). serve runs the web UI headless.
  --max-turns N: abort an agent after N turns in one run (default ${DEFAULT_MAX_TURNS}; 0 = no limit).
  --max-hops N: pause the fleet after N agent messages since your last message (default ${DEFAULT_MAX_HOPS}; 0 = no limit).

Group chat input:
  # text          broadcast to the group
  #name text      post to a named channel
  @name text      direct message
  /agents         list agents
  /stats          per-agent token + cost usage (get_session_stats)
  /channel        list channels; /channel add <name> <m1,m2> [sup]; /channel rm <name>
  /new name [cwd] [model] [role]   spawn an agent
  /stop name      stop an agent
  /stopall        abort every run and pause the fleet until your next message
  /quit           stop all and exit`);
  }
}

main();