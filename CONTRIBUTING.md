# Contributing

## Setup

You need Node.js 24 or newer and git. The browser tests also need Chrome or Edge.

```bash
npm ci
```

Run the fleet from your checkout with `npm run fleet -- <command>`, and the desktop app with
`npm run desktop`. Nothing needs building: `bin/fleet.mjs` runs the TypeScript sources through tsx.

## Tests

```bash
npm test
```

```bash
npm run typecheck
```

| Tests | What they use |
|---|---|
| `test/*.test.ts` | Unit tests of one module |
| `test/e2e.test.ts` | Real supervisor, bridges and pi, with the scripted model in `test/fake-llm.mjs` |
| `test/gui-browser.test.ts` | The same, driven through real Chrome or Edge |
| `test/desktop.test.ts` | Real Electron. Set `PI_FLEET_APP` to test an installed app. On Linux it needs a display, so run `xvfb-run -a npm test` |

To script a model's behaviour, add a `[[directive]]` to `test/fake-llm.mjs`. Hubs from past releases
live in `test/fixtures/hubs`. They are real output from those releases, so do not edit them.

## The bar for a change

- **Every change ships with a test that fails without it.** A test proves nothing until it has been
  seen to fail, so break the code and watch it go red before you trust it.
- **Failures reach the user.** Nothing may fail silently: bad input ends in a sentence and a
  non-zero exit, and trouble at runtime posts to `#group`.
- **Real models misbehave in ways the scripted one does not.** For anything that touches prompts,
  routing or tools, try it on a real model too.
- Match the code around you, and keep unrelated reformatting out of a change.

## Changing the hub

Any change to how files in the hub are written must keep older hubs working. Bump `HUB_FORMAT` in
`src/hubformat.ts`, add a step to `UPGRADES`, and add a fixture from the last release to
`test/fixtures/hubs`.

## Pull requests

Work on a branch, write commit subjects in the imperative (`Add ingestion retry tests`), and describe
the change and how you checked it. CI runs on Windows, Linux and macOS, and must be green. Screenshots
help for GUI changes. Report security problems as described in [SECURITY.md](SECURITY.md), not in an
issue.

## Releases

1. Move the `Unreleased` part of `CHANGELOG.md` under the new version.
2. Run `npm version <version> --no-git-tag-version`, commit, and merge to `main`.
3. Tag `main` with `v<version>` and push the tag.

The Release workflow then installs each form of the release on each system and finishes a task in
it. Only if that passes does it publish the installers and the npm package to GitHub Releases.
