# pi-fleet

Multi-agent fleet for [pi](https://pi.dev): run several **named** pi agent sessions
concurrently, chat with them across **named channels** (each routed by a **supervisor** that
wakes only the agents who need to act), let them **message each other**, and coordinate work
through **OpenSpec**.

```
fleet> # refactor the parser and add tests
• [12:01:02] user → #group refactor the parser and add tests
  ⟳ [alice] working…
  ⚙ [alice] bash
  ✓ [alice] settled
• [12:01:40] alice → #group proposal drafted: openspec/changes/parser-refactor
• [12:01:44] alice → @bob review openspec/changes/parser-refactor when you can
  ⟳ [bob] working…
```

## How it works

- `fleet up` is a supervisor: for each agent it spawns a **bridge** process
  (`src/bridge.ts`) that owns a `pi --mode rpc` child and exposes it over named pipes
  (`\\.\pipe\pi-fleet-<hash>-in/out`). The bridge is spawned **detached** (a single
  `node tsx` process, clean tree: supervisor → node(bridge) → pi), so agents survive the
  supervisor exiting — that's what makes `--detach` and auto-resume possible. The
  supervisor talks to each agent through `PiRpcBridge` (a named-pipe JSONL client, same
  interface as the direct `PiRpc` child-process client).
- Every agent loads the **fleet extension** (`src/extension/index.ts`) which gives it:
  - `fleet_send` — message the group or a specific agent (supports `replyTo` threading)
  - `fleet_mention` — post to the group @mentioning one or more agents; only they wake
  - `fleet_inbox` — read recent messages (each shown with a short id + reply context)
  - `fleet_agents` — who's in the fleet and their status
  - `route` — **supervisor tool**: route a channel message to the members who should act and update the channel's rolling summary (see Channels below)
  - `openspec` — run the OpenSpec CLI (proposals, tasks, validate, archive)
  - `/agents`, `/send`, `/group` slash commands
  - a `fleet` section in the system prompt, including a **live roster** of the other
    agents (rebuilt every turn from `agents.json`, so agents always know their peers)
  - **inbox polling**: when a relevant message arrives and the agent is idle, it is
    woken automatically with that message.
- **Direct wake (real-time)**: while the supervisor is attached it is the wake authority —
  it pushes each agent's wake straight over RPC (`rpc.prompt`) as soon as a relevant message
  hits the bus (~700ms, not the 3s poll). A busy agent gets the wake as a follow-up to its
  current run; a wake that pi refuses (e.g. mid-compaction) is retried for about a minute,
  and one that cannot land posts a `was not delivered` system message to `#group`. A
  supervisor **heartbeat** tells each agent's poller to stay dormant while attached (no
  double-wake); when the supervisor exits/detaches the heartbeat goes stale and the poller
  resumes self-waking, so detached mode still works.
- **Channels & supervisor routing** (see `wakeDecision` / `route`): a **channel** is a named
  group chat with a member list and a **supervisor** (stored in `channels.json`). A channel
  message that @mentions members goes straight to them (no routing turn; the summary is not
  updated). Otherwise only the supervisor wakes (in `route` mode); it calls `route`, once per
  message, to pick the members who should act and to update the channel's rolling summary. An
  agent cannot address itself: `fleet_send` and `fleet_mention` refuse that, because it would
  wake nobody, and tell the model to do the work in its current turn. `route` DMs each chosen
  member a message carrying the original request **plus the summary** (context without the full
  transcript) and persists the summary. A member's reply re-wakes the supervisor, which routes
  again (usually to nobody, ending the turn). This replaces the old N-way broadcast: one cheap
  routing call per message + only the relevant members. The default `#group` channel is
  auto-created on startup (all agents as members, an agent with role `supervisor` — else the
  first agent — as the router). Channels are managed in the GUI (Settings → Channels), the CLI
  (`/channel add|rm|list`), or by posting `#name message` to the bus.
- **Waking semantics** (see `wakeDecision`):
  - a **DM** (`to=<agent>`) wakes that agent;
  - a channel message **@mentioning** members wakes only those members — mentions always
    win, so `fleet_mention` can hand work to a specific agent, even from the supervisor;
  - any other channel message wakes the supervisor (or, with no supervisor, all members);
  - without a channel config, `group` falls back to the legacy rules: a **reply**
    (`replyTo`, no mention) wakes only the thread's participants, and a message with **no
    mention and no reply** is a broadcast (wakes everyone).
