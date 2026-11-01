/**
 * The desktop app as a person uses it: real Electron, real supervisor, real pi and a
 * scripted model. Set PI_FLEET_APP to an installed app to test that instead of the
 * sources. Needs Electron's binary, which the plain test job does not download.
 */
import { describe, it, expect, beforeAll, afterAll, afterEach } from "vitest";
import fs from "node:fs";
import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";
import { _electron, type ElectronApplication, type Page } from "playwright-core";
import { readProjects, rememberProject, startingProject } from "../electron/projects.mjs";
import { Hub, isPidAlive } from "../src/hub.ts";
import { MODEL, ROOT, killTree, startFakeModel, until } from "./support.ts";

const installed = process.env.PI_FLEET_APP;
function devElectron(): string | undefined {
  try {
    return createRequire(import.meta.url)("electron") as unknown as string;
  } catch {
    return undefined; // the module throws when its binary was not downloaded
  }
}
const executable = installed ?? devElectron();
const projectsOf = (userData: string) => path.join(userData, "projects.json");

describe("remembering projects", () => {
  let dir: string;
  beforeAll(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "fleet-projects-"));
  });

  it("starts empty, and survives a broken file", () => {
    const file = path.join(dir, "broken.json");
    expect(readProjects(file)).toEqual([]);
    fs.writeFileSync(file, "{not json");
    expect(readProjects(file)).toEqual([]);
  });

  it("keeps the most recent first, once each", () => {
    const file = path.join(dir, "recent.json");
    rememberProject(file, "/a");
    rememberProject(file, "/b");
    expect(rememberProject(file, "/a")).toEqual(["/a", "/b"]);
  });

  it("forgets the oldest after eight", () => {
    const file = path.join(dir, "many.json");
    for (let i = 0; i < 10; i++) rememberProject(file, `/${i}`);
    expect(readProjects(file)).toHaveLength(8);
    expect(readProjects(file)[0]).toBe("/9");
  });

  it("starts in the latest project that still exists", () => {
    const file = path.join(dir, "gone.json");
    rememberProject(file, "/still-here");
    rememberProject(file, "/deleted");
    expect(startingProject(file, (d) => d === "/still-here")).toBe("/still-here");
    expect(startingProject(file, () => false)).toBeNull();
  });
});

