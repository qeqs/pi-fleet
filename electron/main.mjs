/**
 * pi-fleet desktop app (Electron).
 *
 * The main process launches the fleet supervisor (`fleet up --gui`) as a child
 * process and loads its web UI into a native BrowserWindow. Electron's own Node runs
 * the supervisor, so an installed app needs no Node on the machine. Each project
 * folder has its own fleet in <folder>/.pi-fleet (see `fleet init`), so the app knows
 * what to spawn without a long CLI, and File > Open Project moves between them.
 * Closing the window kills the supervisor's process tree (supervisor -> bridges -> pi).
 *
 * Run with: npm run desktop
 */
import { app, BrowserWindow, dialog, Menu, session, shell } from "electron";
import { spawn, execFileSync } from "node:child_process";
import crypto from "node:crypto";
import net from "node:net";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { needsTrust, readProjects, rememberProject, startingProject } from "./projects.mjs";
import { proxyEnv } from "./proxy.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, "..");
const TSX_CLI = path.join(ROOT, "node_modules", "tsx", "dist", "cli.mjs");
const FLEET = path.join(ROOT, "src", "fleet.ts");
const GUI_TOKEN = crypto.randomBytes(24).toString("base64url");
const STOP_WAIT_MS = 10000;

let supervisor = null;
let supervisorUp = false; // once it has served the page, losing it ends the app
let supervisorOutput = "";
let quitting = false;
let mainWindow = null;
let project = null;

const projectsFile = () => path.join(app.getPath("userData"), "projects.json");

/** Find a free TCP port on localhost. */
function findFreePort() {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.once("error", reject);
    srv.listen(0, "127.0.0.1", () => {
      const port = srv.address().port;
      srv.close(() => resolve(port));
    });
  });
}

/** Poll a URL until it responds (the supervisor is booting). */
function waitForHttp(url, timeoutMs = 90000) {
  const start = Date.now();
  return new Promise((resolve, reject) => {
    (function attempt() {
      fetch(url)
        .then(() => resolve())
        .catch(() => {
          if (Date.now() - start > timeoutMs) reject(new Error(`supervisor did not come up at ${url}`));
          else setTimeout(attempt, 500);
        });
    })();
  });
}

/** What the system would use for the web. Asked afresh, since a new app may not have read it yet. */
async function systemProxy() {
  try {
    await session.defaultSession.forceReloadProxyConfig();
    return await session.defaultSession.resolveProxy("https://example.com");
  } catch {
    return "DIRECT";
  }
}

async function startSupervisor(dir) {
  const port = await findFreePort();
  const proxy = proxyEnv(process.env, await systemProxy());
  console.log(`[desktop] proxy: ${proxy.HTTPS_PROXY ?? "none"}`);
  supervisorOutput = "";
  supervisorUp = false;
  const child = spawn(
    process.execPath,
    [TSX_CLI, FLEET, "up", "--gui", "--port", String(port), "--dir", path.join(dir, ".pi-fleet")],
    { cwd: dir, stdio: ["ignore", "pipe", "pipe"], env: { ...process.env, ...proxy, ELECTRON_RUN_AS_NODE: "1", PI_FLEET_GUI_TOKEN: GUI_TOKEN } },
  );
  supervisor = child;
  const tag = (s) => String(s).split("\n").map((l) => `[supervisor] ${l}`).join("\n");
  child.stdout.on("data", (d) => process.stdout.write(tag(d)));
  child.stderr.on("data", (d) => {
    process.stderr.write(tag(d));
    supervisorOutput = (supervisorOutput + d).slice(-2000);
  });
  child.on("exit", (code) => {
    console.log(`[desktop] supervisor exited (${code})`);
    if (child === supervisor && supervisorUp && mainWindow && !mainWindow.isDestroyed()) app.quit();
  });
  // it can die before the page ever answers: the wait below must not outlast it
  const exited = new Promise((_, reject) => {
    child.once("error", (e) => reject(new Error(`could not start the supervisor: ${e.message}`)));
    child.once("exit", (code) => reject(new Error(supervisorOutput.trim() || `the supervisor exited (${code})`)));
  });
  return { url: `http://127.0.0.1:${port}/?token=${GUI_TOKEN}`, exited };
}

/** Stop the fleet and wait for it, since its agents stop with it. */
function stopSupervisor() {
  const child = supervisor;
  if (!child || child.exitCode !== null) return Promise.resolve();
  const { pid } = child;
  supervisor = null;
  const gone = new Promise((resolve) => {
    child.once("exit", resolve);
    setTimeout(resolve, STOP_WAIT_MS);
  });
  try {
    // by full path: a bare name would also find a taskkill in the project folder
    if (process.platform === "win32") execFileSync(path.join(process.env.SystemRoot ?? "C:\\Windows", "System32", "taskkill.exe"), ["/PID", String(pid), "/T", "/F"], { stdio: "ignore" });
    else process.kill(pid, "SIGTERM");
  } catch {
    // already gone
  }
  return gone;
}

