/**
 * The folders the desktop app has worked in, most recent first. Each one keeps its own
 * hub at <folder>/.pi-fleet. There is no Electron here, so this can be tested on its own.
 */
import fs from "node:fs";
import path from "node:path";

const KEEP = 8;

export function readProjects(file) {
  try {
    const { recent } = JSON.parse(fs.readFileSync(file, "utf8"));
    return Array.isArray(recent) ? recent.filter((dir) => typeof dir === "string") : [];
  } catch {
    return []; // first run, or a file someone broke: neither should stop the app
  }
}

export function rememberProject(file, dir) {
  const recent = [dir, ...readProjects(file).filter((known) => known !== dir)].slice(0, KEEP);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify({ recent }, null, 2));
  return recent;
}

/** A folder can bring its own fleet and pi configuration, and opening it would run them. */
export function needsTrust(file, dir, exists = fs.existsSync) {
  if (readProjects(file).includes(dir)) return false;
  return [path.join(dir, ".pi-fleet", "fleet.json"), path.join(dir, ".pi")].some((p) => exists(p));
}

/** The project to open at launch, or null if the person has to choose one. */
export function startingProject(file, exists = fs.existsSync) {
  return readProjects(file).find((dir) => exists(dir)) ?? null;
}
