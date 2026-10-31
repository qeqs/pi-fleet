// Minimal fake `pi --mode rpc` server for framing tests. Speaks JSONL:
// - responds to {type:"prompt"} with a response (split across two writes to
//   exercise line reassembly) and emits an event first.
// - responds to {type:"get_state"}.
import fs from "node:fs";

let buf = "";
process.stdin.on("data", (chunk) => {
  buf += chunk.toString("utf8");
  let idx;
  while ((idx = buf.indexOf("\n")) >= 0) {
    const line = buf.slice(0, idx).replace(/\r$/, "");
    buf = buf.slice(idx + 1);
    if (!line.trim()) continue;
    let cmd;
    try {
      cmd = JSON.parse(line);
    } catch {
      continue;
    }
    if (cmd.type === "prompt") {
      process.stdout.write(JSON.stringify({ type: "event", name: "test_event", data: { hello: "world" } }) + "\n");
      const resp = JSON.stringify({ type: "response", id: cmd.id, ok: true, result: `pong-${cmd.message}`, streamingBehavior: cmd.streamingBehavior });
      if (cmd.message === "ping") {
        // Single-prompt framing test: split across two writes (partial line) to
        // exercise reassembly. Only for "ping" so concurrent prompts don't interleave.
        process.stdout.write(resp.slice(0, 12));
        setTimeout(() => process.stdout.write(resp.slice(12) + "\n"), 15);
      } else {
        process.stdout.write(resp + "\n");
      }
    } else if (cmd.type === "get_state") {
      process.stdout.write(JSON.stringify({ type: "response", id: cmd.id, ok: true, state: { agents: [] } }) + "\n");
    }
  }
});

process.on("SIGTERM", () => process.exit(0));