function buildMenu() {
  const recent = readProjects(projectsFile());
  const file = {
    label: "File",
    submenu: [
      { label: "Open Project…", accelerator: "CmdOrCtrl+O", click: () => chooseAndOpen() },
      { label: "Open Recent", enabled: recent.length > 0, submenu: recent.map((dir) => ({ label: dir, click: () => switchTo(dir) })) },
      { type: "separator" },
      { role: process.platform === "darwin" ? "close" : "quit" },
    ],
  };
  const app = process.platform === "darwin" ? [{ role: "appMenu" }] : [];
  Menu.setApplicationMenu(Menu.buildFromTemplate([...app, file, { role: "editMenu" }, { role: "viewMenu" }, { role: "windowMenu" }]));
}

async function chooseProject() {
  const { canceled, filePaths } = await dialog.showOpenDialog({
    title: "Choose the folder your agents will work in",
    buttonLabel: "Open Project",
    properties: ["openDirectory", "createDirectory"],
  });
  return canceled ? null : filePaths[0];
}

/** Opening a folder starts its agents, so one that brings its own setup is the person's call. */
async function trusted(dir) {
  if (!needsTrust(projectsFile(), dir)) return true;
  const { response } = await dialog.showMessageBox({
    type: "warning",
    title: "Open this folder?",
    message: `Do you trust ${dir}?`,
    detail: "This folder has its own fleet or pi configuration. Opening it starts its agents and runs any code that configuration names.",
    buttons: ["Open", "Cancel"],
    defaultId: 1,
    cancelId: 1,
  });
  return response === 0;
}

async function chooseAndOpen() {
  const dir = await chooseProject();
  if (dir) await switchTo(dir);
}

/** Start a project's fleet and show it. Whatever was open has already been stopped. */
async function openProject(dir) {
  const { url, exited } = await startSupervisor(dir);
  await Promise.race([waitForHttp(url), exited]);
  exited.catch(() => {}); // from here on, the exit handler above deals with it
  supervisorUp = true;
  project = dir;
  rememberProject(projectsFile(), dir);
  buildMenu();
  if (!mainWindow) createWindow();
  await mainWindow.loadURL(url);
}

async function switchTo(dir) {
  if (dir === project || !(await trusted(dir))) return;
  const previous = project;
  await stopSupervisor();
  try {
    await openProject(dir);
  } catch (e) {
    await stopSupervisor();
    if (quitting) return;
    dialog.showErrorBox(`pi-fleet could not open ${dir}`, e.message);
    if (previous) await openProject(previous);
  }
}

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1320,
    height: 840,
    title: "pi-fleet",
    backgroundColor: "#0d1117",
    webPreferences: { contextIsolation: true, nodeIntegration: false },
  });
  // the page's title carries unread counts: keep those, and say which project this is
  mainWindow.on("page-title-updated", (e, title) => {
    e.preventDefault();
    mainWindow.setTitle(`${title} — ${path.basename(project)}`);
  });
  // open external links in the system browser, not new Electron windows
  const openOutside = (u) => {
    if (/^https?:\/\//.test(u)) shell.openExternal(u);
  };
  mainWindow.webContents.setWindowOpenHandler(({ url: u }) => {
    openOutside(u);
    return { action: "deny" };
  });
  // and this window only ever shows the fleet's own page
  mainWindow.webContents.on("will-navigate", (e, u) => {
    if (new URL(u).hostname === "127.0.0.1") return;
    e.preventDefault();
    openOutside(u);
  });
  mainWindow.on("closed", () => (mainWindow = null));
}

async function launch() {
  buildMenu();
  const dir = process.env.PI_FLEET_PROJECT ?? startingProject(projectsFile()) ?? (await chooseProject());
  if (!dir || !(await trusted(dir))) return app.quit();
  await openProject(dir);
}

// a second copy would find the same project and be refused a second fleet on it
const firstCopy = app.requestSingleInstanceLock();
if (!firstCopy) app.quit();
app.on("second-instance", () => {
  if (!mainWindow) return;
  if (mainWindow.isMinimized()) mainWindow.restore();
  mainWindow.focus();
});

app.whenReady().then(() => {
  if (!firstCopy) return;
  // the page asks for nothing but notifications
  session.defaultSession.setPermissionRequestHandler((_contents, permission, allow) => allow(permission === "notifications"));
  launch().catch((e) => {
    console.error("[desktop] failed to start:", e.message);
    stopSupervisor();
    if (quitting) return; // a page that was still loading fails as the app goes
    dialog.showErrorBox("pi-fleet could not start", e.message);
    app.quit();
  });
  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) launch().catch(console.error);
  });
});

app.on("window-all-closed", async () => {
  await stopSupervisor();
  project = null;
  if (process.platform !== "darwin") app.quit();
});

app.on("before-quit", () => (quitting = true));
// app.quit() closes the windows without the event above
app.on("will-quit", (e) => {
  if (!supervisor) return;
  e.preventDefault();
  stopSupervisor().finally(() => app.quit());
});
