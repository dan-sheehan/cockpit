# cockpit

cockpit is a local web app that shows what is happening in your Claude Code and Codex environment, and lets you act on it from the same screen.

It reads the real state of both tools on your machine and puts it in one dense, navigable view:

- configuration, skills, instruction files and rules;
- hooks, MCP servers and plugins;
- transcripts;
- the projects they work in, with their git state.

It also runs a bounded collaboration workflow: Claude implements, Codex reviews read-only, Claude responds. You can watch every stage live and replay it afterwards.

**[Quick start](#quick-start)** · Before you run it, read **[docs/access-given.md](docs/access-given.md)**. It explains what cockpit reads, runs and exposes on your machine.

## What it does

- **Shows your environment.** Everything is read from disk or from the CLIs themselves, and labelled `OBSERVED`, `INFERRED` or `UNAVAILABLE` so you know how it knows. A few fixed strings are known exceptions ([docs/design.md](docs/design.md#worth-considering-later)).
- **Notices changes.** It watches the Claude and Codex homes and your projects. It rescans on change and keeps a log of what changed (a skill edited, a setting flipped, a new commit), which is often the first answer to "why did the model behave differently today?".
- **Follows transcripts live.** Claude Code and Codex session logs are parsed into timelines, including sessions you started in a terminal.
- **Acts on projects.** You can run a project's npm scripts and a few git commands, and open it in Finder, VS Code or Terminal with `claude`/`codex`. You can run a headless Claude task, or ask Codex for a read-only review of the working tree. Every action is a fixed, allow-listed operation on a discovered project.
- **Runs a collaboration session.** cockpit assembles context, then Claude investigates and implements. Codex reviews the diff in a read-only sandbox, Claude accepts or rejects each finding, and the tests run. There are at most two review rounds, and cockpit never commits. Each step is recorded with its prompt, command line, output and result: see [docs/workflows.md](docs/workflows.md).
- **Optional:** navigation with an Xbox controller in Chrome.

The left rail has twelve views:

| View | Shows |
|---|---|
| Environment | Claude and Codex versions, homes and settings; toolchain; what takes space in each home; recent changes; Attention items; live processes |
| Activity | One timeline of prompts, Codex threads, cockpit sessions, dispositions, processes, transcript writes and changes |
| Projects | Per project: git state, stack, scripts, trust, AI config, history, and the **act** tab |
| Workflows | Collaboration sessions and the new-task form |
| Transcripts | Claude Code and Codex session logs as timelines |
| Processes | Everything cockpit started, with live output and a stop button |
| Skills | Claude and Codex skills, with a link graph |
| Instructions | Every settings, `CLAUDE.md`, `AGENTS.md`, rules and memory file, by precedence |
| Hooks & Policy | Claude hooks and permission rules, Codex exec-policy rules, and the limits cockpit applies to its own agents |
| MCP & Plugins | MCP servers, plugin marketplaces, the Codex plugin cache |
| Agents | Agent definition files, and the roles cockpit gives Claude and Codex |
| Controller | The Xbox controller's live input trace |

## Requirements

- **macOS.** This is the only platform cockpit has been used on. Finder, Terminal and `npm run open` rely on macOS commands.
- **Node.js ≥ 20.** Only Node 26 has actually been tested.
- **git.**
- **Claude Code (`claude`) and Codex (`codex`) on `PATH`,** for anything that launches them. Scanning works without them. VS Code's `code` command is needed for "open in VS Code".
- A browser. The controller support targets Chrome.

There is nothing to install: no npm dependencies and no build step.

## Why you shouldn't install cockpit

- **It is a personal tool.** It was built for one person's setup, on one OS, around exactly two agent CLIs. There are no releases, no support, and no promise that anything stays the same.
- **It reads sensitive things.** That includes your prompts, transcripts and agent configuration. It serves them, mostly redacted, to any process on your machine that can reach `127.0.0.1:4848`. There is no login.
- **Redaction is best effort.** A secret with no recognisable shape or key name gets through. Process output is shown and stored unredacted.
- **Its buttons do real things.** They run your project's scripts, and they launch Claude with permission to edit files and run `node`/`python3` in a project. They spend money on your Claude and Codex accounts. cockpit does not sandbox Claude.
- **It is only useful if you use both Claude Code and Codex.** Without them most views are empty and the workflow cannot run.

If you still want it, read [docs/access-given.md](docs/access-given.md) first.

## Documentation

| Read | For |
|---|---|
| [docs/about.md](docs/about.md) | What cockpit is for, its scope, and what it deliberately is not |
| [docs/access-given.md](docs/access-given.md) | Exactly what it reads, writes, runs, launches and exposes, and the limits of its protections |
| [docs/workflows.md](docs/workflows.md) | What happens on startup, on change, and when you press each button, including the collaboration session |
| [docs/definitions.md](docs/definitions.md) | cockpit's vocabulary, especially the words that mean two things |
| [docs/design.md](docs/design.md) | The visual language and interaction rules |
| [plumbing.md](plumbing.md) | How the code is wired: modules, API, data, processes, tests |
| [harness.md](harness.md) | Rules for coding agents working on this repo (entered via [AGENTS.md](AGENTS.md) and [CLAUDE.md](CLAUDE.md)) |
| [docs/why-harness.md](docs/why-harness.md) | Why the docs are split this way |

## Quick start

```sh
git clone https://github.com/dan-sheehan/cockpit.git
cd cockpit
npm start          # → http://127.0.0.1:4848/
npm run open       # macOS: open it in the default browser
```

- **Which projects appear.** By default, cockpit sees itself plus every project Claude Code or Codex already knows about. To add a folder of projects:

  ```sh
  COCKPIT_PROJECT_ROOTS="$HOME/code" npm start
  ```

  Other settings (port, data dir, Claude and Codex homes) are environment variables, listed in [plumbing.md](plumbing.md#configuration).
- **Stopping.** Ctrl-C stops the server and every process it started.
- **Local data.** Runtime data goes to `data/`, which is git-ignored. Delete it to clear cockpit's history.
- **Tests.**

  ```sh
  npm test               # no Claude Code or Codex needed
  npm run test:machine   # also scans your real Claude/Codex homes
  ```

## License

MIT. See [LICENSE](LICENSE).
