import { describe, it, expect } from "vitest";
import type { AgentInfo, ChannelConfig, FleetMessage } from "../src/hub.ts";
import { fallbackRoute, parseRouterReply, routeByRules, routerPrompt } from "../src/router.ts";

const agent = (name: string, role?: string): AgentInfo => ({ name, pid: 1, cwd: ".", status: "idle", startedAt: 0, lastReadOffset: 0, role });
const agents = [agent("plan", "planner"), agent("impl", "implementer"), agent("rev", "reviewer")];
const channel: ChannelConfig = { name: "group", members: ["plan", "impl", "rev"] };
const msg = (from: string, text: string, id = "1"): FleetMessage => ({ id, ts: 0, from, to: "group", kind: "chat", text });

describe("routeByRules", () => {
  it("ends the turn on an approval, with no model call", () => {
    expect(routeByRules(msg("rev", "APPROVE"), channel, agents)).toEqual([]);
    expect(routeByRules(msg("rev", "APPROVE — looks right"), channel, agents)).toEqual([]);
  });

  it("sends requested changes to the implementers", () => {
    expect(routeByRules(msg("rev", "REQUEST CHANGES: fix the test"), channel, agents)).toEqual(["impl"]);
  });

  it("leaves requested changes to the model when there is no implementer", () => {
    expect(routeByRules(msg("rev", "REQUEST CHANGES: x"), { name: "g", members: ["plan", "rev"] }, agents)).toBeNull();
  });

  it("needs no model when there is only one member", () => {
    const solo: ChannelConfig = { name: "g", members: ["impl"] };
    expect(routeByRules(msg("user", "hello"), solo, agents)).toEqual(["impl"]);
    expect(routeByRules(msg("impl", "done"), solo, agents)).toEqual([]);
  });

  it("leaves anything else to the model", () => {
    expect(routeByRules(msg("user", "build the feature"), channel, agents)).toBeNull();
    expect(routeByRules(msg("rev", "I APPROVE of this plan in part"), channel, agents)).toBeNull();
  });
});

describe("routerPrompt", () => {
  it("gives the model everything, since it remembers nothing", () => {
    const m = msg("user", "build the parser", "new");
    const recent = [msg("plan", "earlier note", "a"), { ...msg("rev", "elsewhere", "b"), to: "rev" }, m];
    const p = routerPrompt({ ...channel, summary: "Parser work so far" }, m, agents, recent);
    expect(p).toContain("#group");
    expect(p).toContain("impl (implementer, idle)");
    expect(p).toContain("Parser work so far");
    expect(p).toContain("plan: earlier note");
    expect(p).toContain("New message from user: build the parser");
    expect(p).not.toContain("elsewhere");
    expect(p.match(/build the parser/g)).toHaveLength(1);
  });
});

describe("parseRouterReply", () => {
  it("reads plain JSON", () => {
    expect(parseRouterReply('{"respond": ["impl"], "summary": "s"}', channel)).toEqual({ respond: ["impl"], summary: "s" });
  });

  it("finds the JSON inside whatever a model wraps around it", () => {
    expect(parseRouterReply('Sure!\n```json\n{"respond": []}\n```', channel)).toEqual({ respond: [], summary: undefined });
  });

  it("drops names that are not members", () => {
    expect(parseRouterReply('{"respond": ["impl", "nobody"]}', channel)?.respond).toEqual(["impl"]);
  });

  it("returns null for a reply it cannot use", () => {
    for (const reply of ["", "no idea", "{broken", '{"summary": "no respond field"}']) expect(parseRouterReply(reply, channel)).toBeNull();
  });
});

describe("fallbackRoute", () => {
  it("prefers the planner, then an implementer", () => {
    expect(fallbackRoute(channel, agents, ["plan", "impl", "rev"])).toEqual(["plan"]);
    expect(fallbackRoute(channel, agents, ["impl", "rev"])).toEqual(["impl"]);
  });

  it("settles for any running member", () => {
    expect(fallbackRoute(channel, agents, ["rev"])).toEqual(["rev"]);
  });

  it("finds nobody when nobody is running", () => {
    expect(fallbackRoute(channel, agents, [])).toEqual([]);
  });
});
