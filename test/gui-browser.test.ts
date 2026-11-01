/**
 * The GUI in a real browser, against real agents and the scripted model. These drive
 * the page as a person does: API tests cannot see a missing input box or a card that
 * snaps shut. Uses whatever Chrome or Edge the machine has, so nothing is downloaded.
 */
import { describe, it, expect, beforeAll, afterAll, afterEach, vi } from "vitest";
import { execFileSync, spawn, type ChildProcess } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { chromium, type Browser, type Page } from "playwright-core";
import { Hub } from "../src/hub.ts";
import { DEAD_MODEL, FLEET, MODEL, ROOT, TSX, firstMatch, killTree, startFakeModel, until, type LlmRequest } from "./support.ts";

vi.setConfig({ testTimeout: 90000 });

let browser: Browser;
let model: Awaited<ReturnType<typeof startFakeModel>>;
const running: { proc: ChildProcess; hubDir: string; page: Page }[] = [];

async function launch(): Promise<Browser> {
  for (const channel of ["chrome", "msedge"]) {
    try {
      return await chromium.launch({ channel, headless: true });
    } catch {
      // try the next one
    }
  }
  throw new Error("these tests need Chrome or Edge installed");
}

/** Start a fleet and open its page the way a person does: from the link it prints. */
async function open(name: string, args: string[]): Promise<{ page: Page; hub: Hub; hubDir: string; url: string }> {
  const hubDir = path.join(model.tmp, name);
  const proc = spawn(process.execPath, [TSX, FLEET, "serve", ...args, "--dir", hubDir], { cwd: model.tmp, env: model.env, stdio: ["ignore", "pipe", "pipe"] });
  const [, url] = await firstMatch(proc, /GUI: (http:\/\/\S+)/);
  const page = await browser.newPage();
  running.push({ proc, hubDir, page });
  await page.goto(url);
  return { page, hub: new Hub(hubDir), hubDir, url };
}

const agentsFor = (...names: string[]) => names.flatMap((n) => ["--agent", `${n}::${MODEL}`]);

async function ready(page: Page, ...names: string[]): Promise<void> {
  for (const n of names) await page.waitForSelector(`[data-chat="${n}"] .cdot.idle`, { timeout: 30000 });
}

async function send(page: Page, text: string): Promise<void> {
  await page.fill("#msgInput", text);
  await page.press("#msgInput", "Enter");
}

const asked = (agent: string, text: string) => async (): Promise<LlmRequest | undefined> => (await model.log()).find((r) => r.agent === agent && r.conversation.includes(text));

beforeAll(async () => {
  browser = await launch();
  model = await startFakeModel("pi fleet browser");
}, 60000);

afterEach(async () => {
  for (const { proc, hubDir, page } of running.splice(0)) {
    await page.close();
    killTree(proc.pid);
    for (const a of Object.values(new Hub(hubDir).readAgents())) killTree(a.pid);
  }
});

