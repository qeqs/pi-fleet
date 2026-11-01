/**
 * The agents' task board as a person sees it. Agents drive OpenSpec or beads through
 * their tools; this reads the same board so the GUI can show it.
 */
import { execFile } from "node:child_process";
import { onPath } from "./programs.ts";
import { packageBinArgv } from "./rpc.ts";

export type TaskBoardKind = "openspec" | "beads";

export interface BoardTask {
  id: string;
  title: string;
  status: string;
  /** Finished and total subtasks, where the board tracks them. */
  done?: number;
  total?: number;
}

export function isTaskBoard(value: unknown): value is TaskBoardKind {
  return value === "openspec" || value === "beads";
}

/** Parse `openspec list --json`, which also prints JSON when a project has no board yet. */
export function parseOpenspecList(json: string): BoardTask[] {
  const { changes } = JSON.parse(json) as { changes?: { name: string; status?: string; completedTasks?: number; totalTasks?: number }[] };
  return (changes ?? []).map((c) => ({ id: c.name, title: c.name, status: c.status ?? "unknown", done: c.completedTasks, total: c.totalTasks }));
}

/** Parse `bd list --json`. */
export function parseBeadsList(json: string): BoardTask[] {
  const issues = JSON.parse(json || "[]") as { id: string; title?: string; status?: string }[];
  return issues.map((i) => ({ id: i.id, title: i.title ?? i.id, status: i.status ?? "unknown" }));
}

function run(argv: string[], cwd: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = execFile(argv[0], argv.slice(1), { cwd, timeout: 30000, maxBuffer: 1024 * 1024, windowsHide: true }, (err, stdout, stderr) => {
      // openspec exits 1 with a JSON report when a project has no board; that is an answer
      if (err && !stdout.trim().startsWith("{")) reject(new Error(stderr.trim() || err.message));
      else resolve(stdout);
    });
    child.stdin?.end();
  });
}

export async function listTasks(kind: TaskBoardKind, root: string, cwd: string): Promise<BoardTask[]> {
  if (kind === "beads") {
    const bd = onPath("bd");
    if (!bd) throw new Error("bd is not installed");
    return parseBeadsList(await run([bd, "list", "--json"], cwd));
  }
  return parseOpenspecList(await run([...packageBinArgv(root, "@fission-ai/openspec", "openspec"), "list", "--json"], cwd));
}
