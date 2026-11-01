/**
 * Minimal pi RPC client — spawns `pi --mode rpc` as a child process and
 * speaks JSONL over stdin/stdout. See pi docs: rpc.md / rpc-commands.md.
 */
import { spawn, type ChildProcess } from "node:child_process";
import { killProcessTree } from "./programs.ts";
import fs from "node:fs";
import net from "node:net";
import path from "node:path";

type Record_ = Record<string, unknown>;

interface Pending {
  resolve: (r: Record_) => void;
  reject: (e: Error) => void;
}

/** How pi treats a prompt that arrives mid-run; without one it refuses the prompt. */
export type StreamingBehavior = "steer" | "followUp";

/**
 * The argv that runs a CLI from pi-fleet's own dependencies. It goes straight to
 * node because npm's .cmd shims need cmd.exe: node refuses to spawn them without
 * a shell (EINVAL), and a shell would re-parse every argument (agent names,
 * paths, model ids).
 */
export function packageBinArgv(root: string, pkgName: string, bin: string): string[] {
  const pkgDir = packageDir(root, pkgName);
  const pkg = JSON.parse(fs.readFileSync(path.join(pkgDir, "package.json"), "utf8")) as { bin: string | Record<string, string> };
  return [process.execPath, path.join(pkgDir, typeof pkg.bin === "string" ? pkg.bin : pkg.bin[bin])];
}

/** Find a dependency, which npm may have hoisted above pi-fleet's own folder. */
function packageDir(root: string, pkgName: string): string {
  for (let dir = root; ; dir = path.dirname(dir)) {
    const candidate = path.join(dir, "node_modules", ...pkgName.split("/"));
    if (fs.existsSync(path.join(candidate, "package.json"))) return candidate;
    if (dir === path.dirname(dir)) throw new Error(`${pkgName} is not installed: reinstall pi-fleet`);
  }
}

export function piArgv(root: string, args: string[]): string[] {
  return [...packageBinArgv(root, "@earendil-works/pi-coding-agent", "pi"), ...args];
}

/**
 * True if a bridge is listening on this pipe. Registry pids can outlive their
 * process and get reused, so only the pipe proves an entry is still our agent.
 */
export function bridgeListening(pipe: string, timeoutMs = 1000): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = net.connect(pipe);
    const done = (listening: boolean) => {
      socket.destroy();
      resolve(listening);
    };
    socket.once("connect", () => done(true));
    socket.once("error", () => done(false));
    socket.setTimeout(timeoutMs, () => done(false));
  });
}

export class PiRpc {
  private proc: ChildProcess;
  private buffer = "";
  private pending = new Map<string, Pending>();
  private idCounter = 0;
  private exited = false;
  onEvent: (rec: Record_) => void = () => {};
  onExit: (code: number | null) => void = () => {};
  private timeoutMs: number;

  constructor(argv: string[], opts: { cwd: string; env: NodeJS.ProcessEnv; logFile: string; timeoutMs?: number }) {
    this.timeoutMs = opts.timeoutMs ?? 30000;
    const logFd = fs.openSync(opts.logFile, "a");
    this.proc = spawn(argv[0], argv.slice(1), {
      cwd: opts.cwd,
      env: opts.env,
      stdio: ["pipe", "pipe", "pipe"],
      windowsHide: true,
    });
    this.proc.stdout!.on("data", (chunk: Buffer) => this.onData(chunk));
    this.proc.stderr!.on("data", (chunk: Buffer) => fs.writeSync(logFd, chunk));
    this.proc.stdin!.on("error", () => {}); // ignore EPIPE on shutdown
    this.proc.on("close", () => fs.closeSync(logFd)); // once its output has drained
    this.proc.on("exit", (code) => {
      this.exited = true;
      for (const p of this.pending.values()) p.reject(new Error(`pi process exited (${code})`));
      this.pending.clear();
      this.onExit(code);
    });
  }

  get pid(): number {
    return this.proc.pid ?? 0;
  }

  get alive(): boolean {
    return !this.exited;
  }

