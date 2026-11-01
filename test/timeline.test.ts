import { describe, it, expect } from "vitest";
import type { FleetMessage } from "../src/hub.ts";
import { buildTimeline } from "../src/timeline.ts";
import { listTasks, parseBeadsList, parseOpenspecList } from "../src/taskboard.ts";

let n = 0;
const msg = (from: string, to: string, text: string, kind: FleetMessage["kind"] = "chat"): FleetMessage => ({ id: `m${++n}`, ts: n, from, to, kind, text });

describe("buildTimeline", () => {
  it("groups what followed under each request, and says why each step happened", () => {
    const ask = msg("user", "group", "build it");
    const [routed, mention, post, dm] = [msg("router", "impl", "[#group] build it"), msg("impl", "group", "@rev look"), msg("rev", "group", "APPROVE"), msg("impl", "rev", "thanks")];
    const [task] = buildTimeline([ask, routed, mention, post, dm], {}, 0);
    expect(task).toMatchObject({ id: ask.id, text: "build it", to: "group" });
    expect(task.steps.map((s) => s.why)).toEqual(["routed", "mention", "channel", "direct"]);
  });

  it("starts a new task at each human message", () => {
    const tasks = buildTimeline([msg("user", "group", "one"), msg("impl", "group", "ok"), msg("user", "impl", "two")], {}, 0);
    expect(tasks.map((t) => t.text)).toEqual(["one", "two"]);
    expect(tasks[1].steps).toEqual([]);
  });

  it("keeps overlapping requests apart", () => {
    const [one, two] = [msg("user", "impl1", "first job"), msg("user", "impl2", "second job")];
    const tasks = buildTimeline([one, two, msg("impl1", "group", "@rev look at mine"), msg("impl2", "group", "@rev2 look at mine"), msg("rev", "group", "APPROVE"), msg("rev2", "group", "APPROVE")], {}, 0);
    expect(tasks[0].steps.map((s) => s.from)).toEqual(["impl1", "rev"]);
    expect(tasks[1].steps.map((s) => s.from)).toEqual(["impl2", "rev2"]);
  });

  it("follows a request a router passed on", () => {
    const tasks = buildTimeline([msg("user", "group", "first"), msg("router", "impl", "[#group] first"), msg("user", "other", "second"), msg("impl", "group", "done")], {}, 0);
    expect(tasks[0].steps.map((s) => s.from)).toEqual(["router", "impl"]);
    expect(tasks[1].steps).toEqual([]);
  });

  it("leaves out what nobody said", () => {
    const tasks = buildTimeline([msg("user", "group", "go"), msg("system", "group", "joined", "system"), msg("router", "group", "routed to a", "activity")], {}, 0);
    expect(tasks[0].steps).toEqual([]);
  });

  it("ignores messages from before anyone asked anything", () => {
    expect(buildTimeline([msg("impl", "group", "hello")], {}, 0)).toEqual([]);
  });

  it("costs each task from the spending between requests", () => {
    const [a, b] = [msg("user", "group", "first"), msg("user", "group", "second")];
    const tasks = buildTimeline([a, b], { [a.id]: 1, [b.id]: 1.5 }, 2.25);
    expect(tasks.map((t) => t.cost)).toEqual([0.5, 0.75]);
  });

  it("does not guess a cost it has no record of", () => {
    expect(buildTimeline([msg("user", "group", "old")], {}, 3)[0].cost).toBeUndefined();
  });
});

describe("task boards", () => {
  it("reads openspec's list", () => {
    const json = JSON.stringify({ changes: [{ name: "add-thing", completedTasks: 1, totalTasks: 2, status: "in-progress" }], root: { path: "x" } });
    expect(parseOpenspecList(json)).toEqual([{ id: "add-thing", title: "add-thing", status: "in-progress", done: 1, total: 2 }]);
  });

  it("treats a project with no board as an empty one", () => {
    expect(parseOpenspecList(JSON.stringify({ changes: [], root: null, status: [{ severity: "error" }] }))).toEqual([]);
  });

  it("says so when the board's tool is not installed", async () => {
    const searched = process.env.PATH;
    process.env.PATH = "";
    await expect(listTasks("beads", ".", ".")).rejects.toThrow("bd is not installed");
    process.env.PATH = searched;
  });

  it("reads beads' list", () => {
    expect(parseBeadsList(JSON.stringify([{ id: "b-1", title: "Fix it", status: "open" }]))).toEqual([{ id: "b-1", title: "Fix it", status: "open" }]);
    expect(parseBeadsList("")).toEqual([]);
  });
});
