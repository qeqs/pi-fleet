/**
 * Command-line parsing for `fleet`. Side-effect free, so it can be unit-tested
 * (fleet.ts is the entry point and runs on import).
 */
import { DEFAULT_MAX_HOPS, DEFAULT_MAX_TURNS } from "./hub.ts";
import { isLimit } from "./config.ts";

/** Runaway limits, handed to each agent at spawn. */
export interface Limits {
  maxTurns: number;
  maxHops: number;
}

/** A mistake on the command line: reported as a message with a pointer to --help, never a stack trace. */
export class UsageError extends Error {}

function limitArg(flag: string, value: string | undefined): number {
  const n = Number(value);
  if (value === undefined || value === "" || !isLimit(n)) throw new UsageError(`${flag} needs a whole number (0 means no limit), got "${value}"`);
  return n;
}

function portArg(value: string | undefined): number {
  const n = Number(value);
  if (value === undefined || value === "" || !Number.isInteger(n) || n < 0 || n > 65535) {
    throw new UsageError(`--port needs a number from 0 to 65535, got "${value}"`);
  }
  return n;
}

function valueArg(flag: string, value: string | undefined): string {
  if (value === undefined || value.startsWith("--")) throw new UsageError(`${flag} needs a value`);
  return value;
}

export function parseArgs(argv: string[]): { dir?: string; agents: string[]; model?: string; lean?: boolean; detach?: boolean; gui?: boolean; port?: number; host?: string; open?: boolean; template?: string; maxTurns?: number; maxHops?: number; rest: string[] } {
  const out: { dir?: string; agents: string[]; model?: string; lean?: boolean; detach?: boolean; gui?: boolean; port?: number; host?: string; open?: boolean; template?: string; maxTurns?: number; maxHops?: number; rest: string[] } = { agents: [], rest: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--dir") out.dir = valueArg(a, argv[++i]);
    else if (a === "--agent") out.agents.push(valueArg(a, argv[++i]));
    else if (a === "--model") out.model = valueArg(a, argv[++i]);
    else if (a === "--template") out.template = valueArg(a, argv[++i]);
    else if (a === "--lean") out.lean = true;
    else if (a === "--no-lean") out.lean = false;
    else if (a === "--detach") out.detach = true;
    else if (a === "--gui") out.gui = true;
    else if (a === "--open") out.open = true;
    else if (a === "--port") out.port = portArg(argv[++i]);
    else if (a === "--host") out.host = valueArg(a, argv[++i]);
    else if (a === "--max-turns") out.maxTurns = limitArg(a, argv[++i]);
    else if (a === "--max-hops") out.maxHops = limitArg(a, argv[++i]);
    else if (a.startsWith("-")) throw new UsageError(`unknown option "${a}"`);
    else out.rest.push(a);
  }
  return out;
}

export type FleetArgs = ReturnType<typeof parseArgs>;

export const USAGE = `pi-fleet — multi-agent supervisor for pi

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
  npm run fleet -- doctor [--dir DIR]        # check pi, the hub, the config and the models
  npm run fleet -- help                      # this text

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
  /quit           stop all and exit`;
