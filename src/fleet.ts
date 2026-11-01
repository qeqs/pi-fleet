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
import fs from "node:fs";
import { parseArgs, UsageError, USAGE } from "./cli.ts";
import { cmdConfig, cmdInit, cmdList, cmdLog, cmdRename, cmdStop, cmdTemplates } from "./commands.ts";
import { cmdDoctor } from "./doctor.ts";
import { cmdUp } from "./supervisor.ts";

function noExtraArgs(rest: string[]): void {
  if (rest.length > 0) throw new UsageError(`unexpected argument "${rest[0]}"`);
}

async function main(): Promise<void> {
  const [cmd, ...rest] = process.argv.slice(2);
  const baseCwd = process.cwd();
  switch (cmd) {
    case undefined:
    case "help":
    case "--help":
    case "-h":
      console.log(USAGE);
      return;
    case "version":
    case "--version":
    case "-v":
      console.log((JSON.parse(fs.readFileSync(new URL("../package.json", import.meta.url), "utf8")) as { version: string }).version);
      return;
    case "up": {
      const p = parseArgs(rest);
      noExtraArgs(p.rest);
      return cmdUp(p, baseCwd);
    }
    case "serve": {
      // headless: spawn the fleet (from --agent/--template/fleet.json) and serve the web UI
      const p = parseArgs(rest);
      noExtraArgs(p.rest);
      if (!p.gui) p.gui = true; // serve implies the web UI
      return cmdUp(p, baseCwd, true);
    }
    case "list":
      return cmdList(parseArgs(rest).dir, baseCwd);
    case "stop": {
      const p = parseArgs(rest);
      return cmdStop(p.rest[0], p.dir, baseCwd);
    }
    case "log": {
      const p = parseArgs(rest);
      return cmdLog(p.rest[0], p.dir, baseCwd);
    }
    case "init":
      return cmdInit(parseArgs(rest).dir, baseCwd);
    case "config":
      return cmdConfig(parseArgs(rest).dir, baseCwd);
    case "templates":
      return cmdTemplates();
    case "rename": {
      const p = parseArgs(rest);
      return cmdRename(p.rest[0], p.rest[1], p.dir, baseCwd);
    }
    case "doctor":
      return cmdDoctor(parseArgs(rest).dir, baseCwd);
    default:
      throw new UsageError(`unknown command "${cmd}"`);
  }
}

main().catch((err: Error) => {
  console.error(`fleet: ${err.message}`);
  if (err instanceof UsageError) console.error("Run `fleet help` for usage.");
  process.exit(err instanceof UsageError ? 2 : 1);
});
