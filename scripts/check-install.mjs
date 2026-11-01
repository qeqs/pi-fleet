// Follows GETTING_STARTED.md on a machine where `fleet` was installed with npm: nothing here
// uses the checkout's dependencies. The only difference from a person is the scripted model.
// Run with: node scripts/check-install.mjs
import { spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { MODEL, firstMatch, killTree, startFakeModel } from "../test/support.ts";

const model = await startFakeModel("pi fleet install");
const project = path.join(model.tmp, "my-project");
fs.mkdirSync(project);

// shell: npm's fleet command is a .cmd script on Windows
function fleet(...args) {
  const r = spawnSync("fleet", args, { cwd: project, env: model.env, encoding: "utf8", shell: true, timeout: 120000 });
  if (r.status !== 0) throw new Error(`fleet ${args.join(" ")} failed:\n${r.stdout}\n${r.stderr}`);
  return r.stdout;
}

console.log("fleet", fleet("--version").trim());
console.log(fleet("doctor"));

const up = spawn("fleet", ["up", "--template", "sdlc", "--model", MODEL], { cwd: project, env: model.env, shell: true, stdio: ["pipe", "pipe", "inherit"] });
await firstMatch(up, /pi-fleet group chat/);
const approved = firstMatch(up, /reviewer → #group\s+APPROVE/);
up.stdin.write("# Build the feature\n");
await approved;
console.log("the sdlc task finished with APPROVE");
up.stdin.write("/quit\n");
await new Promise((resolve) => up.on("exit", resolve));
killTree(model.proc.pid);
process.exit(0);
