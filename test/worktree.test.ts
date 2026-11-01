import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { ensureWorktree, mergeWorktree, repoRoot, repoSubfolder, worktreeChanges } from "../src/worktree.ts";

let tmp: string;
let repo: string;
let hub: string;

const git = (cwd: string, ...args: string[]) => execFileSync("git", args, { cwd, encoding: "utf8" }).trim();
const write = (dir: string, file: string, text: string) => fs.writeFileSync(path.join(dir, file), text);

beforeEach(() => {
  tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "fleet-wt-")));
  repo = path.join(tmp, "repo");
  hub = path.join(tmp, "hub");
  fs.mkdirSync(repo);
  git(repo, "init", "-b", "main");
  git(repo, "config", "user.name", "Test");
  git(repo, "config", "user.email", "test@example.com");
  write(repo, "README.md", "hello\n");
  git(repo, "add", "-A");
  git(repo, "commit", "-m", "First");
});

afterEach(() => {
  fs.rmSync(tmp, { recursive: true, force: true, maxRetries: 3 });
});

describe("repoRoot", () => {
  it("finds a repository from inside it, and nothing outside one", () => {
    fs.mkdirSync(path.join(repo, "sub"));
    expect(path.resolve(repoRoot(path.join(repo, "sub"))!)).toBe(path.resolve(repo));
    expect(repoRoot(tmp)).toBeNull();
  });
});

describe("repoSubfolder", () => {
  it("says where a folder sits in its repository", () => {
    fs.mkdirSync(path.join(repo, "packages", "a"), { recursive: true });
    expect(repoSubfolder(path.join(repo, "packages", "a"))).toBe("packages/a/");
    expect(repoSubfolder(repo)).toBe("");
  });
});

describe("ensureWorktree", () => {
  it("creates a branch and a folder for the agent", () => {
    const wt = ensureWorktree(repo, hub, "alice");
    expect(wt).toMatchObject({ branch: "fleet/alice", base: "main" });
    expect(fs.existsSync(path.join(wt.path, "README.md"))).toBe(true);
  });

  it("picks up the worktree the agent already has", () => {
    const first = ensureWorktree(repo, hub, "alice");
    write(first.path, "work.txt", "in progress");
    expect(ensureWorktree(repo, hub, "alice").path).toBe(first.path);
    expect(fs.existsSync(path.join(first.path, "work.txt"))).toBe(true);
  });

  it("reuses the branch if the folder was removed", () => {
    const first = ensureWorktree(repo, hub, "alice");
    fs.rmSync(first.path, { recursive: true, force: true });
    expect(fs.existsSync(path.join(ensureWorktree(repo, hub, "alice").path, "README.md"))).toBe(true);
  });

  it("stays out of the repository's status when the hub is inside it", () => {
    ensureWorktree(repo, path.join(repo, ".pi-fleet"), "alice");
    expect(git(repo, "status", "--porcelain")).toBe("");
  });

  it("explains a repository that is not on a branch", () => {
    git(repo, "checkout", "--detach");
    expect(() => ensureWorktree(repo, hub, "alice")).toThrow("is not on a branch");
  });

  it("explains a repository with no commits", () => {
    const empty = path.join(tmp, "empty");
    fs.mkdirSync(empty);
    git(empty, "init");
    expect(() => ensureWorktree(empty, hub, "alice")).toThrow("has no commits yet");
  });
});

describe("worktreeChanges", () => {
  it("shows new files and edits, committed or not", () => {
    const wt = ensureWorktree(repo, hub, "alice");
    write(wt.path, "committed.txt", "a\n");
    git(wt.path, "add", "-A");
    git(wt.path, "commit", "-m", "Work");
    write(wt.path, "uncommitted.txt", "b\n");
    write(wt.path, "README.md", "changed\n");
    const changes = worktreeChanges(wt);
    expect(changes.files.sort()).toEqual(["README.md", "committed.txt", "uncommitted.txt"]);
    expect(changes.patch).toContain("+b");
    expect(changes.patch).toContain("-hello");
  });

  it("is empty before any work", () => {
    expect(worktreeChanges(ensureWorktree(repo, hub, "alice"))).toMatchObject({ files: [], patch: "" });
  });
});

