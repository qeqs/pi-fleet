import { describe, it, expect } from "vitest";
import { parseChatLine } from "../src/chat.ts";

describe("parseChatLine", () => {
  it("ignores blank lines", () => {
    expect(parseChatLine("   ")).toEqual({ kind: "empty" });
  });

  it("reads known commands and their arguments", () => {
    expect(parseChatLine("/agents")).toEqual({ kind: "command", name: "agents", args: "" });
    expect(parseChatLine("/help")).toEqual({ kind: "command", name: "help", args: "" });
    expect(parseChatLine("/stop alice")).toEqual({ kind: "command", name: "stop", args: "alice" });
    expect(parseChatLine("/new bob . fake/model planner")).toEqual({ kind: "command", name: "new", args: "bob . fake/model planner" });
    expect(parseChatLine("/channel add dev a,b")).toEqual({ kind: "command", name: "channel", args: "add dev a,b" });
  });

  it("rejects a mistyped command, so it never reaches the agents", () => {
    const line = parseChatLine("/stat");
    expect(line.kind).toBe("error");
    expect(line).toMatchObject({ message: expect.stringContaining('unknown command "/stat"') });
    expect(line).toMatchObject({ message: expect.stringContaining("/help") });
  });

  it("shows usage for a command missing its argument", () => {
    expect(parseChatLine("/stop")).toEqual({ kind: "error", message: "usage: /stop name" });
    expect(parseChatLine("/new")).toMatchObject({ kind: "error", message: expect.stringContaining("usage: /new name") });
  });

  it("treats a path as a message, not a command", () => {
    expect(parseChatLine("/tmp/out.log is empty")).toEqual({ kind: "message", to: "group", text: "/tmp/out.log is empty" });
  });

  it("addresses agents and channels", () => {
    expect(parseChatLine("@alice do it")).toEqual({ kind: "message", to: "alice", text: "do it" });
    expect(parseChatLine("#dev do it")).toEqual({ kind: "message", to: "dev", text: "do it" });
    expect(parseChatLine("# do it")).toEqual({ kind: "message", to: "group", text: "do it" });
    expect(parseChatLine("do it")).toEqual({ kind: "message", to: "group", text: "do it" });
  });

  it("shows usage for an address with no message", () => {
    expect(parseChatLine("@alice")).toEqual({ kind: "error", message: "usage: @name message" });
    expect(parseChatLine("#dev")).toMatchObject({ kind: "error", message: expect.stringContaining("usage: #name message") });
  });

  it("lets a command word be posted on purpose", () => {
    expect(parseChatLine("# /stat means something else here")).toEqual({ kind: "message", to: "group", text: "/stat means something else here" });
  });
});
