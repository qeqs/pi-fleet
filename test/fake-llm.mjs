// Scripted OpenAI-compatible endpoint: lets the e2e tests run real pi agents with
// no model server. Prints the port it bound, then behaves like this:
//   "Routing task for #x"  -> calls route(); targets from `route=a,b` in the text,
//                             else the SDLC default (user -> planner, otherwise nobody)
//   [[slow N]]             -> streams for N seconds, keeping the agent busy
//   router calls          -> answers with JSON; targets from `route=a,b` in the text, else
//                             the planner if there is one, or nobody for agents' messages
//   [[router-garbage]]     -> as the router, answers with no JSON
//   [[ask]]                -> calls ask_human (from test/ask-extension.ts)
//   [[guarded]]            -> calls fleet_agents, for testing approvals
//   [[write file text]]    -> writes a file, then asks the reviewer to look
//   a merge conflict       -> merges the base into its branch, keeping its own side
//   [[run command]]        -> runs a command, then says ok
//   [[openspec args]]      -> runs the task board tool, then says ok
//   [[say text]]           -> answers with that text and calls no tool, as a weak model does
//   [[inspect text]]       -> runs a command, then answers with that text and calls no fleet tool
//   the watching router    -> says the crew has finished, unless the task has [[stalled name]]: then
//                             that member must write a file, or with [[stalled name hopeless]],
//                             must do something it answers by only talking
//   [[router-slow N]]      -> the router takes N seconds and gives no usable answer
//   [[watcher-slow N]]     -> the watching router takes N seconds and gives no usable answer
//   model "fake/no-tools"  -> a server that ignores tools: only ever writes text
//   model "fake/tool-refused" -> refuses the tool test because it has no tools
//   model "fake/cut-off"   -> fails the tool test for a reason that says nothing about tools
//   [[md]]                 -> answers with markdown, some of it hostile
//   [[tool-then-slow]]     -> calls a tool, then streams slowly
//   [[hang]]               -> never answers
//   [[fail]]               -> answers with an error that pi does not retry
//   [[runon]]              -> never ends the run: every turn calls another tool
//   [[repeat]]             -> never ends the run: every turn posts the same message
//   [[chatter]]            -> never ends the run: every turn posts a slightly different message
//   [[flaky N]]            -> anywhere in the conversation: this agent's first N requests fail
//                             with a 503, then it answers as usual
//   [[pingpong a b]]       -> a and b keep sending each other this same message
//   no directive           -> SDLC defaults: planner mentions implementer, implementer
//                             mentions reviewer, reviewer posts APPROVE to #group
// GET /__log returns every request as { agent, last, conversation, decision }.
import http from "node:http";

const requests = [];

const textOf = (m) =>
  typeof m?.content === "string"
    ? m.content
    : Array.isArray(m?.content)
      ? m.content.map((b) => b.text ?? "").join("")
      : "";

function agentOf(messages) {
  const sys = textOf(messages.find((m) => m.role === "system" || m.role === "developer"));
  if (sys.startsWith("You route messages")) return "router";
  if (sys.startsWith("You watch a team")) return "watcher";
  if (sys.startsWith("You check that a model")) return "tool-test";
  return /You are "([^"]+)"/.exec(sys)?.[1] ?? "?";
}

