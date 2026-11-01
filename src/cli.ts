/**
 * Command-line parsing for `fleet`. Side-effect free, so it can be unit-tested
 * (fleet.ts is the entry point and runs on import).
 */
import { DEFAULT_MAX_HOPS, DEFAULT_MAX_TURNS } from "./hub.ts";
import { isBudget, isLimit } from "./config.ts";
import { isTaskBoard, type TaskBoardKind } from "./taskboard.ts";

/** Runaway limits, handed to each agent at spawn. */
export interface Limits {
  maxTurns: number;
  maxHops: number;
  /** Pause the fleet at this spend, in dollars. Changes at runtime with /budget. */
  maxCost?: number;
}

/** A mistake on the command line: reported as a message with a pointer to --help, never a stack trace. */
export class UsageError extends Error {}

function limitArg(flag: string, value: string | undefined): number {
  const n = Number(value);
  if (value === undefined || value === "" || !isLimit(n)) throw new UsageError(`${flag} needs a whole number (0 means no limit), got "${value}"`);
  return n;
}

export function budgetArg(flag: string, value: string | undefined): number {
  const n = Number(value);
  if (value === undefined || value === "" || !isBudget(n)) throw new UsageError(`${flag} needs a positive number of dollars, got "${value}"`);
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

export function parseArgs(argv: string[]): { dir?: string; agents: string[]; model?: string; lean?: boolean; detach?: boolean; gui?: boolean; port?: number; host?: string; open?: boolean; template?: string; maxTurns?: number; maxHops?: number; maxCost?: number; approve?: string[]; fresh?: boolean; noRestart?: boolean; routerModel?: string; worktrees?: boolean; taskboard?: TaskBoardKind; rest: string[] } {
  const out: { dir?: string; agents: string[]; model?: string; lean?: boolean; detach?: boolean; gui?: boolean; port?: number; host?: string; open?: boolean; template?: string; maxTurns?: number; maxHops?: number; maxCost?: number; approve?: string[]; fresh?: boolean; noRestart?: boolean; routerModel?: string; worktrees?: boolean; taskboard?: TaskBoardKind; rest: string[] } = { agents: [], rest: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--dir") out.dir = valueArg(a, argv[++i]);
    else if (a === "--agent") out.agents.push(valueArg(a, argv[++i]));
    else if (a === "--model") out.model = valueArg(a, argv[++i]);
    else if (a === "--template") out.template = valueArg(a, argv[++i]);
    else if (a === "--lean") out.lean = true;
    else if (a === "--no-lean") out.lean = false;
    else if (a === "--detach") out.detach = true;
    else if (a === "--fresh") out.fresh = true;
    else if (a === "--no-restart") out.noRestart = true;
    else if (a === "--gui") out.gui = true;
    else if (a === "--open") out.open = true;
    else if (a === "--port") out.port = portArg(argv[++i]);
    else if (a === "--host") out.host = valueArg(a, argv[++i]);
    else if (a === "--max-turns") out.maxTurns = limitArg(a, argv[++i]);
    else if (a === "--max-hops") out.maxHops = limitArg(a, argv[++i]);
    else if (a === "--router-model") out.routerModel = valueArg(a, argv[++i]);
    else if (a === "--worktrees") out.worktrees = true;
    else if (a === "--taskboard") {
      const board = valueArg(a, argv[++i]);
      if (!isTaskBoard(board)) throw new UsageError(`--taskboard needs openspec or beads, got "${board}"`);
      out.taskboard = board;
    }
    else if (a === "--max-cost") out.maxCost = budgetArg(a, argv[++i]);
    else if (a === "--approve") out.approve = valueArg(a, argv[++i]).split(",").map((t) => t.trim()).filter(Boolean);
    else if (a.startsWith("-")) throw new UsageError(`unknown option "${a}"`);
    else out.rest.push(a);
  }
  return out;
}

export type FleetArgs = ReturnType<typeof parseArgs>;

export const USAGE = `pi-fleet — multi-agent supervisor for pi

Usage:
  fleet up --agent name[:cwd][:model][:role] [--agent name2[:cwd2][:model2]] [--model M] [--lean] [--detach] [--gui [--open] [--port N]] [--max-turns N] [--max-hops N] [--dir DIR]
  fleet list [--dir DIR]
  fleet stop [name|all] [--dir DIR]
  fleet log [name] [--dir DIR]
  fleet init [--dir DIR]         # create a starter fleet.json
  fleet templates                 # list --template presets (sdlc, pair, solo)
  fleet config [--dir DIR]        # show fleet.json
  fleet rename <agent> <name>     # set an agent's pi session display name
  fleet serve [--agent ... | --template ...] [--port N] [--host H]   # headless web UI
  fleet doctor [--dir DIR]        # check pi, the hub, the config and the models
  fleet help                      # this text
  fleet version                   # the installed version

  With no --agent flags, up reads the fleet from <dir>/fleet.json (see: fleet init).

  Agent spec: name[:cwd][:model][:role] — per-agent model overrides --model; role (planner|implementer|reviewer) sets a prompt preset.
  --lean: smaller prompt for weak/local models (no skills, no web/research tools).
  --detach: agents keep running after /quit; re-attach later with: fleet up (auto-resume).
  --gui: open a web UI (group chat + per-agent live RPC-event activity); --open launches the browser.
         Open the link printed at startup: it carries the access token (kept in <dir>/gui-token).
  --host H: GUI bind address (default 127.0.0.1; use 0.0.0.0 for LAN access). serve runs the web UI headless.
  --worktrees: give implementers, and agents with no role, their own git worktree and branch.
  --taskboard T: the agents' task board, openspec (default) or beads.
  --router-model M: model for routing channel messages; a cheap one is enough (default: --model).
  --fresh: start agents with new sessions instead of resuming their conversations.
  --no-restart: leave crashed agents stopped instead of restarting them (up to 3 times in 10 minutes).
  --max-turns N: abort an agent after N turns in one run (default ${DEFAULT_MAX_TURNS}; 0 = no limit).
  --max-hops N: pause the fleet after N agent messages since your last message (default ${DEFAULT_MAX_HOPS}; 0 = no limit).
  --max-cost N: abort every run and pause the fleet once it has spent N dollars.
  --approve bash,write: agents ask a person before running these tools.

Group chat input:
  # text          broadcast to the group
  #name text      post to a named channel
  @name text      direct message
  /agents         list agents
  /stats          per-agent token + cost usage (get_session_stats)
  /channel        list channels; /channel add <name> <m1,m2> [sup]; /channel rm <name>
  /new name [cwd] [model] [role]   spawn an agent
  /stop name      stop an agent
  /restart name   restart an agent; it keeps its conversation
  /stopall        abort every run and pause the fleet until your next message
  /resume         lift a pause and deliver the messages it held back
  /answer name x  answer an agent's question
  /budget N       change the spending limit, in dollars
  /diff name      what an agent has changed in its worktree
  /merge name     merge an agent's worktree into its base branch
  /quit           stop all and exit`;
