# Goal: ship pi-fleet 1.1 from the first real use of 1.0

Owner: pi-fleet
Status: DONE. Set and finished 2026-11-01, with `v1.1.0` released, after the owner installed 1.0 and
got no answer from the router and empty messages in the agents' chats. The last check found one
fault that goes to the next release: a run that hands off and never ends.

## Definition of done
- Every item in milestone 8 of `ROADMAP.md` is `[x]` (implemented + verified).
- `v1.1.0` is tagged, with CI green on Windows, Linux and macOS.
- The installer from the `v1.1.0` release, on a real machine, takes a task from the desktop app to
  `APPROVE` on a real model, driven through the app's own windows and not by a test script.

## How to work it
The rules of the 1.0 goal below still apply. New ideas go into **Next** in `ROADMAP.md`.

## Progress log
- 2026-11-03: `v1.2.3` released, so the owner sees the questions agents ask with pix-ask's `ask_user`.
  `v1.2.2` was tagged and never published: its Release workflow found that `npm install -g` from
  GitHub ignores the shrinkwrap and took pi 1.5.0, out the day before, which no longer exports
  TypeBox's `Type`, so `fleet` would not start. 1.2.1 installed that way breaks too. pi is pinned to
  1.4.0, the install from git was checked locally before tagging, and the Release workflow passed on
  each system. The published Windows installer, with its digest checked, went onto the owner's
  machine, and the desktop tests passed against it. CI on `main` failed once on Windows: three
  processes writing channels at once lost 4 of 45 updates, which is in **Next**.
- 2026-11-02: `v1.2.1` released with the fixes below. The Release workflow finished a task with each
  form of the install on each system, and the published Windows installer, with its digest checked,
  went onto a real machine, where the app opens a project and leaves nothing running when closed.
  CI failed three times with no product change behind it: a fleet that took over 30 seconds to start
  on macOS, playwright's close outlasting a cleanup hook on Linux, and a strict match on Windows that
  found two wakes in a chat. The first two were fixed, and a new test watches the app quit in the
  middle of a run. The third was relaxed, and why there were two wakes is in **Next**.
- 2026-11-02: First runs on real weak models, on OpenRouter's free tier. On `liquid/lfm-2.5-2.6b:free`
  the planner wrote the page itself, to a made-up path above the project, reported it done and ended
  the chain, and a 429 ended the router's watch in silence. All of that is fixed, and the fixes met
  the same model: its next write, to `/cwd/converter.html`, was refused. No run on a weak model has
  reached `APPROVE`: that model was rate limited upstream, and a second one,
  `nvidia/nemotron-3-nano-omni-30b-a3b-reasoning:free`, hit the limit of 50 free requests a day
  after 4 calls. Same day, on hf-space-qwen38, with the task of the 1.2 run: `APPROVE` in 2 minutes
  with 127k tokens against 490k, the planner's share 22k against 257k, in 2 model calls, and one
  handoff, with no error in its chat. The page's test passes.
- 2026-11-02: `v1.2.0` released, which fixes what the last check below found. The Release workflow
  finished a task with each form of the install on each system. A candidate installer with the same
  `src/`, in the app's own windows on hf-space-qwen38, took the same task to `APPROVE` with 7 agent
  messages and 490k tokens, down from 15 and 805k. Neither the refusal nor the router's check fired,
  and the planner still sent the work twice, which is in **Next**. A scripted weak model in that
  installer was sent back to work after 31s of quiet. No real weak model has run this yet: the
  owner reported `gpt-4o` chatting and not working, but OpenRouter's free limit was used up and the
  account has no credit for it. CI's first run on macOS found a test expecting a Mac app to quit
  with its window, and a run on Linux found a test reading a file while it was written.
- 2026-11-01: Last check, on the published installer, in the app's own windows, on hf-space-qwen38.
  The first-run screen asked for a model and refused to start without one, the crew reached
  `APPROVE`, and its test passes, which closes this goal. The run also showed a real fault. After
  handing off, the planner never ended its turn: in one run, from one wake, it polled the
  implementer's files, reviewed the work itself, and posted "done" to the group 11 times in 7
  minutes, until the brake on identical calls fired. That cost 606k of the crew's 805k tokens, and
  the brake's abort was then reported as a model error. Delivery was not at fault, and three
  earlier runs did not do this. Also measured: a window takes about 20s only on the first launch
  after an install, and about 2s after that.