function routerReply(text) {
  if (text.includes("[[router-garbage]]")) return "I am not sure who should do this.";
  const from = /New message from (\S+):/.exec(text)?.[1];
  const members = [...(/Members: (.*)/.exec(text)?.[1] ?? "").matchAll(/([\w-]+) \(/g)].map((m) => m[1]);
  const explicit = /route=([\w,-]+)/.exec(text)?.[1]?.split(",");
  const respond = explicit ?? (from === "user" ? [members.includes("planner") ? "planner" : members[0]] : []);
  return JSON.stringify({ respond, summary: `latest from ${from}` });
}

function watcherReply(text) {
  const stalled = /\[\[stalled (\S+?)( hopeless)?\]\]/.exec(text);
  if (!stalled) return JSON.stringify({ finished: true });
  return JSON.stringify({ finished: false, next: stalled[1], say: stalled[2] ? "[[say I will get to it.]]" : "[[write nudged.txt done]]" });
}

const MARKDOWN = [
  "# Report",
  "",
  "| col a | col b |",
  "|---|---|",
  "| 1 | 2 |",
  "",
  "1. first",
  "2. second",
  "",
  "```",
  "- not a list item",
  "<script>window.__xss = 1</script>",
  "```",
  "",
  `[hover](x" onmouseover="window.__xss=2" y=")`,
  "[click](javascript:window.__xss=3)",
  "[good](https://example.com/page)",
  "<img src=x onerror=window.__xss=4>",
].join("\n");

const say = (text) => ({ kind: "text", text });
const tool = (name, args) => ({ kind: "tool", name, args });

const outages = new Map();

function decide(agent, messages, model) {
  const last = messages.at(-1);
  const slowly = /\[\[(router|watcher)-slow (\d+)\]\]/.exec(textOf(last));
  if (slowly?.[1] === agent) return { kind: "slow", seconds: Number(slowly[2]) };
  if (agent === "router") return say(routerReply(textOf(last)));
  if (agent === "watcher") return say(watcherReply(textOf(last)));
  if (model === "no-tools") return say("I cannot open files, but I am sure it is fine.");
  if (agent === "tool-test" && model === "tool-refused") return { kind: "fail", message: "No endpoints found that support tool use." };
  if (agent === "tool-test" && model === "cut-off") return { kind: "fail", message: "Your daily allowance is used up." };
  if (agent === "tool-test") return last.role === "tool" ? say(textOf(last)) : tool("read", { path: /on (.+), then reply/.exec(textOf(last))[1] });
  const flaky = /\[\[flaky (\d+)\]\]/.exec(messages.map(textOf).join("\n"));
  if (flaky && (outages.get(agent) ?? 0) < Number(flaky[1])) {
    outages.set(agent, (outages.get(agent) ?? 0) + 1);
    return { kind: "unavailable" };
  }
  const lastUser = textOf([...messages].reverse().find((m) => m.role === "user"));
  if (lastUser.includes("[[write ") && last.role === "tool" && !textOf(last).startsWith("Mentioned")) return tool("fleet_mention", { agents: ["reviewer"], text: "Please review my change." });
  const conflict = /Merging your branch \S+ into (\S+) conflicts/.exec(lastUser);
  if (conflict && last.role !== "tool") return tool("bash", { command: `git merge ${conflict[1]} -X ours -m "Resolve the conflict"` });
  if (lastUser.includes("[[runon]]")) return tool("fleet_agents", {});
  if (lastUser.includes("[[tool-then-slow]]")) return last.role === "tool" ? { kind: "slow", seconds: 4 } : tool("fleet_agents", {});
  if (lastUser.includes("[[repeat]]")) return tool("fleet_send", { to: "group", text: "Already done." });
  if (lastUser.includes("[[chatter]]")) return tool("fleet_send", { to: "group", text: `Done, checked ${messages.length} times.` });
  const inspect = /\[\[inspect ([^\]]+)\]\]/.exec(lastUser);
  if (inspect) return last.role === "tool" ? say(inspect[1]) : tool("bash", { command: "echo looked" });
  // the way of a weak model: report first, and work only when told to
  if (last.role === "tool" && textOf(last).startsWith("Not sent: you have not used a tool")) return tool("bash", { command: `echo ${agent} working` });
  if (last.role === "tool" && textOf(last).trim() === `${agent} working`) {
    const { name, arguments: sent } = messages.findLast((m) => m.tool_calls?.[0]?.function.name.startsWith("fleet_")).tool_calls[0].function;
    return tool(name, JSON.parse(sent));
  }
  if (last.role === "tool") return say(`ok (${agent})`);
  const user = textOf(last);
  const pong = /\[\[pingpong ([\w-]+) ([\w-]+)\]\]/.exec(user);
  if (pong) return tool("fleet_send", { to: agent === pong[1] ? pong[2] : pong[1], text: `[[pingpong ${pong[1]} ${pong[2]}]] your turn` });
  const routing = /Routing task for #(\S+)\./.exec(user);
  if (routing) {
    const said = /said: "([\s\S]*?)"\nCurrent summary/.exec(user)?.[1] ?? "";
    const from = /New message \(id \S+\): (\S+) said/.exec(user)?.[1];
    const explicit = /route=([\w,-]+)/.exec(said)?.[1];
    const respond = explicit ? explicit.split(",") : from === "user" ? ["planner"] : [];
    return tool("route", { channel: routing[1], respond, summary: `latest from ${from}` });
  }
  const board = /\[\[openspec ([^\]]+)\]\]/.exec(user);
  if (board) return tool("openspec", { args: board[1] });
  const run = /\[\[run ([^\]]+)\]\]/.exec(user);
  if (run) return tool("bash", { command: run[1] });
  const write = /\[\[write (\S+) ([^\]]+)\]\]/.exec(user);
  if (write) return tool("write", { path: write[1], content: write[2] });
  const saying = /\[\[say ([^\]]+)\]\]/.exec(user);
  if (saying) return say(saying[1]);
  if (user.includes("[[md]]")) return say(MARKDOWN);
  if (user.includes("[[ask]]")) return tool("ask_human", {});
  if (user.includes("[[guarded]]")) return tool("fleet_agents", {});
  if (user.includes("[[hang]]")) return { kind: "hang" };
  if (user.includes("[[fail]]")) return { kind: "fail" };
  const slow = /\[\[slow (\d+)\]\]/.exec(user);
  if (slow) return { kind: "slow", seconds: Number(slow[1]) };
  if (agent === "planner") return tool("fleet_mention", { agents: ["implementer"], text: "Please implement the feature." });
  if (agent === "implementer") return tool("fleet_mention", { agents: ["reviewer"], text: "Implementation finished, please review." });
  if (agent === "reviewer") return tool("fleet_send", { to: "group", text: "APPROVE" });
  return say(`ack from ${agent}`);
}

