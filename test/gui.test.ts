import { describe, it, expect, beforeAll, afterAll } from "vitest";
import http from "node:http";
import { GuiServer } from "../src/gui.ts";
import { Hub } from "../src/hub.ts";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";

const TOKEN = "test-token";
const AUTH = { authorization: `Bearer ${TOKEN}` };

let hub: Hub;
let dir: string;
let gui: GuiServer;
let port: number;
const posted: { to: string; text: string }[] = [];
const sessionNames: { name: string; sessionName: string }[] = [];
let stopAllCalls = 0;
const answers: { id: string; answer: unknown }[] = [];
const budgets: number[] = [];

function get(path: string, headers: http.OutgoingHttpHeaders = AUTH): Promise<{ status: number; body: string; headers: http.IncomingHttpHeaders }> {
  return new Promise((resolve, reject) => {
    http.get({ port, host: "127.0.0.1", path, headers }, (res) => {
      let body = "";
      res.on("data", (c) => (body += c));
      res.on("end", () => resolve({ status: res.statusCode ?? 0, body, headers: res.headers }));
    }).on("error", reject);
  });
}

function post(path: string, body: string, headers: http.OutgoingHttpHeaders = AUTH): Promise<{ status: number }> {
  return new Promise((resolve, reject) => {
    const req = http.request({ port, host: "127.0.0.1", path, method: "POST", headers }, (res) => {
      res.on("data", () => {});
      res.on("end", () => resolve({ status: res.statusCode ?? 0 }));
    });
    req.on("error", reject);
    req.end(body);
  });
}

/** Connect to /events and resolve with the accumulated stream text after a delay. */
function readEvents(ms: number): Promise<string> {
  return new Promise((resolve, reject) => {
    const req = http.get({ port, host: "127.0.0.1", path: "/events", headers: AUTH }, (res) => {
      let body = "";
      res.on("data", (c) => (body += c));
      setTimeout(() => {
        req.destroy();
        resolve(body);
      }, ms);
    });
    req.on("error", reject);
  });
}

beforeAll(async () => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "fleet-gui-"));
  hub = new Hub(dir);
  hub.updateAgent("alice", { name: "alice", pid: 1, cwd: "/x", status: "idle" });
  hub.appendMessage({ from: "user", to: "group", kind: "chat", text: "hello fleet" });
  gui = new GuiServer({
    token: TOKEN,
    getSnapshot: () => ({ agents: Object.values(hub.readAgents()), messages: hub.tailMessages(50), channels: [], paused: "held for testing" }),
    onMessage: (m) => {
      if (m.to === "nosuch") throw new Error('no agent or channel "nosuch"');
      posted.push(m);
    },
    onSessionName: (name, sessionName) => {
      sessionNames.push({ name, sessionName });
    },
    stopAll: async () => {
      stopAllCalls++;
      return 2;
    },
    resumeHeld: () => 3,
    answer: (id, answer) => {
      if (id === "gone") throw new Error("that question is no longer waiting");
      answers.push({ id, answer });
    },
    setBudget: (dollars) => {
      if (!(dollars > 0)) throw new Error("the spending limit must be a positive number of dollars");
      budgets.push(dollars);
    },
  });
  port = await gui.start();
});