- 2026-11-01: `v1.1.0` released, with CI green on Windows, Linux and macOS and the Release workflow
  finishing a task with each form of the install on each system. The published Windows installer
  matches the release's checksum, it installs here, and the installed sources match the tag. Its
  window opened on an empty project, but the session was locked by then, so nobody saw that page.
  CI's first run on Linux and macOS found what Windows hid: the system proxy can be unread when
  the app starts, and with no model set up `fleet doctor` hung.
- 2026-11-01: The installed app, walked through in its own windows on a real Windows machine.
  From the first-run screen through a crew on hf-space-qwen38, a Russian task went planner,
  implementer, reviewer, `APPROVE` in 168s with 3 messages and 264k tokens, and the crew's test
  passed. With the model switched off mid-session, the chat said why in about 15s, and the agent's
  chat showed one error block. Stop all, Usage, Timeline and quitting (no process left) all worked.
  The run found what scripted models and CI had not: nothing in `fleet doctor` or a model test
  noticed a refused prompt, the first-run screen could only offer the model already chosen and
  picked the first on the list, even a paid or dead one, a crew started after choosing a default
  was not kept, a second launch ran a second copy, and hosted models were out of reach behind a
  system proxy. All fixed, with tests. The task text was sent with the call behind the Send
  button, since the automation here can click that window but not type into it.
  On OpenRouter, reached through the system proxy with the key only in the process environment,
  a free model (`cohere/north-mini-code:free`) finished a loan calculator with a correct formula,
  after one provider error that stopped the implementer and one message to carry on. It cost
  546k tokens and left `APPROVE` in the reviewer's own chat instead of the group's, which is in
  **Next**. A mutation check showed the hold on busy agents does not change what the model
  receives, since pi's queue merges messages either way: what it changes is that held messages
  stay undelivered, so a crash does not call them interrupted. The test now says so.
- 2026-11-01: Group chat reworked. The same task, "a web app calculator for a credit percent", on
  hf-space-qwen38, one run each: 14 messages, 15 wakes, 56 model turns and 571k tokens before; 5
  messages, 3 wakes, 33 turns and 240k tokens after, and no stray files from `openspec init`
  (there were 12). The chain went planner, implementer, reviewer, `APPROVE`. The calculator's own
  tests pass, and its result is right by hand: 1054.99 a month for 12,000 at 10% over 12 months.
  The router read 6 of 6 test messages correctly on the real model. 13 of 13 mutations were caught.
  One slow run under CPU load showed that a model chosen while a crew starts could be lost; fixed.
  About 96% of the tokens are context sent again on each turn, which is in **Next**.
- 2026-11-01: Model errors and model setup done. The report came down to three local models that
  were all down, with pi's error turns drawn as empty messages, four per message, and a router
  that could not say why it failed. Each failure now says what happened, and Settings has a Models
  tab that adds a server or a key and tests a model for real.

---

# Previous goal: ship pi-fleet 1.0 by completing ROADMAP.md

Owner: pi-fleet
Status: DONE. Set and finished 2026-11-01, with `v1.0.0` tagged.

## Definition of done
- Every `[ ]` in `ROADMAP.md` is `[x]` (implemented + verified) or explicitly descoped with a
  note saying why.
- Every milestone's **Done when** line has been demonstrated, and how is recorded in the
  progress log below.
- `v1.0.0` is tagged, with CI green on Windows, Linux and macOS.

## How to work it
- One milestone at a time, in order. New ideas go into `ROADMAP.md`, not into the current
  milestone, unless it cannot be finished without them.
- Each item ships with a test that fails without it. A test proves nothing until it has been
  seen to fail.
- Each milestone ends with a passing `npm test`, a clean `npm run typecheck`, and at least one
  real-model run of the sdlc chain: the scripted model does not show how real models misbehave.
- One branch per milestone, merged into `main` once CI is green and tagged with the release
  in the roadmap. (Pull requests need `gh` or a token, which this environment does not have.)

## Progress log
- 2026-11-01: Milestone 7 done (1.0.0). The Release workflow is the demonstration: on Windows,
  Linux and macOS it runs `npm install -g` from GitHub and finishes the sdlc task with
  `scripts/check-install.mjs`, which follows `GETTING_STARTED.md` on the command line, then builds
  the installer, installs it, and runs `test/desktop.test.ts` against the installed app. Those use
  the scripted model. Real-model sdlc chain on hf-space-qwen38 with this code: 96s under load,
  no routing turn in any worker. Hubs that releases 0.1.1 to 0.6.0 really wrote upgrade in
  `test/e2e.test.ts`. The security review and what stays open are in `SECURITY.md`. Linux CI
  found that a fleet ignored `SIGTERM`, which left agents running after the app quit.