const chunk = (delta, finish = null) =>
  `data: ${JSON.stringify({ id: "fake", object: "chat.completion.chunk", choices: [{ index: 0, delta, finish_reason: finish }] })}\n\n`;

async function stream(res, decision, promptTokens) {
  if (decision.kind === "hang") return;
  if (decision.kind === "unavailable") {
    res.writeHead(503, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: { message: "scripted outage", type: "server_error" } }));
    return;
  }
  if (decision.kind === "fail") {
    res.writeHead(400, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: { message: decision.message ?? "scripted failure", type: "invalid_request_error" } }));
    return;
  }
  res.writeHead(200, { "Content-Type": "text/event-stream", "Cache-Control": "no-cache" });
  res.write(chunk({ role: "assistant", content: "" }));
  if (decision.kind === "slow") {
    for (let i = 0; i < decision.seconds * 4; i++) {
      res.write(chunk({ content: `working ${i} ` }));
      await new Promise((r) => setTimeout(r, 250));
    }
    res.write(chunk({}, "stop"));
  } else if (decision.kind === "tool") {
    const call = { index: 0, id: `call_${Date.now()}`, type: "function", function: { name: decision.name, arguments: JSON.stringify(decision.args) } };
    res.write(chunk({ tool_calls: [call] }));
    res.write(chunk({}, "tool_calls"));
  } else {
    res.write(chunk({ content: decision.text }));
    res.write(chunk({}, "stop"));
  }
  const usage = { prompt_tokens: promptTokens, completion_tokens: 20, total_tokens: promptTokens + 20 };
  res.write(`data: ${JSON.stringify({ id: "fake", object: "chat.completion.chunk", choices: [], usage })}\n\n`);
  res.write("data: [DONE]\n\n");
  res.end();
}

const server = http.createServer((req, res) => {
  if (req.method === "GET" && req.url === "/__log") {
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify(requests));
    return;
  }
  let body = "";
  req.on("data", (c) => (body += c));
  req.on("end", async () => {
    const { messages = [], model } = JSON.parse(body || "{}");
    const agent = agentOf(messages);
    const decision = decide(agent, messages, model);
    requests.push({
      agent,
      last: textOf(messages.at(-1)),
      conversation: messages.map(textOf).join("\n"),
      decision: decision.kind === "tool" ? `${decision.name} ${JSON.stringify(decision.args)}` : decision.kind,
    });
    await stream(res, decision, Math.ceil(body.length / 4));
  });
});

server.listen(0, "127.0.0.1", () => console.log(`fake llm on ${server.address().port}`));