  private onData(chunk: Buffer) {
    this.buffer += chunk.toString("utf8");
    let idx: number;
    while ((idx = this.buffer.indexOf("\n")) >= 0) {
      const line = this.buffer.slice(0, idx).replace(/\r$/, "");
      this.buffer = this.buffer.slice(idx + 1);
      if (!line.trim()) continue;
      let rec: Record_;
      try {
        rec = JSON.parse(line) as Record_;
      } catch {
        continue;
      }
      if (rec.type === "response" && typeof rec.id === "string" && this.pending.has(rec.id)) {
        const p = this.pending.get(rec.id)!;
        this.pending.delete(rec.id);
        p.resolve(rec);
      } else {
        this.onEvent(rec);
      }
    }
  }

  private send(cmd: Record_): Promise<Record_> {
    const id = `fleet-${++this.idCounter}`;
    const line = JSON.stringify({ ...cmd, id }) + "\n";
    return new Promise((resolve, reject) => {
      if (this.exited) {
        reject(new Error("pi process already exited"));
        return;
      }
      this.pending.set(id, { resolve, reject });
      this.proc.stdin!.write(line, "utf8");
      setTimeout(() => {
        if (this.pending.has(id)) {
          this.pending.delete(id);
          reject(new Error(`RPC timeout: ${cmd.type}`));
        }
      }, this.timeoutMs).unref(); // a pending request is no reason to keep a finished command alive
    });
  }

  prompt(message: string, streamingBehavior?: StreamingBehavior): Promise<Record_> {
    return this.send({ type: "prompt", message, streamingBehavior });
  }

  getState(): Promise<Record_> {
    return this.send({ type: "get_state" });
  }

  getStats(): Promise<Record_> {
    return this.send({ type: "get_session_stats" });
  }

  setSessionName(name: string): Promise<Record_> {
    return this.send({ type: "set_session_name", name });
  }

  sendCommand(cmd: Record_): Promise<Record_> {
    return this.send(cmd);
  }

  /** Orderly shutdown: close stdin, then kill the process tree if needed. */
  async close(): Promise<void> {
    if (this.exited) return;
    this.proc.stdin!.end();
    await new Promise((r) => setTimeout(r, 1500));
    if (!this.exited) {
      if (process.platform === "win32" && this.pid) {
        killProcessTree(this.pid); // pi may have spawned tools of its own
      } else {
        try {
          this.proc.kill();
        } catch {
          // ignore
        }
      }
      await new Promise((r) => setTimeout(r, 500));
      if (!this.exited) {
        try {
          this.proc.kill("SIGKILL");
        } catch {
          // ignore
        }
      }
    }
  }
}

/**
 * Client that talks to a pi-fleet bridge over its named pipes (JSONL). Same
 * interface as PiRpc, but the transport is the bridge's IN/OUT pipes instead of
 * a child-process pipe — so the supervisor can detach and re-attach (the bridge
 * keeps pi alive). `pid` is the bridge's pid (kill it with taskkill /T to stop
 * the agent).
 */
export class PiRpcBridge {
  private inSocket: net.Socket;
  private outSocket: net.Socket;
  private buffer = "";
  private pending = new Map<string, Pending>();
  private idCounter = 0;
  private exited = false;
  onEvent: (rec: Record_) => void = () => {};
  onExit: (code: number | null) => void = () => {};
  private timeoutMs: number;
  private bridgePid: number;

  private constructor(inSocket: net.Socket, outSocket: net.Socket, bridgePid: number, timeoutMs: number) {
    this.inSocket = inSocket;
    this.outSocket = outSocket;
    this.bridgePid = bridgePid;
    this.timeoutMs = timeoutMs;
    this.outSocket.on("data", (chunk: Buffer) => this.onData(chunk));
    this.outSocket.on("close", () => this.onPipeClose());
    this.outSocket.on("error", () => {});
    this.inSocket.on("error", () => {});
  }

