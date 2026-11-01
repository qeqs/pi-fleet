# Security

## Reporting a problem

Please use [a private advisory](https://github.com/qeqs/pi-fleet/security/advisories/new) rather
than a public issue, with the version, your system and the steps to reproduce it.

## What an agent can do

**An agent runs with your account's permissions.** pi's tools can read, change and run anything you
can, and a model can be steered by what it reads: a file, a web page or another agent's message.
pi-fleet adds coordination, not a sandbox.

- `--approve` and `--max-cost` are brakes for a cooperative model, not a boundary. An agent that can
  write files can also write to the hub, because the hub is just files under your account.
- A git worktree protects agents from each other's mistakes, not from each other's intent.
- For work you do not fully trust, run the fleet in a container or virtual machine, with only the
  files and credentials the task needs. See pi's
  [guide](https://github.com/earendil-works/pi/blob/main/packages/coding-agent/docs/security.md).

## What pi-fleet protects

| Who | What stops them |
|---|---|
| A website you visit while the GUI runs | Every request needs the token. The cookie is `HttpOnly` and `SameSite=Strict`, and cross-origin requests are refused. |
| Other people on your network | The GUI listens on `127.0.0.1` unless you pass `--host`. With `--host` it is plain HTTP and the fleet warns you: use a TLS proxy or a VPN. |
| Text from a model, shown in the GUI | Markdown is built from escaped pieces, under a nonce-based CSP that blocks scripts and remote images. |
| Text from a model, shown in the terminal | Control characters are removed before printing. |
| Other accounts on your machine | The hub is private to its owner, and bridge sockets are too, on Linux and macOS. |
| A folder you open in the desktop app | The app asks before opening a new folder that has its own fleet or pi configuration. |
| A program planted in a folder | Programs run by full path, never through a shell. |

Whoever holds the GUI token controls the fleet, which includes starting agents and editing their
configuration. Treat the link printed at startup like a password.

## Open risks

These were reviewed for 1.0 and accepted. Each has a reason, and most have a way to reduce it.

| Risk | Why it stands | What you can do |
|---|---|---|
| `fleet up` runs what a folder's `.pi-fleet/fleet.json` names, with no prompt | You ran it in that folder yourself, like `npm run`. Only the desktop app opens folders on your behalf, and it asks. | Read the file first in a folder you did not create. |
| Installers are not code-signed | Signing needs certificates in the project's name. | Compare the file against the release page, or use the npm install. |
| `npm install -g` keeps pi's pinned `undici` 8.10.2, which has known advisories | pi 1.4.0 pins that exact version, and npm ignores a package's own overrides on global install. Installers and `npm ci` use the fixed 8.12.3 and pass `npm audit`. Most of the advisories are denial of service by a hostile server, so the exposure is mainly a malicious model endpoint. | Use the desktop app, or only connect to model endpoints you trust. Fixed once pi updates. |
| On Windows, other accounts may be able to read a named pipe | Windows' default pipe permissions allow reading, and Node offers no way to change them. | Do not run a fleet on a Windows machine shared with people you do not trust. |
| GUI request bodies have no size limit | Only a token holder can send one, and they could stop the fleet anyway. | None needed. |

## The 1.0 review

Covered: the web GUI, the desktop shell, bridges and sockets, the hub's files, process launches, agent
names, what reaches the terminal, the CI and release workflows, and dependencies. Each fix below has
a test that fails without it.

| Severity | Finding | Fix |
|---|---|---|
| High | On Windows a bare program name finds a file in the working folder first, so a `git.exe`, `bd.exe` or `taskkill` in a repository would run in place of the real one. | Programs run by full path, in `src/programs.ts`. |
| High | Opening a cloned repository in the desktop app started whatever its `.pi-fleet/fleet.json` named. | The app asks before opening a new folder with its own setup. |
| High | On Linux and macOS the hub was readable by other users, which exposed conversations and logs. | Hubs are created private, and older hubs are closed on upgrade. |
| High | `undici` had known high-severity advisories. | Raised to 8.12.3, except as noted above. |
| Medium | `fleet stop` built a shell command from a pid read from `agents.json`, so a tampered registry could run commands. | No shells, and pids are checked to be numbers. |
| Medium | The desktop app's GUI token was in every agent's environment, where a model could print it. | Removed from what agents inherit. |
| Medium | Bridge sockets relied on the umask, and anyone who can reach one can drive pi. | Sockets are set to owner only. |
| Medium | On Linux and macOS, quitting the desktop app or sending `kill` to a fleet left its agents running. | The supervisor stops them on `SIGTERM`, and the app waits for that before it exits. |
| Low | Agent names such as `__proto__` and `nul` were accepted, and mean something else as an object key or a Windows file name. | Refused. |
| Low | Model output could carry escape sequences to retitle or rewrite a terminal. | Control characters are removed before printing. |
| Low | The desktop window could be navigated to another site. | It stays on the fleet's page, and links open in the browser. |
| Low | The desktop app granted any permission a page asked for. | Only notifications are allowed. |
| Low | `minimatch` had a moderate advisory. | Raised to 11.0.3, except as noted above. |
| Low | CI workflows ran with default permissions, and the release used movable action tags. | Read-only by default, and the release pins actions to commits. |
