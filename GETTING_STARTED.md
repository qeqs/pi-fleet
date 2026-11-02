# Getting started

From nothing to a crew of agents finishing a task, in about ten minutes. You need a model pi can
reach, and either the desktop app or Node.js 24 or newer. Agents run with your account's
permissions, so read [what they can do](SECURITY.md#what-an-agent-can-do) before pointing them at
anything you care about.

## 1. Install

### Desktop app

Download the installer for your system from the
[releases page](https://github.com/qeqs/pi-fleet/releases/latest). It brings everything it needs,
including Node.

| System | File | First run |
|---|---|---|
| Windows | `pi-fleet-<version>-win-x64.exe` | Windows warns about an unknown publisher: choose **More info**, then **Run anyway**. |
| macOS | `pi-fleet-<version>-mac-arm64.dmg` | Drag the app to Applications. macOS refuses unsigned apps, so right-click it and choose **Open**, or run `xattr -dr com.apple.quarantine /Applications/pi-fleet.app`. |
| Linux | `pi-fleet-<version>-linux-x86_64.AppImage` | Run `chmod +x` on the file, then start it. If Ubuntu reports a sandbox error, start it with `--no-sandbox`. |

The installers are not code-signed, which is why these warnings appear.

### Command line

```bash
npm install -g github:qeqs/pi-fleet#v1.2.0
```

This gives you the `fleet` command. Check it with:

```bash
fleet --version
```

## 2. Connect a model

pi-fleet runs [pi](https://pi.dev), and uses whatever models pi knows. Set this up once, and both
the command line and the desktop app will find it in `~/.pi`.

**In the app.** Open **Settings → Models** to add a server or an API key, and press **Test** to check
that a model answers. A key can bring hundreds of models: filter them by name, or tick **Free only**.
You can also do it from the terminal, as below.

**A hosted provider.** Install pi and sign in:

```bash
npm install -g --ignore-scripts @earendil-works/pi-coding-agent
```

```bash
pi
```

Inside pi, type `/login`, choose your provider, then quit with `/quit`.

**A local model.** Tell pi about any OpenAI-compatible server, such as Ollama, by creating
`~/.pi/agent/models.json`:

```json
{
  "providers": {
    "ollama": {
      "baseUrl": "http://localhost:11434/v1",
      "api": "openai-completions",
      "apiKey": "ollama",
      "models": [{ "id": "qwen3:8b", "contextWindow": 32768, "maxTokens": 4096 }]
    }
  }
}
```

A model's full name is `provider/id`, as in `ollama/qwen3:8b`.

## 3. Check your setup (command line)

Go to the project you want the agents to work in, and run:

```bash
fleet doctor
```

Each line should say `ok`. A `warn` is safe to ignore for now. A `fail` tells you what to fix. The
`model` line really asks the model for a word, so it also shows whether its server is up and its key
is good.

## 4. Run your first task

The `sdlc` crew is three agents: a planner, an implementer and a reviewer.

### In the desktop app

1. Open pi-fleet and choose your project folder.
2. Pick a model, then press the `sdlc` crew. The app checks that the model answers before it starts.
3. When the three agents show as idle, type a task, such as `Add a hello.txt containing the word hi`, and press Enter.
4. Watch them work. The task is finished when the reviewer posts `APPROVE`.

Use **File → Open Project** to move to another folder. Each folder keeps its own agents and history
in a `.pi-fleet` folder, which you will want to add to `.gitignore`.

### On the command line

```bash
fleet up --template sdlc --model provider/model
```

When the prompt appears, send the task to the group by starting the line with `#`:

```text
# Add a hello.txt containing the word hi
```

The task is finished when the reviewer posts `APPROVE`. Type `/quit` to stop the fleet.

To use the web page instead of the terminal, start the fleet with:

```bash
fleet serve --template sdlc --model provider/model --open
```

## 5. Keep yourself in control

- **Stop**: `Stop all` in the app, or `/stopall` in the terminal, aborts every run and pauses the fleet.
- **Spending**: start with `--max-cost 5` to pause the fleet at five dollars.
- **Approvals**: start with `--approve bash,write`, and agents wait for you before using those tools.
- **Crew and models**: Settings → Fleet in the app, or `fleet init` and then edit `.pi-fleet/fleet.json`.

## 6. Work on one repository in parallel

Give each implementer its own git worktree and branch with `--worktrees`:

```bash
fleet up --worktrees --model provider/model --agent "impl1:.::implementer" --agent "impl2:.::implementer" --agent "reviewer:.::reviewer"
```

When the review is done, press `Changes` on the agent in the app to see its diff and merge it, or
use `/diff impl1` and `/merge impl1` in the terminal. See [Parallel work](README.md#parallel-work).

## If something goes wrong

| What you see | What to do |
|---|---|
| A `fail` from `fleet doctor` | Follow the message on that line. |
| `pi does not know "provider/model"` | Finish step 2, and use the full `provider/id` name. |
| `Model error: Connection error` | Nothing is answering at the model's address. Start its server, or test another in Settings → Models. |
| `got a model error ... It tries again in 30s` | The fleet tries again by itself, three times over about 8 minutes. Your next message or Stop all cancels that. |
| A hosted model answers `403`, or cannot be reached | The desktop app uses your system proxy. On the command line, set `HTTPS_PROXY` yourself. |
| The agents stay idle after a task | Check for a notice in `#group`, such as a pause or a model error. Send any message to lift a pause. |
| `the crew has stopped with the work unfinished` | The model was reminded twice and still only talked. Send a message to try again, or test a stronger model in Settings → Models. |
| `so it cannot tell if the crew has finished` | The router's model did not answer three times, so nothing checked the work. Look at what the crew did, and send a message if it is not done. |
| `answers, but did not use a tool` | The server ignores tools, so agents on it can write text but not work. Turn on tool calling in the server, or choose another model. |
| `another supervisor is already running` | Another fleet is using this folder. Stop it, or pass `--dir` to use a separate one. |
| Agents still running after you quit | `fleet list` shows them, and `fleet stop all` stops them. |

The [README](README.md) covers everything else, and bugs and questions are welcome on the
[issue tracker](https://github.com/qeqs/pi-fleet/issues).
