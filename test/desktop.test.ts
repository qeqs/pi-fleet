/**
 * The desktop app as a person uses it: real Electron, real supervisor, real pi and a
 * scripted model. Set PI_FLEET_APP to an installed app to test that instead of the
 * sources. Needs Electron's binary, which the plain test job does not download.
 */
import { describe, it, expect, beforeAll, afterAll, afterEach } from "vitest";
import { spawn } from "node:child_process";
import fs from "node:fs";
import http from "node:http";
import { createRequire } from "node:module";
import type { AddressInfo } from "node:net";
import os from "node:os";
import path from "node:path";
import { _electron, type ElectronApplication, type Page } from "playwright-core";
import { needsTrust, readProjects, rememberProject, startingProject } from "../electron/projects.mjs";
import { proxyEnv } from "../electron/proxy.mjs";
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

describe("the system proxy", () => {
  it("is passed on, with local servers left out", () => {
    expect(proxyEnv({}, "PROXY 127.0.0.1:2080")).toEqual({ HTTPS_PROXY: "http://127.0.0.1:2080", HTTP_PROXY: "http://127.0.0.1:2080", NO_PROXY: "localhost,127.0.0.1,::1" });
    expect(proxyEnv({}, "HTTPS corp.example:443;DIRECT").HTTPS_PROXY).toBe("https://corp.example:443");
    expect(proxyEnv({ NO_PROXY: ".local" }, "PROXY a:1").NO_PROXY).toBe(".local");
  });

  it("stays out of the way when there is none, or one is already set", () => {
    expect(proxyEnv({}, "DIRECT")).toEqual({});
    expect(proxyEnv({}, "SOCKS5 127.0.0.1:1080")).toEqual({});
    expect(proxyEnv({ HTTPS_PROXY: "http://mine:1" }, "PROXY a:1")).toEqual({});
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
    await page.selectOption("#firstModel", MODEL);
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
    // the file shows up empty for a moment while it is written
    await until("the question", () => fs.existsSync(asked) && fs.readFileSync(asked, "utf8").length > 0, 30000);
    expect(fs.readFileSync(asked, "utf8")).toContain("project-two");
    await new Promise((resolve) => setTimeout(resolve, 2000));
    expect(fs.existsSync(path.join(two, ".pi-fleet", "agents.json"))).toBe(false); // nothing of it ran
    expect(await title()).toContain("project-one");
  }, 120000);

  it("gives agents the system proxy, and still reaches a local model", async () => {
    const { userData, one } = folders("proxy");
    const page = await launch(userData, { PI_FLEET_PROJECT: one, HTTPS_PROXY: "", HTTP_PROXY: "", NO_PROXY: "" }, ["--proxy-server=127.0.0.1:9"]);
    let desktopLog = "";
    app!.process().stdout?.on("data", (d) => (desktopLog += d));
    expect(await app!.evaluate(({ session }) => session.defaultSession.resolveProxy("https://example.com"))).toBe("PROXY 127.0.0.1:9");
    await startCrew(page);
    await page.fill("#msgInput", "@implementer [[run node -p process.env.HTTPS_PROXY]]");
    await page.press("#msgInput", "Enter");
    const ran = () => model.log().then((all) => all.find((r) => r.agent === "implementer" && r.conversation.includes("process.env.HTTPS_PROXY") && r.decision === "text"));
    await until("the command", ran, 45000).catch(async () => {
      throw new Error(`the command did not finish. The implementer's requests: ${JSON.stringify((await model.log()).filter((r) => r.agent === "implementer").slice(-3))}`);
    });
    expect((await ran())!.last, desktopLog.slice(0, 1500)).toContain("http://127.0.0.1:9");
  }, 120000);

  it("shows the running app when it is started a second time", async () => {
    const { userData, one } = folders("second-copy");
    const page = await launch(userData, { PI_FLEET_PROJECT: one });
    await page.waitForSelector("#conversation", { timeout: 60000 });
    await app!.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].minimize());
    const args = [...(installed ? [] : [ROOT]), `--user-data-dir=${userData}`, ...(process.platform === "linux" ? ["--no-sandbox"] : [])];
    const second = spawn(executable!, args, { env: { ...model.env, PI_FLEET_PROJECT: one } as NodeJS.ProcessEnv, stdio: "ignore" });
    try {
      await step("the second copy to leave", new Promise((resolve) => second.once("exit", resolve)), 30000);
    } finally {
      killTree(second.pid);
    }
    await until("the window to come back", () => app!.evaluate(({ BrowserWindow }) => !BrowserWindow.getAllWindows()[0].isMinimized()), 10000);
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

  it("gives the page notifications and nothing else", async () => {
    const { userData, one } = folders("permissions");
    const page = await launch(userData, { PI_FLEET_PROJECT: one });
    await page.waitForSelector("#conversation", { timeout: 60000 });
    const asked = await page.evaluate(async () => ({
      notifications: await Notification.requestPermission(),
      midi: await navigator.requestMIDIAccess({ sysex: true }).then(
        () => "granted",
        () => "denied",
      ),
    }));
    expect(asked).toEqual({ notifications: "granted", midi: "denied" });
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

  /** Hold back the supervisor's answer, as a slow machine does, until the file exists. */
  function holdSupervisor(userData: string): { stub: string; answer: () => void } {
    const release = path.join(userData, "answer-now");
    const stub = path.join(userData, "hold.cjs");
    fs.writeFileSync(stub, `const real = fetch; globalThis.fetch = async (...args) => { while (!require("fs").existsSync(${JSON.stringify(release)})) await new Promise((r) => setTimeout(r, 100)); return real(...args); };`);
    return { stub, answer: () => fs.writeFileSync(release, "") };
  }

  const errorStub = (userData: string): { stub: string; shown: string } => {
    const shown = path.join(userData, "shown.json");
    const stub = path.join(userData, "errors.cjs");
    fs.writeFileSync(stub, `require("electron").dialog.showErrorBox = (title, text) => require("fs").writeFileSync(${JSON.stringify(shown)}, JSON.stringify({ title, text }));`);
    return { stub, shown };
  };

  const fileMenu = () =>
    app!.evaluate(({ Menu }) => {
      const items = Menu.getApplicationMenu()!.items.find((i) => i.label === "File")!.submenu!.items;
      return { open: items.find((i) => i.label === "Open Project…")!.enabled, recent: items.find((i) => i.label === "Open Recent")!.enabled };
    });

  it.skipIf(!!installed)("shows its window at once, and says what it is waiting for", async () => {
    const { userData, one, two } = folders("starting");
    rememberProject(projectsOf(userData), two);
    const { stub, answer } = holdSupervisor(userData);
    const page = await launch(userData, { PI_FLEET_PROJECT: one }, ["-r", stub]);
    await step("the starting page", page.locator("#starting").getByText("project-one").waitFor({ timeout: 0 }));
    expect(await app!.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].isVisible())).toBe(true);
    expect(await title()).not.toContain("project-one"); // that says it is ready

    expect(await fileMenu()).toEqual({ open: false, recent: false });
    await openRecent(two); // a second start now would kill the first
    await new Promise((resolve) => setTimeout(resolve, 1000));
    expect(fs.existsSync(path.join(two, ".pi-fleet"))).toBe(false);

    answer();
    await step("the fleet's page", page.waitForSelector("#conversation", { timeout: 0 }));
    await until("the title", async () => (await title()).includes("project-one"), 60000);
    expect(await fileMenu()).toEqual({ open: true, recent: true });
  }, 120000);

  it.skipIf(!!installed)("says which project is starting while it moves to another", async () => {
    const { userData, one, two } = folders("starting-switch");
    const { stub, answer } = holdSupervisor(userData);
    rememberProject(projectsOf(userData), two);
    fs.writeFileSync(path.join(userData, "answer-now"), ""); // the first project opens as usual
    const page = await launch(userData, { PI_FLEET_PROJECT: one }, ["-r", stub]);
    await step("the first project", page.waitForSelector("#conversation", { timeout: 0 }));
    await until("the title", async () => (await title()).includes("project-one"), 60000);
    fs.rmSync(path.join(userData, "answer-now"));
    await openRecent(two);
    await step("the starting page", page.locator("#starting").getByText("project-two").waitFor({ timeout: 0 }));
    expect(await title()).not.toContain("project-one");
    answer();
    await step("the second project", page.waitForSelector("#conversation", { timeout: 0 }));
    await until("the title", async () => (await title()).includes("project-two"), 60000);
  }, 120000);

  it.skipIf(!!installed)("can be closed while it starts, with no error and nothing left running", async () => {
    const { userData, one } = folders("closed-while-starting");
    const { stub: hold } = holdSupervisor(userData);
    const { stub, shown } = errorStub(userData);
    const page = await launch(userData, { PI_FLEET_PROJECT: one }, ["-r", stub, "-r", hold]);
    await step("the starting page", page.locator("#starting").waitFor({ timeout: 0 }));
    const fleet = new Hub(path.join(one, ".pi-fleet"));
    await until("the supervisor", () => fleet.supervisorAlive(), 60000);
    const pid = fleet.otherSupervisor()!;
    const gone = new Promise((resolve) => app!.process().once("exit", resolve));
    await app!.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].close());
    if (process.platform !== "darwin") {
      await step("the app to leave", gone, 30000); // a Mac app stays open, to be reopened from the Dock
      app = undefined;
    }
    await until("the supervisor to go with it", () => !isPidAlive(pid), 15000);
    expect(fs.existsSync(shown)).toBe(false);
  }, 120000);

  it.skipIf(!!installed)("starts no fleet once its window has closed, even if the app stays open", async () => {
    const { userData, one } = folders("closed-first");
    const stub = path.join(userData, "stays-open.cjs"); // as on a Mac, and with the proxy slow to answer
    fs.writeFileSync(stub, `const { app, session } = require("electron"); app.quit = () => {}; app.whenReady().then(() => { session.defaultSession.forceReloadProxyConfig = () => new Promise((r) => setTimeout(r, 1500)); });`);
    const { stub: errors, shown } = errorStub(userData);
    const page = await launch(userData, { PI_FLEET_PROJECT: one }, ["-r", stub, "-r", errors]);
    let desktopLog = "";
    app!.process().stdout?.on("data", (d) => (desktopLog += d));
    await step("the starting page", page.locator("#starting").waitFor({ timeout: 0 }));
    await app!.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].close());
    await new Promise((resolve) => setTimeout(resolve, 3000));
    expect(desktopLog).not.toContain("[desktop] proxy:"); // the line before the supervisor starts
    expect(fs.existsSync(shown)).toBe(false); // the person left: that is no failure
    await app!.evaluate(({ app: electronApp }) => electronApp.exit(0)).catch(() => {});
    app = undefined;
  }, 120000);

  it.skipIf(!!installed)("closes the window when a project fails and there is none to go back to", async () => {
    const { userData, one, two } = folders("nothing-behind");
    fs.mkdirSync(path.join(two, ".pi-fleet"));
    fs.writeFileSync(path.join(two, ".pi-fleet", "fleet.json"), "{ broken");
    rememberProject(projectsOf(userData), two);
    const { stub, shown } = errorStub(userData);
    const stays = path.join(userData, "stays-open.cjs");
    fs.writeFileSync(stays, `require("electron").app.quit = () => {};`);
    const page = await launch(userData, { PI_FLEET_PROJECT: one }, ["-r", stub, "-r", stays]);
    await step("the project", page.waitForSelector("#conversation", { timeout: 0 }));
    await until("the title", async () => (await title()).includes("project-one"), 60000);
    await app!.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].close());
    await until("the fleet to stop", () => !new Hub(path.join(one, ".pi-fleet")).supervisorAlive(), 30000);
    await openRecent(two);
    await until("the error", () => fs.existsSync(shown), 60000);
    await until("no window left", () => app!.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().length === 0), 10000);
    await app!.evaluate(({ app: electronApp }) => electronApp.exit(0)).catch(() => {});
    app = undefined;
  }, 120000);

  it.skipIf(!!installed)("gives up with a message when the way back fails too", async () => {
    const { userData, one, two } = folders("no-way-back");
    fs.mkdirSync(path.join(two, ".pi-fleet"));
    fs.writeFileSync(path.join(two, ".pi-fleet", "fleet.json"), "{ broken");
    rememberProject(projectsOf(userData), two);
    const { stub, shown } = errorStub(userData);
    await launch(userData, { PI_FLEET_PROJECT: one }, ["-r", stub]);
    await until("the first project", async () => (await title()).includes("project-one"), 60000);
    fs.writeFileSync(path.join(one, ".pi-fleet", "fleet.json"), "{ broken too");
    await openRecent(two);
    await until("the last word", () => fs.existsSync(shown) && JSON.parse(fs.readFileSync(shown, "utf8")).title.includes("could not start"), 60000);
  }, 120000);

  it.skipIf(!!installed)("says what went wrong when the first project cannot start", async () => {
    const { userData, two } = folders("bad-start");
    fs.mkdirSync(path.join(two, ".pi-fleet"));
    fs.writeFileSync(path.join(two, ".pi-fleet", "fleet.json"), "{ broken");
    rememberProject(projectsOf(userData), two);
    const { stub, shown } = errorStub(userData);
    await launch(userData, { PI_FLEET_PROJECT: two }, ["-r", stub]);
    await until("the error", () => fs.existsSync(shown), 60000);
    expect(JSON.parse(fs.readFileSync(shown, "utf8")).title).toContain("could not start");
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
