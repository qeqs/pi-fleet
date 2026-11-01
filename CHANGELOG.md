# Changelog

## Unreleased

- Settings has a Models tab: add a server or an API key, test that a model answers, and choose the
  default and routing models.
- A model is tested before a crew starts, and `fleet doctor` really asks it for a word.
- A model chosen for an agent survives a restart.
- Fixed: a model error showed as empty messages in the agent's chat. It now shows the error, once.
- Fixed: the router said it "gave no usable answer" without saying why, and waited out pi's retries.
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
