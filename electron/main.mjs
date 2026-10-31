/**
 * pi-fleet desktop app (Electron).
 *
 * The main process launches the fleet supervisor (`fleet up --gui`) as a child
 * process and loads its web UI into a native BrowserWindow. The fleet composition
 * comes from <root>/.pi-fleet/fleet.json (see `fleet init`), so the app knows what
 * to spawn without a long CLI. Closing the window kills the supervisor's process
 * tree (supervisor -> bridges -> pi).
 *
 * Run with: npm run desktop
 */
import { app, BrowserWindow, dialog, shell } from "electron";
import { spawn, execSync } from "node:child_process";
import crypto from "node:crypto";
import net from "node:net";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, "..");
const HUB_DIR = path.join(ROOT, ".pi-fleet");
const TSX_CLI = path.join(ROOT, "node_modules", "tsx", "dist", "cli.mjs");
const FLEET = path.join(ROOT, "src", "fleet.ts");
const GUI_TOKEN = crypto.randomBytes(24).toString("base64url");

let supervisor = null;
let supervisorOutput = "";
let mainWindow = null;

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

async function startSupervisor() {
  const port = await findFreePort();
  supervisor = spawn(
    "node",
    [TSX_CLI, FLEET, "up", "--gui", "--port", String(port), "--dir", HUB_DIR],
    { cwd: ROOT, stdio: ["ignore", "pipe", "pipe"], env: { ...process.env, PI_FLEET_GUI_TOKEN: GUI_TOKEN } },
  );
  const tag = (s) => String(s).split("\n").map((l) => `[supervisor] ${l}`).join("\n");
  supervisor.stdout.on("data", (d) => process.stdout.write(tag(d)));
  supervisor.stderr.on("data", (d) => {
    process.stderr.write(tag(d));
    supervisorOutput = (supervisorOutput + d).slice(-2000);
  });
  supervisor.on("exit", (code) => {
    console.log(`[desktop] supervisor exited (${code})`);
    if (mainWindow && !mainWindow.isDestroyed()) app.quit();
  });
  // it can die before the page ever answers: the wait below must not outlast it
  const exited = new Promise((_, reject) => {
    supervisor.once("error", (e) => reject(new Error(`could not start the supervisor: ${e.message}`)));
    supervisor.once("exit", (code) => reject(new Error(supervisorOutput.trim() || `the supervisor exited (${code})`)));
  });
  return { url: `http://127.0.0.1:${port}/?token=${GUI_TOKEN}`, exited };
}

function stopSupervisor() {
  if (!supervisor) return;
  const pid = supervisor.pid;
  try {
    if (process.platform === "win32") execSync(`taskkill /PID ${pid} /T /F`, { stdio: "ignore" });
    else process.kill(pid, "SIGTERM");
  } catch {
    // already gone
  }
  supervisor = null;
}

async function createWindow() {
  const { url, exited } = await startSupervisor();
  await Promise.race([waitForHttp(url), exited]);
  exited.catch(() => {}); // from here on, the exit handler above deals with it
  mainWindow = new BrowserWindow({
    width: 1320,
    height: 840,
    title: "pi-fleet",
    backgroundColor: "#0d1117",
    webPreferences: { contextIsolation: true, nodeIntegration: false },
  });
  await mainWindow.loadURL(url);
  // open external links in the system browser, not new Electron windows
  mainWindow.webContents.setWindowOpenHandler(({ url: u }) => {
    if (u.startsWith("http")) shell.openExternal(u);
    return { action: "deny" };
  });
  mainWindow.on("closed", () => (mainWindow = null));
}

app.whenReady().then(() => {
  createWindow().catch((e) => {
    console.error("[desktop] failed to start:", e.message);
    stopSupervisor();
    dialog.showErrorBox("pi-fleet could not start", e.message);
    app.quit();
  });
  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow().catch(console.error);
  });
});

app.on("window-all-closed", () => {
  stopSupervisor();
  if (process.platform !== "darwin") app.quit();
});