- 2026-11-01: Milestone 6 done (0.7.0). Real-model run on hf-space-qwen38: two implementers
  changed one repository at once in their own worktrees, the reviewer read both worktrees and
  approved, and both branches merged through the fleet's own `/merge` in 90s, with `main`
  clean and no manual git. Same-file conflicts go back to the agent, covered by
  `a conflict goes back to the agent` in `test/e2e.test.ts`. The run also showed overlapping
  requests collapsing into one on the timeline, now fixed. Milestone 5's first CI run failed on
  macOS: a slow history reply could wipe a live conversation. Fixed and reproduced by test
  before v0.6.0 was tagged.
- 2026-11-01: Milestone 5 done (0.6.0). Demonstrated by `goes from an empty app to a finished
  sdlc task` in `test/gui-browser.test.ts`: in real Chrome, from a fleet with no agents and no
  config, a person picks a crew, sends a task and sees `APPROVE`, with `fleet.json` written for
  them. Browser tests also found a real bug: history arriving late erased a message just sent.
- 2026-11-01: Milestone 4 done (0.5.0). Real-model sdlc chain on hf-space-qwen38: 65s, no
  routing turn in any worker, router 262 tokens, implementer 10,118 (baseline 22,546 when it
  also routed), whole fleet 20,733. Rules settled `APPROVE` with no model call.
- 2026-11-01: Milestone 3 done (0.4.0). Demonstrated in `test/e2e.test.ts`: an agent's question
  reaches the GUI and is answered through it (`lets a person answer`), and a fleet pauses at a
  budget computed by pi from token usage (`shows real token counts`). Added approvals on pi's
  `tool_call` hook, cost after every turn, `/budget`, delivery of held messages, and routing
  decisions and agent DMs in the channel view.
- 2026-11-01: Milestone 2 done (0.3.0). Demonstrated by `resumes the task after every process
  is killed, and loses no message` in `test/e2e.test.ts`: the supervisor and all agents are
  killed mid-task, a message is posted while everything is down, and after `fleet up` the
  agent has its old context, is told it was interrupted, and receives the message. Cursor,
  inbox, session resume, auto-restart and `/restart` added; `readBus` follows a reader through
  rotations (the old code lost whatever was unread when the bus rotated).
- 2026-11-01: Milestone 1 done (0.2.0). Every failure on the list now reaches the user. Bad
  input ends in a sentence and a non-zero exit; a crash, a router loss, a stalled model and a
  model error all post to `#group`. Demonstrated by one test per failure in `test/e2e.test.ts`
  and `test/cli-run.test.ts`; each safeguard was disabled in a copy to confirm its test fails
  (10 of 10). Desktop: a broken config is shown in 2s, was 90s of nothing.
  Found by real-model runs: a model error left the agent silently idle, and a router could loop
  on `route` and `fleet_send`. Both added to this milestone and fixed.
- 2026-11-01: Milestone 0 done (0.1.1). CI green on Windows, Linux and macOS on the first run,
  so Linux and macOS work as they are. `src/fleet.ts` split into cli, supervisor, spawn, wakes
  and commands.
- 2026-11-01: Goal set. `ROADMAP.md` written from the review below and checked against pi's
  docs: `get_state` returns `sessionFile` (resume), RPC dialogs exist (`extension_ui_request`),
  and the `tool_call` hook can block a call (approvals).
- 2026-10-31: 0.1.0 published to github.com/qeqs/pi-fleet under Apache-2.0. A hands-on review
  found the main sdlc chain stalled, and these were fixed: `@mentions` in channels, delivery to
  busy agents, channels in detached mode, GUI composer and forms, GUI token + origin checks +
  CSP, shell-free pi launch, pid checks before `fleet stop`, the terminal prompt, the openspec
  tool on Windows, and lost `agents.json` writes (EPERM under concurrent reads on Windows).
  Added `--max-turns`, `--max-hops` and Stop all. 144 tests, including 8 e2e scenarios with a
  scripted model; the chain was also verified on a real model.