- **Runaway protection**: three brakes, because a model that never stops costs real money.
  - `--max-turns N` (default 100): an agent is aborted after N turns in one run. It covers a
    model that never ends its turn. Each agent counts for itself, so this also holds in
    detached mode.
  - `--max-hops N` (default 40): after N agent messages since your last message the fleet
    **pauses**. It covers agents waking each other in a loop. Attached, the supervisor
    enforces it; detached, each agent's poller does.
  - **Stop all** (GUI button, or `/stopall` in the terminal) aborts every run, drops queued
    messages and pauses the fleet.

  A paused fleet stays up, but agent messages stay on the bus and wake nobody; those held
  messages are not delivered later. Your next message, to a channel or directly to an agent,
  resumes the fleet and restarts the hop count. `0` turns a limit off. Both limits can also be
  set in `fleet.json` (`maxTurns`, `maxHops`); a flag wins over the config, and agents that
  re-attach keep the turn limit they started with.
- **Message limits**: each bus message is capped at `MAX_MESSAGE_LEN` chars (default
  2000, override with `PI_FLEET_MAX_MSG`); longer text is truncated with a marker and
  `fleet_send` tells the agent so it can split it.
- **Detached mode + auto-resume**: `--detach` keeps agents running when you `/quit`
  (the bridges survive). Re-running `fleet up` **auto-resumes** — it re-attaches to any
  bridge still alive (registry pid alive + pipes present) instead of re-spawning, so
  agents keep their session context. `/new` re-attaches the same way; `fleet up` with no
  agents re-attaches to everything still alive. A normal `/quit` (no `--detach`) kills
  each bridge tree (`taskkill /T`).
- The shared state is a plain directory (`.pi-fleet/`): `messages.jsonl` (append-only
  bus) and `agents.json` (registry, incl. each agent's pipe paths). Human-readable,
  debuggable, survives restarts.

## Setup

```bash
npm install
```

Requires `pi` on PATH (global `@earendil-works/pi-coding-agent`) and working
model/auth config in `~/.pi`.

## Usage

```bash
# start the fleet + group chat (agents named, optional per-agent cwd + model)
npm run fleet -- up --agent alice --agent bob:./other-project

# heterogeneous fleet: per-agent model in the spec (name[:cwd][:model])
# lean is auto-applied to the small model (4B), not the 27B
npm run fleet -- up --agent "planner::hf-space-qwen38/huihui-qwen3.8-27b-abliterated" \
                     --agent "worker::local-llm-lab/Qwen/Qwen3-4B-AWQ"

# force lean on/off for every agent (overrides auto-detect)
npm run fleet -- up --lean --agent alice --agent bob
npm run fleet -- up --no-lean --agent alice --agent bob

# spawn more agents live from the chat:
fleet> /new carol ./third-project
fleet> /agents
fleet> /stop bob

# detached mode: agents keep running after you /quit
npm run fleet -- up --detach --agent alice --agent bob
# ... later, re-attach (auto-resume) — agents keep their session context:
npm run fleet -- up --agent alice --agent bob
# or with no agents, re-attach to everything still alive:
npm run fleet -- up

# standalone commands
npm run fleet -- list
npm run fleet -- stop [name|all]
npm run fleet -- log [name]
```

Group chat input:

| Input | Effect |
|---|---|
| `# text` or plain text | post to the default `#group` channel |
| `#name text` | post to a named channel (routed by its supervisor) |
| `@name text` | direct message to one agent |
| `/agents` | list agents + status |
| `/stats` | per-agent token + cost usage |
| `/channel` | list channels; `/channel add <name> <m1,m2> [sup]`; `/channel rm <name>` |
| `/new name [cwd] [model]` | spawn an agent |
| `/stop name` | stop an agent |
| `/stopall` | abort every run and pause the fleet until your next message |
| `/quit` | stop all, exit |

## GUI (web UI)

A minimal web UI streams the live fleet state and the full RPC-event data flow —
group chat plus one pane per agent showing token streaming, thinking, and tool calls
as they happen. It's a plain Node HTTP server (SSE for server→client, HTTP POST for
client→server) with no extra dependencies.

```bash
npm run fleet -- up --gui --agent "planner::hf-space-qwen38/huihui-qwen38-27b-abliterated" --agent "worker::local-llm-lab/Qwen/Qwen3-4B-AWQ"
# prints: 🖥  GUI: http://127.0.0.1:<port>/?token=<token>
```