  /** Connect to a running bridge's pipes (retries while the bridge starts up). */
  static async connect(pipeIn: string, pipeOut: string, bridgePid: number, timeoutMs = 30000): Promise<PiRpcBridge> {
    const inSocket = await connectWithRetry(pipeIn);
    const outSocket = await connectWithRetry(pipeOut);
    return new PiRpcBridge(inSocket, outSocket, bridgePid, timeoutMs);
  }

  get pid(): number {
    return this.bridgePid;
  }

  get alive(): boolean {
    return !this.exited;
  }

  private onPipeClose() {
    if (this.exited) return;
    this.exited = true;
    for (const p of this.pending.values()) p.reject(new Error("bridge pipe closed"));
    this.pending.clear();
    this.onExit(null);
  }

  private onData(chunk: Buffer) {
    this.buffer += chunk.toString("utf8");
    let idx: number;
    while ((idx = this.buffer.indexOf("\n")) >= 0) {
      const line = this.buffer.slice(0, idx).replace(/\r$/, "");
      this.buffer = this.buffer.slice(idx + 1);
      if (!line.trim()) continue;
      let rec: Record_;
      try {
        rec = JSON.parse(line) as Record_;
      } catch {
        continue;
      }
      if (rec.type === "response" && typeof rec.id === "string" && this.pending.has(rec.id)) {
        const p = this.pending.get(rec.id)!;
        this.pending.delete(rec.id);
        p.resolve(rec);
      } else {
        this.onEvent(rec);
      }
    }
  }

  private send(cmd: Record_): Promise<Record_> {
    const id = `fleet-${++this.idCounter}`;
    const line = JSON.stringify({ ...cmd, id }) + "\n";
    return new Promise((resolve, reject) => {
      if (this.exited) {
        reject(new Error("bridge already closed"));
        return;
      }
      this.pending.set(id, { resolve, reject });
      this.inSocket.write(line, "utf8");
      setTimeout(() => {
        if (this.pending.has(id)) {
          this.pending.delete(id);
          reject(new Error(`RPC timeout: ${cmd.type}`));
        }
      }, this.timeoutMs).unref(); // a pending request is no reason to keep a finished command alive
    });
  }

  prompt(message: string, streamingBehavior?: StreamingBehavior): Promise<Record_> {
    return this.send({ type: "prompt", message, streamingBehavior });
  }

  getState(): Promise<Record_> {
    return this.send({ type: "get_state" });
  }

  getStats(): Promise<Record_> {
    return this.send({ type: "get_session_stats" });
  }

  setSessionName(name: string): Promise<Record_> {
    return this.send({ type: "set_session_name", name });
  }

  /** Send an arbitrary RPC command (used by the GUI proxy for whitelisted commands). */
  sendCommand(cmd: Record_): Promise<Record_> {
    return this.send(cmd);
  }

  /** Write a line that gets no response, such as an answer to one of pi's questions. */
  write(rec: Record_): void {
    if (!this.exited) this.inSocket.write(JSON.stringify(rec) + "\n", "utf8");
  }

  /** Disconnect from the pipes. Does NOT kill the bridge (it may keep running). */
  close(): void {
    if (this.exited) return;
    // destroy() (not end()) so short-lived clients (e.g. `fleet rename`) release
    // the event loop and exit; the bridge keeps running for the supervisor.
    try {
      this.inSocket.destroy();
    } catch {
      // ignore
    }
    try {
      this.outSocket.destroy();
    } catch {
      // ignore
    }
  }
}

async function connectWithRetry(pipe: string, retries = 60, delayMs = 100): Promise<net.Socket> {
  let lastErr: Error | undefined;
  for (let i = 0; i < retries; i++) {
    try {
      return await new Promise<net.Socket>((resolve, reject) => {
        const s = net.connect(pipe, () => resolve(s));
        s.once("error", (e) => reject(e));
      });
    } catch (e) {
      lastErr = e as Error;
      await new Promise((r) => setTimeout(r, delayMs));
    }
  }
  throw new Error(`could not connect to pipe ${pipe}: ${lastErr?.message}`);
}