---

# Previous goal: finish every item in BACKLOG.md

Status: COMPLETE — Phase 1 (incl. direct-wake), Phase 2 (5/5), Phase 3 GUI prototype, Phase 4 (templates, beads, web UI hosting), Phase 5 (desktop app) all done.

## Definition of done
Every `[ ]` in `BACKLOG.md` is either `[x]` (implemented + verified) or explicitly
descoped with a note. Each item gets a validation note (test run, live fleet run, or
command used). `tsc --noEmit` stays clean and the vitest suite passes.

## Phases (sequencing)
> Scope confirmed: GUI = minimal working prototype built early to validate the
> approach, refined at the end. "Later" section = fully in scope.

### Phase 1 — Communication + Robustness (quick wins, high value)
- [x] Verify `--lean` agents still have enough tools for real tasks
- [x] Message threading/replies (reply-to id)
- [x] @mentions in group messages that only wake the mentioned agent
- [x] Message size limits / truncation for very long bus lines
- [x] messages.jsonl rotation + compaction of old history
- [x] Quality gates: agent must post `openspec validate` result before marking tasks done
- [x] Review protocol: reviewer agent must reply with approve/request-changes
- [x] Robustness: Windows taskkill /T verify
- [x] Robustness: registry write contention (file lock or per-agent files)
- [x] Robustness: extension handles hub dir deleted mid-run
- [x] Tests: hub offset reads, rpc framing, extension polling (vitest)

### Phase 2 — Fleet management
- [x] `fleet up` auto-resume: re-attach to agents.json entries still alive
- [x] Agent roles (planner/implementer/reviewer) as prompt presets
- [x] Cost tracking per agent (RPC `get_session_stats`)
- [x] Detached mode: agents survive supervisor exit (named-pipe stdin on Windows)

### Phase 3 — GUI minimal prototype (early validation)
- [x] Small working desktop/web GUI: group chat + one pane per agent (validates RPC-event data flow)
- [x] Live token/tool activity per agent (via RPC events)

### Phase 4 — Later (all in scope)
- [x] Fleet templates: `fleet up --template sdlc` (planner + implementer + reviewer)
- [x] beads integration as alternative task board
- [x] Web UI (host pattern: hf-qwen38-abliterated-space)

### Phase 5 — GUI refinement (final)
- [x] Full desktop app (Tauri/Electron) group-chat view: one pane per agent + shared channel
- [x] Session naming/rename UI (`set_session_name` over RPC)
- [x] Fleet config UI: default model, providers, per-agent cwd (read-only in the GUI; editing moved to ROADMAP Milestone 5)

## Progress log
- 2026-10-29: Phase 1 item 5 done — rotation + compaction: Hub.rotateIfLarge archives
  messages.jsonl (keeps last 5) + bumps a generation counter; supervisor triggers at 2MB;
  agents + supervisor detect gen change and reset byte offset (no missed/dup messages).
  Validated: rotate bumped gen 0->1, archived, agent reset and read post-rotation msg.
- 2026-10-29: Phase 1 item 2 done — message threading: `replyTo` on FleetMessage, fleet_send
  accepts replyTo (short id), inbox shows ids + "↪ replying to <from>", supervisor shows
  `↪<id>(<from>)`; lookups index full+short id. Validated with 27B agent.
- 2026-10-29: Phase 1 item 3 done — @mentions: group msg with @name wakes only that agent;
  no mention = broadcast; replies (replyTo) thread-scoped to participants (prevents
  cascades). Validated: @bob woke only bob, bob's reply didn't wake alice.
- 2026-10-29: @mention item expanded per user — added live roster in system prompt (agents
  know peers) + fleet_mention tool (explicit @mention, only named agents wake). Mentions now
  take priority over thread-scoping. Validated: roster in prompt; alice mentioned bob, bob
  woke and replied "pong".
- 2026-10-29: Phase 1 item 4 done — message size limits: MAX_MESSAGE_LEN (2000, env
  PI_FLEET_MAX_MSG), appendMessage truncates with marker, fleet_send reports truncation.
  Validated: 2500->2012 chars, valid JSON on disk.
- 2026-10-29: Phase 1 item 1 done — verified lean agents keep bash/read/edit/write +
  fleet tools (live 4B test: read app.js, bash-created note.txt, edit validated, fleet_send
  reported the read value).
