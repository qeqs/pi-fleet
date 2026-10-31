/**
 * Fleet config — a stable, user-editable description of the fleet composition.
 *
 * Lives at `<hub-dir>/fleet.json`. When `fleet up` is run with no `--agent`
 * flags and a config exists, it spawns the agents described there (and re-attaches
 * to any that are already running). The desktop app relies on this so it knows
 * what to launch without a long CLI.
 *
 * Shape:
 *   {
 *     "defaultModel": "provider/model",        // optional, used when an agent has no model
 *     "maxTurns": 100,                         // optional, turns per run (0 = no limit)
 *     "maxHops": 40,                           // optional, agent messages per human message (0 = no limit)
 *     "maxCost": 5,                            // optional, pause the fleet at this spend in dollars
 *     "agents": [
 *       { "name": "planner", "cwd": ".", "role": "planner" },
 *       { "name": "worker",  "cwd": ".", "model": "other/model", "role": "implementer" }
 *     ]
 *   }
 */
import fs from "node:fs";
import path from "node:path";

export interface FleetAgentConfig {
  name: string;
  cwd?: string;
  model?: string;
  role?: string;
  lean?: boolean;
  /** Absolute paths of pi extensions (plugins) to load for this agent via --extension. */
  extensions?: string[];
  /** Tools this agent may only run once a person agrees. */
  approve?: string[];
}

export interface FleetConfig {
  defaultModel?: string;
  /** Turns one agent may take in a single run (0 = no limit). */
  maxTurns?: number;
  /** Messages agents may exchange per human message (0 = no limit). */
  maxHops?: number;
  /** Pause the fleet at this spend, in dollars. */
  maxCost?: number;
  agents: FleetAgentConfig[];
}

export function configPath(hubDir: string): string {
  return path.join(hubDir, "fleet.json");
}

/** A usable --max-turns / --max-hops value: a whole number, 0 meaning no limit. */
export function isLimit(n: unknown): n is number {
  return typeof n === "number" && Number.isInteger(n) && n >= 0;
}

/** A usable --max-cost value: a positive number of dollars. */
export function isBudget(n: unknown): n is number {
  return typeof n === "number" && Number.isFinite(n) && n > 0;
}

/** Read the config, or null if there is none. Throws if the file is unusable, naming the file. */
export function loadFleetConfig(hubDir: string): FleetConfig | null {
  const p = configPath(hubDir);
  if (!fs.existsSync(p)) return null;
  let raw: Partial<FleetConfig>;
  try {
    raw = JSON.parse(fs.readFileSync(p, "utf8")) as Partial<FleetConfig>;
  } catch (e) {
    throw new Error(`invalid fleet config ${p}: ${(e as Error).message}`);
  }
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) throw new Error(`invalid fleet config ${p}: expected an object`);
  if (raw.agents !== undefined && !Array.isArray(raw.agents)) throw new Error(`invalid fleet config ${p}: "agents" must be a list`);
  for (const a of raw.agents ?? []) {
    if (!a || typeof a.name !== "string") throw new Error(`invalid fleet config ${p}: every agent needs a "name"`);
  }
  for (const field of ["maxTurns", "maxHops"] as const) {
    if (raw[field] !== undefined && !isLimit(raw[field])) throw new Error(`invalid fleet config ${p}: "${field}" must be a whole number (0 means no limit)`);
  }
  if (raw.maxCost !== undefined && !isBudget(raw.maxCost)) throw new Error(`invalid fleet config ${p}: "maxCost" must be a positive number of dollars`);
  return {
    defaultModel: raw.defaultModel,
    maxTurns: raw.maxTurns,
    maxHops: raw.maxHops,
    maxCost: raw.maxCost,
    agents: (raw.agents ?? []).map((a) => ({
      ...a,
      extensions: Array.isArray(a.extensions) ? a.extensions.filter((e): e is string => typeof e === "string") : undefined,
    })),
  };
}

export function saveFleetConfig(hubDir: string, cfg: FleetConfig): void {
  fs.mkdirSync(hubDir, { recursive: true });
  fs.writeFileSync(configPath(hubDir), JSON.stringify(cfg, null, 2) + "\n");
}

/**
 * Convert a config agent to the CLI spec string `name[:cwd][:model][:role]`.
 * Empty segments are preserved so positional parsing stays correct.
 */
export function agentSpecFromConfig(a: FleetAgentConfig): string {
  return [a.name, a.cwd ?? "", a.model ?? "", a.role ?? ""].join(":");
}

/** A starter template for `fleet init`. */
export function templateConfig(defaultModel?: string): FleetConfig {
  return {
    defaultModel,
    agents: [
      { name: "planner", cwd: ".", role: "planner" },
      { name: "implementer", cwd: ".", role: "implementer" },
      { name: "reviewer", cwd: ".", role: "reviewer" },
    ],
  };
}