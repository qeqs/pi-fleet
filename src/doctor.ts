/**
 * `fleet doctor`: checks what a fleet needs, so a broken setup is explained up
 * front instead of failing halfway through a start.
 */
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Hub, isPidAlive } from "./hub.ts";
import { bridgeListening, packageBinArgv, piArgv } from "./rpc.ts";
import { configPath, loadFleetConfig } from "./config.ts";
import { probeContextWindow } from "./spawn.ts";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

export interface Check {
  status: "ok" | "warn" | "fail";
  label: string;
  detail: string;
}

function versionOf(argv: string[]): string {
  return execFileSync(argv[0], [...argv.slice(1), "--version"], { encoding: "utf8", timeout: 30000, windowsHide: true }).trim();
}

function toolCheck(label: string, argv: () => string[], missing: Check["status"]): Check {
  try {
    return { status: "ok", label, detail: versionOf(argv()) };
  } catch (e) {
    return { status: missing, label, detail: `not usable: ${(e as Error).message.split("\n")[0]}` };
  }
}

function writableCheck(hub: Hub): Check {
  const probe = path.join(hub.dir, `.doctor-${process.pid}`);
  try {
    fs.writeFileSync(probe, "");
    fs.unlinkSync(probe);
    return { status: "ok", label: "hub", detail: `writable: ${hub.dir}` };
  } catch (e) {
    return { status: "fail", label: "hub", detail: `cannot write to ${hub.dir}: ${(e as Error).message}` };
  }
}

/** Checks that need nothing but the hub on disk. */
export function configCheck(hub: Hub): Check {
  try {
    const cfg = loadFleetConfig(hub.dir);
    if (!cfg) return { status: "ok", label: "config", detail: `none at ${configPath(hub.dir)} (optional)` };
    return { status: "ok", label: "config", detail: `${cfg.agents.length} agent(s) in ${configPath(hub.dir)}` };
  } catch (e) {
    return { status: "fail", label: "config", detail: (e as Error).message };
  }
}

export function supervisorCheck(hub: Hub): Check {
  const other = hub.otherSupervisor();
  return { status: "ok", label: "supervisor", detail: other ? `attached (pid ${other})` : "none attached" };
}

/** Registry entries that claim to be running but have no bridge behind them. */
export async function registryCheck(hub: Hub): Promise<Check> {
  const stale: string[] = [];
  const agents = Object.values(hub.readAgents());
  for (const a of agents) {
    if (a.status === "stopped") continue;
    const alive = isPidAlive(a.pid) && !!a.pipeIn && (await bridgeListening(a.pipeIn));
    if (!alive) stale.push(a.name);
  }
  if (stale.length > 0) {
    return { status: "warn", label: "agents", detail: `${stale.join(", ")} marked running but gone; the next \`fleet up\` clears this` };
  }
  return { status: "ok", label: "agents", detail: `${agents.length} registered, none stale` };
}

async function modelChecks(hub: Hub): Promise<Check[]> {
  let cfg;
  try {
    cfg = loadFleetConfig(hub.dir);
  } catch {
    return []; // already reported by the config check
  }
  const models = [...new Set([cfg?.defaultModel, cfg?.routerModel, ...(cfg?.agents ?? []).map((a) => a.model)].filter((m): m is string => !!m))];
  const checks = await Promise.all(
    models.map(async (model): Promise<Check> => {
      const contextWindow = await probeContextWindow(model);
      return contextWindow === undefined
        ? { status: "fail", label: "model", detail: `pi does not know "${model}" (see ~/.pi/agent/models.json)` }
        : { status: "ok", label: "model", detail: `${model} (context window ${contextWindow})` };
    }),
  );
  return checks;
}

export async function cmdDoctor(dir: string | undefined, baseCwd: string): Promise<void> {
  const hub = new Hub(dir ?? path.join(baseCwd, ".pi-fleet"));
  const checks: Check[] = [
    { status: "ok", label: "node", detail: process.version },
    toolCheck("pi", () => piArgv(ROOT, []), "fail"),
    toolCheck("openspec", () => packageBinArgv(ROOT, "@fission-ai/openspec", "openspec"), "warn"),
    writableCheck(hub),
    configCheck(hub),
    supervisorCheck(hub),
    await registryCheck(hub),
    ...(await modelChecks(hub)),
  ];
  for (const c of checks) console.log(`${c.status.padEnd(4)}  ${c.label.padEnd(10)}  ${c.detail}`);
  if (checks.some((c) => c.status === "fail")) throw new Error("some checks failed");
}
