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
//   [[md]]                 -> answers with markdown, some of it hostile
//   [[tool-then-slow]]     -> calls a tool, then streams slowly
//   [[hang]]               -> never answers
//   [[fail]]               -> answers with an error that pi does not retry
//   [[runon]]              -> never ends the run: every turn calls another tool
//   [[repeat]]             -> never ends the run: every turn posts the same message
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

function decide(agent, messages) {
  const last = messages.at(-1);
  if (agent === "router") return say(routerReply(textOf(last)));
  const lastUser = textOf([...messages].reverse().find((m) => m.role === "user"));
  if (lastUser.includes("[[write ") && last.role === "tool" && !textOf(last).startsWith("Mentioned")) return tool("fleet_mention", { agents: ["reviewer"], text: "Please review my change." });
  const conflict = /Merging your branch \S+ into (\S+) conflicts/.exec(lastUser);
  if (conflict && last.role !== "tool") return tool("bash", { command: `git merge ${conflict[1]} -X ours -m "Resolve the conflict"` });
  if (lastUser.includes("[[runon]]")) return tool("fleet_agents", {});
  if (lastUser.includes("[[tool-then-slow]]")) return last.role === "tool" ? { kind: "slow", seconds: 4 } : tool("fleet_agents", {});
  if (lastUser.includes("[[repeat]]")) return tool("fleet_send", { to: "group", text: "Already done." });
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
  if (decision.kind === "fail") {
    res.writeHead(400, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: { message: "scripted failure", type: "invalid_request_error" } }));
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
    const messages = JSON.parse(body || "{}").messages ?? [];
    const agent = agentOf(messages);
    const decision = decide(agent, messages);
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