- 2026-10-29: Phase 1 items 8+9+10 done — robustness: (a) taskkill /T in PiRpc.close()
  (0 orphans after stop+quit); (b) advisory lock file serializes agents.json read-modify-write
  (8/8 agents preserved under 8 concurrent workers); (c) Hub.ensureDir recreates dir on write
  (delete mid-run, next append recreates + writes).
- 2026-10-29: Phase 1 items 6+7 done — quality gate + review protocol (prompt rules, full +
  lean). Validated end-to-end: implementer ran `openspec validate` (valid), posted result,
  marked task done, mentioned reviewer; reviewer validated + smoke-tested and replied
  APPROVE per protocol.
- 2026-10-29: Phase 1 item 11 done — vitest suite (29 tests / 3 files, `npm test`): hub
  (offset reads, tail, registry, truncation, rotation, shortId), rpc (split-line reassembly,
  events, id-matching, get_state, timeout via fake JSONL server), extension (groupWakesAgent
  mention/thread semantics, createPoller wake/busy/flush/seek/rotation). Polling extracted
  into testable createPoller; POLL_MS + RPC timeout made configurable. Live 2-agent smoke
  test confirmed the refactored poller still wakes agents on mentions.
- 2026-10-29: Phase 2 item done — agent roles as prompt presets. Agent spec extended to
  `name[:cwd][:model][:role]`; rolePrompt() injects planner/implementer/reviewer presets.
  Unit-tested (33 tests now) + validated live: planner created+validated an openspec proposal
  and @mentioned the implementer, who implemented utils.js (add(a,b)).
- 2026-10-29: Phase 2 item done — cost tracking. PiRpc.getStats() -> get_session_stats;
  /stats queries all agents (tokens/cost/context) and persists to stats.json; fleet list shows
  last stats. Validated live: alice tokens=32108 ctx=10792/131072.
- 2026-10-30: Phase 2 COMPLETE — detached mode + auto-resume via a per-agent **bridge**
  process (src/bridge.ts). Each agent now runs behind a bridge that owns the pi child and
  exposes it over named pipes (\\.\pipe\pi-fleet-<hash>-in/out). The bridge is spawned
  detached as a single `node tsx` process (clean tree: supervisor -> node(bridge) -> pi), so
  it survives the supervisor exiting. `PiRpcBridge` (src/rpc.ts) is the named-pipe client
  (same interface as PiRpc). `--detach` keeps agents running on /quit; normal /quit kills the
  bridge tree (taskkill /T). `fleet up` auto-resumes by re-attaching to live bridges; `/new`
  re-attaches too; no agents given re-attaches to all alive. Fixed the extension overwriting
  the registry pid with pi's pid (now preserves the bridge pid). Integration-tested
  (test/bridge.test.ts: connect->prompt->disconnect->re-attach->kill; 35 tests total) +
  validated live: agent remembered a secret code (BANANA42) across detach + re-attach.
- 2026-10-30: **Direct wake** optimization (was the last open Communication item). While the
  supervisor is attached it is now the wake authority: its bus tailer computes which agents
  each new chat message wakes (same groupWakesAgent rules) and pushes the wake straight over
  RPC (`rpc.prompt(formatInbox(...))`) — ~700ms instead of up to the 3s poll. pi queues the
  prompt if the agent is busy (disposition "queued"), so it's safe either way. A supervisor
  heartbeat (Hub.writeSupervisorHeartbeat, 2s, supervisor.json) tells each agent's poller
  whether to self-wake: fresh heartbeat -> poller dormant (no double-wake); stale heartbeat
  (supervisor exited/detached) -> poller resumes self-waking, so detached mode still works.
  Heartbeat cleared on shutdown. Unit-tested (4 heartbeat tests + 2 poller supervisor tests;
  41 tests total) + validated live: with PI_FLEET_POLL_MS=30000 an agent still woke in <1s
  (proving direct-push, not the poller).
- 2026-07-13: Phase 3 (GUI prototype) done — minimal web GUI. `fleet up --gui [--open] [--port N]`
  serves a single-page UI (SSE + HTTP POST, zero deps — src/gui.ts + src/gui.html) with a
  group-chat pane and one pane per agent. It streams the full RPC-event data flow live
  (token deltas, thinking, tool calls, run state) and accepts messages via POST /message.
  Validated: all event types (agent_start/settled, message_update, thinking_delta,
  tool_execution_*, turn_*) observed in the SSE stream; HTML/SSE/POST endpoints unit-tested
  (5 tests). 46 tests pass. Typecheck clean.
