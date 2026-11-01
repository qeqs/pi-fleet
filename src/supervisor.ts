/**
 * The supervisor: spawns or re-attaches the agents, tails the bus, pushes wakes to
 * agents, serves the GUI and runs the terminal chat.
 */
import { execSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import readline from "node:readline";
import { fileURLToPath } from "node:url";
import { Hub, isPidAlive, formatMessage, shortId, DEFAULT_MAX_HOPS, DEFAULT_MAX_TURNS, type AgentInfo, type ChannelConfig, type FleetMessage } from "./hub.ts";
import { PiRpcBridge, bridgeListening } from "./rpc.ts";
import { agentNameFromSpec, agentCwdFromSpec, agentModelFromSpec, agentRoleFromSpec, isValidAgentName } from "./spec.ts";
import { CHAT_HELP, parseChatLine } from "./chat.ts";
import { GuiServer } from "./gui.ts";
import { loadFleetConfig, agentSpecFromConfig, saveFleetConfig, configPath, isBudget, checkFleetConfig } from "./config.ts";
import { expandTemplate, templateNames, templateDescription, TEMPLATES } from "./templates.ts";
import { discoverExtensions, readMcpConfig, writeMcpConfig } from "./pi-resources.ts";
import { computeWakes } from "./wakes.ts";
import { availableModels, killProcessTree, probeContextWindow, resolveLean, spawnAgent, type AgentHandle } from "./spawn.ts";
import { RestartPolicy } from "./restart.ts";
import { describeQuestion, parseAnswer, questionFrom, type Answer, type Question } from "./questions.ts";
import { fallbackRoute, ModelRouter, parseRouterReply, routeByRules, routerPrompt, type RouteDecision } from "./router.ts";
import { applyRoute } from "./extension/index.ts";
import { UsageError, budgetArg, type FleetArgs, type Limits } from "./cli.ts";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

/** A wake pi refuses (e.g. mid-compaction) is retried for about a minute before it is left for later. */
const WAKE_RETRIES = 12;
const WAKE_RETRY_MS = 5000;

/** Put in front of a wake the agent had accepted but not finished when it went down. */
const INTERRUPTED_NOTE = "You were restarted before you finished the work below. Check what is already done, then carry on.";

/** The dedicated router's name on the bus, and its inbox of messages to route. */
const ROUTER = "router";

function printBanner() {
  console.log("");
  console.log("  pi-fleet group chat");
  console.log("  # text            broadcast to group");
  console.log("  @name text        direct message");
  console.log("  /agents /new /stop /stopall /stats /quit");
  console.log("");
}

export async function cmdUp(args: FleetArgs, baseCwd: string, headless = false) {
  const hub = new Hub(args.dir ?? path.join(baseCwd, ".pi-fleet"));
  const agents = new Map<string, AgentHandle>();
  const spawnedHere = new Set<string>(); // not re-attached: this run answers for them if the start fails
  const stopping = new Set<string>(); // stopped on purpose, so their exit is not a crash
  const restarts = new Map<string, RestartPolicy>();
  const questions = new Map<string, Question>(); // waiting for the human, by request id
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
    if (!t) throw new UsageError(`unknown template "${args.template}" (available: ${templateNames().join(", ")})`);
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
  const leanFor = (name: string): boolean | undefined => args.lean ?? fleetCfg?.agents.find((a) => a.name === name)?.lean;
  const limits: Limits = {
    maxTurns: args.maxTurns ?? fleetCfg?.maxTurns ?? DEFAULT_MAX_TURNS,
    maxHops: args.maxHops ?? fleetCfg?.maxHops ?? DEFAULT_MAX_HOPS,
    maxCost: args.maxCost ?? fleetCfg?.maxCost,
  };
  const approveFor = (name: string): string[] | undefined => fleetCfg?.agents.find((a) => a.name === name)?.approve ?? args.approve;

  // One supervisor per hub: two would both push every wake, so agents would run twice.
  const other = hub.otherSupervisor();
  if (other) throw new Error(`another supervisor (pid ${other}) is already running on ${hub.dir}. Stop it, or use --dir for a separate fleet.`);

  // Supervisor heartbeat: agents read this to know the supervisor is attached
  // (and will push wakes) vs. detached (they must self-wake via polling).
  const heartbeat = setInterval(() => hub.writeSupervisorHeartbeat(), 2000);
  hub.writeSupervisorHeartbeat();

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

  /** An agent is blocked on the human until this is answered, so it has to be impossible to miss. */
  function onQuestion(name: string, rec: Record<string, unknown>): void {
    const q = questionFrom(name, rec);
    if (!q) {
      if (rec.method === "notify") print(`  ! [${name}] ${String(rec.message)}`);
      return;
    }
    questions.set(q.id, q);
    hub.updateAgent(name, { status: "waiting" });
    gui?.broadcast("status", { name, status: "waiting" });
    gui?.broadcast("question", q);
    hub.appendMessage({ from: "system", to: "group", kind: "system", text: `agent "${name}" is waiting for you: ${describeQuestion(q)}` });
    print(`  ? [${name}] answer with: /answer ${name} ...`);
    if (q.timeout) setTimeout(() => forgetQuestion(q.id), q.timeout);
  }

  function forgetQuestion(id: string): void {
    if (questions.delete(id)) gui?.broadcast("question_gone", { id });
  }

  function answerQuestion(id: string, answer: Answer): void {
    const q = questions.get(id);
    if (!q) throw new Error("that question is no longer waiting");
    const handle = agents.get(q.agent);
    if (!handle) throw new Error(`agent "${q.agent}" is not running`);
    handle.rpc.write({ type: "extension_ui_response", id, ...answer });
    forgetQuestion(id);
    if (![...questions.values()].some((other) => other.agent === q.agent)) {
      hub.updateAgent(q.agent, { status: "busy" });
      gui?.broadcast("status", { name: q.agent, status: "busy" });
    }
  }

  /** Keep the numbers current, and stop spending the moment the budget is gone. */
  async function refreshStats(name: string, handle: AgentHandle): Promise<void> {
    const resp = await handle.rpc.getStats().catch(() => null);
    const data = resp?.data as Record<string, unknown> | undefined;
    if (!data) return;
    hub.saveStats(name, data);
    gui?.broadcast("stats", { name, stats: data });
    checkBudget();
  }

  function checkBudget(): void {
    if (limits.maxCost === undefined || hub.pausedReason() !== null) return;
    const spent = Object.values(hub.readStats()).reduce((sum, s) => sum + Number(s.cost ?? 0), 0);
    if (spent >= limits.maxCost) void stopAllRuns(`spending limit reached: $${spent.toFixed(2)} of $${limits.maxCost} (raise it with /budget)`);
  }

  // the dedicated router: one bare pi per model, started on first use
  const routers = new Map<string, ModelRouter>();
  function routerFor(channel: ChannelConfig): ModelRouter {
    const info = hub.readAgents();
    const model = channel.supervisorModel ?? args.routerModel ?? fleetCfg?.routerModel ?? args.model ?? channel.members.map((m) => info[m]?.model).find(Boolean);
    let router = routers.get(model ?? "");
    if (!router) {
      router = new ModelRouter(ROOT, hub.dir, hub.logFileFor(ROUTER), model);
      routers.set(model ?? "", router);
    }
    return router;
  }

  /** Decide who acts on a channel message: a rule if one fits, else one short model call. */
  async function decideRoute(m: FleetMessage, channel: ChannelConfig): Promise<RouteDecision> {
    const known = Object.values(hub.readAgents());
    const byRule = routeByRules(m, channel, known);
    if (byRule) return { respond: byRule };
    const reply = await routerFor(channel).ask(routerPrompt(channel, m, known, hub.tailMessages(40))).catch(() => "");
    const spent = [...routers.values()].reduce((sum, r) => ({ tokens: sum.tokens + r.spent.tokens, cost: sum.cost + r.spent.cost }), { tokens: 0, cost: 0 });
    const stats = { tokens: { total: spent.tokens }, cost: spent.cost };
    hub.saveStats(ROUTER, stats);
    gui?.broadcast("stats", { name: ROUTER, stats });
    checkBudget();
    const decision = parseRouterReply(reply, channel);
    if (decision) return decision;
    const respond = fallbackRoute(channel, known, [...agents.keys()]);
    hub.appendMessage({ from: "system", to: "group", kind: "system", text: `the router gave no usable answer, so a message in #${channel.name} went to ${respond.join(", ") || "nobody"}` });
    return { respond };
  }

  /** Work through the messages waiting for the router. They stay on disk until they are routed. */
  async function pumpRouter(): Promise<void> {
    for (const entry of hub.readInbox(ROUTER)) {
      if (hub.pausedReason() !== null) return;
      const m = JSON.parse(entry.text) as FleetMessage;
      const channel = hub.getChannel(m.to);
      if (channel) {
        const decision = await decideRoute(m, channel);
        if (hub.pausedReason() !== null) return; // the budget, or Stop all, came first
        const respond = decision.respond.filter((name) => name !== m.from);
        applyRoute(hub, ROUTER, channel, m, respond, decision.summary ?? "");
      }
      hub.removeFromInbox(ROUTER, entry.id);
    }
  }

  let routing: Promise<void> = Promise.resolve();
  function scheduleRouting(): void {
    routing = routing.then(pumpRouter).catch((err: Error) => {
      hub.appendMessage({ from: "system", to: "group", kind: "system", text: `routing failed: ${err.message}` });
    });
  }

  function wire(handle: AgentHandle, name: string) {
    handle.rpc.onEvent = (rec) => {
      const t = rec.type as string;
      if (t === "extension_ui_request") return onQuestion(name, rec);
      if (t === "turn_end" || t === "agent_settled") void refreshStats(name, handle);
      if (t === "agent_start") {
        print(`  ⟳ [${name}] working…`);
      } else if (t === "tool_execution_start") {
        const tool = String(rec.toolName ?? "");
        print(`  ⚙ [${name}] ${tool}`);
      } else if (t === "agent_settled") {
        print(`  ✓ [${name}] settled — ${listAgentsLine()}`);
        hub.ackDelivered(name);
        forgetQuestionsOf(name);
      }
      // keep the GUI status badge in sync with the run state
      if (t === "agent_start") gui?.broadcast("status", { name, status: "busy" });
      else if (t === "agent_settled") gui?.broadcast("status", { name, status: "idle" });
      // stream every RPC event to the GUI (validates the event data flow)
      gui?.broadcast("agent_event", { name, event: rec });
    };
    handle.rpc.onExit = (code) => {
      agents.delete(name);
      forgetQuestionsOf(name);
      print(`  ✕ [${name}] exited (${code})`);
      if (shuttingDown || stopping.delete(name)) return;
      hub.updateAgent(name, { status: "stopped" });
      hub.appendMessage({ from: "system", to: "group", kind: "system", text: `agent "${name}" stopped unexpectedly. Its log: ${hub.logFileFor(name)}` });
      gui?.broadcast("status", { name, status: "stopped" });
      reassignRouters();
      restartAfterCrash(name);
    };
  }

  function forgetQuestionsOf(name: string): void {
    for (const q of questions.values()) if (q.agent === name) forgetQuestion(q.id);
  }

  /** Bring a crashed agent back, spacing the attempts out and giving up on a crash loop. */
  function restartAfterCrash(name: string): void {
    if (args.noRestart || shuttingDown) return;
    const policy = restarts.get(name) ?? new RestartPolicy();
    restarts.set(name, policy);
    const delay = policy.next();
    if (delay === null) {
      hub.appendMessage({ from: "system", to: "group", kind: "system", text: `agent "${name}" keeps crashing, so it was left stopped. Check its log, then use /restart.` });
      return;
    }
    hub.appendMessage({ from: "system", to: "group", kind: "system", text: `restarting agent "${name}" in ${delay / 1000}s` });
    setTimeout(() => {
      reviveAgent(name).catch((err: Error) => {
        hub.appendMessage({ from: "system", to: "group", kind: "system", text: `agent "${name}" did not restart: ${err.message}` });
        restartAfterCrash(name);
      });
    }, delay);
  }

  /** Start a stopped agent again as it was, with its conversation and whatever it was doing. */
  async function reviveAgent(name: string): Promise<void> {
    const info = hub.readAgents()[name];
    if (shuttingDown || agents.has(name) || !info) return;
    await spawnAndTrack(name, info.cwd, info.model, info.role, extensionsFor(name));
    refreshDefaultChannel();
    schedulePump(name, true);
  }

  async function spawnAndTrack(name: string, cwd: string, model?: string, role?: string, extensions?: string[]) {
    if (agents.has(name)) throw new Error(`agent "${name}" already running`);
    const lean = await resolveLean(model, leanFor(name), leanCache);
    const prior = hub.readAgents()[name];
    // pi keeps sessions per directory, and writes none until the first exchange
    const resume = !args.fresh && prior?.sessionFile && prior.cwd === cwd && fs.existsSync(prior.sessionFile) ? prior.sessionFile : undefined;
    const handle = await spawnAgent(hub, name, cwd, limits, model, lean, role, extensions, resume, approveFor(name));
    spawnedHere.add(name);
    agents.set(name, handle);
    wire(handle, name);
    const modelLabel = model ? ` model=${model}` : "";
    const leanLabel = lean ? " lean" : "";
    const roleLabel = role ? ` role=${role}` : "";
    const extLabel = extensions && extensions.length ? ` plugins=${extensions.length}` : "";
    const resumeLabel = resume ? " resumed" : "";
    print(`  + [${name}] spawned (pid ${handle.rpc.pid}, cwd ${cwd}${modelLabel}${leanLabel}${roleLabel}${extLabel}${resumeLabel})`);
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

  /** A start that fails partway must not leave agents running with nobody attached. */
  function abandonStart(): void {
    shuttingDown = true;
    clearInterval(heartbeat);
    hub.clearSupervisorHeartbeat();
    for (const a of agents.values()) {
      a.rpc.close();
      if (spawnedHere.has(a.name)) {
        killProcessTree(a.rpc.pid);
        hub.updateAgent(a.name, { status: "stopped" });
      }
    }
  }

  // initial agents — auto-resume: re-attach to live bridges, spawn the rest
  const live: AgentInfo[] = [];
  for (const a of Object.values(hub.readAgents())) {
    if (a.pipeIn && a.pipeOut && isPidAlive(a.pid) && (await bridgeListening(a.pipeIn))) live.push(a);
    // gone without a word (crash, reboot): whatever it last reported no longer holds
    else if (a.status !== "stopped") hub.updateAgent(a.name, { status: "stopped" });
  }
  const liveByName = new Map(live.map((a) => [a.name, a]));
  try {
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
  } catch (err) {
    abandonStart();
    throw err;
  }
  if (agents.size === 0) {
    print("  (no agents running — use /new name [cwd] to spawn one)");
  }

  /** Abort every run and drop what is queued; the pause stops their last messages waking anyone. */
  async function stopAllRuns(reason = "stopped by you"): Promise<number> {
    hub.pause(reason);
    syncPaused();
    const running = [...agents.values()];
    await Promise.allSettled(
      running.map(async (a) => {
        hub.clearInbox(a.name);
        hub.clearInbox(ROUTER);
        // in this order: pi carries on with whatever is still queued after an abort
        await a.rpc.sendCommand({ type: "clear_queue" });
        await a.rpc.sendCommand({ type: "abort" });
      }),
    );
    return running.length;
  }

  // Keep the GUI's paused banner in step with the hub.
  let shownPaused = hub.pausedReason();
  let shownHeld = hub.heldMessages().length;
  function syncPaused(): void {
    const reason = hub.pausedReason();
    const held = reason === null ? 0 : hub.heldMessages().length;
    if (reason !== shownPaused || held !== shownHeld) gui?.broadcast("paused", { reason, held });
    if (reason === null && shownPaused !== null) scheduleRouting(); // what the router left when the pause began
    shownPaused = reason;
    shownHeld = held;
  }

  /** Lift a pause and let what it held back through, so a long chain continues where it stopped. */
  function resumeHeld(): number {
    const held = hub.heldMessages();
    if (hub.pausedReason() === null) return 0;
    // the mark restarts the hop count; held messages are delivered past the limit on purpose
    hub.appendMessage({ from: "user", to: "group", kind: "activity", text: "resumed" });
    hub.resume();
    syncPaused();
    const woken = [...computeWakes(held, hub, lookup, 0, (m) => hub.enqueueWake(ROUTER, JSON.stringify(m)))];
    for (const [name, text] of woken) hub.enqueueWake(name, text);
    for (const [name] of woken) schedulePump(name);
    scheduleRouting();
    return held.length;
  }

  /** Channels stop when their router does: hand them to a running member and say so. */
  function reassignRouters(): void {
    const changes = hub.reassignSupervisors([...agents.keys()]);
    for (const { channel, supervisor } of changes) {
      hub.appendMessage({ from: "system", to: "group", kind: "system", text: `#${channel} is now routed by "${supervisor}"` });
    }
    if (changes.length > 0) gui?.broadcast("channels", hub.readChannels());
  }

  // Ensure the default "group" channel exists (all agents as members, a
  // supervisor for routing). Re-run whenever the membership changes.
  function refreshDefaultChannel(): void {
    try {
      hub.ensureDefaultChannel();
      reassignRouters();
      const c = hub.getChannel("group");
      gui?.broadcast("channels", hub.readChannels());
      print(`  # channel "group" (routed by ${c?.supervisor ?? "the router"}, members: ${c?.members.join(", ") || "(none)"})`);
    } catch {
      // ignore
    }
  }
  refreshDefaultChannel();

  function saveChannel(channel: ChannelConfig): void {
    if (channel.name !== "group" && !isValidAgentName(channel.name)) throw new Error(`invalid channel name "${channel.name}": use letters, digits, "_" and "-"`);
    if (hub.readAgents()[channel.name]) throw new Error(`"${channel.name}" is already an agent: a channel needs its own name`);
    hub.upsertChannel(channel);
    gui?.broadcast("channels", hub.readChannels());
  }

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
        held: hub.heldMessages().length,
        questions: [...questions.values()],
        stats: hub.readStats(),
        maxCost: limits.maxCost,
        templates: Object.entries(TEMPLATES).map(([name, t]) => ({ name, description: t.description })),
        defaultModel: args.model,
      }),
      controls: {
        stopAgent: (name) => stopAgent(name),
        restartAgent: (name) => restartAgent(name),
        removeAgent: forgetAgent,
        startTemplate,
        models: () => availableModels([...agents.values()][0]?.rpc),
        readConfig: () => loadFleetConfig(hub.dir) ?? { agents: [] },
        writeConfig: (config) => saveFleetConfig(hub.dir, checkFleetConfig(config, "fleet config")),
        search: (query) => hub.searchMessages(query),
        clearChannel: (name) => {
          const channel = hub.getChannel(name);
          if (!channel) throw new Error(hub.unknownTarget(name));
          saveChannel({ ...channel, clearedAt: Date.now() });
        },
      },
      stopAll: () => stopAllRuns(),
      resumeHeld,
      answer: answerQuestion,
      setBudget: setBudget,
      onMessage: ({ to, text }) => {
        hub.postUserMessage(to, text);
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
      upsertChannel: saveChannel,
      removeChannel: (name) => {
        if (name !== "group") hub.removeChannel(name);
        gui?.broadcast("channels", hub.readChannels());
      },
    });
    let port: number;
    try {
      port = await gui.start();
    } catch (err) {
      abandonStart();
      throw new Error(`could not start the GUI on port ${args.port ?? "(any)"}: ${(err as Error).message}`);
    }
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

  // tail the bus, picking up where the last supervisor stopped. Agents alive from a
  // detached run may have got further by themselves, so those messages are theirs.
  let cursor = [hub.readCursor() ?? hub.busEnd(), ...live.flatMap((a) => (a.handled ? [a.handled] : []))].reduce((a, b) =>
    b.gen > a.gen || (b.gen === a.gen && b.offset > a.offset) ? b : a,
  );
  hub.writeCursor(cursor);
  const lookup = new Map<string, FleetMessage>();
  const ROTATE_BYTES = 2 * 1024 * 1024; // 2 MB

  /** Hand one agent one wake. False means it stays in the inbox for later. */
  async function deliverWake(name: string, text: string): Promise<boolean> {
    let reason = "";
    for (let attempt = 0; attempt < WAKE_RETRIES; attempt++) {
      if (hub.pausedReason() !== null) return false; // a retry must not outlive Stop all
      const handle = agents.get(name);
      if (!handle || !handle.rpc.alive) {
        if (!waitingFor.has(name)) {
          waitingFor.add(name);
          hub.appendMessage({ from: "system", to: "group", kind: "system", text: `"${name}" is not running: its messages will wait until it is back` });
        }
        return false;
      }
      waitingFor.delete(name);
      try {
        const res = await handle.rpc.prompt(text, "followUp");
        if (res.success !== false) return true;
        reason = String(res.error ?? "refused by pi");
      } catch (err) {
        // a timed-out prompt may still land, so sending it again could double it
        reason = (err as Error).message;
        break;
      }
      await new Promise((r) => setTimeout(r, WAKE_RETRY_MS));
    }
    hub.appendMessage({ from: "system", to: "group", kind: "system", text: `message for "${name}" could not be delivered yet: ${reason}` });
    return false;
  }

  const waitingFor = new Set<string>(); // agents already reported as not running

  /** Deliver an agent's inbox in order. What was accepted but unfinished comes back after a restart. */
  async function pumpInbox(name: string, restarted: boolean): Promise<void> {
    for (const entry of hub.readInbox(name)) {
      if (entry.delivered && !restarted) continue;
      const text = entry.delivered ? `${INTERRUPTED_NOTE}\n\n${entry.text}` : entry.text;
      if (!(await deliverWake(name, text))) return;
      hub.markDelivered(name, entry.id);
    }
  }

  // One queue per agent, so a retry cannot let a later message overtake it.
  const wakeQueues = new Map<string, Promise<void>>();
  function schedulePump(name: string, restarted = false): void {
    wakeQueues.set(name, (wakeQueues.get(name) ?? Promise.resolve()).then(() => pumpInbox(name, restarted)));
  }

  // Direct wake: while attached, the supervisor is the wake authority. For each
  // new chat message it computes which agents it wakes (channel-aware: a
  // supervised channel wakes only its router, in "route" mode) and pushes the
  // wake straight over RPC — no 3s poll delay. A busy agent gets it as a
  // follow-up to its current run. The agent's own poller stays dormant while
  // the heartbeat is fresh (see below), so there is no double-wake.
  const tailer = setInterval(() => {
    try {
      const { messages, next } = hub.readBus(cursor);
      const channels = messages.length > 0 ? hub.readChannels() : [];
      for (const m of messages) {
        lookup.set(m.id, m);
        lookup.set(shortId(m.id), m);
        print(formatMessage(m, lookup, channels));
        gui?.broadcast("message", m);
      }
      let toRoute = 0;
      const woken = [
        ...computeWakes(messages, hub, lookup, limits.maxHops, (m) => {
          hub.enqueueWake(ROUTER, JSON.stringify(m));
          toRoute++;
        }),
      ];
      for (const [name, text] of woken) hub.enqueueWake(name, text);
      // only now is the position safe to save: a crash above replays these messages
      cursor = next;
      if (messages.length > 0) hub.writeCursor(cursor);
      for (const [name] of woken) schedulePump(name);
      if (toRoute > 0) scheduleRouting();
      if (hub.rotateIfLarge(ROTATE_BYTES)) lookup.clear();
      syncPaused();
    } catch {
      // ignore
    }
  }, 700);

  // whatever waited in the inboxes while the fleet was down
  for (const name of agents.keys()) schedulePump(name, spawnedHere.has(name));
  scheduleRouting();

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

  /** Stop an agent and return once its bridge is really gone. */
  async function endAgent(handle: AgentHandle): Promise<void> {
    const { name } = handle;
    stopping.add(name);
    const pipeIn = hub.readAgents()[name]?.pipeIn;
    handle.rpc.close();
    killProcessTree(handle.rpc.pid); // kill the bridge (and its pi child)
    agents.delete(name);
    hub.updateAgent(name, { status: "stopped" });
    gui?.broadcast("status", { name, status: "stopped" });
    for (let i = 0; pipeIn && i < 50 && (await bridgeListening(pipeIn)); i++) await new Promise((r) => setTimeout(r, 100));
  }

  async function stopAgent(name: string) {
    const handle = agents.get(name);
    if (!handle) throw new Error(`no running agent "${name}"`);
    print(`  - stopping [${name}]…`);
    await endAgent(handle);
    hub.ackDelivered(name); // stopped on purpose: its work in progress is not to be resumed
    reassignRouters();
  }

  /** Forget an agent for good: stopped, out of the registry, the channels and the config. */
  async function forgetAgent(name: string): Promise<void> {
    const handle = agents.get(name);
    if (handle) await endAgent(handle);
    hub.clearInbox(name);
    hub.removeAgent(name);
    const cfg = loadFleetConfig(hub.dir);
    if (cfg?.agents.some((a) => a.name === name)) saveFleetConfig(hub.dir, { ...cfg, agents: cfg.agents.filter((a) => a.name !== name) });
    gui?.broadcast("agent_removed", { name });
    gui?.broadcast("channels", hub.readChannels());
  }

  /** Start a whole crew from the first-run screen, and remember it for next time. */
  async function startTemplate(template: string, model: string | undefined): Promise<void> {
    const crew = expandTemplate(template);
    if (!crew) throw new Error(`unknown template "${template}" (available: ${templateNames().join(", ")})`);
    if (model) args.model = model;
    for (const a of crew) await spawnAndTrack(a.name, baseCwd, model ?? args.model, a.role);
    refreshDefaultChannel();
    if (!loadFleetConfig(hub.dir)) saveFleetConfig(hub.dir, { defaultModel: model, agents: crew });
  }

  /** Restart an agent by hand. It keeps its conversation and any work in progress. */
  async function restartAgent(name: string): Promise<void> {
    const handle = agents.get(name);
    if (handle) await endAgent(handle);
    else if (!hub.readAgents()[name]) throw new Error(hub.unknownTarget(name));
    await reviveAgent(name);
    print(`  ↻ [${name}] restarted`);
  }

  function setBudget(dollars: number): void {
    if (!isBudget(dollars)) throw new Error("the spending limit must be a positive number of dollars");
    limits.maxCost = dollars;
    gui?.broadcast("budget", { maxCost: dollars });
  }

  /** Run one parsed terminal command. */
  async function runCommand(name: string, cmdArgs: string): Promise<void> {
    switch (name) {
      case "help":
        print(CHAT_HELP);
        return;
      case "quit":
      case "exit":
        return shutdown();
      case "agents": {
        const reg = Object.values(hub.readAgents());
        print(reg.length ? reg.map((a) => `  ${a.name} [${a.status}] pid ${a.pid} alive=${isPidAlive(a.pid)} cwd ${a.cwd}`).join("\n") : "  (none)");
        return;
      }
      case "stats": {
        print("  querying session stats…");
        const rows: string[] = [];
        for (const [agent, handle] of agents) {
          try {
            const resp = await handle.rpc.getStats();
            const data = ((resp.data ?? resp) as Record<string, any>) ?? {};
            const tokens = (data.tokens ?? {}) as Record<string, number>;
            const cost = Number(data.cost ?? 0);
            const ctx = (data.contextUsage ?? {}) as Record<string, number>;
            hub.saveStats(agent, data);
            rows.push(`  ${agent.padEnd(14)} tokens=${String(tokens.total ?? 0).padStart(8)}  cost=$${cost.toFixed(4)}  ctx=${String(ctx.tokens ?? 0)}/${String(ctx.contextWindow ?? "?")}`);
          } catch (e) {
            rows.push(`  ${agent.padEnd(14)} (error: ${(e as Error).message})`);
          }
        }
        print(rows.length ? rows.join("\n") : "  (no agents)");
        return;
      }
      case "new": {
        const parts = cmdArgs.split(/\s+/);
        const agent = parts[0];
        const cwd = parts[1] ? path.resolve(parts[1]) : baseCwd;
        const reg = hub.readAgents()[agent];
        if (reg && reg.pipeIn && reg.pipeOut && !agents.has(agent) && isPidAlive(reg.pid) && (await bridgeListening(reg.pipeIn))) {
          await reattachAndTrack(reg);
        } else {
          await spawnAndTrack(agent, cwd, parts[2] ?? args.model, parts[3]);
        }
        refreshDefaultChannel();
        return;
      }
      case "stopall":
        print(`  stopped ${await stopAllRuns()} agent(s); your next message resumes the fleet`);
        return;
      case "resume":
        print(`  resumed; ${resumeHeld()} held message(s) delivered`);
        return;
      case "answer": {
        const m = /^(\S+)\s+([\s\S]+)$/.exec(cmdArgs);
        if (!m) throw new Error("usage: /answer name text");
        const q = [...questions.values()].find((other) => other.agent === m[1]);
        if (!q) throw new Error(`"${m[1]}" is not waiting for an answer`);
        answerQuestion(q.id, parseAnswer(q, m[2]));
        return;
      }
      case "budget":
        setBudget(budgetArg("/budget", cmdArgs));
        print(`  spending limit is now $${cmdArgs}`);
        return;
      case "stop":
        return stopAgent(cmdArgs);
      case "restart":
        return restartAgent(cmdArgs);
      case "channel": {
        const parts = cmdArgs.split(/\s+/).filter(Boolean);
        if (parts.length === 0) {
          const channels = hub.readChannels();
          print(channels.length ? channels.map((c) => `  #${c.name}  routed by ${c.supervisor ?? "the router"}  members=${c.members.join(", ") || "(none)"}${c.summary ? "  [summary]" : ""}`).join("\n") : "  (no channels)");
        } else if (parts[0] === "add") {
          const channel = parts[1];
          const members = (parts[2] ?? "").split(",").map((m) => m.trim()).filter(Boolean);
          const supervisor = parts[3];
          if (!channel || members.length === 0) {
            print("  usage: /channel add <name> <m1,m2,...> [supervisor]");
          } else {
            saveChannel({ name: channel, members, supervisor });
            print(`  created #${channel} (members: ${members.join(", ")}, routed by ${supervisor ?? "the router"})`);
          }
        } else if (parts[0] === "rm") {
          const channel = parts[1];
          if (channel && channel !== "group") {
            hub.removeChannel(channel);
            gui?.broadcast("channels", hub.readChannels());
            print(`  removed #${channel}`);
          } else {
            print("  (cannot remove the default 'group' channel)");
          }
        } else {
          print("  usage: /channel | /channel add <name> <m1,m2,...> [supervisor] | /channel rm <name>");
        }
      }
    }
  }

  if (rl) rl.on("line", (line) => {
    const parsed = parseChatLine(line);
    if (parsed.kind === "empty") {
      if (interactive) rl!.prompt();
      return;
    }
    (async () => {
      try {
        if (parsed.kind === "error") print(`  ${parsed.message}`);
        else if (parsed.kind === "message") hub.postUserMessage(parsed.to, parsed.text);
        else await runCommand(parsed.name, parsed.args);
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
    for (const router of routers.values()) router.close();
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
          hub.ackDelivered(a.name); // you quit: work in progress is not to resume by itself
        } catch {
          // ignore
        }
      }
    }
    process.exit(0);
  }

  process.on("SIGINT", () => void shutdown());
}
