/**
 * Starting agents: resolves lean mode, launches a detached bridge per agent, and
 * connects to it over named pipes.
 */
import { spawn } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Hub } from "./hub.ts";
import { PiRpc, PiRpcBridge, piArgv, type StreamingBehavior, packageBinArgv } from "./rpc.ts";
import { isValidAgentName } from "./spec.ts";
import { killProcessTree } from "./programs.ts";
import type { Limits } from "./cli.ts";
import type { Worktree } from "./worktree.ts";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const EXTENSION = path.join(ROOT, "src", "extension", "index.ts");

/** Common surface of the two RPC transports (child-process pipe vs bridge named pipes). */
export interface RpcClient {
  pid: number;
  alive: boolean;
  onEvent: (rec: Record<string, unknown>) => void;
  onExit: (code: number | null) => void;
  prompt(message: string, streamingBehavior?: StreamingBehavior): Promise<Record<string, unknown>>;
  sendCommand(cmd: Record<string, unknown>): Promise<Record<string, unknown>>;
  write(rec: Record<string, unknown>): void;
  getState(): Promise<Record<string, unknown>>;
  getStats(): Promise<Record<string, unknown>>;
  setSessionName(name: string): Promise<Record<string, unknown>>;
  close(): void | Promise<void>;
}

export interface AgentHandle {
  name: string;
  cwd: string;
  rpc: RpcClient;
  model?: string;
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
export async function probeContextWindow(model: string): Promise<number | undefined> {
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

/** Every model pi knows, as `provider/id`, asked of a short-lived process (no model server needed). */
export async function availableModels(rpc?: RpcClient): Promise<string[]> {
  const own = rpc ? null : new PiRpc(piArgv(ROOT, ["--mode", "rpc", "--no-session"]), { cwd: process.cwd(), env: { ...process.env }, logFile: path.join(os.tmpdir(), `pi-fleet-models-${Date.now()}.log`) });
  try {
    const res = await (rpc ?? own!).sendCommand({ type: "get_available_models" });
    const models = (res.data as { models?: { provider: string; id: string }[] } | undefined)?.models ?? [];
    return models.map((m) => `${m.provider}/${m.id}`);
  } finally {
    await own?.close();
  }
}

/**
 * Decide whether an agent runs lean. Explicit `--lean`/`--no-lean` wins; otherwise
 * auto-detect from the model's context window (probed + cached per model).
 */
export async function resolveLean(
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

/**
 * Spawn an agent: launch a detached bridge (which owns the pi child and exposes
 * it over named pipes), then connect a PiRpcBridge client to those pipes.
 * The bridge survives the supervisor exiting, enabling detached mode + re-attach.
 */
/** What an agent is started with, beyond its name and place. */
export interface AgentOptions {
  model?: string;
  lean?: boolean;
  role?: string;
  extensions?: string[];
  sessionFile?: string;
  approve?: string[];
  taskboard?: string;
  worktree?: Worktree;
}

export async function spawnAgent(hub: Hub, name: string, cwd: string, limits: Limits, options: AgentOptions): Promise<AgentHandle> {
  const { model, lean, role, extensions, sessionFile, approve, taskboard, worktree } = options;
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
  if (sessionFile) args.push("--session", sessionFile);
  const pipeIn = pipePath("in", name, hub.dir);
  const pipeOut = pipePath("out", name, hub.dir);
  const bridgeScript = path.join(ROOT, "src", "bridge.ts");
  // Spawn the bridge as a single node process (no npx/shell wrapper) so the
  // process tree is clean: supervisor -> node(bridge) -> pi. The registry pid
  // is then the bridge, and taskkill /T on it takes pi down with it.
  const [node, tsxCli] = packageBinArgv(ROOT, "tsx", "tsx");
  // the desktop app's key to the GUI stays out of what an agent can print to its model
  const { PI_FLEET_GUI_TOKEN: _token, ...inherited } = process.env;
  const bridge = spawn(node, [tsxCli, bridgeScript], {
    cwd: hub.dir,
    env: {
      ...inherited,
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
      PI_FLEET_APPROVE: (approve ?? []).join(","),
      ...(taskboard ? { PI_FLEET_TASKBOARD: taskboard } : {}),
      ...(worktree ? { PI_FLEET_BRANCH: worktree.branch } : {}),
      ...(role ? { PI_FLEET_ROLE: role } : {}),
      ...(lean ? { PI_FLEET_LEAN: "1" } : {}),
    },
    stdio: "ignore",
    detached: true,
    windowsHide: true,
  });
  bridge.unref();
  const bridgePid = bridge.pid ?? 0;
  hub.updateAgent(name, { name, pid: bridgePid, cwd, status: "starting", startedAt: Date.now(), logFile, pipeIn, pipeOut, model, role, worktree });
  try {
    const rpc = await PiRpcBridge.connect(pipeIn, pipeOut, bridgePid);
    return { name, cwd, rpc, model };
  } catch (err) {
    killProcessTree(bridgePid);
    hub.updateAgent(name, { status: "stopped" });
    throw new Error(`agent "${name}" did not start: ${(err as Error).message} (log: ${logFile})`);
  }
}
