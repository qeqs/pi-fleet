import { describe, it, expect } from "vitest";
import { parseArgs, USAGE } from "../src/cli.ts";

describe("parseArgs", () => {
  it("reads flags and keeps positionals in rest", () => {
    const args = parseArgs(["alice", "--dir", "hub", "--agent", "a", "--agent", "b", "--detach", "--lean"]);
    expect(args).toMatchObject({ dir: "hub", agents: ["a", "b"], detach: true, lean: true, rest: ["alice"] });
  });

  it("reads --no-lean as an explicit false", () => {
    expect(parseArgs(["--no-lean"]).lean).toBe(false);
  });

  it("reads the runaway limits, keeping an explicit 0", () => {
    expect(parseArgs(["--max-turns", "25", "--max-hops", "0"])).toMatchObject({ maxTurns: 25, maxHops: 0 });
  });

  it("leaves unset limits undefined, so config and defaults can apply", () => {
    const args = parseArgs([]);
    expect(args.maxTurns).toBeUndefined();
    expect(args.maxHops).toBeUndefined();
  });
});

describe("USAGE", () => {
  it("documents the runaway limits and their defaults", () => {
    expect(USAGE).toContain("--max-turns N");
    expect(USAGE).toContain("default 100");
    expect(USAGE).toContain("--max-hops N");
    expect(USAGE).toContain("default 40");
  });
});