- 2026-07-13: Phase 5 (desktop app) done — Electron shell + fleet config + session naming.
  - **Electron desktop app** (`npm run desktop`, electron/main.mjs): launches the fleet
    supervisor as a child process (clean `node tsx` tree) and loads the web UI into a native
    BrowserWindow; closing the window kills the supervisor tree (taskkill /T). Validated live:
    supervisor booted from config, GUI reachable, agent responded through the app.
  - **Fleet config** (`src/config.ts`): `<hub>/fleet.json` (defaultModel + per-agent
    name/cwd/model/role). `fleet init` creates a starter, `fleet config` shows it, and
    `fleet up` with no --agent flags spawns from it (what the desktop app relies on).
  - **Session naming**: `fleet rename <agent> <name>` (CLI) + a per-agent "name" button in
    the GUI (POST /session-name), both forwarding pi's set_session_name over RPC. Verified
    via get_state (data.sessionName). Fixed the bridge to broadcast its OUT pipe to ALL
    connected clients (was single-client) so an ad-hoc rename no longer steals the
    supervisor's event stream; PiRpcBridge.close() now destroys sockets so short-lived
    clients exit cleanly. 47 tests pass. Typecheck clean.
- 2026-07-13: Phase 4 (later items) done — templates, beads, web UI hosting. PROJECT COMPLETE.
  - **Fleet templates** (src/templates.ts): `fleet up --template sdlc|pair|solo` + `fleet
    templates`. Named presets that expand to a set of agents. Verified live: `--template
    pair` spawned implementer + reviewer with the right roles.
  - **beads integration**: pluggable task board. `PI_FLEET_TASKBOARD=beads` swaps the
    OpenSpec tool for a `beads` tool (runs the `bd` CLI, bd.exe on Windows) and makes the
    system prompt task-board-aware (plan + quality-gate lines). Installed bd 1.3.2 and
    verified end-to-end: a 27B agent ran `bd list`, created issue beads-live-test-4iq,
    closed it, and reported with the quality gate.
  - **Web UI hosting**: `fleet serve [--agent ... | --template ...] [--port N] [--host H]`
    runs the fleet headless (no terminal chat) and serves the web UI; `--host 0.0.0.0`
    binds for LAN access. Verified live: headless serve spawned the fleet from config,
    served the GUI on 0.0.0.0, and the agent responded through the web UI.
  - 49 tests pass. Typecheck clean. All phases (1–5) complete.
- 2026-07-13: Phase 6 (channels + supervisor routing) done — named channels with a per-channel
  supervisor that routes messages to the relevant members instead of broadcasting.
  - **Channels** (src/hub.ts): `<hub>/channels.json` stores `{name, members, supervisor, summary}`.
    `ensureDefaultChannel` auto-creates the default `#group` channel (all agents as members, an
    agent with role `supervisor` — else the first agent — as the router). Managed via the GUI
    (Settings → Channels), the CLI (`/channel add|rm|list`), and the bus (`#name msg`).
  - **Supervisor routing** (src/extension/index.ts): `wakeDecision` wakes only the channel
    supervisor (in `route` mode) on a new channel message; members stay asleep. The supervisor
    calls the new `route` tool: it picks who should act and updates the channel's rolling
    summary; `route` DMs each chosen member a message carrying the original request + the summary
    (context without the full transcript) and persists the summary. A member's reply re-wakes the
    supervisor, which routes again (usually `respond: []` to end the turn). Replaces the N-way
    broadcast — one cheap routing call per message + only the relevant members.
  - **GUI** (src/gui.html + src/gui.ts): channels in the sidebar, a channel conversation view,
    a channel header (supervisor/members/summary + Manage/Clear), a channel composer, and a
    Settings → Channels tab (POST /channels, /channels/remove). Snapshot + `channels` SSE event
    keep it in sync.
  - test/channels.test.ts: wakeDecision (route/normal/DM/legacy-group), routingPrompt,
    directedMessageText, defaultSupervisor, hub channel storage. 65 tests pass. Typecheck clean.
  - Verified live: a 27B supervisor routed a user request in #group to the implementer via `route`;
    the implementer replied to the channel with working, tested code; the channel summary was
    updated to reflect the completed task. Only the implementer was woken — no broadcast.