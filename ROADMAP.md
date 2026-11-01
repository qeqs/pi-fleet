# pi-fleet roadmap

The road from a working prototype to a 1.0 that someone other than its author can install and
trust with real work, and what came after. 1.0 shipped on 2026-11-01. The current goal is in
[GOAL.md](GOAL.md).

Milestones run in order, because each one relies on the one before: there is no point
polishing a GUI over messages that can vanish. An item is done when a test covers it, and a
milestone is done when its **Done when** line has been demonstrated.

| # | Milestone | What you get | Release |
|---|---|---|---|
| 0 | Foundation | Every change tested on Windows, Linux and macOS | 0.1.x |
| 1 | Nothing fails silently | Every failure is visible and explained | 0.2 |
| 2 | Work survives restarts | Stopping or crashing loses no context or messages | 0.3 |
| 3 | Human in the loop | Agents can ask you; you can see and cap the cost | 0.4 |
| 4 | Routing without a worker | A cheap router that never blocks or bloats a worker | 0.5 |
| 5 | A GUI for daily use | No terminal or file editing needed day to day | 0.6 |
| 6 | Safe parallel work | Several agents on one repo without collisions | 0.7 |
| 7 | 1.0 | Installable, documented, reviewed | 1.0 |
| 8 | First real use | Model errors explained, models set up in the GUI, a quieter group chat | 1.1 |

## Already shipped (0.1.0)

The sdlc chain runs end to end, and `@mentions` reach their target in a channel. Messages to a
busy agent are queued and failed deliveries are reported. The GUI requires a token and refuses
cross-origin requests, and pi starts without a shell. Turn and hop limits and Stop all bound
runaway models.

## 0. Foundation

Linux and macOS have never been run, and the riskiest logic cannot be unit-tested yet.

- [x] CI on every push and pull request: typecheck and the full test suite on Windows, Linux and macOS
- [x] Fix whatever CI finds on Linux and macOS (it found nothing: green on the first run)
- [x] Typecheck `test/` as well as `src/`
- [x] Split `src/fleet.ts` (1,000 lines, runs `main()` on import) so wake, pause and argument logic can be unit-tested
- [x] An interrupted test run leaves no detached agents behind

**Done when:** CI is green on all three systems on `main`.

## 1. Nothing fails silently

- [x] Bad input gets a clear message and a non-zero exit, never a stack trace: unknown flags, `--port abc`, an invalid `fleet.json`
- [x] `fleet --help`, and a useful `fleet stop` on an empty hub
- [x] A failed spawn rolls back, leaving no orphaned agents
- [x] Unknown terminal `/commands` are rejected instead of being sent to agents; add `/help`
- [x] `@typo` and `#typo` are rejected in the terminal and the GUI; channels always display as `#name`
- [x] Messages too long for the bus are refused or split, never silently cut
- [x] A crashed agent is marked stopped in the registry, with a notice on the bus
- [x] A stopped channel supervisor is replaced instead of leaving the channel dead
- [x] A second supervisor on the same hub is refused
- [x] A model request that stalls is detected and reported: the turn limit only counts finished turns
- [x] A run that ends in a model error says so on the bus, instead of the agent just going idle
- [x] A run that keeps making the same fleet call is stopped early, long before the turn limit
- [x] `channels.json` writes take the registry lock, so concurrent updates are not lost
- [x] `lean` in `fleet.json` is honoured
- [x] Desktop: a failed start shows an error window at once, not 90 seconds of nothing
- [x] `fleet doctor` checks pi, the model, the hub and stale registry entries

**Done when:** each failure above has a test that provokes it and asserts the message the user sees.

## 2. Work survives restarts

- [x] Session resume: store `sessionFile` from `get_state` and restart pi with `--session`, so an agent keeps its context
- [x] Durable inbox: a message for a stopped agent waits and is delivered when it returns
- [x] Delivery is acknowledged, so a supervisor crash between read and wake loses nothing
- [x] Crashed agents restart automatically, with backoff and a retry cap
- [x] `/restart name`, so plugin and model changes can take effect without a full stop
- [x] Bus rotation is safe while agents are reading

**Done when:** killing every process mid-task and running `fleet up` resumes the task with its context, and no message is lost.

## 3. Human in the loop

- [x] Agent questions (`extension_ui_request`: select, confirm, input, editor) appear in the GUI and terminal and can be answered; today such an agent hangs
- [x] An agent waiting for you is shown as waiting, not busy
- [x] Optional approval rules per agent: risky tool calls wait for a human, using pi's `tool_call` hook
- [x] Cost is collected after each run and shown in the Usage tab and agent header
- [x] `--max-cost`: pause the fleet at a spending limit
- [x] After a pause, choose whether to deliver the held messages, so a long chain can continue where it stopped
- [x] Routing decisions and agent DMs are visible in the channel view

**Done when:** an agent's question is answered from the GUI in an e2e test, and a fleet pauses at its budget using real token counts.

## 4. Routing without a worker

Today the router is an ordinary worker: its context grows with every message, and channel
messages wait while it works.

- [x] Rules first: messages that need no judgement, such as `APPROVE`, are routed without a model call
- [x] A dedicated stateless router: a short model call per message, on the cheap `supervisorModel`, independent of any worker
- [x] Channel summaries stay current when `@mentions` bypass the router
- [x] `sdlc` and `pair` use the new router by default

