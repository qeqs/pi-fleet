/**
 * pi-fleet bridge: a small persistent process that owns a `pi --mode rpc` child
 * and exposes it over named pipes so the supervisor can attach, detach, and
 * re-attach. The bridge is the parent of pi, so killing the bridge (taskkill /T)
 * takes pi down with it. The bridge survives the supervisor exiting, which is
 * what makes detached mode + auto-resume possible.
 *
 * Env:
 *   PI_FLEET_PIPE_IN   named pipe path: supervisor -> pi stdin
 *   PI_FLEET_PIPE_OUT  named pipe path: pi stdout -> supervisor
 *   PI_FLEET_ARGV      JSON array: the program and arguments to spawn (no shell)
 *   PI_FLEET_CWD       cwd for pi
 *   PI_FLEET_LOG       stderr log file
 *   PI_FLEET_OWNER_PID optional: exit when this process dies. Bridges outlive the
 *                      supervisor on purpose, so a killed test run would leak agents.
 *
 * PI_FLEET_DIR / PI_FLEET_AGENT / PI_FLEET_ROOT / PI_FLEET_ROLE / PI_FLEET_LEAN
 * are passed through to pi via process.env.
 */
import net from "node:net";
import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

const pipeIn = process.env.PI_FLEET_PIPE_IN!;
const pipeOut = process.env.PI_FLEET_PIPE_OUT!;
const argv = JSON.parse(process.env.PI_FLEET_ARGV ?? "[]") as string[];
const cwd = process.env.PI_FLEET_CWD!;
const logFile = process.env.PI_FLEET_LOG!;

if (!pipeIn || !pipeOut || argv.length === 0 || !cwd || !logFile) {
  console.error("bridge: missing env (PI_FLEET_PIPE_IN/OUT, PI_FLEET_ARGV, PI_FLEET_CWD, PI_FLEET_LOG)");
  process.exit(2);
}

fs.mkdirSync(path.dirname(logFile), { recursive: true });
const logFd = fs.openSync(logFile, "a");
const note = (s: string) => fs.writeSync(logFd, s.endsWith("\n") ? s : s + "\n");

const pi = spawn(argv[0], argv.slice(1), {
  cwd,
  env: process.env,
  stdio: ["pipe", "pipe", "pipe"],
  windowsHide: true,
});
pi.on("error", (e) => {
  note(`[bridge] could not start pi: ${e.message}`);
  process.exit(1);
});
pi.stderr!.on("data", (c: Buffer) => fs.writeSync(logFd, c));
pi.stdin!.on("error", () => {}); // ignore EPIPE on shutdown
note(`[bridge] started pi pid=${pi.pid} in=${pipeIn} out=${pipeOut}`);

// OUT: bridge (server) writes pi.stdout to every connected client (supervisor +
// ad-hoc clients like `fleet rename`). Multiple clients can read the event stream
// simultaneously; the first one to connect drains the pre-connection buffer.
let outBuf = "";
const outClients = new Set<net.Socket>();
const outServer = net.createServer((socket) => {
  if (outBuf) {
    socket.write(outBuf);
    outBuf = ""; // only the first client after a gap gets the backlog
  }
  outClients.add(socket);
  socket.on("close", () => outClients.delete(socket));
  socket.on("error", () => {});
});
outServer.on("error", (e) => note(`[bridge] out pipe error: ${e.message}`));
// A killed bridge leaves its Unix socket files behind, and they would block this listen.
// (A live bridge for this agent is ruled out before a new one is spawned.)
if (process.platform !== "win32") for (const pipe of [pipeIn, pipeOut]) fs.rmSync(pipe, { force: true });
outServer.listen(pipeOut, () => note(`[bridge] out pipe listening`));
pi.stdout!.on("data", (c: Buffer) => {
  const s = c.toString("utf8");
  if (outClients.size > 0) {
    for (const client of outClients) {
      if (!client.destroyed) client.write(s);
    }
  } else {
    outBuf += s; // buffer until a client (re)connects
    if (outBuf.length > 1024 * 1024) outBuf = outBuf.slice(-512 * 1024);
  }
});

// IN: supervisor (client) writes commands; bridge (server) forwards to pi.stdin.
// When the supervisor disconnects we do NOT end pi.stdin, so pi keeps running.
const inServer = net.createServer((socket) => {
  note("[bridge] supervisor attached (in)");
  socket.on("data", (c: Buffer) => {
    if (!pi.stdin.destroyed) pi.stdin.write(c);
  });
  socket.on("close", () => note("[bridge] supervisor detached (in)"));
  socket.on("error", () => {});
});
inServer.on("error", (e) => note(`[bridge] in pipe error: ${e.message}`));
inServer.listen(pipeIn, () => note(`[bridge] in pipe listening`));

pi.on("exit", (code) => {
  note(`[bridge] pi exited (${code})`);
  try {
    outServer.close();
    inServer.close();
  } catch {
    // ignore
  }
  process.exit(code ?? 0);
});

function shutdown() {
  try {
    pi.kill();
  } catch {
    // ignore
  }
  process.exit(0);
}
process.on("SIGTERM", shutdown);
process.on("SIGINT", shutdown);

const ownerPid = Number(process.env.PI_FLEET_OWNER_PID ?? 0);
if (ownerPid > 0) {
  setInterval(() => {
    try {
      process.kill(ownerPid, 0);
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === "ESRCH") shutdown();
    }
  }, 1000);
}