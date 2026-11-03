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
- **Channels & routing** (see `wakeDecision`, `src/router.ts`): a **channel** is a named group
  chat with a member list (stored in `channels.json`). A message addressed to members goes
  straight to them. Any other message goes to the **router**, which is not an agent: rules settle
  what needs no judgement (`APPROVE` ends the turn, `REQUEST CHANGES` goes to the implementers),
  and the rest get one short model call from a bare pi process that starts from nothing each
  time, so routing neither grows a worker's context nor waits for one. It DMs each chosen member
  the request plus a rolling summary (context without the full transcript), and each decision
  shows in the channel. Set a cheap model with `--router-model`, `routerModel` in `fleet.json`, or
  `supervisorModel` on a channel; it defaults to `--model`. If the router fails, the message goes
  to the planner or the first running member, with a notice. To have an agent route instead, give
  it the `supervisor` role (for `#group`) or name it as a channel's supervisor; it then uses the
  `route` tool, once per message. An agent cannot address itself: `fleet_send` and `fleet_mention`
  refuse that, because it would wake nobody, and tell the model to do the work in its current
  turn. In detached mode there is no supervisor process to run the router, so a channel's first
  member routes. The default `#group` channel is auto-created on startup with all agents as
  members. Channels are managed in the GUI (Settings → Channels), the CLI (`/channel add|rm|list`),
  or by posting `#name message` to the bus.
- **Waking semantics** (see `wakeDecision`):
  - a **DM** (`to=<agent>`) wakes that agent;
  - a channel message **addressed** to members wakes only those members, even from the
    supervisor. A person addresses everyone they @name. An agent addresses the names its message
    opens with, which is what `fleet_mention` writes: a name later on ("thanks @rev") is a
    reference, and waking someone costs a whole turn;
  - any other channel message goes to the router, or to the channel's supervisor agent, so
    "ready for review, @rev" still reaches the reviewer;
  - messages for an agent in the middle of a run wait until it settles, and arrive as one wake;
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

  - `--max-cost N`: at N dollars, every run is aborted and the fleet pauses. Cost is read
    after each turn, so one turn can overshoot; it counts all spending recorded in this hub.
    Raise it with `/budget N` or in Settings → Usage. It needs a supervisor attached.

  A paused fleet stays up, but agent messages stay on the bus and wake nobody. Your next
  message, to a channel or directly to an agent, resumes the fleet and restarts the hop count;
  the held messages stay undelivered. To continue the chain instead, use **Resume and deliver**
  in the GUI or `/resume` in the terminal. `0` turns a turn or hop limit off. All three can be
  set in `fleet.json` (`maxTurns`, `maxHops`, `maxCost`); a flag wins over the config, and agents
  that re-attach keep the turn limit they started with.
- **Questions and approvals**: when an agent asks something (`ctx.ui.confirm`, `select`, `input`
  or `editor`), it shows as waiting, the question appears at the top of the GUI and in `#group`,
  and you answer there or with `/answer name text`. A questionnaire from pix-ask's `ask_user`, which
  pi cannot draw in RPC mode, comes one question at a time the same way. `--approve bash,write`
  (or `approve` per agent in `fleet.json`) makes those tools ask first; declined calls are blocked.
  Nobody can answer in detached mode, so an agent that asks waits until a supervisor re-attaches.
- **Failures are visible**: a crashed agent is marked stopped with a notice in `#group`, and
  its channels move to a running member. A run that ends in a model error says so, and so does
  a model that stays silent mid-turn for 5 minutes (`PI_FLEET_STALL_MS`, `0` turns it off; only
  the wait for the model is timed, not tools). Only one supervisor can attach to a hub.
- **Models that are away for a while**: after pi's own quick retries, a run that ended in a
  connection error, a 429, a 5xx or a provider error is tried again by the fleet after 30 seconds,
  2 minutes and 5 minutes (`PI_FLEET_RETRY_WAITS`, in milliseconds), and only then given up on. A
  bad key, an unknown model or a limit per day is not. A person's message, Stop all, a pause or a
  new wake cancels a waiting try. The wait does not survive the agent itself crashing.