Open the printed link: the token in it is what grants access, and the page keeps it in
a cookie for 30 days. Every request needs that token (the agents behind this server can
run commands), and requests from another site's page are refused. The token is stored in
`<dir>/gui-token` and stays the same across restarts; scripts can send it as
`Authorization: Bearer <token>`. To revoke access, delete the file and restart the fleet.

- `--gui` — start the web UI (the terminal chat still works alongside it).
- `--open` — also launch the browser automatically.
- `--port N` — bind a fixed port (default: a free port is chosen).
- `--host H` — bind address (default `127.0.0.1`; use `0.0.0.0` for LAN access).

In the UI: send to `#group` or `@<agent>` from the composer; each agent pane shows a
live activity feed (tool calls, streamed output, run state) and a status badge.

### Headless hosting (`fleet serve`)

Run the fleet headless (no terminal chat) and serve the web UI — useful for hosting
it on a machine or sharing it over the network. The fleet comes from `--agent` flags,
a `--template`, or `fleet.json`:

```bash
npm run fleet -- serve --host 0.0.0.0 --port 8080   # LAN-accessible web UI
```

The server speaks plain HTTP, so on a shared network the token can be sniffed: put it
behind a TLS proxy or a VPN, because whoever has the link controls the agents.

## Desktop app (Electron)

`npm run desktop` wraps the web UI in a native window. The Electron main process
(`electron/main.mjs`) launches the fleet supervisor as a child process and loads its
web UI into a BrowserWindow; closing the window kills the supervisor's whole process
tree (supervisor → bridges → pi). The fleet composition comes from `fleet.json` (below),
so the app knows what to spawn without a long CLI.

```bash
npm run desktop
```

## Fleet config

`<hub>/fleet.json` describes the fleet — a stable, user-editable alternative to a long
`--agent` command line. With no `--agent` flags, `fleet up` (and the desktop app) spawn
the agents listed here.

```bash
npm run fleet -- init      # create a starter .pi-fleet/fleet.json
npm run fleet -- config    # show it
```

```json
{
  "defaultModel": "provider/model",
  "agents": [
    { "name": "planner", "cwd": ".", "role": "planner" },
    { "name": "worker", "cwd": "./my-project", "model": "other/model", "role": "implementer" }
  ]
}
```

## Fleet templates

For common crews, `--template` expands to a set of agents in one word (sugar for
`--agent` flags). Built-in templates: `sdlc` (planner + implementer + reviewer),
`pair` (implementer + reviewer), `solo` (one implementer).

```bash
npm run fleet -- templates                       # list templates
npm run fleet -- up --template sdlc --model provider/model
```

## Session naming

Each agent's pi session can be given a display name (shows up in pi's session
listings). Two ways:

```bash
npm run fleet -- rename <agent> <session-name>   # CLI
```

or click the **name** button on an agent's pane in the GUI. Both forward pi's
`set_session_name` over RPC.

## Agent spec

`--agent` takes `name[:cwd][:model][:role]`:

| Spec | Effect |
|---|---|
| `alice` | name only, default cwd + `--model` |
| `alice:./proj` | name + cwd |
| `alice:./proj:provider/model` | name + cwd + model |
| `alice::provider/model` | name + default cwd + model |
| `alice::provider/model:planner` | name + model + **role preset** |
| `alice:C:\proj:provider/model` | name + **Windows cwd** + model |

The per-agent model overrides the global `--model`, so you can mix models in one
fleet (e.g. a strong planner + cheap workers). A Windows drive-letter path in the
cwd segment (`C:\...`) is handled — the drive-letter `:` is not mistaken for a field
separator. `/new name [cwd] [model] [role]` accepts the same parts live from the chat.

### Roles

The optional `role` segment injects a role-specific prompt preset:

- **`planner`** — breaks goals into openspec tasks, assigns work by @mentioning an
  implementer, tracks progress. Does not implement code itself.
- **`implementer`** — implements assigned tasks, follows the quality gate (validate
  before marking done), @mentions the reviewer when a task is complete.
- **`reviewer`** — inspects a change, runs `openspec validate`, smoke-tests, and
  replies `APPROVE` or `REQUEST CHANGES: <reasons>`.

## Local / weak models

pi's default system prompt embeds **every installed skill** (~15–20 KB) plus 10
built-in tools. That alone is ~3000 tokens, which exceeds the context of a small
local model (e.g. a 4B on a 4 GB GPU, where vLLM's `max_model_len` is capped by
KV-cache memory). **Lean mode** shrinks the prompt:

