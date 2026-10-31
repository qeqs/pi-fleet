# pi-fleet backlog

Everything here is done and kept as a record. New work is tracked in [ROADMAP.md](ROADMAP.md).

## Local / weak models
- [x] `--lean` flag: spawn agents with a smaller prompt (`--no-skills`,
      `--no-context-files`, exclude web/research tools). Validated: 4B local model
      now calls `fleet_send` and the bus delivers (27B unaffected, `--lean` is opt-in).
- [x] Auto-detect lean: on startup, `fleet up` probes each unique model's
      `contextWindow` via a short-lived `pi --mode rpc` `get_state` (cached per
      model) and applies lean automatically when the window is < 16384 tokens.
      `--lean` / `--no-lean` override. Validated: 4B (8k) → lean, 27B (128k) → full.
- [x] Per-agent `--model` + `--lean` in the agent spec (`--agent name[:cwd][:model]`)
      — per-agent model overrides `--model`; `--lean` is a global flag. Validated with a
      heterogeneous fleet (27B planner + 4B worker, both replied via the bus).
- [x] Trim the fleet extension's own system-prompt section for small models —
      the extension uses a compact fleet section when `PI_FLEET_LEAN=1`. Combined
      with `--no-skills` etc., the system prompt drops ~8× (25.7 KB → 3.0 KB).
- [x] Verify `--lean` agents still have enough tools for real tasks — live test with a 4B
      lean agent in a real cwd: `read` (read app.js), `bash` (created note.txt), `edit`
      (called + correctly validated/rejected a bad edit), `write`, and `fleet_send` all
      worked. Lean excludes only the 5 web/research tools; bash/read/edit/write are kept.

## Windows app (GUI)
- [x] **Minimal web GUI (Phase 3 prototype)** — `fleet up --gui [--open] [--port N]`: a single-page UI (SSE + HTTP POST, no deps) with a group-chat pane and one pane per agent. Streams the full RPC-event data flow live (token deltas, thinking, tool calls, run state) — validates the event pipeline end-to-end. See `src/gui.ts` + `src/gui.html`.
- [x] **Desktop app (Electron)** — `npm run desktop` (`electron/main.mjs`): launches the fleet supervisor as a child process and loads the web UI into a native BrowserWindow; closing the window kills the supervisor's process tree. Fleet composition comes from `fleet.json`.
- [x] **Session naming** — `fleet rename <agent> <name>` (CLI) and a per-agent "name" button in the GUI (`POST /session-name`), both forwarding pi's `set_session_name` over RPC. The bridge now broadcasts its OUT pipe to **all** connected clients so an ad-hoc rename doesn't steal the supervisor's event stream.
- [x] **Fleet config** — `<hub>/fleet.json` (default model + per-agent name/cwd/model/role). `fleet init` creates a starter; `fleet config` shows it; `fleet up` with no `--agent` flags spawns from it (this is what the desktop app relies on).

## Communication
- [x] Message threading/replies (reply-to id) — `FleetMessage.replyTo`, `fleet_send` accepts
      `replyTo` (short id shown in inbox), inbox shows per-message ids + "↪ replying to <from>",
      supervisor display shows `↪<id>(<from>)`. Lookups index by full + short id. Validated:
      27B agent replied with the user message's id; origin resolved in the group chat.
- [x] @mentions in group messages that only wake the mentioned agent — `groupWakesAgent`:
      a group message with `@name` wakes only the mentioned agent(s); no mention = broadcast.
      **Mentions always win** over thread-scoping, so `fleet_mention` can target a new agent
      inside a thread. Replies (`replyTo`, no mention) are thread-scoped to participants
      (prevents cascades). Agents know their peers via a **live roster in the system prompt**
      (rebuilt each turn from agents.json) and have a **`fleet_mention` tool** to @mention one
      or more agents by name. Validated: roster present in prompt; alice's fleet_mention to
      bob woke only bob, who replied "pong".
- [x] Direct wake via RPC `prompt` instead of 3s polling (supervisor → agent push) — while
      attached, the supervisor is the wake authority: its bus tailer computes which agents
      each new chat message wakes (same `groupWakesAgent` rules) and pushes the wake straight
      over RPC (`rpc.prompt(formatInbox(...))`), ~700ms instead of up to 3s. pi queues the
      prompt if the agent is busy (disposition "queued"), so it's safe either way. A
      **supervisor heartbeat** (`Hub.writeSupervisorHeartbeat`, 2s, `supervisor.json`) tells
      each agent's poller whether to self-wake: while the heartbeat is fresh the poller stays
      dormant (no double-wake); once it goes stale (supervisor exited/detached) the poller
      resumes self-waking — so detached mode still works. Heartbeat is cleared on shutdown.
      Unit-tested (heartbeat write/read/stale/clear; poller suppresses self-wake while
      attached, resumes when detached) + validated live: with PI_FLEET_POLL_MS=30000 an agent
      still woke in <1s (proving direct-push, not the poller).