- **Models that talk instead of working**: a message reaches the chat only through a tool call, so
  a model that chats can use tools; a weak one just reports work instead of doing it. Agents are
  told that a message does no work, and the first message an implementer or reviewer sends after a
  wake is refused until it has used a tool. If it sends again, it goes through: it may be a real
  question. When a crew has been silent for 30 seconds (`PI_FLEET_QUIET_MS`, `0` turns it off) with
  nothing running or waiting, and no approval of someone else's work has ended the job, the router
  gets the task, the tools each agent really used and what was said. It either leaves the crew
  alone or sends one member back to work, at most twice, and then tells you that the work is
  unfinished. If the router gives no answer it tries again, three times in all, and then tells you
  that it cannot say. This needs a supervisor, and it watches work given to a channel, not a direct
  message.
- **Models that write in the wrong place**: a weak model can make up a path, and the write works, so
  it reports success while the project stays empty. A `write` or `edit` outside an agent's working
  folder is refused once and the agent is told where to write; if it tries again, it goes through.
  A call that was refused or declined does not count as work.
- **Message limits**: a message is refused, never cut, above `MAX_MESSAGE_LEN` chars (default
  2000, override with `PI_FLEET_MAX_MSG`): you see the reason, and an agent is told to split it.
  A run may send 6 messages with nothing new coming in, and is stopped if it ignores two refusals.
- **Surviving restarts**: agents keep their conversation across a restart (`--fresh` starts new
  ones). A wake is written to a per-agent inbox before it is sent and cleared once the agent
  settles, and the supervisor saves its place on the bus, so a crash at any point loses no
  message: one posted to a stopped agent waits for it, and work cut off by a crash is resumed
  with a note saying so. Work you stopped yourself is not resumed. Crashed agents restart up to
  3 times in 10 minutes (`--no-restart` turns this off), and `/restart name` does it by hand.
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

[GETTING_STARTED.md](GETTING_STARTED.md) goes from nothing to a finished task. In short:

```bash
npm install -g github:qeqs/pi-fleet#v1.2.2
```

