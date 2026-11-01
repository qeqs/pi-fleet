// Shared by the tests that run real agents against the scripted model in fake-llm.mjs.
import { spawn, execFileSync, type ChildProcess } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

export const ROOT = path.resolve(import.meta.dirname, "..");
export const TSX = path.join(ROOT, "node_modules", "tsx", "dist", "cli.mjs");
export const FLEET = path.join(ROOT, "src", "fleet.ts");
export const MODEL = "fake/fake-1";
export const DEAD_MODEL = "dead/dead-1";

export interface LlmRequest {
  agent: string;
  last: string;
  conversation: string;
  decision: string;
}

export function firstMatch(proc: ChildProcess, re: RegExp): Promise<RegExpExecArray> {
  return new Promise((resolve, reject) => {
    let out = "";
    const timer = setTimeout(() => reject(new Error(`no ${re} in:\n${out}`)), 30000);
    proc.stdout!.on("data", (d) => {
      out += d;
      const m = re.exec(out);
      if (m) {
        clearTimeout(timer);
        resolve(m);
      }
    });
    proc.stderr?.on("data", (d) => (out += d));
  });
}

export async function until<T>(what: string, check: () => T | Promise<T>, timeoutMs = 45000): Promise<NonNullable<T>> {
  const end = Date.now() + timeoutMs;
  for (;;) {
    const value = await check();
    if (value) return value;
    if (Date.now() > end) throw new Error(`timed out waiting for ${what}`);
    await new Promise((r) => setTimeout(r, 150));
  }
}

export function killTree(pid: number | undefined): void {
  if (!pid) return;
  try {
    if (process.platform === "win32") execFileSync("taskkill", ["/PID", String(pid), "/T", "/F"], { stdio: "ignore" });
    else process.kill(pid, "SIGTERM");
  } catch {
    // already gone
  }
}

/** A crash rather than a request to stop: nothing gets the chance to clean up. */
export function crash(pid: number | null | undefined): void {
  if (!pid) return;
  if (process.platform === "win32") return killTree(pid);
  try {
    process.kill(-pid, "SIGKILL"); // a bridge leads its own group, with tsx and pi inside it
  } catch {
    process.kill(pid, "SIGKILL"); // the supervisor does not
  }
}

/** A scripted model server, and a private home whose pi knows only that model. */
export async function startFakeModel(prefix: string): Promise<{ proc: ChildProcess; port: number; tmp: string; env: NodeJS.ProcessEnv; log: () => Promise<LlmRequest[]> }> {
  // a space in the path, because that is what command-line handling breaks on
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), `${prefix} `));
  const proc = spawn(process.execPath, [path.join(ROOT, "test", "fake-llm.mjs")], { stdio: ["ignore", "pipe", "inherit"] });
  const port = Number((await firstMatch(proc, /fake llm on (\d+)/))[1]);
  const agentDir = path.join(tmp, "home", ".pi", "agent");
  fs.mkdirSync(agentDir, { recursive: true });
  fs.writeFileSync(
    path.join(agentDir, "models.json"),
    JSON.stringify({
      providers: {
        fake: {
          baseUrl: `http://127.0.0.1:${port}/v1`,
          apiKey: "fake",
          api: "openai-completions",
          models: [{ id: "fake-1", name: "Fake", reasoning: false, input: ["text"], contextWindow: 131072, maxTokens: 2048, cost: { input: 3, output: 15, cacheRead: 0, cacheWrite: 0 } }],
        },
        // nothing listens here: a model whose server is down
        dead: { baseUrl: "http://127.0.0.1:9/v1", apiKey: "dead", api: "openai-completions", models: [{ id: "dead-1", contextWindow: 131072, maxTokens: 2048 }] },
      },
    }),
  );
  const env = {
    ...process.env,
    HOME: path.join(tmp, "home"),
    USERPROFILE: path.join(tmp, "home"),
    PI_CODING_AGENT_DIR: agentDir,
    PI_OFFLINE: "1",
    PI_SKIP_VERSION_CHECK: "1",
    PI_TELEMETRY: "0",
    PI_FLEET_POLL_MS: "300",
    PI_FLEET_OWNER_PID: String(process.pid),
  };
  const log = async () => (await fetch(`http://127.0.0.1:${port}/__log`)).json() as Promise<LlmRequest[]>;
  return { proc, port, tmp, env, log };
}