afterAll(async () => {
  await browser?.close();
  killTree(model?.proc.pid);
  try {
    fs.rmSync(model.tmp, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
  } catch {
    // a just-killed process may still hold a log file on Windows
  }
});

describe("a new user", () => {
  it("goes from an empty app to a finished sdlc task with no terminal or config file", async () => {
    const { page, hubDir } = await open("first-run", []);

    await page.waitForSelector(".firstrun");
    await page.waitForFunction(() => document.querySelectorAll("#modelList option").length > 0);
    await page.fill("#firstModel", MODEL);
    await page.click('button[data-template="sdlc"]');
    await ready(page, "planner", "implementer", "reviewer");

    await send(page, "build the feature");
    await page.locator("#conversation").getByText("APPROVE").waitFor({ timeout: 45000 });
    await page.locator("#conversation").getByText("routed to planner").waitFor();
    expect(JSON.parse(fs.readFileSync(path.join(hubDir, "fleet.json"), "utf8")).agents).toHaveLength(3); // remembered for next time
  });

  it("is told what went wrong when the crew cannot start", async () => {
    const { page } = await open("first-run-bad", []);
    await page.waitForSelector(".firstrun");
    await page.fill("#firstModel", "");
    await page.evaluate(() => document.querySelector('button[data-template="sdlc"]')!.setAttribute("data-template", "nope"));
    await page.click('button[data-template="nope"]');
    await page.waitForFunction(() => document.getElementById("firstError")!.textContent!.includes("unknown template"));
  });
});

describe("messages", () => {
  it("offers a composer whatever the number of agents", async () => {
    for (const [name, names] of [["one", ["a"]], ["three", ["a", "b", "c"]]] as const) {
      const { page } = await open(`composer-${name}`, agentsFor(...names));
      await ready(page, ...names);
      await page.waitForSelector("#msgInput");
      const options = await page.locator("#toSel option").allTextContents();
      expect(options).toEqual(["# group", ...names.map((n) => `@ ${n}`)]);
    }
  });

  it("shows your own direct message at once, and only once", async () => {
    const { page } = await open("echo", agentsFor("alice"));
    await ready(page, "alice");
    await page.click('[data-chat="alice"]');
    await send(page, "hello from me");
    await page.locator(".msg.user .bubble").getByText("hello from me").waitFor();
    await until("the model to be asked", asked("alice", "hello from me"));
    await page.locator("#conversation").getByText("ack from alice").waitFor();
    expect(await page.locator(".msg.user .bubble").count()).toBe(1);
  });

  it.each(["before", "after"])("keeps what happened while a slow history was on its way, when it was read %s the answer", async (read) => {
    const { page } = await open(`slow-history-${read}`, agentsFor("alice"));
    await ready(page, "alice");
    await page.click('[data-chat="alice"]');
    await page.waitForFunction(() => document.querySelector("#conversation .empty"));
    await page.reload(); // from here the history reply is held back, as on a slow machine
    let answered!: () => void;
    const held = new Promise<void>((resolve) => (answered = resolve));
    await page.route("**/rpc", async (route) => {
      if (route.request().postDataJSON()?.command !== "get_messages") return route.continue();
      if (read === "after") await held;
      const reply = await route.fetch();
      await held;
      await route.fulfill({ response: reply });
    });
    await ready(page, "alice");
    await page.click('[data-chat="alice"]');
    await send(page, "[[md]]");
    await page.waitForSelector("#conversation table");
    const delivered = page.waitForResponse((r) => r.url().endsWith("/rpc"));
    answered();
    await delivered;
    await page.waitForTimeout(200);
    expect(await page.locator("#conversation th").count()).toBe(2);
    expect(await page.locator(".msg.user .bubble").count()).toBe(1);
  });

  it("shows an agent's older history even after it has said something new", async () => {
    const { page } = await open("older-history", agentsFor("alice"));
    await ready(page, "alice");
    await page.click('[data-chat="alice"]');
    await send(page, "the first thing");
    await page.locator("#conversation").getByText("ack from alice").waitFor();
    await page.reload();
    await ready(page, "alice");
    await send(page, "@alice the second thing"); // alice speaks with its chat closed
    await until("alice to answer", asked("alice", "the second thing"));
    await page.waitForTimeout(500);
    await page.click('[data-chat="alice"]');
    await page.locator("#conversation").getByText("the first thing").waitFor();
    await page.locator(".wake summary").getByText("Message from the fleet").waitFor(); // and the new one too
    expect(await page.locator("#conversation").getByText("the first thing").count()).toBe(1);
  });

  it("keeps the line breaks of a multi-line channel message", async () => {
    const { page } = await open("multiline", agentsFor("alice"));
    await ready(page, "alice");
    await page.fill("#msgInput", "first line\nsecond line");
    await page.click("#sendBtn");
    await page.waitForSelector(".bubble br", { state: "attached" });
    expect(await page.locator(".bubble p").first().innerText()).toBe("first line\nsecond line");
  });

  it("does not show the fleet's prompts as if you had typed them", async () => {
    const { page, hub } = await open("wake", agentsFor("alice"));
    await ready(page, "alice");
    await page.click('[data-chat="alice"]');
    hub.appendMessage({ from: "user", to: "alice", kind: "chat", text: "sent through the bus" });
    await page.locator(".wake summary").getByText("Message from the fleet").waitFor();
    expect(await page.locator(".msg.user").count()).toBe(0);
  });

  it("renders markdown, and agent output cannot run anything", async () => {
    const { page } = await open("markdown", agentsFor("alice"));
    await ready(page, "alice");
    await page.click('[data-chat="alice"]');
    await send(page, "[[md]]");
    await page.waitForSelector("#conversation table");
    expect(await page.locator("#conversation th").allTextContents()).toEqual(["col a", "col b"]);
    expect(await page.locator("#conversation ol li").allTextContents()).toEqual(["first", "second"]);
    expect(await page.locator("#conversation pre").innerText()).toContain("- not a list item");
    expect(await page.locator("#conversation a").evaluateAll((links) => links.map((a) => a.getAttribute("href")))).toEqual(["https://example.com/page"]);
    await page.locator("#conversation").getByText("hover").hover();
    expect(await page.evaluate(() => (window as unknown as { __xss?: number }).__xss)).toBeUndefined();
  });
});

describe("staying in place", () => {
  it("keeps a tool card open while the agent streams", async () => {
    const { page } = await open("tool-card", agentsFor("alice"));
    await ready(page, "alice");
    await page.click('[data-chat="alice"]');
    await send(page, "[[tool-then-slow]]");
    await page.click(".tool .thead");
    await page.waitForSelector(".tool.open");
    await page.locator("#conversation").getByText("working 4").waitFor();
    expect(await page.locator(".tool.open").count()).toBe(1);
  });

  it("keeps a draft across switching chats and a dropped connection", async () => {
    const { page, hubDir, url } = await open("draft", agentsFor("alice"));
    await ready(page, "alice");
    await page.fill("#msgInput", "half a thought");
    await page.click('[data-chat="alice"]');
    expect(await page.inputValue("#msgInput")).toBe("");
    await page.click('[data-chat="group"]');
    expect(await page.inputValue("#msgInput")).toBe("half a thought");

    // a real dropped connection: the supervisor goes away and comes back on the same port
    const first = running[running.length - 1];
    killTree(first.proc.pid);
    await page.waitForSelector("#conn:not(.on)");
    const port = new URL(url).port;
    first.proc = spawn(process.execPath, [TSX, FLEET, "serve", "--port", port, "--dir", hubDir], { cwd: model.tmp, env: model.env, stdio: "ignore" });
    await page.waitForSelector("#conn.on", { timeout: 20000 });
    expect(await page.inputValue("#msgInput")).toBe("half a thought");
  });

  it("marks what you have not read, and clears it when you look", async () => {
    const { page, hub } = await open("unread", agentsFor("alice"));
    await ready(page, "alice");
    await page.click('[data-chat="alice"]');
    hub.appendMessage({ from: "alice", to: "group", kind: "chat", text: "news" });
    await page.waitForSelector('[data-chat="group"] .unread');
    expect(await page.title()).toBe("(1) pi-fleet");
    await page.click('[data-chat="group"]');
    expect(await page.locator(".unread").count()).toBe(0);
    expect(await page.title()).toBe("pi-fleet");
  });
});

describe("reviewing an agent's work", () => {
  it("shows what it changed and merges it, with no git", async () => {
    const repo = path.join(model.tmp, "gui-repo");
    fs.mkdirSync(repo, { recursive: true });
    const git = (...args: string[]) => execFileSync("git", args, { cwd: repo, stdio: "ignore" });
    git("init", "-b", "main");
    git("config", "user.name", "Test");
    git("config", "user.email", "test@example.com");
    fs.writeFileSync(path.join(repo, "README.md"), "hello\n");
    git("add", "-A");
    git("commit", "-m", "First");

    const { page } = await open("changes", ["--agent", `alice:${repo}:${MODEL}:implementer`, "--agent", `reviewer:${repo}:${MODEL}:reviewer`, "--worktrees"]);
    await ready(page, "alice", "reviewer");
    await page.click('[data-chat="alice"]');
    await send(page, "[[write added.txt from alice]]");
    await page.locator("#conversation").getByText("ok (alice)").waitFor({ timeout: 30000 });

    await page.click('button[data-act="changes"]');
    await page.locator(".diff .add").getByText("+from alice").waitFor();
    await page.click("#mergeBtn");
    await page.locator("#mergeStatus").getByText("Merged.").waitFor();
    expect(fs.readFileSync(path.join(repo, "added.txt"), "utf8")).toBe("from alice");
  }, 60000);

  it("has no Changes button for an agent with no worktree", async () => {
    const { page } = await open("no-changes", agentsFor("alice"));
    await ready(page, "alice");
    await page.click('[data-chat="alice"]');
    await page.waitForSelector('button[data-act="restart"]');
    expect(await page.locator('button[data-act="changes"]').count()).toBe(0);
  });

  it("shows the timeline and the task board", async () => {
    const { page, hub } = await open("timeline", agentsFor("alice"));
    await ready(page, "alice");
    hub.appendMessage({ from: "user", to: "group", kind: "chat", text: "a request to trace" });
    await page.locator("#conversation").getByText("a request to trace").waitFor();
    await page.click("#settingsBtn");
    await page.click('#tabs button[data-tab="timeline"]');
    await page.locator("#mbody").getByText("a request to trace", { exact: true }).waitFor();
    await page.click('#tabs button[data-tab="tasks"]');
    await page.locator("#mbody").getByText("No tasks on the board yet.").waitFor();
  });
});

describe("a model that cannot be reached", () => {
  it("shows the error in the agent's chat, once, not as empty messages", async () => {
    const { page } = await open("dead-chat", ["--agent", `alice::${DEAD_MODEL}`]);
    await ready(page, "alice");
    await page.click('[data-chat="alice"]');
    await send(page, "are you there");
    await page.locator(".turn-error").getByText("Model error: Connection error.").waitFor({ timeout: 40000 });
    await page.locator(".turn-error").getByText("attempts").waitFor({ timeout: 40000 });
    expect(await page.locator(".turn-error").count()).toBe(1);
    await page.click(".turn-error button");
    await page.waitForSelector("#modelRows");
  }, 60000);

  it("is caught before a crew starts, and can be started anyway", async () => {
    const { page, hubDir } = await open("dead-first-run", []);
    await page.waitForSelector(".firstrun");
    await page.fill("#firstModel", DEAD_MODEL);
    await page.click('button[data-template="pair"]');
    await page.locator("#firstError", { hasText: "did not answer: Connection error" }).waitFor({ timeout: 30000 });
    expect(fs.existsSync(path.join(hubDir, "fleet.json"))).toBe(false);
    await page.click('#firstError button[data-untested]');
    await until("the crew", () => fs.existsSync(path.join(hubDir, "fleet.json")));
    expect(JSON.parse(fs.readFileSync(path.join(hubDir, "fleet.json"), "utf8")).defaultModel).toBe(DEAD_MODEL);
  }, 60000);
});

describe("setting up models", () => {
  const agentDir = () => model.env.PI_CODING_AGENT_DIR!;
  const openModels = async (page: Page) => {
    await page.click("#settingsBtn");
    await page.click('#tabs button[data-tab="models"]');
    await page.waitForSelector("#modelRows");
  };

  it("adds a server, tests it and makes it the default, with no file to edit", async () => {
    const { page, hubDir } = await open("add-server", agentsFor("alice"));
    await ready(page, "alice");
    await openModels(page);
    await page.fill("#provName", "added");
    await page.fill("#provUrl", `http://127.0.0.1:${model.port}/v1`);
    await page.fill("#provModels", "fake-1");
    await page.click("#provAdd");
    const row = page.locator('.mrow[data-model="added/fake-1"]');
    await row.waitFor({ timeout: 20000 });
    await row.locator('button[data-do="test"]').click();
    await row.locator(".mres.good").getByText("Answers").waitFor({ timeout: 30000 });
    await row.locator('button[data-do="default"]').click();
    await page.locator('.mrow[data-model="added/fake-1"] .tag').getByText("default").waitFor({ timeout: 20000 });
    expect(JSON.parse(fs.readFileSync(path.join(hubDir, "fleet.json"), "utf8")).defaultModel).toBe("added/fake-1");
  }, 60000);

  it("says which model does not answer, and why", async () => {
    const { page } = await open("test-dead", agentsFor("alice"));
    await ready(page, "alice");
    await openModels(page);
    const row = page.locator(`.mrow[data-model="${DEAD_MODEL}"]`);
    await row.locator('button[data-do="test"]').click();
    await row.locator(".mres.bad").getByText("Connection error").waitFor({ timeout: 30000 });
  }, 60000);

  it("saves a key without ever showing it again", async () => {
    const { page } = await open("add-key", agentsFor("alice"));
    await ready(page, "alice");
    await openModels(page);
    await page.fill("#keyProvider", "anthropic");
    await page.fill("#keyValue", "sk-test-key");
    await page.click("#keyAdd");
    await page.waitForFunction(() => (document.getElementById("keyValue") as HTMLInputElement | null)?.value === ""); // the tab reloaded
    expect(JSON.parse(fs.readFileSync(path.join(agentDir(), "auth.json"), "utf8")).anthropic).toEqual({ type: "api_key", key: "sk-test-key" });
    expect(await page.content()).not.toContain("sk-test-key");
    fs.rmSync(path.join(agentDir(), "auth.json")); // other tests share this home
  }, 60000);

  it("keeps a model chosen for an agent after a restart", async () => {
    const { page, hubDir } = await open("pick-model", []);
    await page.waitForSelector(".firstrun");
    await page.fill("#firstModel", MODEL);
    await page.click('button[data-template="pair"]');
    const name = "implementer";
    await ready(page, name);
    await page.click(`[data-chat="${name}"]`);
    await page.selectOption("#modelPick", DEAD_MODEL);
    await until("the choice to be kept", () => JSON.parse(fs.readFileSync(path.join(hubDir, "fleet.json"), "utf8")).agents.find((a: { name: string }) => a.name === name).model === DEAD_MODEL);
  }, 60000);
});

describe("running the fleet", () => {
  it("stops, starts and removes an agent", async () => {
    const { page, hub } = await open("controls", agentsFor("alice", "bob"));
    await ready(page, "alice", "bob");
    await page.click('[data-chat="alice"]');

    await page.click('button[data-act="stop-agent"]');
    await page.waitForSelector('[data-chat="alice"] .cdot.stopped');
    await page.click('button[data-act="restart"]');
    await ready(page, "alice");

    await page.click('button[data-act="remove"]');
    await page.click("#dialogSubmit");
    await page.waitForSelector('[data-chat="alice"]', { state: "detached" });
    expect(hub.readAgents().alice).toBeUndefined();
    expect(hub.getChannel("group")?.members).toEqual(["bob"]);
  });

  it("picks a model from the ones pi knows", async () => {
    const { page } = await open("models", agentsFor("alice"));
    await ready(page, "alice");
    await page.click('[data-chat="alice"]');
    await page.waitForSelector("#modelPick");
    expect(await page.locator("#modelPick option").allTextContents()).toContain(MODEL);
    await page.selectOption("#modelPick", MODEL);
    await page.waitForTimeout(300);
    expect(await page.inputValue("#modelPick")).toBe(MODEL);
  });

  it("edits fleet.json from the Fleet tab, and says when a value is wrong", async () => {
    const { page, hubDir } = await open("fleet-tab", agentsFor("alice"));
    await ready(page, "alice");
    await page.click("#settingsBtn");
    await page.waitForSelector("#cfgSave");
    await page.fill("#cfgRouterModel", "cheap/model");
    await page.fill("#cfgMaxTurns", "lots");
    await page.click("#cfgSave");
    await page.waitForFunction(() => document.getElementById("cfgStatus")!.textContent!.includes("Not saved"));

    await page.fill("#cfgMaxTurns", "25");
    await page.click("#cfgAdd");
    await page.fill("#cfgAgents .agentrow [data-f=name]", "added");
    await page.selectOption("#cfgAgents .agentrow [data-f=role]", "reviewer");
    await page.click("#cfgSave");
    await page.locator("#cfgStatus").getByText("Saved.").waitFor();
    const saved = JSON.parse(fs.readFileSync(path.join(hubDir, "fleet.json"), "utf8"));
    expect(saved).toMatchObject({ routerModel: "cheap/model", maxTurns: 25, agents: [{ name: "added", role: "reviewer" }] });
  });

  it("chooses who routes the group, and that choice lasts", async () => {
    const { page, hub } = await open("group-router", agentsFor("alice", "bob"));
    await ready(page, "alice", "bob");
    await page.click("#settingsBtn");
    await page.click('#tabs button[data-tab="channels"]');
    await page.click('button[data-chedit="group"]');
    await page.selectOption("#chSup", "alice");
    await page.click("#chAdd");
    await until("the choice to be saved", () => hub.getChannel("group")?.supervisor === "alice");
    expect(hub.ensureDefaultChannel().supervisor).toBe("alice");
  });

  it("finds a message in the archives", async () => {
    const { page, hub } = await open("search", agentsFor("alice"));
    await ready(page, "alice");
    hub.appendMessage({ from: "alice", to: "group", kind: "chat", text: "the needle is here" });
    hub.rotateIfLarge(1);
    await page.click("#settingsBtn");
    await page.click('#tabs button[data-tab="search"]');
    await page.fill("#searchInput", "NEEDLE");
    await page.press("#searchInput", "Enter");
    await page.locator(".hit").getByText("the needle is here").waitFor();
    await page.click(".hit");
    await page.locator("#overlay").waitFor({ state: "hidden" });
  });

  it("clears a channel for good, and the messages stay searchable", async () => {
    const { page, hub } = await open("clear", agentsFor("alice"));
    await ready(page, "alice");
    hub.appendMessage({ from: "alice", to: "group", kind: "chat", text: "old message" });
    await page.locator("#conversation").getByText("old message").waitFor();
    await page.click('button[data-act="clear-channel"]');
    await page.locator("#conversation").getByText("old message").waitFor({ state: "detached" });
    await page.reload();
    await page.waitForSelector("#msgInput");
    expect(await page.locator("#conversation").getByText("old message").count()).toBe(0);
    expect(hub.searchMessages("old message")).toHaveLength(1);
  });

  it("puts a question in front of you, and Stop all holds the fleet", async () => {
    const extensions = [path.join(ROOT, "test", "ask-extension.ts")];
    const hubDir = path.join(model.tmp, "question");
    fs.mkdirSync(hubDir, { recursive: true });
    fs.writeFileSync(path.join(hubDir, "fleet.json"), JSON.stringify({ defaultModel: MODEL, agents: [{ name: "alice", extensions }] }));
    const { page, hub } = await open("question", []);
    await ready(page, "alice");
    hub.appendMessage({ from: "user", to: "alice", kind: "chat", text: "[[ask]]" });
    await page.click('.question button[data-value="green"]');
    await until("the answer", asked("alice", "the human chose green"));

    await page.click("#stopAllBtn");
    await page.locator("#pausedBar").getByText("stopped by you").waitFor();
  });
});