or use a desktop installer from the [releases page](https://github.com/qeqs/pi-fleet/releases/latest),
which needs no Node. Either way, pi needs a working model config in `~/.pi`.

## Usage

```bash
# start the fleet + group chat (agents named, optional per-agent cwd + model)
fleet up --agent alice --agent bob:./other-project

# heterogeneous fleet: per-agent model in the spec (name[:cwd][:model])
# lean is auto-applied to the small model (4B), not the 27B
fleet up --agent "planner::hf-space-qwen38/huihui-qwen3.8-27b-abliterated" \
                     --agent "worker::local-llm-lab/Qwen/Qwen3-4B-AWQ"

# force lean on/off for every agent (overrides auto-detect)
fleet up --lean --agent alice --agent bob
fleet up --no-lean --agent alice --agent bob

# spawn more agents live from the chat:
fleet> /new carol ./third-project
fleet> /agents
fleet> /stop bob

# detached mode: agents keep running after you /quit
fleet up --detach --agent alice --agent bob
# ... later, re-attach (auto-resume) — agents keep their session context:
fleet up --agent alice --agent bob
# or with no agents, re-attach to everything still alive:
fleet up

# standalone commands
fleet list
fleet stop [name|all]
fleet log [name]
fleet doctor     # check pi, the hub, the config and the models
fleet help
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
| `/restart name` | restart an agent; it keeps its conversation |
| `/stopall` | abort every run and pause the fleet until your next message |
| `/resume` | lift a pause and deliver the messages it held back |
| `/answer name text` | answer an agent's question |
| `/budget N` | change the spending limit, in dollars |
| `/diff name` | list what an agent changed in its worktree |
| `/merge name` | merge an agent's worktree into its base branch |
| `/help` | list these commands |
| `/quit` | stop all, exit |

## GUI (web UI)

A minimal web UI streams the live fleet state and the full RPC-event data flow —
group chat plus one pane per agent showing token streaming, thinking, and tool calls
as they happen. It's a plain Node HTTP server (SSE for server→client, HTTP POST for
client→server) with no extra dependencies.

```bash
fleet up --gui --agent "planner::hf-space-qwen38/huihui-qwen38-27b-abliterated" --agent "worker::local-llm-lab/Qwen/Qwen3-4B-AWQ"
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

Everything day to day happens in the page, with no terminal or config file:

- **First run**: with no agents, pick a crew and a model, and the fleet starts and remembers it.
- **Chat**: send to a channel or an agent from the composer. Each agent pane shows a live feed of
  tool calls, streamed output and run state. Agent output is rendered as Markdown (tables, lists,
  code) from escaped pieces, so nothing an agent writes can run in the page. What the fleet sends
  an agent is collapsed, so you can tell it from what you typed. Drafts, open tool cards and your
  scroll position survive streaming and reconnects.
- **Agents**: `Abort run`, `Restart`, `Stop agent` and `Remove` on each agent, and a model picker
  fed by pi's own list. A stopped agent has a `Start` button.
- **Settings**: `Fleet` edits `fleet.json`, `Channels` manages channels and who routes them
  (including `#group`), `Usage` shows spending and the limit, `Search` finds any message,
  archives included. `Clear` hides a channel's messages for everyone; they stay searchable.
- **Models**: Settings → `Models` lists what pi knows, tests that a model answers, sets the default
  and routing models, and adds servers and API keys. A model is tested before a crew starts, and
  a model error shows in the agent's chat with what went wrong.
- **Reviewing work**: an agent in a worktree has a `Changes` button, showing its diff and a
  `Merge` button. Settings also has `Tasks`, the agents' task board, and `Timeline`, which
  shows for each request who woke whom, why, and what it cost. Costs are the spending between
  one request and the next, so requests that overlap share it.
- **Staying informed**: unread counts in the sidebar and the page title, and a desktop
  notification when an agent asks you something or the fleet pauses while the page is hidden.

### Headless hosting (`fleet serve`)

Run the fleet headless (no terminal chat) and serve the web UI — useful for hosting
it on a machine or sharing it over the network. The fleet comes from `--agent` flags,
a `--template`, or `fleet.json`:

```bash
fleet serve --host 0.0.0.0 --port 8080   # LAN-accessible web UI
```

The server speaks plain HTTP, so on a shared network the token can be sniffed: put it
behind a TLS proxy or a VPN, because whoever has the link controls the agents.

## Desktop app (Electron)

The desktop app wraps the web UI in a native window, and needs no Node on the machine. The
Electron main process (`electron/main.mjs`) launches the fleet supervisor as a child process
and loads its web UI into a BrowserWindow; closing the window kills the supervisor's whole
process tree (supervisor → bridges → pi).

It works on one project folder at a time, whose fleet lives in `<folder>/.pi-fleet`. **File →
Open Project** and **Open Recent** move between folders, and the last one reopens at launch.
The app asks before opening a new folder that brings its own fleet or pi configuration.

Installers are on the [releases page](https://github.com/qeqs/pi-fleet/releases/latest). From a
checkout, `npm run desktop` runs the app, and `npm run dist` builds an installer for your system.

## Fleet config

`<hub>/fleet.json` describes the fleet — a stable, user-editable alternative to a long
`--agent` command line. With no `--agent` flags, `fleet up` (and the desktop app) spawn
the agents listed here.

```bash
fleet init      # create a starter .pi-fleet/fleet.json
fleet config    # show it
```

```json
{
  "defaultModel": "provider/model",
  "worktrees": true,
  "taskboard": "openspec",
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
fleet templates                       # list templates
fleet up --template sdlc --model provider/model
```

## Session naming

Each agent's pi session can be given a display name (shows up in pi's session
listings). Two ways:

```bash
fleet rename <agent> <session-name>   # CLI
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

- **`planner`** — breaks goals into tasks, using openspec for work of several steps, and
  gives them to an implementer in one message, which ends its run. Does not implement code itself:
  with an implementer in the crew, a file it writes outside `openspec/` is refused once.
- **`implementer`** — implements assigned tasks, follows the quality gate (validate
  before marking done), and @mentions the reviewer once when everything is done.
- **`reviewer`** — acts only when asked. Inspects a change, runs `openspec validate`,
  smoke-tests, and sends one verdict, `APPROVE` or `REQUEST CHANGES: <reasons>`. `APPROVE`
  ends the job.

Every agent is told to send a message only to hand off work, ask something that blocks it, or
report a finished result, and never just to acknowledge. A weak model can still write its verdict
in its own chat instead of sending it, so the fleet posts that verdict to the channel the work
came from. Any other text stays in the agent's chat.

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

OpenSpec is the default task board, but the fleet can use **beads** (the `bd` CLI) instead. Set `"taskboard": "beads"` in `fleet.json`, or pass `--taskboard beads`. Agents then get a `beads` tool (instead of `openspec`) and a task-board-aware prompt, and Settings → Tasks shows that board. `PI_FLEET_TASKBOARD=beads` still works when neither is set.

```bash
fleet up --taskboard beads --agent "worker:./my-project"
```

Requires `bd` on PATH (on Windows, `bd.exe`). Run `bd init` once in a project cwd before agents use it. The agent creates issues (`bd create <title>`), lists them (`bd list`), and closes them when done (`bd close <id>`).

## Parallel work

With `--worktrees` (or `"worktrees": true` in `fleet.json`), implementers and agents with no role
each get a git worktree under `<hub>/worktrees/<agent>` and a branch `fleet/<agent>`, so two of
them can change one repository at once without touching each other's files or the checkout you
are on. Reviewers and planners stay in the main checkout and read the path an implementer gives
them. `"worktree": true` or `false` on an agent in `fleet.json` overrides this.

```bash
fleet up --worktrees \
  --agent "impl1:./my-project::implementer" \
  --agent "impl2:./my-project::implementer" \
  --agent "reviewer:./my-project::reviewer"
```

When a review is done, open `Changes` on the agent in the GUI and press `Merge`, or use `/diff`
and `/merge` in the terminal. Merging commits whatever the agent left uncommitted, merges its
branch into the branch that was checked out when the worktree was made, and brings the agent up
to date. It refuses while the agent is working, while that branch is not checked out, and while
it has uncommitted changes. If the merge conflicts, nothing changes: the agent is asked to merge
the base into its branch and resolve it, and you merge again once it says it is done.

A worktree holds tracked files only, so each one needs its own install step, such as `npm ci`.
Removing an agent leaves its branch and worktree in place. In a folder that is not a git
repository, the agent works in place and the fleet says so.

## Files

```
src/fleet.ts           entry point: dispatches the fleet commands
src/cli.ts             argument parsing and usage text
src/supervisor.ts      fleet up/serve: spawns agents, tails the bus, GUI, terminal chat
src/spawn.ts           starting agents: lean detection, bridges, process-tree kill
src/wakes.ts           who a batch of bus messages wakes, and with what text
src/commands.ts        one-shot commands (list/stop/log/init/config/templates/rename)
src/chat.ts            the terminal chat's input language
src/doctor.ts          fleet doctor: checks a setup
src/restart.ts         when to bring a crashed agent back
src/questions.ts       questions from agents to the human
src/router.ts          the dedicated channel router: rules, then one short model call
src/worktree.ts        a git worktree per agent: create, diff, merge
src/programs.ts        starting other programs by full path, never in a shell
src/hubformat.ts       the hub's format version, and upgrades from earlier releases
src/taskboard.ts       reads the OpenSpec or beads board for the GUI
src/timeline.ts        who woke whom for each request, and what it cost
src/rpc.ts             pi RPC client (JSONL) — direct child + named-pipe bridge client
src/bridge.ts          detached bridge process owning a pi child over named pipes
src/hub.ts             file-based message bus + agent registry (+ rotation, stats, heartbeat)
src/config.ts          fleet.json loading/saving (default model + per-agent config)
src/templates.ts       named fleet presets (--template sdlc|pair|solo)
src/gui.ts             web UI server (SSE + POST, no deps)
src/gui.html           single-page web UI
src/extension/index.ts pi extension loaded by each agent (tools, prompt, poller, roles)
src/extension/ask-user.ts  pix-ask's ask_user questionnaires, asked as plain dialogs
electron/main.mjs      Electron desktop shell (npm run desktop)
electron/projects.mjs  the folders the desktop app has opened
scripts/               installs a release the way a person would, and finishes a task in it
src/markdown.cjs       Markdown for agent output, inlined into the page
test/                  vitest suite (unit, e2e with real pi and a scripted model, browser)
.pi-fleet/             runtime state (created on first run)
```

## Development

```bash
npm test         # run the vitest suite (a few minutes: it boots real agents and a browser)
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
the brakes stopping real runs (hop and turn limits, Stop all). `test/gui-browser.test.ts` drives
the page in a real browser the same way, using whatever Chrome or Edge is installed.

## More

[CONTRIBUTING.md](CONTRIBUTING.md) covers development, [SECURITY.md](SECURITY.md) what an agent can do
and what the fleet protects, and [CHANGELOG.md](CHANGELOG.md) what changed in each release.

## Roadmap

See [ROADMAP.md](ROADMAP.md) for what comes next and [GOAL.md](GOAL.md) for the current goal.
[BACKLOG.md](BACKLOG.md) records what is already done.

## License

Licensed under the [Apache License, Version 2.0](LICENSE).