/**
 * The desktop app as a person uses it: real Electron, real supervisor, real pi and a
 * scripted model. Set PI_FLEET_APP to an installed app to test that instead of the
 * sources. Needs Electron's binary, which the plain test job does not download.
 */
import { describe, it, expect, beforeAll, afterAll, afterEach } from "vitest";
import fs from "node:fs";
import http from "node:http";
import { createRequire } from "node:module";
import type { AddressInfo } from "node:net";
import os from "node:os";
import path from "node:path";
import { _electron, type ElectronApplication, type Page } from "playwright-core";
import { needsTrust, readProjects, rememberProject, startingProject } from "../electron/projects.mjs";
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

  it("asks before opening a new folder that brings its own setup", () => {
    const file = path.join(dir, "trust.json");
    const has = (found: string) => (p: string) => p.endsWith(found);
    expect(needsTrust(file, "/cloned", has("fleet.json"))).toBe(true);
    expect(needsTrust(file, "/cloned", has(".pi"))).toBe(true);
    expect(needsTrust(file, "/plain", () => false)).toBe(false);
    rememberProject(file, "/cloned");
    expect(needsTrust(file, "/cloned", has("fleet.json"))).toBe(false); // already opened
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

  /** Name the step that stalled: a CI log is not always at hand. */
  async function step<T>(name: string, work: Promise<T>, ms = 60000): Promise<T> {
    let timer: NodeJS.Timeout | undefined;
    const stalled = new Promise<never>((_, reject) => (timer = setTimeout(() => reject(new Error(`stalled at: ${name}`)), ms)));
    try {
      return await Promise.race([work, stalled]);
    } finally {
      clearTimeout(timer);
    }
  }

  async function startCrew(page: Page): Promise<void> {
    await step("the first-run screen", page.waitForSelector(".firstrun", { timeout: 0 }));
    await step("the model list", page.waitForFunction(() => document.querySelectorAll("#modelList option").length > 0, undefined, { timeout: 0 }));
    await page.fill("#firstModel", MODEL);
    await page.click('button[data-template="sdlc"]');
    for (const n of ["planner", "implementer", "reviewer"]) await step(`${n} to start`, page.waitForSelector(`[data-chat="${n}"] .cdot.idle`, { timeout: 0 }));
  }

  it("finishes an sdlc task in a project, moves to another, and comes back", async () => {
    const { userData, one, two } = folders("switching");
    rememberProject(projectsOf(userData), two);
    const page = await launch(userData, { PI_FLEET_PROJECT: one });
    await startCrew(page);
    await page.fill("#msgInput", "build the feature");
    await page.press("#msgInput", "Enter");
    await step("the sdlc task", page.locator("#conversation").getByText("APPROVE").waitFor({ timeout: 0 }));
    expect(fs.existsSync(path.join(one, ".pi-fleet", "fleet.json"))).toBe(true); // in the project, not next to the app
    await until("the title", async () => (await title()).includes("project-one"));
    const firstFleet = new Hub(path.join(one, ".pi-fleet"));

    await step("opening the second project", openRecent(two));
    await step("the second project's page", page.waitForSelector(".firstrun", { timeout: 0 })); // no crew yet
    await until("the title", async () => (await title()).includes("project-two"));
    await until("the first fleet to stop", () => !firstFleet.supervisorAlive());

    await step("reopening the first project", openRecent(one));
    await step("the first project's history", page.locator("#conversation").getByText("APPROVE").waitFor({ timeout: 0 }));
    expect(readProjects(projectsOf(userData))[0]).toBe(one);

    const pids = [firstFleet.otherSupervisor()!, ...Object.values(firstFleet.readAgents()).map((a) => a.pid)];
    expect(pids.length).toBe(4);
    await step("the app to close", app!.close());
    app = undefined;
    await until("the fleet to go with the app", () => !pids.some(isPidAlive));
  }, 300000);

  it.skipIf(!!installed)("will not open a folder with its own setup until the person agrees", async () => {
    const { userData, one, two } = folders("trust");
    fs.mkdirSync(path.join(two, ".pi-fleet"));
    fs.writeFileSync(path.join(two, ".pi-fleet", "fleet.json"), JSON.stringify({ agents: [{ name: "unwanted" }] }));
    const asked = path.join(userData, "asked.txt");
    const stub = path.join(userData, "refuse.cjs");
    fs.writeFileSync(stub, `require("electron").dialog.showMessageBox = async (o) => { require("fs").writeFileSync(${JSON.stringify(asked)}, o.message); return { response: 1 }; };`);
    await launch(userData, { PI_FLEET_PROJECT: one }, ["-r", stub]);
    await until("the first project", async () => (await title()).includes("project-one"), 60000);
    await app!.evaluate(({ dialog }, target) => {
      dialog.showOpenDialog = (async () => ({ canceled: false, filePaths: [target] })) as typeof dialog.showOpenDialog;
    }, two);
    await app!.evaluate(({ Menu }) => {
      Menu.getApplicationMenu()!.items.find((i) => i.label === "File")!.submenu!.items.find((i) => i.label === "Open Project…")!.click();
    });
    await until("the question", () => fs.existsSync(asked), 30000);
    expect(fs.readFileSync(asked, "utf8")).toContain("project-two");
    await new Promise((resolve) => setTimeout(resolve, 2000));
    expect(fs.existsSync(path.join(two, ".pi-fleet", "agents.json"))).toBe(false); // nothing of it ran
    expect(await title()).toContain("project-one");
  }, 120000);

  it("keeps its window on the fleet's own page", async () => {
    const { userData, one } = folders("navigate");
    const page = await launch(userData, { PI_FLEET_PROJECT: one });
    await page.waitForSelector("#conversation", { timeout: 60000 });
    await app!.evaluate(({ shell }) => {
      shell.openExternal = async () => {}; // the link would go to the browser: not in a test
    });
    let requests = 0;
    const elsewhere = http.createServer((_req, res) => {
      requests++;
      res.end("<title>elsewhere</title>");
    });
    await new Promise<void>((resolve) => elsewhere.listen(0, "127.0.0.1", resolve));
    const { port } = elsewhere.address() as AddressInfo;
    await page.evaluate((target) => {
      location.href = target;
    }, `http://localhost:${port}/`).catch(() => {});
    await new Promise((resolve) => setTimeout(resolve, 1500));
    elsewhere.close();
    expect(requests).toBe(0);
    expect(new URL(page.url()).hostname).toBe("127.0.0.1");
  }, 120000);

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
