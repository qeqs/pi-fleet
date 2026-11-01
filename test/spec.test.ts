import { describe, it, expect } from "vitest";
import { parseAgentSpec, agentNameFromSpec, agentCwdFromSpec, agentModelFromSpec, agentRoleFromSpec, isValidAgentName } from "../src/spec.ts";

const BS = "\\";

describe("names that mean something else", () => {
  it.each(["__proto__", "constructor", "prototype", "con", "NUL", "com1", "LPT9"])("refuses %s", (name) => {
    expect(isValidAgentName(name)).toBe(false);
  });

  it("still allows names that only look close", () => {
    expect(isValidAgentName("console")).toBe(true);
    expect(isValidAgentName("com")).toBe(true);
  });
});

describe("isValidAgentName", () => {
  it("accepts what an @mention can carry", () => {
    for (const name of ["planner", "agent-2", "qa_bot", "A1"]) expect(isValidAgentName(name)).toBe(true);
  });

  it("refuses names that could escape a path or a command line", () => {
    for (const name of ["", "../../evil", "a/b", `a${BS}b`, "x --version&mkdir pwned", "a b", 'q"', "a.b", "x".repeat(65)]) {
      expect(isValidAgentName(name)).toBe(false);
    }
  });

  it("refuses the names the bus keeps for itself", () => {
    for (const name of ["group", "user", "system", "router"]) expect(isValidAgentName(name)).toBe(false);
  });
});

describe("parseAgentSpec", () => {
  it("parses a bare name", () => {
    expect(parseAgentSpec("planner")).toEqual({ name: "planner" });
  });

  it("parses name + relative cwd + model", () => {
    expect(parseAgentSpec("planner:./myproj:hf-model")).toEqual({
      name: "planner",
      cwd: "./myproj",
      model: "hf-model",
    });
  });

  it("treats a single non-path segment as cwd (not model)", () => {
    expect(parseAgentSpec("planner:somewhere")).toEqual({ name: "planner", cwd: "somewhere" });
  });

  it("parses name::model (empty cwd)", () => {
    expect(parseAgentSpec("planner::hf-model")).toEqual({ name: "planner", model: "hf-model" });
  });

  it("parses a Windows drive-letter cwd (backslash)", () => {
    const spec = "planner" + ":" + "C:" + BS + "Users" + BS + "vlygin" + BS + "Projects" + BS + "pi-fleet";
    expect(parseAgentSpec(spec)).toEqual({
      name: "planner",
      cwd: "C:" + BS + "Users" + BS + "vlygin" + BS + "Projects" + BS + "pi-fleet",
    });
  });

  it("parses a Windows drive-letter cwd + model + role", () => {
    const spec = "planner" + ":" + "C:" + BS + "Users" + BS + "proj" + ":hf-model:implementer";
    expect(parseAgentSpec(spec)).toEqual({
      name: "planner",
      cwd: "C:" + BS + "Users" + BS + "proj",
      model: "hf-model",
      role: "implementer",
    });
  });

  it("parses a Windows drive-letter cwd with forward slashes", () => {
    expect(parseAgentSpec("planner:C:/Users/proj")).toEqual({ name: "planner", cwd: "C:/Users/proj" });
  });

  it("does not treat a bare drive letter followed by a non-path as a path", () => {
    // "C" followed by "hf-model" (no leading slash) → cwd is "C", model is "hf-model"
    expect(parseAgentSpec("planner:C:hf-model")).toEqual({ name: "planner", cwd: "C", model: "hf-model" });
  });
});

describe("spec field helpers", () => {
  it("agentNameFromSpec returns the name", () => {
    expect(agentNameFromSpec("planner:C:/x:y")).toBe("planner");
  });

  it("agentCwdFromSpec resolves cwd or falls back", () => {
    const fallback = "/base";
    expect(agentCwdFromSpec("planner", fallback)).toBe(fallback);
    expect(agentCwdFromSpec("planner:./rel", fallback).endsWith("rel")).toBe(true);
  });

  it("agentModelFromSpec / agentRoleFromSpec", () => {
    expect(agentModelFromSpec("a:b:m:r")).toBe("m");
    expect(agentRoleFromSpec("a:b:m:r")).toBe("r");
    expect(agentModelFromSpec("a")).toBeUndefined();
    expect(agentRoleFromSpec("a:b")).toBeUndefined();
  });
});