**Done when:** on a real model the sdlc chain runs with no routing turns in a worker's session, using fewer tokens than the current baseline (22.5k for the hello.txt task).

## 5. A GUI for daily use

- [x] Browser tests for the GUI, which today has only static checks
- [x] A sanitising Markdown renderer: tables, ordered lists and code blocks all work
- [x] Your own messages appear at once; multi-line channel messages keep their line breaks
- [x] Routing prompts are collapsed, not shown as if you had typed them
- [x] Tool cards, scroll position and drafts survive streaming and reconnects
- [x] Stop, Restart and Remove for each agent
- [x] Model picker from `get_available_models`
- [x] An editable Fleet tab that saves to `fleet.json`, including the channel supervisor
- [x] A first-run screen with a template picker
- [x] Unread badges and notifications
- [x] History search, including archived messages
- [x] Clear means something consistent: it hides messages for everyone, and they stay searchable

**Done when:** a new user can go from an empty app to a finished sdlc task without a terminal or a config file, covered by a browser test.

## 6. Safe parallel work

- [x] Optional git worktree and branch per agent
- [x] Diff view per agent or task in the GUI
- [x] Merge flow from an agent's branch after review
- [x] Task board in the GUI for OpenSpec and beads
- [x] `taskboard` in `fleet.json` instead of an environment variable
- [x] Timeline: who woke whom and why, with cost per task

**Done when:** two implementers change the same repository at once and both results merge after review, with no manual git.

## 7. 1.0

- [x] A `fleet` command from `npm install -g`, instead of `npm run fleet --`
- [x] Desktop installers for Windows, Linux and macOS
- [x] Project switcher: the desktop hub is no longer tied to the repository folder
- [x] Versioned hub format, with upgrades from earlier releases
- [x] A full security review, with findings fixed
- [x] Getting-started guide, `CONTRIBUTING.md` and `CHANGELOG.md`

**Done when:** `v1.0.0` is tagged, and a clean machine on each system can install it and finish the sdlc task by following the guide.

## 8. First real use

1.0 passed every check, and then its owner installed it and got no answer from the router and
empty messages in the agents' chats. The models were down and nothing said so. On real models,
the group chat had only ever run small tasks.

- [x] A model error shows in the agent's chat, once, instead of as empty messages
- [x] The router says why it failed, and does not wait out pi's retries
- [x] A Models tab in Settings: add a server or an API key, test a model, choose the default and routing models
- [x] A model is tested before a crew starts, and `fleet doctor` really asks it for a word
- [x] The first-run screen lists every model and follows the default chosen in Settings
- [x] The desktop app uses the computer's proxy settings
- [x] Starting the desktop app a second time brings up the running one
- [x] A model chosen for an agent survives a restart, even if it was chosen while the crew started
- [x] An agent wakes another only by opening its message with that name; a name in passing goes to the router
- [x] Messages for an agent in the middle of a run arrive as one wake
- [x] Agents do not acknowledge, the reviewer's verdict ends the job, and small jobs can skip OpenSpec
- [x] `openspec init` adds nothing for other AI tools to the repository

**Done when:** the `v1.1.0` installer, on a real machine, takes a task from the desktop app to `APPROVE` on a real model, and a model that cannot answer says why.

## 9. Real models, good and weak

1.1's last check showed a planner that never stopped, and its owner's own test showed models that
chat and tag each other and do no work.

- [x] A verdict must reach the group: a weak model can leave `APPROVE` in its own chat, and the group just goes quiet. Other final text stays in the agent's chat, to keep the group quiet
- [x] Filter the model lists by name, and make free models easy to find: an OpenRouter key adds about 400 rows
- [x] Show the desktop window at once: the first launch after an install takes about 20 seconds to appear, and a later one about 2, with nothing on screen until then
- [x] Retry by itself when a model is unavailable: pi's own retries are over in seconds, and then the chain waits for a person
- [x] Brake an agent that hands off and keeps going: one real run sent 11 varied messages for 606k tokens, and the brake's own abort was reported as a model error
- [x] Get work out of weak models: they can call tools, since every chat message is a tool call, but they report work instead of doing it. Refuse a message from an agent that has used no tool, have the router send a quiet crew back to work, and test that a model really uses a tool

**Done when:** the `v1.2.0` release passes on Windows, Linux and macOS, and its installer takes a task to `APPROVE` on a real model.

## Next

Not scheduled yet.

- [ ] Run a crew on a real weak model: the refusal and the watcher have only met a scripted one, and `openai/gpt-4o` needs credit on OpenRouter
- [ ] Find out which tools agents are missing: the built-in ones were enough in the real runs so far
- [ ] Spend less on context: about 96% of the tokens in a real run were context sent again on each turn, so try prompt caching on providers that have it
- [ ] Stop a planner going on after its handoff: on a real model it checked its plan again and sent the same work a second time, and its status posts woke the implementer and the reviewer. It spent 257k of the run's 490k tokens
- [ ] Keep small jobs small: the planner still writes an OpenSpec proposal for a one-page app
- [ ] Publish to the npm registry, which needs the owner's account
- [ ] Sign the installers, which needs certificates in the owner's name

## Not planned for 1.0

- Hosted or multi-user use: one token, one user. Exposing the GUI beyond your machine means putting it behind your own TLS proxy or VPN.
- Agents spread across several machines.
