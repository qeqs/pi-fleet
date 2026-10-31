/**
 * pi-fleet GUI server — a minimal web UI that validates the RPC-event data flow.
 *
 * Serves a single HTML page (gui.html) and streams live data to the browser:
 *   - group chat messages (from the hub bus)
 *   - per-agent RPC events (tool calls, token streaming, run state)
 *   - agent status changes
 *
 * Transport: Server-Sent Events (server→client) over /events, and a plain
 * HTTP POST /message for client→server. No extra dependencies.
 */
import crypto from "node:crypto";
import http from "node:http";
import type { AddressInfo } from "node:net";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { AgentInfo, FleetMessage, ChannelConfig } from "./hub.ts";
import type { ExtensionInfo, McpConfig } from "./pi-resources.ts";
import type { Answer, Question } from "./questions.ts";

export interface GuiSnapshot {
  agents: AgentInfo[];
  messages: FleetMessage[];
  channels: ChannelConfig[];
  /** Why the fleet is paused, if it is. */
  paused?: string | null;
  /** How many agent messages the pause is holding back. */
  held?: number;
  /** Questions from agents that wait for an answer. */
  questions?: Question[];
  /** Last known session stats per agent. */
  stats?: Record<string, Record<string, unknown>>;
  /** Spending limit in dollars, if any. */
  maxCost?: number;
}

/** RPC commands the GUI may proxy to an agent (whitelist). */
const RPC_WHITELIST = new Set([
  "get_state",
  "get_messages",
  "get_entries",
  "get_session_stats",
  "get_available_models",
  "set_model",
  "cycle_model",
  "get_available_thinking_levels",
  "set_thinking_level",
  "cycle_thinking_level",
  "abort",
  "compact",
  "new_session",
  "set_session_name",
  "prompt",
]);

export interface NewAgentSpec {
  name: string;
  cwd?: string;
  model?: string;
  role?: string;
}

export interface GuiServerOptions {
  /** Port to bind (0 = pick a free one). Defaults to 0. */
  port?: number;
  /** Host/interface to bind. Defaults to 127.0.0.1 (local only); use 0.0.0.0 for LAN access. */
  host?: string;
  /** Secret every request must carry: the agents behind this server can run commands. */
  token: string;
  /** Current state, sent to a browser when it first connects. */
  getSnapshot: () => GuiSnapshot;
  /** Called when the browser posts a message (to="group" or an agent name). */
  onMessage: (msg: { to: string; text: string }) => void;
  /** Called when the browser asks to set an agent's pi session display name. */
  onSessionName?: (name: string, sessionName: string) => void | Promise<void>;
  /** Proxy a whitelisted RPC command to a running agent. */
  onRpc?: (agent: string, command: string, payload: Record<string, unknown>) => Promise<unknown>;
  /** List discoverable pi extensions + the per-agent selection. */
  getExtensions?: () => { available: ExtensionInfo[]; selected: Record<string, string[]> };
  /** Update the per-agent extension selection (persisted to fleet config). */
  setAgentExtensions?: (agent: string, extensions: string[]) => void;
  /** Read the user-level MCP config. */
  getMcp?: () => McpConfig;
  /** Write the user-level MCP config. */
  setMcp?: (cfg: McpConfig) => void;
  /** Spawn a new agent (the GUI "new chat" action). */
  spawnAgent?: (spec: NewAgentSpec) => Promise<void>;
  /** Abort every run and pause the fleet; resolves with the number of agents told to stop. */
  stopAll?: () => Promise<number>;
  /** Lift a pause and deliver what it held back; resolves with the number of messages. */
  resumeHeld?: () => number;
  /** Answer an agent's question. */
  answer?: (id: string, answer: Answer) => void;
  /** Change the spending limit. */
  setBudget?: (dollars: number) => void;
  /** List the channels (named group chats). */
  getChannels?: () => ChannelConfig[];
  /** Create or update a channel. */
  upsertChannel?: (channel: ChannelConfig) => void;
  /** Remove a channel (never the default "group"). */
  removeChannel?: (name: string) => void;
}

export class GuiServer {
  private server: http.Server | null = null;
  private clients = new Set<http.ServerResponse>();
  private port = 0;
  private host = "127.0.0.1";
  private html: string;

  constructor(private opts: GuiServerOptions) {
    const htmlPath = path.join(path.dirname(fileURLToPath(import.meta.url)), "gui.html");
    this.html = fs.readFileSync(htmlPath, "utf8");
  }

