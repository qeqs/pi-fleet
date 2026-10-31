import { describe, it, expect } from "vitest";
import { parseArgs, UsageError, USAGE } from "../src/cli.ts";

describe("parseArgs", () => {
  it("reads flags and keeps positionals in rest", () => {
    const args = parseArgs(["alice", "--dir", "hub", "--agent", "a", "--agent", "b", "--detach", "--lean"]);
    expect(args).toMatchObject({ dir: "hub", agents: ["a", "b"], detach: true, lean: true, rest: ["alice"] });
  });

  it("reads --no-lean as an explicit false", () => {
    expect(parseArgs(["--no-lean"]).lean).toBe(false);
  });

  it("reads the restart options", () => {
    expect(parseArgs(["--fresh", "--no-restart"])).toMatchObject({ fresh: true, noRestart: true });
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

describe("bad input", () => {
  const refused = (args: string[]) => () => parseArgs(args);

  it("refuses unknown options by name", () => {
    expect(refused(["--detatch"])).toThrow(UsageError);
    expect(refused(["--detatch"])).toThrow('unknown option "--detatch"');
  });

  it("refuses a bad port", () => {
    for (const port of ["abc", "70000", "-1", "1.5"]) expect(refused(["--port", port])).toThrow("--port needs a number");
  });

  it("accepts port 0 and the top of the range", () => {
    expect(parseArgs(["--port", "0"]).port).toBe(0);
    expect(parseArgs(["--port", "65535"]).port).toBe(65535);
  });

  it("refuses a flag with its value missing", () => {
    expect(refused(["--dir"])).toThrow("--dir needs a value");
    expect(refused(["--model", "--lean"])).toThrow("--model needs a value");
  });

  it("refuses a bad limit", () => {
    expect(refused(["--max-turns", "lots"])).toThrow("--max-turns needs a whole number");
    expect(refused(["--max-hops"])).toThrow("--max-hops needs a whole number");
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