describe.skipIf(!executable)("the desktop app", () => {
  let model: Awaited<ReturnType<typeof startFakeModel>>;
  let app: ElectronApplication | undefined;

  beforeAll(async () => {
    model = await startFakeModel("pi fleet desktop");
  }, 60000);

  afterEach(async () => {
    await app?.close().catch(() => {});
    app = undefined;
  }, 60000);

  afterAll(() => {
    killTree(model?.proc.pid);
    try {
      fs.rmSync(model.tmp, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
    } catch {
      // a just-killed process may still hold a log file on Windows
    }
  });

  function folders(name: string): { userData: string; one: string; two: string } {
    const root = path.join(model.tmp, name);
    const [userData, one, two] = ["data", "project-one", "project-two"].map((d) => path.join(root, d));
    for (const d of [userData, one, two]) fs.mkdirSync(d, { recursive: true });
    return { userData, one, two };
  }

  async function launch(userData: string, env: Record<string, string> = {}, preload: string[] = []): Promise<Page> {
    app = await _electron.launch({
      executablePath: executable,
      args: [...preload, ...(installed ? [] : [ROOT]), `--user-data-dir=${userData}`, ...(process.platform === "linux" ? ["--no-sandbox"] : [])],
      env: { ...model.env, ...env } as Record<string, string>,
      timeout: 60000,
    });
    return app.firstWindow();
  }

  const title = () => app!.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]?.getTitle() ?? "");
  const openRecent = (dir: string) =>
    app!.evaluate(({ Menu }, target) => {
      const recent = Menu.getApplicationMenu()!.items.find((i) => i.label === "File")!.submenu!.items.find((i) => i.label === "Open Recent")!;
      recent.submenu!.items.find((i) => i.label === target)!.click();
    }, dir);

  async function startCrew(page: Page): Promise<void> {
    await page.waitForSelector(".firstrun", { timeout: 60000 });
    await page.waitForFunction(() => document.querySelectorAll("#modelList option").length > 0, undefined, { timeout: 60000 });
    await page.fill("#firstModel", MODEL);
    await page.click('button[data-template="sdlc"]');
    for (const n of ["planner", "implementer", "reviewer"]) await page.waitForSelector(`[data-chat="${n}"] .cdot.idle`, { timeout: 60000 });
  }

  it("finishes an sdlc task in a project, moves to another, and comes back", async () => {
    const { userData, one, two } = folders("switching");
    rememberProject(projectsOf(userData), two);
    const page = await launch(userData, { PI_FLEET_PROJECT: one });
    await startCrew(page);
    await page.fill("#msgInput", "build the feature");
    await page.press("#msgInput", "Enter");
    await page.locator("#conversation").getByText("APPROVE").waitFor({ timeout: 45000 });
    expect(fs.existsSync(path.join(one, ".pi-fleet", "fleet.json"))).toBe(true); // in the project, not next to the app
    await until("the title", async () => (await title()).includes("project-one"));
    const firstFleet = new Hub(path.join(one, ".pi-fleet"));

    await openRecent(two);
    await page.waitForSelector(".firstrun", { timeout: 60000 }); // a project with no crew yet
    await until("the title", async () => (await title()).includes("project-two"));
    await until("the first fleet to stop", () => !firstFleet.supervisorAlive());

    await openRecent(one);
    await page.locator("#conversation").getByText("APPROVE").waitFor({ timeout: 60000 });
    expect(readProjects(projectsOf(userData))[0]).toBe(one);

    const pid = firstFleet.otherSupervisor();
    expect(pid).toBeTruthy();
    await app!.close();
    app = undefined;
    await until("the supervisor to go with the app", () => !isPidAlive(pid!));
  }, 240000);

  it("reopens the last project by itself", async () => {
    const { userData, one } = folders("reopen");
    rememberProject(projectsOf(userData), one);
    await launch(userData);
    await until("the title", async () => (await title()).includes("project-one"), 60000);
  }, 120000);

  it.skipIf(!!installed)("asks for a folder the first time", async () => {
    const { userData, one } = folders("first-launch");
    const chooser = path.join(userData, "chooser.cjs");
    fs.writeFileSync(chooser, `require("electron").dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [${JSON.stringify(one)}] });`);
    await launch(userData, {}, ["-r", chooser]);
    await until("the title", async () => (await title()).includes("project-one"), 60000);
    expect(readProjects(projectsOf(userData))).toEqual([one]);
  }, 120000);

  it.skipIf(!!installed)("says what went wrong when a project cannot start", async () => {
    const { userData, one, two } = folders("bad-project");
    fs.mkdirSync(path.join(two, ".pi-fleet"));
    fs.writeFileSync(path.join(two, ".pi-fleet", "fleet.json"), "{ broken");
    const shown = path.join(userData, "shown.json");
    const stub = path.join(userData, "errors.cjs");
    fs.writeFileSync(stub, `require("electron").dialog.showErrorBox = (title, text) => require("fs").writeFileSync(${JSON.stringify(shown)}, JSON.stringify({ title, text }));`);
    rememberProject(projectsOf(userData), two);
    await launch(userData, { PI_FLEET_PROJECT: one }, ["-r", stub]);
    await until("the first project", async () => (await title()).includes("project-one"), 60000);
    await openRecent(two);
    await until("the error", () => fs.existsSync(shown), 60000);
    expect(JSON.parse(fs.readFileSync(shown, "utf8")).title).toContain("project-two");
    await until("the way back", async () => (await title()).includes("project-one"), 60000);
  }, 180000);
});
