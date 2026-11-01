import { describe, it, expect } from "vitest";
import { countsAsWork } from "../src/extension/index.ts";
import type { AgentInfo, ChannelConfig, FleetMessage } from "../src/hub.ts";
import { closesJob, noteTool, parseWatchReply, startJob, watchPrompt } from "../src/watch.ts";

const channel: ChannelConfig = { name: "group", members: ["planner", "implementer"] };
const agent = (name: string, role: string) => ({ name, role, status: "idle" }) as AgentInfo;
const crew = [agent("planner", "planner"), agent("implementer", "implementer"), agent("outsider", "reviewer")];

let ids = 0;
const message = (from: string, text: string, ts = 1000, kind: FleetMessage["kind"] = "chat"): FleetMessage => ({ id: `id-${++ids}`, ts, from, to: "group", kind, text });
const job = (text = "make a page") => startJob(message("user", text));

describe("what counts as work", () => {
  it("is never talking or planning", () => {
    for (const tool of ["fleet_send", "fleet_mention", "fleet_inbox", "fleet_agents", "route", "openspec", "beads"]) {
      expect(countsAsWork(tool, "reviewer")).toBe(false);
    }
  });

  it("for an implementer, is changing or running something", () => {
    for (const tool of ["write", "edit", "bash"]) expect(countsAsWork(tool, "implementer")).toBe(true);
    for (const tool of ["read", "grep", "find", "ls"]) expect(countsAsWork(tool, "implementer")).toBe(false);
  });

  it("for anyone else, includes reading", () => {
    expect(countsAsWork("read", "reviewer")).toBe(true);
    expect(countsAsWork("read", undefined)).toBe(true);
  });
});

describe("what ends a job", () => {
  it("is an approval of something real", () => {
    const j = job();
    noteTool(j, "implementer", "write");
    expect(closesJob(message("reviewer", "APPROVE: looks right"), j)).toBe(true);
  });

  it("is not an approval when nobody changed anything", () => {
    const j = job();
    noteTool(j, "reviewer", "read");
    noteTool(j, "reviewer", "bash"); // a look around, however it was done
    noteTool(j, "planner", "fleet_mention");
    expect(closesJob(message("reviewer", "APPROVE"), j)).toBe(false);
  });

  it("is not a message that merely talks about approving", () => {
    const j = job();
    noteTool(j, "implementer", "write");
    expect(closesJob(message("planner", "I will APPROVE this later"), j)).toBe(false);
    expect(closesJob(message("reviewer", "REQUEST CHANGES: add a test"), j)).toBe(false);
    expect(closesJob(message("system", "APPROVE", 1000, "system"), j)).toBe(false);
  });
});

describe("what the router is told about a quiet crew", () => {
  it("says who really used which tools, and that the rest used none", () => {
    const j = job();
    noteTool(j, "planner", "read");
    noteTool(j, "planner", "read");
    noteTool(j, "planner", "fleet_mention");
    const prompt = watchPrompt(j, channel, crew, []);
    expect(prompt).toContain("planner (planner): read 2, fleet_mention 1");
    expect(prompt).toContain("implementer (implementer): none");
    expect(prompt).not.toContain("outsider");
  });

  it("gives the task and what was said since, and nothing from before it", () => {
    const j = startJob(message("user", "make a page", 2000));
    const recent = [message("planner", "an earlier job", 1000), j.task, message("planner", "over to you", 3000), message("system", "joined", 3000, "system")];
    const prompt = watchPrompt(j, channel, crew, recent);
    expect(prompt).toContain("The person asked #group: make a page");
    expect(prompt).toContain("planner: over to you");
    expect(prompt).not.toContain("an earlier job");
    expect(prompt).not.toContain("joined");
    expect(prompt.match(/make a page/g)).toHaveLength(1);
  });

  it("says so when nothing was said", () => {
    expect(watchPrompt(job(), channel, crew, [])).toContain("No messages since then.");
  });

  it("stays short, whatever was said", () => {
    const j = job("x".repeat(5000));
    const said = Array.from({ length: 30 }, (_, i) => message("planner", `${i} ${"y".repeat(5000)}`, 2000));
    expect(watchPrompt(j, channel, crew, said).length).toBeLessThan(5000);
  });
});

describe("the router's answer", () => {
  it("reads a finished job", () => {
    expect(parseWatchReply('{"finished": true}', channel)).toEqual({ finished: true, next: undefined, say: undefined });
  });

  it("reads who must act, around whatever else the model wrote", () => {
    const reply = 'Sure:\n```json\n{"finished": false, "next": "implementer", "say": " Write the file. "}\n```';
    expect(parseWatchReply(reply, channel)).toEqual({ finished: false, next: "implementer", say: "Write the file." });
  });

  it("drops a name that is not a member", () => {
    expect(parseWatchReply('{"finished": false, "next": "outsider", "say": "go"}', channel)?.next).toBeUndefined();
  });

  it("gives nothing for an answer that is not one", () => {
    for (const reply of ["", "I am not sure.", "{broken", '{"finished": "no"}', '{"next": "planner"}']) {
      expect(parseWatchReply(reply, channel)).toBeNull();
    }
  });
});