- [x] Message size limits / truncation for very long bus lines — `MAX_MESSAGE_LEN` (default
      2000, override via `PI_FLEET_MAX_MSG`); `Hub.appendMessage` truncates with a
      "…(truncated)" marker; `fleet_send` reports truncation so agents can split. Validated:
      2500-char message stored as 2012 with marker, valid JSON on disk.
- [x] messages.jsonl rotation + compaction of old history — `Hub.rotateIfLarge(maxBytes,
      keepArchives)` archives messages.jsonl to a timestamped file (keeps last 5) and bumps a
      **generation counter** (`gen` file). The supervisor triggers rotation at 2 MB; agents and
      the supervisor detect the generation change each poll and reset their byte offset to 0,
      so no messages are missed or re-read. Old history lives in the archive files (compacted
      out of the active bus). Validated: rotate at 100 bytes bumped gen 0->1, archived, agent
      reset offset and read the post-rotation message.
- [x] Quality gates: agent must post `openspec validate` result before marking tasks done —
      fleet prompt rule (full + lean). Validated: implementer ran `openspec validate
      add-greeting` ("valid"), posted the result, then marked the task done.
- [x] Review protocol: reviewer agent must reply with approve/request-changes — fleet prompt
      rule (full + lean). Validated: reviewer validated + smoke-tested the change and replied
      `APPROVE — ...` per the protocol.

## Fleet management
- [x] `fleet up` auto-resume: re-attach to agents.json entries still alive — on `fleet up`,
      live bridge agents (registry pid alive + pipeIn/pipeOut set) are re-attached via
      `PiRpcBridge.connect` instead of re-spawned; `/new` also re-attaches if the name is
      already alive. No agents given → re-attach to everything still alive.
- [x] Per-agent model/provider flags (`--agent name[:cwd][:model]`) — see Local / weak models
- [x] Agent roles (planner/implementer/reviewer) as prompt presets — agent spec now takes
      `name[:cwd][:model][:role]`; `PI_FLEET_ROLE` env → `rolePrompt()` appends a role preset
      to the fleet prompt (planner: plan + assign, don't code; implementer: implement +
      quality gate + mention reviewer; reviewer: validate + smoke-test + APPROVE/REQUEST
      CHANGES). Unit-tested (fleetPrompt/rolePrompt) + validated live: planner created +
      validated an openspec proposal and @mentioned the implementer, who implemented it.
- [x] Cost tracking per agent (RPC `get_session_stats`) — `PiRpc.getStats()` calls
      `get_session_stats`; `/stats` in the group chat queries all running agents and prints
      tokens/cost/context-usage, persisting to `stats.json`; `fleet list` shows the last
      recorded stats per agent. Validated live: alice tokens=32108 ctx=10792/131072, shown in
      both /stats and fleet list.
- [x] Detached mode: agents survive supervisor exit (named-pipe stdin on Windows) — each
      agent now runs behind a **bridge** process (`src/bridge.ts`) that owns the pi child and
      exposes it over named pipes (`\\.\pipe\pi-fleet-<hash>-in/out`). The bridge is spawned
      detached (single `node tsx` process, clean tree) so it survives the supervisor exiting.
      `--detach` keeps agents running on `/quit`; normal `/quit` kills the bridge tree
      (taskkill /T). Re-attach = a new supervisor reconnects to the same pipes (auto-resume).
      `PiRpcBridge` (src/rpc.ts) is the named-pipe client (same interface as PiRpc).
      Integration-tested (test/bridge.test.ts: connect→prompt→disconnect→re-attach→kill) +
      validated live: agent remembered a secret code across detach + re-attach.

## Robustness
- [x] Windows: verify taskkill /T works for pi process trees — `PiRpc.close()` now uses
      `taskkill /PID <pid> /T /F` on Windows (matches `fleet stop`), so `/stop` and `/quit`
      kill the whole tree (pi is a grandchild of the cmd.exe shell wrapper). Validated:
      spawn + stop + quit leaves 0 orphan pi-rpc processes.
- [x] Registry write contention (multi-agent) — advisory lock file (`agents.json.lock`,
      O_EXCL create, stale-lock break after 2s) serializes the read-modify-write in
      `updateAgent`/`removeAgent`. Validated: 8 concurrent worker processes (30 updates each)
      preserved all 8 agent entries (no lost updates).
