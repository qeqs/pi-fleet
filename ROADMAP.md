# pi-fleet roadmap

The road from today's working prototype to a 1.0 that someone other than its author can
install and trust with real work. The current goal in [GOAL.md](GOAL.md) is to finish this file.

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

- [ ] Browser tests for the GUI, which today has only static checks
- [ ] A sanitising Markdown renderer: tables, ordered lists and code blocks all work
- [ ] Your own messages appear at once; multi-line channel messages keep their line breaks
- [ ] Routing prompts are collapsed, not shown as if you had typed them
- [ ] Tool cards, scroll position and drafts survive streaming and reconnects
- [ ] Stop, Restart and Remove for each agent
- [ ] Model picker from `get_available_models`
- [ ] An editable Fleet tab that saves to `fleet.json`, including the channel supervisor
- [ ] A first-run screen with a template picker
- [ ] Unread badges and notifications
- [ ] History search, including archived messages
- [ ] Clear means something consistent: today it only hides messages until the next reload

**Done when:** a new user can go from an empty app to a finished sdlc task without a terminal or a config file, covered by a browser test.

## 6. Safe parallel work

- [ ] Optional git worktree and branch per agent
- [ ] Diff view per agent or task in the GUI
- [ ] Merge flow from an agent's branch after review
- [ ] Task board in the GUI for OpenSpec and beads
- [ ] `taskboard` in `fleet.json` instead of an environment variable
- [ ] Timeline: who woke whom and why, with cost per task

**Done when:** two implementers change the same repository at once and both results merge after review, with no manual git.

## 7. 1.0

- [ ] A `fleet` command from `npm install -g`, instead of `npm run fleet --`
- [ ] Desktop installers for Windows, Linux and macOS
- [ ] Project switcher: the desktop hub is no longer tied to the repository folder
- [ ] Versioned hub format, with upgrades from earlier releases
- [ ] A full security review, with findings fixed
- [ ] Getting-started guide, `CONTRIBUTING.md` and `CHANGELOG.md`

**Done when:** `v1.0.0` is tagged, and a clean machine on each system can install it and finish the sdlc task by following the guide.

## Not planned for 1.0

- Hosted or multi-user use: one token, one user. Exposing the GUI beyond your machine means putting it behind your own TLS proxy or VPN.
- Agents spread across several machines.