describe("mergeWorktree", () => {
  it("commits what the agent left and merges it", () => {
    const wt = ensureWorktree(repo, hub, "alice");
    write(wt.path, "new.txt", "done\n");
    expect(mergeWorktree(wt, "Work by alice")).toEqual({ merged: true, conflicts: [] });
    expect(fs.existsSync(path.join(repo, "new.txt"))).toBe(true);
    expect(git(repo, "log", "-1", "--format=%s")).toBe("Merge fleet/alice: Work by alice");
  });

  it("has nothing to do when nothing changed", () => {
    expect(mergeWorktree(ensureWorktree(repo, hub, "alice"), "Nothing")).toEqual({ merged: false, conflicts: [] });
  });

  it("brings the agent up to date after a merge", () => {
    const wt = ensureWorktree(repo, hub, "alice");
    write(wt.path, "new.txt", "done\n");
    mergeWorktree(wt, "Work");
    expect(git(wt.path, "rev-parse", "HEAD")).toBe(git(repo, "rev-parse", "HEAD"));
  });

  it("merges two agents in turn", () => {
    const a = ensureWorktree(repo, hub, "alice");
    const b = ensureWorktree(repo, hub, "bob");
    write(a.path, "a.txt", "a\n");
    write(b.path, "b.txt", "b\n");
    expect(mergeWorktree(a, "A").merged).toBe(true);
    expect(mergeWorktree(b, "B").merged).toBe(true);
    expect(fs.readdirSync(repo).sort()).toEqual([".git", "README.md", "a.txt", "b.txt"]);
  });

  it("names the files in a conflict and leaves the base untouched", () => {
    const a = ensureWorktree(repo, hub, "alice");
    const b = ensureWorktree(repo, hub, "bob");
    write(a.path, "same.txt", "from a\n");
    write(b.path, "same.txt", "from b\n");
    mergeWorktree(a, "A");
    const head = git(repo, "rev-parse", "HEAD");
    expect(mergeWorktree(b, "B")).toEqual({ merged: false, conflicts: ["same.txt"] });
    expect(git(repo, "rev-parse", "HEAD")).toBe(head);
    expect(git(repo, "status", "--porcelain")).toBe("");
  });

  it("reports a merge that git refused, which is not the same as nothing to merge", () => {
    const wt = ensureWorktree(repo, hub, "alice");
    write(wt.path, "new.txt", "from the agent\n");
    write(repo, "new.txt", "a person's untracked file\n");
    expect(() => mergeWorktree(wt, "Work")).toThrow(/could not merge fleet\/alice: .*untracked working tree files/s);
    expect(fs.readFileSync(path.join(repo, "new.txt"), "utf8")).toBe("a person's untracked file\n");
  });

  it("refuses when the base has uncommitted changes", () => {
    const wt = ensureWorktree(repo, hub, "alice");
    write(wt.path, "new.txt", "done\n");
    write(repo, "README.md", "edited by a person\n");
    expect(() => mergeWorktree(wt, "Work")).toThrow("has uncommitted changes");
  });

  it("refuses when another branch is checked out", () => {
    const wt = ensureWorktree(repo, hub, "alice");
    git(repo, "checkout", "-b", "other");
    expect(() => mergeWorktree(wt, "Work")).toThrow("is on other: check out main");
  });

  it("does not need a git identity on the machine", () => {
    git(repo, "config", "--unset", "user.name");
    git(repo, "config", "--unset", "user.email");
    const wt = ensureWorktree(repo, hub, "alice");
    write(wt.path, "new.txt", "done\n");
    const home = { ...process.env };
    process.env.GIT_CONFIG_GLOBAL = path.join(tmp, "no-config");
    process.env.GIT_CONFIG_NOSYSTEM = "1";
    try {
      expect(mergeWorktree(wt, "Work").merged).toBe(true);
    } finally {
      process.env = home;
    }
  });
});
