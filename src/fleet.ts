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
import { parseArgs, USAGE } from "./cli.ts";
import { cmdConfig, cmdInit, cmdList, cmdLog, cmdRename, cmdStop, cmdTemplates } from "./commands.ts";
import { cmdUp } from "./supervisor.ts";

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
      console.log(USAGE);
  }
}

main();
