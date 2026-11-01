/**
 * One git worktree and branch per agent, so agents working on the same repository
 * at the same time cannot overwrite each other. Their work reaches the base branch
 * by merge, which a person asks for after review.
 */
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { onPath } from "./programs.ts";

export interface Worktree {
  /** The main checkout. */
  repo: string;
  path: string;
  branch: string;
  /** The branch this work merges back into. */
  base: string;
}

export interface MergeResult {
  merged: boolean;
  /** Files in conflict; nothing was changed if there are any. */
  conflicts: string[];
}

function git(cwd: string, ...args: string[]): string {
  const program = onPath("git");
  if (!program) throw new Error("git is not installed");
  return execFileSync(program, args, { cwd, encoding: "utf8", windowsHide: true, stdio: ["ignore", "pipe", "pipe"] }).trim();
}

function succeeds(cwd: string, ...args: string[]): boolean {
  try {
    git(cwd, ...args);
    return true;
  } catch {
    return false;
  }
}

export function repoRoot(cwd: string): string | null {
  try {
    return git(cwd, "rev-parse", "--show-toplevel");
  } catch {
    return null;
  }
}

/** Where a folder sits inside its repository, as a path relative to the top. */
export function repoSubfolder(cwd: string): string {
  return git(cwd, "rev-parse", "--show-prefix");
}

/** Create the agent's worktree, or pick up the one it already has. */
export function ensureWorktree(repo: string, hubDir: string, agent: string): Worktree {
  if (!succeeds(repo, "rev-parse", "HEAD")) throw new Error(`${repo} has no commits yet, so it cannot be branched for "${agent}"`);
  const branch = `fleet/${agent}`;
  const worktrees = path.join(path.resolve(hubDir), "worktrees");
  const wtPath = path.join(worktrees, agent);
  const base = git(repo, "rev-parse", "--abbrev-ref", "HEAD");
  if (base === "HEAD") throw new Error(`${repo} is not on a branch, so "${agent}" has nothing to merge back into: check one out`);
  if (!fs.existsSync(path.join(wtPath, ".git"))) {
    fs.mkdirSync(worktrees, { recursive: true });
    fs.writeFileSync(path.join(worktrees, ".gitignore"), "*\n"); // the hub is often inside the repository
    git(repo, "worktree", "prune");
    const exists = succeeds(repo, "rev-parse", "--verify", branch);
    git(repo, "worktree", "add", ...(exists ? [wtPath, branch] : ["-b", branch, wtPath]));
  }
  return { repo, path: wtPath, branch, base };
}

/** Everything the agent has changed since it branched, committed or not. */
export function worktreeChanges(wt: Worktree): { branch: string; base: string; files: string[]; patch: string } {
  const since = git(wt.path, "merge-base", wt.base, "HEAD");
  git(wt.path, "add", "--intent-to-add", "--all"); // so new files show up in the diff
  const files = git(wt.path, "diff", "--name-only", since).split("\n").filter(Boolean);
  return { branch: wt.branch, base: wt.base, files, patch: git(wt.path, "diff", since) };
}

/** A commit needs an identity, and a fresh machine may not have one. */
function identity(cwd: string): string[] {
  const configured = succeeds(cwd, "config", "user.email");
  return configured ? [] : ["-c", "user.name=pi-fleet", "-c", "user.email=pi-fleet@localhost"];
}

/**
 * Commit whatever the agent left uncommitted and merge its branch into the base.
 * On a conflict the merge is undone and the conflicting files are returned.
 */
export function mergeWorktree(wt: Worktree, message: string): MergeResult {
  const current = git(wt.repo, "rev-parse", "--abbrev-ref", "HEAD");
  if (current !== wt.base) throw new Error(`${wt.repo} is on ${current}: check out ${wt.base} to merge into it`);
  if (git(wt.repo, "status", "--porcelain", "--untracked-files=no")) throw new Error(`${wt.repo} has uncommitted changes: commit or stash them first`);

  git(wt.path, "add", "--all");
  if (!succeeds(wt.path, "diff", "--cached", "--quiet")) git(wt.path, ...identity(wt.path), "commit", "-m", message);
  if (git(wt.repo, "rev-list", "--count", `${wt.base}..${wt.branch}`) === "0") return { merged: false, conflicts: [] };

  try {
    git(wt.repo, ...identity(wt.repo), "merge", "--no-ff", "-m", `Merge ${wt.branch}: ${message}`, wt.branch);
  } catch (err) {
    const conflicts = git(wt.repo, "diff", "--name-only", "--diff-filter=U").split("\n").filter(Boolean);
    if (conflicts.length === 0) throw new Error(`could not merge ${wt.branch}: ${String((err as { stderr?: string }).stderr ?? err).trim()}`);
    git(wt.repo, "merge", "--abort");
    return { merged: false, conflicts };
  }
  git(wt.path, "merge", "--ff-only", wt.base); // start the next task from what was just merged
  return { merged: true, conflicts: [] };
}