- `--no-skills` — drop the skills section
- `--no-context-files` — skip AGENTS.md / CLAUDE.md discovery
- `--exclude-tools web_search,source_check,fetch_content,get_search_content,ask_user`
  — drop the web/research tools the fleet rarely needs
- a **compact fleet section** in the system prompt (the extension detects lean via
  `PI_FLEET_LEAN`)

Together these cut the system prompt ~8× (measured 25.7 KB → 3.0 KB).

### Lean is auto-detected

You usually don't need to think about it. On startup, `fleet up` probes each
unique model's `contextWindow` (via a short-lived `pi --mode rpc` `get_state`,
cached per model) and **applies lean automatically when the window is below
16 384 tokens**. So a 4B local model (8k window) runs lean, while a 27B (128k)
or cloud model (200k) runs full. Override with:

- `--lean` — force lean on (all agents)
- `--no-lean` — force lean off (all agents)

The spawn line shows the resolved mode, e.g.
`+ [worker] spawned (… model=local-llm-lab/Qwen/Qwen3-4B-AWQ lean)`.

> Note: a 4B model is weak enough to muddle multi-step instructions (e.g. mixing
> up who says "ping" vs "pong"), but it reliably calls `fleet_send` and the bus
> delivers — the architecture holds. For dependable multi-agent reasoning, use a
> 7B+ model or a strong cloud model.

## OpenSpec workflow

Each agent runs OpenSpec in **its own cwd**, so specs live in the project the
agent works on. Typical flow: agent A drafts a change proposal
(`openspec/changes/<id>/proposal.md`, `tasks.md`), tells agent B via
`fleet_send`, B reviews/validates (`openspec validate <id>`), work is tracked in
`tasks.md`, and the change is archived when done.

Run `openspec init` in a project cwd first if it has no `openspec/` directory.

## Task board (beads)

OpenSpec is the default task board, but the fleet can use **beads** (the `bd` CLI) instead. Set `PI_FLEET_TASKBOARD=beads` when launching — the supervisor passes it to the agents, which then get a `beads` tool (instead of `openspec`) and a task-board-aware prompt:

```bash
PI_FLEET_TASKBOARD=beads npm run fleet -- up --agent "worker:./my-project"
```

Requires `bd` on PATH (on Windows, `bd.exe`). Run `bd init` once in a project cwd before agents use it. The agent creates issues (`bd create <title>`), lists them (`bd list`), and closes them when done (`bd close <id>`).

## Files

```
src/fleet.ts           supervisor + group chat CLI (+ serve/init/config/templates/rename)
src/rpc.ts             pi RPC client (JSONL) — direct child + named-pipe bridge client
src/bridge.ts          detached bridge process owning a pi child over named pipes
src/hub.ts             file-based message bus + agent registry (+ rotation, stats, heartbeat)
src/config.ts          fleet.json loading/saving (default model + per-agent config)
src/templates.ts       named fleet presets (--template sdlc|pair|solo)
src/gui.ts             web UI server (SSE + POST, no deps)
src/gui.html           single-page web UI
src/extension/index.ts pi extension loaded by each agent (tools, prompt, poller, roles)
electron/main.mjs      Electron desktop shell (npm run desktop)
test/                  vitest suite (unit tests + e2e with real pi and a scripted model)
.pi-fleet/             runtime state (created on first run)
```

## Development

```bash
npm test         # run the vitest suite (about 2 minutes: the e2e tests boot real agents)
npm run typecheck   # tsc --noEmit
```

The suite covers the file-bus offset reads, JSONL RPC framing (split-line reassembly,
events, id-matching, timeouts — against a fake `pi --mode rpc` server), the agent-side
poller (wake-on-mention, busy buffering, rotation offset reset), and GUI access control.
Polling logic lives in a testable `createPoller` unit; `PI_FLEET_POLL_MS` and the RPC
timeout are configurable so tests run fast.

`test/e2e.test.ts` runs the real supervisor, bridges and pi against `test/fake-llm.mjs`, a
scripted OpenAI-compatible endpoint. It covers what the unit tests cannot see: a message
actually travelling through the fleet (the sdlc chain, a busy agent, detached channels) and
the brakes stopping real runs (hop and turn limits, Stop all).

## Backlog

See [BACKLOG.md](BACKLOG.md).

## License

Licensed under the [Apache License, Version 2.0](LICENSE).