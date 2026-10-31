/**
 * The terminal chat's input language: slash commands and addressed messages.
 * Parsing is separate from acting on it so every path can be unit-tested.
 */

export type ChatLine =
  | { kind: "empty" }
  | { kind: "command"; name: string; args: string }
  | { kind: "message"; to: string; text: string }
  | { kind: "error"; message: string };

/** Commands and whether they need arguments. */
const COMMANDS: Record<string, string | undefined> = {
  help: undefined,
  agents: undefined,
  stats: undefined,
  channel: undefined,
  stopall: undefined,
  resume: undefined,
  quit: undefined,
  exit: undefined,
  new: "/new name [cwd] [model] [role]",
  stop: "/stop name",
  restart: "/restart name",
  answer: "/answer name text",
  budget: "/budget dollars",
};

export const CHAT_HELP = `  # text          post to the group
  #name text      post to a named channel
  @name text      direct message
  text            post to the group
  /agents         list agents
  /stats          per-agent token + cost usage
  /channel        list channels; /channel add <name> <m1,m2> [sup]; /channel rm <name>
  /new name [cwd] [model] [role]   spawn an agent
  /stop name      stop an agent
  /restart name   restart an agent; it keeps its conversation
  /stopall        abort every run and pause the fleet until your next message
  /resume         lift a pause and deliver the messages it held back
  /answer name x  answer an agent's question
  /budget N       change the spending limit, in dollars
  /quit           stop all and exit
  /help           this list`;

export function parseChatLine(line: string): ChatLine {
  const input = line.trim();
  if (!input) return { kind: "empty" };

  // a word after the slash is a command; a path such as /tmp/out.log is a message
  const command = /^\/([A-Za-z]+)(?:\s+([\s\S]*))?$/.exec(input);
  if (command) {
    const name = command[1];
    const args = (command[2] ?? "").trim();
    if (!(name in COMMANDS)) return { kind: "error", message: `unknown command "/${name}". Type /help for the list, or "# /${name} ..." to post it as a message.` };
    const usage = COMMANDS[name];
    if (usage && !args) return { kind: "error", message: `usage: ${usage}` };
    return { kind: "command", name, args };
  }

  if (input.startsWith("@")) {
    const m = /^@(\S+)\s+([\s\S]+)$/.exec(input);
    return m ? { kind: "message", to: m[1], text: m[2] } : { kind: "error", message: "usage: @name message" };
  }
  if (input.startsWith("# ")) {
    const text = input.slice(2).trim();
    return text ? { kind: "message", to: "group", text } : { kind: "error", message: "usage: # message" };
  }
  if (input.startsWith("#")) {
    const m = /^#(\S+)\s+([\s\S]+)$/.exec(input);
    return m ? { kind: "message", to: m[1], text: m[2] } : { kind: "error", message: "usage: #name message   (or '# message' for the group)" };
  }
  return { kind: "message", to: "group", text: input };
}