afterAll(() => {
  gui.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

describe("GuiServer", () => {
  it("serves the HTML page at /", async () => {
    const res = await get("/");
    expect(res.status).toBe(200);
    expect(res.body).toContain("pi-fleet");
    expect(res.body).toContain("EventSource");
  });

  it("streams a snapshot to /events on connect", async () => {
    const body = await readEvents(300);
    expect(body).toContain("event: snapshot");
    expect(body).toContain("alice");
    expect(body).toContain("hello fleet");
  });

  it("broadcasts events to connected clients", async () => {
    const reader = readEvents(500);
    await new Promise((r) => setTimeout(r, 150)); // let the client connect
    gui.broadcast("message", { id: "x", from: "bob", to: "group", kind: "chat", text: "live update" });
    const body = await reader;
    expect(body).toContain("event: message");
    expect(body).toContain("live update");
  });

  it("accepts a message via POST /message", async () => {
    const res = await post("/message", JSON.stringify({ to: "group", text: "from the browser" }));
    expect(res.status).toBe(200);
    expect(posted).toContainEqual({ to: "group", text: "from the browser" });
  });

  it("tells the page why a message was refused", async () => {
    const res = await new Promise<{ status: number; body: string }>((resolve, reject) => {
      const req = http.request({ port, host: "127.0.0.1", path: "/message", method: "POST", headers: AUTH }, (r) => {
        let body = "";
        r.on("data", (c) => (body += c));
        r.on("end", () => resolve({ status: r.statusCode ?? 0, body }));
      });
      req.on("error", reject);
      req.end(JSON.stringify({ to: "nosuch", text: "hi" }));
    });
    expect(res.status).toBe(400);
    expect(JSON.parse(res.body)).toEqual({ ok: false, error: 'no agent or channel "nosuch"' });
  });

  it("sets a session name via POST /session-name", async () => {
    const res = await post("/session-name", JSON.stringify({ name: "alice", sessionName: "my-work" }));
    expect(res.status).toBe(200);
    expect(sessionNames).toContainEqual({ name: "alice", sessionName: "my-work" });
  });

  it("sends the paused state in the snapshot", async () => {
    expect(await readEvents(300)).toContain("held for testing");
  });

  it("stops the fleet via POST /stop-all, with a token only", async () => {
    expect((await post("/stop-all", "{}", {})).status).toBe(401);
    expect(stopAllCalls).toBe(0);
    expect((await post("/stop-all", "{}")).status).toBe(200);
    expect(stopAllCalls).toBe(1);
  });

  it("passes an answer to the agent's question on, and needs a token", async () => {
    const body = JSON.stringify({ id: "q1", confirmed: true });
    expect((await post("/answer", body, {})).status).toBe(401);
    expect((await post("/answer", body)).status).toBe(200);
    expect(answers).toEqual([{ id: "q1", answer: { confirmed: true } }]);
  });

  it("reports an answer that came too late", async () => {
    expect((await post("/answer", JSON.stringify({ id: "gone", value: "x" }))).status).toBe(400);
  });

  it("resumes and delivers held messages, with a token only", async () => {
    expect((await post("/resume", "{}", {})).status).toBe(401);
    expect((await post("/resume", "{}")).status).toBe(200);
  });

  it("changes the spending limit, refusing nonsense", async () => {
    expect((await post("/budget", JSON.stringify({ dollars: 5 }))).status).toBe(200);
    expect(budgets).toEqual([5]);
    expect((await post("/budget", JSON.stringify({ dollars: -1 }))).status).toBe(400);
  });

  it("tracks connected client count", async () => {
    const reader = readEvents(300);
    await new Promise((r) => setTimeout(r, 150));
    expect(gui.clientCount).toBeGreaterThanOrEqual(1);
    await reader;
  });
});

describe("GuiServer access control", () => {
  it("refuses every route without a token", async () => {
    for (const route of ["/", "/events", "/extensions", "/mcp", "/channels"]) {
      expect((await get(route, {})).status).toBe(401);
    }
    const before = posted.length;
    expect((await post("/message", JSON.stringify({ text: "anonymous" }), {})).status).toBe(401);
    expect(posted).toHaveLength(before);
  });

  it("refuses a wrong token of any length", async () => {
    expect((await get("/", { authorization: "Bearer test-tokem" })).status).toBe(401);
    expect((await get("/", { authorization: "Bearer x" })).status).toBe(401);
    expect((await get("/?token=wrong", {})).status).toBe(401);
  });

  it("the startup link serves the page and leaves a same-site, script-proof cookie", async () => {
    const res = await get(`/?token=${TOKEN}`, {});
    expect(res.status).toBe(200);
    const cookie = res.headers["set-cookie"]![0];
    expect(cookie).toContain(`pi_fleet_${port}=${TOKEN}`);
    expect(cookie).toContain("HttpOnly");
    expect(cookie).toContain("SameSite=Strict");
    // the cookie alone then works, for the requests the page makes itself
    const pair = cookie.split(";")[0];
    expect((await get("/mcp", { cookie: pair })).status).toBe(200);
    expect((await post("/message", JSON.stringify({ text: "by cookie" }), { cookie: pair })).status).toBe(200);
  });

  it("accepts the link token on the page only, not on the API", async () => {
    expect((await get(`/mcp?token=${TOKEN}`, {})).status).toBe(401);
  });

  it("ignores a cookie meant for another server's port", async () => {
    expect((await get("/mcp", { cookie: `pi_fleet_1=${TOKEN}` })).status).toBe(401);
  });

  it("refuses cross-origin requests even with valid credentials", async () => {
    const hostile = { ...AUTH, origin: "https://evil.example" };
    const before = posted.length;
    expect((await post("/message", JSON.stringify({ text: "csrf" }), hostile)).status).toBe(403);
    expect((await post("/message", JSON.stringify({ text: "csrf" }), { ...AUTH, origin: "null" })).status).toBe(403);
    expect(posted).toHaveLength(before);
  });

  it("accepts the page's own origin", async () => {
    const res = await post("/message", JSON.stringify({ text: "same origin" }), { ...AUTH, origin: `http://127.0.0.1:${port}` });
    expect(res.status).toBe(200);
  });

  it("does not open /events to other origins", async () => {
    const res = await new Promise<http.IncomingMessage>((resolve, reject) => {
      const req = http.get({ port, host: "127.0.0.1", path: "/events", headers: AUTH }, (r) => {
        resolve(r);
        req.destroy();
      });
      req.on("error", () => {});
      req.on("timeout", () => reject(new Error("timeout")));
    });
    expect(res.headers["access-control-allow-origin"]).toBeUndefined();
  });

  it("locks scripts on the page to a per-response nonce", async () => {
    const [a, b] = [await get("/"), await get("/")];
    const nonce = /script-src 'nonce-([^']+)'/.exec(String(a.headers["content-security-policy"]))?.[1];
    expect(nonce).toBeTruthy();
    expect(a.body).toContain(`<script nonce="${nonce}">`);
    expect(b.body).not.toContain(`<script nonce="${nonce}">`);
    expect(String(a.headers["content-security-policy"])).not.toContain("script-src 'unsafe-inline'");
  });

  it("includes the token in the startup link", () => {
    expect(gui.url).toBe(`http://127.0.0.1:${port}/?token=${TOKEN}`);
  });
});

describe("gui.html", () => {
  const html = fs.readFileSync(path.join(__dirname, "..", "src", "gui.html"), "utf8");

  it("closes the value attribute of the DM options (an open one swallows the composer)", () => {
    expect(html).toContain(`'<option value="' + esc(n) + '">@ '`);
  });

  it("has no inline event handlers, which the page's CSP would block", () => {
    expect(html).not.toMatch(/<[^>]+\son[a-z]+="/);
  });

  it("has its renderer inlined, so the page needs nothing else", async () => {
    const page = await get("/");
    expect(page.body).toContain("function renderMarkdown");
    expect(page.body).not.toContain("markdown.cjs */");
  });

  it("does not use window.prompt, which the desktop shell does not support", () => {
    expect(html).not.toMatch(/[^.\w]prompt\(/);
  });
});