  async start(): Promise<number> {
    this.host = this.opts.host ?? "127.0.0.1";
    this.server = http.createServer((req, res) => this.handle(req, res));
    await new Promise<void>((resolve, reject) => {
      this.server!.once("error", reject);
      this.server!.listen(this.opts.port ?? 0, this.host, () => resolve());
    });
    this.port = (this.server.address() as AddressInfo).port;
    return this.port;
  }

  get url(): string {
    const displayHost = this.host === "0.0.0.0" ? "127.0.0.1" : this.host;
    return `http://${displayHost}:${this.port}/?token=${encodeURIComponent(this.opts.token)}`;
  }

  /** Push an event to every connected browser. */
  broadcast(type: string, data: unknown): void {
    if (this.clients.size === 0) return;
    const payload = `event: ${type}\ndata: ${JSON.stringify(data)}\n\n`;
    for (const res of this.clients) {
      try {
        res.write(payload);
      } catch {
        // client went away; cleaned up on 'close'
      }
    }
  }

  get clientCount(): number {
    return this.clients.size;
  }

  /** Cookies ignore ports, so each server needs its own name. */
  private get cookieName(): string {
    return `pi_fleet_${this.port}`;
  }

  private tokenMatches(candidate: string | undefined | null): boolean {
    if (!candidate) return false;
    const given = Buffer.from(candidate);
    const expected = Buffer.from(this.opts.token);
    return given.length === expected.length && crypto.timingSafeEqual(given, expected);
  }

  /** The token comes from the startup link (the page only), the page's cookie, or a Bearer header. */
  private authorized(req: http.IncomingMessage, linkToken: string | null): boolean {
    const auth = req.headers.authorization;
    const bearer = auth?.startsWith("Bearer ") ? auth.slice("Bearer ".length) : undefined;
    const cookie = (req.headers.cookie ?? "")
      .split(";")
      .map((c) => c.trim().split("="))
      .find(([k]) => k === this.cookieName)?.[1];
    return [linkToken, bearer, cookie].some((t) => this.tokenMatches(t));
  }

  /** Browsers send Origin on cross-site requests; those never get to act on the fleet. */
  private sameOrigin(req: http.IncomingMessage): boolean {
    const origin = req.headers.origin;
    if (!origin) return true;
    try {
      return new URL(origin).host === req.headers.host;
    } catch {
      return false; // "null" from sandboxed frames and file:// pages
    }
  }

  private servePage(res: http.ServerResponse): void {
    const nonce = crypto.randomBytes(16).toString("base64");
    res.writeHead(200, {
      "Content-Type": "text/html; charset=utf-8",
      "Cache-Control": "no-store",
      "Referrer-Policy": "no-referrer",
      "Set-Cookie": `${this.cookieName}=${this.opts.token}; HttpOnly; SameSite=Strict; Path=/; Max-Age=2592000`,
      "Content-Security-Policy":
        `default-src 'none'; script-src 'nonce-${nonce}'; style-src 'unsafe-inline'; connect-src 'self'; ` +
        `img-src 'self' data:; base-uri 'none'; form-action 'none'; frame-ancestors 'none'`,
    });
    res.end(this.html.replace("<script>", `<script nonce="${nonce}">`));
  }

