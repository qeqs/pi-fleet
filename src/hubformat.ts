/**
 * The hub's files change between releases, so a hub records the format it is in. A
 * newer release upgrades an older hub the first time a supervisor opens it. An older
 * release refuses a newer hub, because it could not tell what it would be damaging.
 */
import fs from "node:fs";
import path from "node:path";

export const HUB_FORMAT = 1;

const formatFile = (dir: string): string => path.join(dir, "format.json");

/** Releases before 1.0 kept the reason for a pause as plain text. */
function upgradePausedFile(dir: string): void {
  const file = path.join(dir, "paused");
  if (!fs.existsSync(file)) return;
  const text = fs.readFileSync(file, "utf8");
  try {
    JSON.parse(text);
  } catch {
    fs.writeFileSync(file, JSON.stringify({ reason: text.trim(), since: fs.statSync(file).mtimeMs }));
  }
}

/** Releases before 0.5 made a worker supervise #group. The dedicated router does that now. */
function upgradeGroupSupervisor(dir: string): void {
  const file = path.join(dir, "channels.json");
  if (!fs.existsSync(file)) return;
  const data = JSON.parse(fs.readFileSync(file, "utf8")) as { channels: { name: string; supervisor?: string; pinned?: boolean }[] };
  const group = data.channels.find((c) => c.name === "group");
  if (!group?.supervisor || group.pinned) return;
  delete group.supervisor;
  fs.writeFileSync(file, JSON.stringify(data, null, 2));
}

/** What takes a hub from each format to the next. */
const UPGRADES: Record<number, (dir: string) => void> = {
  0: (dir) => {
    upgradePausedFile(dir);
    upgradeGroupSupervisor(dir);
  },
};

export function readHubFormat(dir: string): number {
  try {
    return (JSON.parse(fs.readFileSync(formatFile(dir), "utf8")) as { format: number }).format;
  } catch {
    return 0; // nothing before 1.0 recorded one
  }
}

/** Bring a hub up to date. Returns the format it was in, if it had to change. */
export function upgradeHub(dir: string): number | null {
  const found = readHubFormat(dir);
  if (found > HUB_FORMAT) throw new Error(`${dir} was written by a newer pi-fleet (hub format ${found}; this one reads up to ${HUB_FORMAT}). Update pi-fleet to use it.`);
  if (found === HUB_FORMAT) return null;
  const isNew = !fs.existsSync(path.join(dir, "messages.jsonl")) && !fs.existsSync(path.join(dir, "agents.json"));
  for (let format = found; format < HUB_FORMAT; format++) UPGRADES[format](dir);
  fs.writeFileSync(formatFile(dir), JSON.stringify({ format: HUB_FORMAT }));
  return isNew ? null : found;
}
