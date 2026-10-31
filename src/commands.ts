/**
 * The one-shot `fleet` commands: everything except `up` and `serve`.
 */
import { execSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { Hub, isPidAlive } from "./hub.ts";
import { PiRpcBridge, bridgeListening } from "./rpc.ts";
import { saveFleetConfig, templateConfig, configPath } from "./config.ts";
import { TEMPLATES } from "./templates.ts";

export function cmdList(dir: string | undefined, baseCwd: string) {
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

export async function cmdStop(target: string | undefined, dir: string | undefined, baseCwd: string) {
  const hub = new Hub(dir ?? path.join(baseCwd, ".pi-fleet"));
  const agents = Object.values(hub.readAgents());
  if (agents.length === 0) {
    console.log("no agents registered in this hub");
    return;
  }
  const targets = target === "all" || !target ? agents : agents.filter((a) => a.name === target);
  if (targets.length === 0) throw new Error(`no agent "${target}". Agents: ${agents.map((a) => a.name).join(", ")}.`);
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

export function cmdLog(name: string | undefined, dir: string | undefined, baseCwd: string) {
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
export function cmdInit(dir: string | undefined, baseCwd: string) {
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
export function cmdConfig(dir: string | undefined, baseCwd: string) {
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
export function cmdTemplates(): void {
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
export async function cmdRename(agent: string | undefined, sessionName: string | undefined, dir: string | undefined, baseCwd: string) {
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