  private handle(req: http.IncomingMessage, res: http.ServerResponse): void {
    const parsed = new URL(req.url ?? "/", "http://localhost");
    const url = parsed.pathname;
    if (!this.sameOrigin(req)) {
      res.writeHead(403, { "Content-Type": "text/plain" });
      res.end("cross-origin request refused");
      return;
    }
    const isPage = req.method === "GET" && (url === "/" || url === "/index.html");
    if (!this.authorized(req, isPage ? parsed.searchParams.get("token") : null)) {
      res.writeHead(401, { "Content-Type": "text/plain; charset=utf-8" });
      res.end("pi-fleet: access token required. Open the link printed when the fleet started, or find the token in <hub>/gui-token.\n");
      return;
    }
    if (isPage) {
      this.servePage(res);
      return;
    }
    if (req.method === "GET" && url === "/events") {
      res.writeHead(200, {
        "Content-Type": "text/event-stream",
        "Cache-Control": "no-cache",
        Connection: "keep-alive",
      });
      res.write("retry: 2000\n\n");
      // initial snapshot so a freshly-opened browser has context
      try {
        res.write(`event: snapshot\ndata: ${JSON.stringify(this.opts.getSnapshot())}\n\n`);
      } catch {
        // ignore
      }
      this.clients.add(res);
      req.on("close", () => this.clients.delete(res));
      return;
    }
    if (req.method === "POST" && url === "/message") {
      let body = "";
      req.on("data", (c) => (body += c));
      req.on("end", () => {
        try {
          const { to, text } = JSON.parse(body) as { to: string; text: string };
          if (typeof text === "string" && text.trim()) this.opts.onMessage({ to: to || "group", text: text.trim() });
          res.writeHead(200, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ ok: true }));
        } catch (e) {
          res.writeHead(400, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ ok: false, error: (e as Error).message }));
        }
      });
      return;
    }
    if (req.method === "POST" && url === "/session-name") {
      let body = "";
      req.on("data", (c) => (body += c));
      req.on("end", async () => {
        try {
          const { name, sessionName } = JSON.parse(body) as { name: string; sessionName: string };
          if (!name || !sessionName || !this.opts.onSessionName) {
            res.writeHead(400, { "Content-Type": "application/json" });
            res.end(JSON.stringify({ ok: false, error: "name and sessionName required" }));
            return;
          }
          await this.opts.onSessionName(name, sessionName);
          this.broadcast("session_name", { name, sessionName });
          res.writeHead(200, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ ok: true }));
        } catch (e) {
          res.writeHead(400, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ ok: false, error: String(e) }));
        }
      });
      return;
    }
    if (req.method === "POST" && url === "/rpc") {
      let body = "";
      req.on("data", (c) => (body += c));
      req.on("end", async () => {
        try {
          const { agent, command, payload } = JSON.parse(body) as {
            agent: string;
            command: string;
            payload?: Record<string, unknown>;
          };
          if (!agent || !command || !this.opts.onRpc) {
            res.writeHead(400, { "Content-Type": "application/json" });
            res.end(JSON.stringify({ ok: false, error: "agent and command required" }));
            return;
          }
          if (!RPC_WHITELIST.has(command)) {
            res.writeHead(400, { "Content-Type": "application/json" });
            res.end(JSON.stringify({ ok: false, error: `command not allowed: ${command}` }));
            return;
          }
          const result = await this.opts.onRpc(agent, command, payload ?? {});
          res.writeHead(200, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ ok: true, result }));
        } catch (e) {
          res.writeHead(500, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ ok: false, error: String(e) }));
        }
      });
      return;
    }
    if (req.method === "GET" && url === "/extensions") {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify(this.opts.getExtensions ? this.opts.getExtensions() : { available: [], selected: {} }));
      return;
    }
    if (req.method === "POST" && url === "/extensions") {
      let body = "";
      req.on("data", (c) => (body += c));
      req.on("end", () => {
        try {
          const { agent, extensions } = JSON.parse(body) as { agent: string; extensions: string[] };
          if (!agent || !Array.isArray(extensions) || !this.opts.setAgentExtensions) {
            res.writeHead(400, { "Content-Type": "application/json" });
            res.end(JSON.stringify({ ok: false, error: "agent and extensions[] required" }));
            return;
          }
          this.opts.setAgentExtensions(agent, extensions);
          this.broadcast("extensions", { agent, extensions });
          res.writeHead(200, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ ok: true }));
        } catch (e) {
          res.writeHead(400, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ ok: false, error: String(e) }));
        }
      });
      return;
    }
    if (req.method === "GET" && url === "/mcp") {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify(this.opts.getMcp ? this.opts.getMcp() : { mcpServers: {} }));
      return;
    }
    if (req.method === "POST" && url === "/mcp") {
      let body = "";
      req.on("data", (c) => (body += c));
      req.on("end", () => {
        try {
          const cfg = JSON.parse(body) as McpConfig;
          if (!cfg || typeof cfg.mcpServers !== "object" || !this.opts.setMcp) {
            res.writeHead(400, { "Content-Type": "application/json" });
            res.end(JSON.stringify({ ok: false, error: "mcpServers object required" }));
            return;
          }
          this.opts.setMcp(cfg);
          this.broadcast("mcp", cfg);
          res.writeHead(200, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ ok: true }));
        } catch (e) {
          res.writeHead(400, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ ok: false, error: String(e) }));
        }
      });
      return;
    }
    if (req.method === "POST" && url === "/agents") {
      let body = "";
      req.on("data", (c) => (body += c));
      req.on("end", async () => {
        try {
          const spec = JSON.parse(body) as NewAgentSpec;
          if (!spec || !spec.name || !this.opts.spawnAgent) {
            res.writeHead(400, { "Content-Type": "application/json" });
            res.end(JSON.stringify({ ok: false, error: "name required" }));
            return;
          }
          await this.opts.spawnAgent(spec);
          res.writeHead(200, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ ok: true }));
        } catch (e) {
          res.writeHead(500, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ ok: false, error: String(e) }));
        }
      });
      return;
    }
    if (req.method === "POST" && url === "/stop-all") {
      res.setHeader("Content-Type", "application/json");
      if (!this.opts.stopAll) {
        res.writeHead(400);
        res.end(JSON.stringify({ ok: false, error: "not available" }));
        return;
      }
      this.opts.stopAll().then(
        (stopped) => res.end(JSON.stringify({ ok: true, stopped })),
        (e) => {
          res.writeHead(500);
          res.end(JSON.stringify({ ok: false, error: String(e) }));
        },
      );
      return;
    }
    if (req.method === "POST" && url === "/resume") {
      res.setHeader("Content-Type", "application/json");
      if (!this.opts.resumeHeld) {
        res.writeHead(400);
        res.end(JSON.stringify({ ok: false, error: "not available" }));
        return;
      }
      res.end(JSON.stringify({ ok: true, delivered: this.opts.resumeHeld() }));
      return;
    }
    if (req.method === "POST" && url === "/answer") {
      let body = "";
      req.on("data", (c) => (body += c));
      req.on("end", () => {
        res.setHeader("Content-Type", "application/json");
        try {
          const { id, ...answer } = JSON.parse(body) as { id: string } & Answer;
          if (!id || !this.opts.answer) throw new Error("id required");
          this.opts.answer(id, answer as Answer);
          res.end(JSON.stringify({ ok: true }));
        } catch (e) {
          res.writeHead(400);
          res.end(JSON.stringify({ ok: false, error: (e as Error).message }));
        }
      });
      return;
    }
    if (req.method === "POST" && url === "/budget") {
      let body = "";
      req.on("data", (c) => (body += c));
      req.on("end", () => {
        res.setHeader("Content-Type", "application/json");
        try {
          const { dollars } = JSON.parse(body) as { dollars: number };
          if (!this.opts.setBudget) throw new Error("not available");
          this.opts.setBudget(dollars);
          res.end(JSON.stringify({ ok: true }));
        } catch (e) {
          res.writeHead(400);
          res.end(JSON.stringify({ ok: false, error: (e as Error).message }));
        }
      });
      return;
    }
    if (req.method === "GET" && url === "/channels") {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify(this.opts.getChannels ? this.opts.getChannels() : []));
      return;
    }
    if (req.method === "POST" && url === "/channels") {
      let body = "";
      req.on("data", (c) => (body += c));
      req.on("end", () => {
        try {
          const ch = JSON.parse(body) as ChannelConfig;
          if (!ch || typeof ch.name !== "string" || !ch.name.trim() || !Array.isArray(ch.members) || !this.opts.upsertChannel) {
            res.writeHead(400, { "Content-Type": "application/json" });
            res.end(JSON.stringify({ ok: false, error: "name and members[] required" }));
            return;
          }
          ch.name = ch.name.trim();
          ch.members = ch.members.filter((m) => typeof m === "string" && m.trim());
          this.opts.upsertChannel(ch);
          res.writeHead(200, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ ok: true }));
        } catch (e) {
          res.writeHead(400, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ ok: false, error: String(e) }));
        }
      });
      return;
    }
    if (req.method === "POST" && url === "/channels/remove") {
      let body = "";
      req.on("data", (c) => (body += c));
      req.on("end", () => {
        try {
          const { name } = JSON.parse(body) as { name: string };
          if (!name || !this.opts.removeChannel) {
            res.writeHead(400, { "Content-Type": "application/json" });
            res.end(JSON.stringify({ ok: false, error: "name required" }));
            return;
          }
          this.opts.removeChannel(name);
          res.writeHead(200, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ ok: true }));
        } catch (e) {
          res.writeHead(400, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ ok: false, error: String(e) }));
        }
      });
      return;
    }
    res.writeHead(404, { "Content-Type": "text/plain" });
    res.end("not found");
  }

  close(): void {
    for (const res of this.clients) {
      try {
        res.end();
      } catch {
        // ignore
      }
    }
    this.clients.clear();
    this.server?.close();
    this.server = null;
  }
}