- [x] Extension: handle hub dir deleted mid-run — `Hub` recreates its dir on every write
      (`ensureDir()` in appendMessage/writeAgents); reads already tolerate missing files.
      Validated: delete dir mid-run, next append recreates it and writes.
- [x] Tests: hub offset reads, rpc framing, extension polling (vitest) — `npm test` runs 29
      tests across 3 files: hub (offset reads, tail, registry, truncation, rotation, shortId),
      rpc (split-line reassembly, events, id-matching, get_state, timeout via a fake JSONL
      server), extension (groupWakesAgent mention/thread semantics, createPoller wake/busy/
      flush/seek/rotation). Polling logic extracted into a testable `createPoller` unit;
      POLL_MS + RPC timeout made configurable for fast tests.
- [x] Windows: agent-spec cwd with a drive letter — `--agent name:C:\proj:model` used to split
      on the drive-letter `:` and treat `C` as the cwd (`cwd does not exist: <root>\C`). Spec
      parsing moved to a side-effect-free `src/spec.ts` (`parseAgentSpec`); a bare drive letter
      followed by a path segment is rejoined into the cwd. 11 unit tests (test/spec.test.ts);
      validated live: `--agent "planner:C:\\Users\\...\\pi-fleet:model:planner"` spawns with the
      full cwd, correct model + role.

## Later
- [x] **Fleet templates** — `fleet up --template sdlc|pair|solo` (and `fleet templates` to list). Templates are named presets that expand to a set of agents (src/templates.ts). Verified live: `--template pair` spawned implementer + reviewer with the right roles.
- [x] **beads integration** — pluggable task board. `PI_FLEET_TASKBOARD=beads` swaps the OpenSpec tool for a `beads` tool (runs the `bd` CLI) and makes the system prompt task-board-aware. Verified end-to-end: a 27B agent ran `bd list`, created issue `beads-live-test-4iq`, closed it, and reported with the quality gate.
- [x] **Web UI hosting** — `fleet serve [--agent ... | --template ...] [--port N] [--host H]`: runs the fleet headless (no terminal chat) and serves the web UI. `--host 0.0.0.0` binds for LAN/network access. Verified live: headless serve spawned the fleet from config, served the GUI on 0.0.0.0, and the agent responded through the web UI.

## Channels & supervisor routing
- [x] **Named channels** — a channel is a named group chat with a member list and a supervisor. Stored in `<hub>/channels.json` (src/hub.ts: `readChannels`/`writeChannels`/`getChannel`/`upsertChannel`/`removeChannel`/`setChannelSummary`/`ensureDefaultChannel`). The default `#group` channel is auto-created on startup with all agents as members and a supervisor (an agent with role `supervisor`, else the first agent). Channels are managed via the GUI (Settings → Channels), the CLI (`/channel add <name> <m1,m2> [sup]`, `/channel rm <name>`, `/channel` to list), and the bus (`#name message` posts to a channel; `# message` posts to the group).
- [x] **Supervisor routing** — in a channel, only the supervisor wakes on a new message (`wakeDecision` in src/extension/index.ts returns `{mode:"route"}` for the supervisor, `{wake:false}` for members). The supervisor gets a compact routing prompt (channel summary + the new message + member roster) and calls the new `route` tool: it picks the members who should act and updates the channel's rolling summary. `route` sends each chosen member a directed DM carrying the original message + the summary (so members get context without reading the full transcript) and writes the new summary to `channels.json`. When a member's response comes back to the channel the supervisor is re-woken and routes again (usually `respond: []` to end the turn). This replaces the old N-way broadcast: each message costs one supervisor routing call + only the relevant members, keeping token spend low. The supervisor's routing is pushed directly over RPC by the attached supervisor (`pushDirectWakes` in src/fleet.ts uses `wakeDecision` + `routingPrompt`), so there is no 3s poll delay.
- [x] **GUI channels** — the web UI lists channels in the sidebar (a "Channels" section above "Direct"), shows a channel's public conversation (bus messages addressed to it), a channel header with supervisor/members/summary + Manage/Clear actions, and a composer that posts to the selected channel or DMs an agent. Settings → Channels creates/edits/removes channels (POST /channels, POST /channels/remove). The snapshot + a `channels` SSE event keep the UI in sync. Unit-tested (test/channels.test.ts: wakeDecision route/normal/DM/legacy-group, routingPrompt, directedMessageText, defaultSupervisor, hub channel storage) — 65 tests pass. Verified live: a supervisor (27B) routed a user request in #group to the implementer via `route`, the implementer replied to the channel with working code, and the channel summary was updated to reflect the completed task — only the implementer was woken, not a broadcast.