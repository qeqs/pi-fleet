# Changelog

## 1.2.1

The first run on a real weak model, `liquid/lfm-2.5-2.6b:free`, looked like success and was not. The
planner wrote the page itself, to a path it made up, and reported it done. The project folder stayed
empty, nobody reviewed anything, and the router, rate limited, dropped the job without a word.

- A planner's run ends with its handoff. Once everyone who can take the work has it, the run stops,
  as a finished run with no error and no notice. Until then it may not send the same work again or
  post a status that wakes the others. It also hands off with `fleet_mention`, so the group sees it.
  One real task went from 490k tokens to 127k, and the planner's share from 257k to 22k. A reviewer's
  verdict ends its run the same way, since a real one sent the same `APPROVE` twice.
- A write outside an agent's working folder is refused once, and the agent is told where to write.
  It goes through if the agent tries again, since a person may have asked for it.
- A planner with an implementer in the crew is told to pass the work on, not to do it, and a file it
  writes outside `openspec/` is refused once. The text that wakes agents used to tell it to do the
  work itself.
- A refused or declined tool call no longer counts as work. pi reports a call before it can be
  refused, so an agent could fail to write a file and still pass as having done something.
- When the router cannot say if a crew has finished, it tries again after another quiet spell, three
  times in all, and then tells you. Before, a busy or failing model ended the watch in silence.

## 1.2.0

- A verdict reaches the group even if a model leaves it in its own chat. When an agent woken by a
  channel ends its run without sending anything, and its last text starts with `APPROVE` or
  `REQUEST CHANGES`, that text is posted to the channel. Any other final text stays in the agent's
  chat, to keep the group quiet.
- Settings → Models and the first-run screen filter models by name, and **Free only** shows the free
  ones. The list in Settings scrolls by itself, so a key that adds 400 models no longer pushes the
  add-a-server and add-a-key forms out of reach.
- The desktop window appears at once and says which project is starting. Before, nothing showed
  until the fleet answered: about 2 seconds on a later launch, and about 20 on the first launch
  after an install. File → Open Project waits until the project is up.
- A run that ends in a model error is tried again by the fleet, after 30 seconds, 2 minutes and
  5 minutes, and the channel says so. That covers connection errors, 429, 5xx and provider errors,
  not a bad key, an unknown model or a limit per day. A person's message, Stop all, a pause or a new
  wake cancels a waiting try. Set `PI_FLEET_RETRY_WAITS` to change the waits, or leave it empty for
  none.
- A crew that stops before the work is done no longer just goes quiet. After 30 seconds of silence
  with nothing running or waiting, the router looks at the task, the tools each agent really used
  and what was said. If the work is unfinished it sends one member back to work, at most twice, and
  then tells you. Set `PI_FLEET_QUIET_MS` to change the wait, or to `0` to turn this off.
- Weak models work instead of reporting work. The text that wakes an agent used to end by telling it
  to reply; it now says to do the work first, because a message does no work. An implementer or
  reviewer that sends a message before using a tool is refused once, and a verdict left in a chat
  counts only from an agent that looked at something.
- Testing a model also checks that it really uses a tool, in Settings → Models, before a crew
  starts, and in `fleet doctor`. A server can accept tools and ignore them, and agents on such a
  model can only write text.
- An agent that hands off and keeps going is stopped much sooner. The tool result tells it that a
  reply will wake it, a run may send 6 messages with nothing new coming in, and one that ignores
  two refusals is stopped. On a real model one such run sent 11 messages and spent 606k tokens.
- Fixed: when the fleet stopped a run, the chat also said it had stopped on a model error.
- Fixed: after a failed start the desktop app never finished quitting.

## 1.1.0

- Settings has a Models tab: add a server or an API key, test that a model answers, and choose the
  default and routing models.
- A model is tested before a crew starts, and `fleet doctor` really asks it for a word.
- A model chosen for an agent survives a restart.
- The first-run screen lists every model to pick from, and follows the default chosen in Settings.
  With several models and no default it asks, since the first could be paid or switched off.
- The desktop app uses the computer's proxy settings, so hosted models work behind one.
- Starting the desktop app a second time brings up the running one.
- Agents wake each other less. A name in passing, such as "thanks @rev", wakes nobody: only the
  names an agent's message opens with do, and the router reads the rest. A person's @name still
  wakes whoever they name.
- Messages for an agent in the middle of a run wait and arrive as one wake.
- Agents are told not to acknowledge, the reviewer's verdict ends the job, and small jobs skip
  OpenSpec. On a real model the same task took 5 messages and 240k tokens, down from 14 and 571k.
- `openspec init` no longer adds skills and prompts for other AI tools to your repository.
- Fixed: a model error showed as empty messages in the agent's chat. It now shows the error, once.
- Fixed: the router said it "gave no usable answer" without saying why, and waited out pi's retries.
- Fixed: with no model set up, `fleet doctor` and a model test waited two minutes for an answer that
  could not come.
- Fixed: every request to pi kept a finished command alive for its full timeout, and every pi process
  left its log file open.

## 1.0.0

- Install with `npm install -g`, which gives you a `fleet` command, or with a desktop installer for
  Windows, Linux or macOS. Installers need no Node on the machine.
- The desktop app works on any folder, with File → Open Project and a recent list. It asks before
  opening a folder that brings its own setup.
- Hubs record their format. Hubs from every earlier release are upgraded on first use, and a hub
  from a newer release is refused.
- A full security review, with findings and open risks in [SECURITY.md](SECURITY.md).
- [GETTING_STARTED.md](GETTING_STARTED.md), [CONTRIBUTING.md](CONTRIBUTING.md) and this changelog.
- Fixed: quitting the desktop app from its menu left the supervisor and agents running, and so did
  sending `kill` to a fleet on Linux or macOS.
- Fixed: a paused fleet from before 0.4 looked as if it was running.

## 0.7.0

- `--worktrees` gives each implementer its own git worktree and branch.
- The GUI shows what an agent changed and merges it after review. A conflict goes back to the
  agent. `/diff` and `/merge` do the same from the terminal.
- Task board and timeline in the GUI. `taskboard` can be set in `fleet.json`.

## 0.6.0

- A first-run screen takes you from an empty app to a working crew with no config file.
- The GUI edits `fleet.json`, manages channels and agents, searches history and picks models.
- Drafts, open tool cards and scroll position survive streaming and reconnects.
- Agent output is rendered as Markdown, safely. Unread counts and desktop notifications.
- Fixed: a slow history reply could wipe a live conversation.

## 0.5.0

- A dedicated router handles channel messages, so no worker spends tokens on routing. Simple cases
  are settled by rules with no model call.
- `--router-model` picks a cheap model for routing.

## 0.4.0

- Agents can ask a person a question, from the GUI or the terminal.
- `--approve` makes chosen tools wait for a person.
- `--max-cost` and `/budget` pause the fleet at a spending limit.
- Routing decisions and agent DMs show in the channel view.

## 0.3.0

- A fleet survives restarts and crashes: agents resume their conversations, and no message is lost.
- Crashed agents restart by themselves, and `/restart` does it by hand.

## 0.2.0

- Every failure reaches the user: bad input, crashes, a lost router, a stalled model and model errors.
- `fleet doctor` checks a setup.

## 0.1.1

- CI on Windows, Linux and macOS.
- The supervisor split into modules that can be tested.

## 0.1.0

- The first version: named pi agents, a group chat, @mentions, channels, a web GUI and a desktop shell.
