/**
 * What happened for each thing a person asked: who woke whom, why, and what it cost.
 * All of it comes from the bus, plus how much had been spent when each request came in.
 */
import type { FleetMessage } from "./hub.ts";

export interface TimelineStep {
  ts: number;
  from: string;
  to: string;
  why: "routed" | "mention" | "direct" | "channel";
  text: string;
}

export interface TimelineTask {
  id: string;
  ts: number;
  to: string;
  text: string;
  steps: TimelineStep[];
  /** Dollars, or undefined if spending was not recorded for this task. */
  cost?: number;
}

const MENTION = /@([A-Za-z0-9_-]+)/g;

function why(m: FleetMessage): TimelineStep["why"] {
  if (m.from === "router") return "routed";
  if (m.text.match(MENTION)) return "mention";
  return m.to === "group" ? "channel" : "direct";
}

/**
 * Tasks in order, newest last. Requests can overlap, so a step belongs to the task its
 * agent was woken for, not simply to the latest one. `spend` holds the fleet's total
 * when each request came in, so a task's cost includes whatever overlapped it.
 */
export function buildTimeline(messages: FleetMessage[], spend: Record<string, number>, spentNow: number): TimelineTask[] {
  const tasks: TimelineTask[] = [];
  const working = new Map<string, TimelineTask>();
  const wake = (m: FleetMessage, task: TimelineTask): void => {
    for (const name of [m.to, ...[...m.text.matchAll(MENTION)].map((match) => match[1])]) working.set(name, task);
  };
  for (const m of messages) {
    if (m.kind !== "chat") continue;
    if (m.from === "user") {
      const task: TimelineTask = { id: m.id, ts: m.ts, to: m.to, text: m.text, steps: [] };
      tasks.push(task);
      wake(m, task);
      continue;
    }
    const task = working.get(m.from) ?? tasks.at(-1);
    task?.steps.push({ ts: m.ts, from: m.from, to: m.to, why: why(m), text: m.text });
    if (task) wake(m, task);
  }
  tasks.forEach((task, i) => {
    const start = spend[task.id];
    const end = i + 1 < tasks.length ? spend[tasks[i + 1].id] : spentNow;
    if (start !== undefined && end !== undefined) task.cost = Math.max(0, end - start);
  });
  return tasks;
}
