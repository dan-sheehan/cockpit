# Cockpit

A local tool for inspecting and operating an AI development environment built on Claude Code and Codex.

```sh
npm start      # → http://127.0.0.1:4848/
```

No npm dependencies and no build step: a Node HTTP server plus a vanilla-JS page. The server binds to 127.0.0.1 only.

## What Cockpit is

Cockpit answers one question about the machine it runs on:

> What is happening in my AI environment, why is it happening, and what can I do from here?

It scans the real local state of Claude Code and Codex (their configuration, skills, instruction files, rules, hooks, MCP servers, plugins, agent definitions, transcripts) plus the projects they work in and those projects' git state. It renders that as one dense, navigable instrument. From the same screen you can operate the environment: run allow-listed project commands, launch headless Claude runs, request read-only Codex reviews, and stop processes. It also hosts a bounded Claude → Codex → Claude collaboration workflow, and every stage, finding and disposition of that workflow can be inspected live and afterwards.

It is not a chat window, not a general file browser, and not a dashboard of static counts. Every number, path and state on screen was read from disk or from a process Cockpit itself launched. Where Cockpit shows something it did not directly observe, it says so:

- **OBSERVED** means read from disk, from a CLI, or from a process's output.
- **INFERRED** means derived by Cockpit, such as a project's stack guessed from its files, or an Attention item computed by a heuristic.
- **UNAVAILABLE** means it cannot be observed, such as hidden model reasoning or a test command the project doesn't have.

## Requirements

- **Node.js.** `package.json` declares `engines: node >=20`. This release has been tested on Node 26 only; the lower bound has not been verified.
- **git** for project status, diffs and the workflow's pre-task snapshot.
- **Claude Code (`claude`) and Codex (`codex`)** on `PATH` for the features that launch them. Scanning works without them; a missing CLI is shown as missing.
- **macOS** is the platform Cockpit has been developed and used on. The Finder and Terminal launch actions, and `npm run open`, use macOS commands (`open`, `osascript`). The editor action needs VS Code's `code` command on `PATH`. Other platforms are untested.
- A browser for the UI. The optional Xbox controller support targets Chrome (see below).

## Running it

Clone the repository, then from the checkout:

```sh
npm start              # start the server → http://127.0.0.1:4848/
npm run open           # macOS: open that URL in the default browser
npm test               # default test suite (no Claude Code or Codex needed)
npm run test:machine   # also runs the real-machine scan test
```

There is nothing to install: `package.json` has no dependencies. Ctrl-C stops the server and every subprocess it started.

Configuration is by environment variable only:

| Variable | Effect |
|---|---|
| `COCKPIT_PORT` | Port to listen on (default `4848`), e.g. `COCKPIT_PORT=5000 npm start`. |
| `COCKPIT_PROJECT_ROOTS` | Extra directories to search for projects (see [Project discovery](#project-discovery)). |
| `COCKPIT_DATA_DIR` | Where runtime data is written (default `data/` in the checkout). |
| `CLAUDE_CONFIG_DIR` | Honoured as Claude Code honours it: replaces `~/.claude`, and `.claude.json` is read from inside it. |
| `CODEX_HOME` | Honoured as Codex honours it: replaces `~/.codex`. |
| `COCKPIT_MACHINE_TESTS=1` | Enables the real-machine test (what `npm run test:machine` sets). |

## Architecture

```
server.mjs              local HTTP + SSE on 127.0.0.1, Host-header check, Origin/JSON guard on POST, no CORS
lib/homes.mjs           where Claude Code and Codex keep their state (CLAUDE_CONFIG_DIR / CODEX_HOME aware), path containment helpers
lib/scan.mjs            environment scanner (read-only) → one JSON inventory; project discovery
lib/redact.mjs          pattern/structure-based credential redaction
lib/git.mjs             status / diff / pre-task snapshot (git stash create)
lib/runs.mjs            process manager: every subprocess is a Run with live output + persistence
lib/adapters/claude.mjs claude -p --output-format stream-json (plan | acceptEdits, --resume, --json-schema)
lib/adapters/codex.mjs  codex exec --sandbox read-only --ephemeral --json --output-schema
lib/workflow.mjs        collaboration state machine (stages, findings, dispositions, limits)
lib/transcripts.mjs     read-only parsers for Claude Code and Codex session logs
lib/watch.mjs           fs.watch on config roots → debounced rescan; live transcript watch
lib/envdiff.mjs         diff of consecutive scans → change log
lib/report.mjs          Markdown report of a session
lib/terminal.mjs        opens an interactive claude/codex in Terminal.app (macOS)
lib/store.mjs           JSON files under data/sessions and data/runs
public/                 vanilla-JS single page; controller.js + controller-core.js for the optional gamepad
test/                   node --test suites (see Tests)
```

Concepts: **environment → project → agent → workflow → session → stage → context → artifact → finding → action**. Provider-specific execution lives only in `lib/adapters/`. There are two adapters because two providers are supported; nothing speculative.

Visual language: monospace, dark, square, hairline borders. Claude is cyan, Codex is violet, and Cockpit is amber. OBSERVED is green, INFERRED is amber, and UNAVAILABLE is dim.

## Project discovery

A project in Cockpit is an action target (scripts, git, Claude/Codex runs) and a file-viewer root, so discovery is deliberately bounded. Sources, from `discoverProjectPaths` in `lib/scan.mjs`:

1. **Cockpit itself.** It is identified from the location of its own code (the checkout containing `lib/`), not from the current working directory, and is always included.
2. **`COCKPIT_PROJECT_ROOTS`, if set.** This is a list of absolute directories separated by `:` (the platform path delimiter, like `PATH`). Relative entries are ignored, and there is no default: Cockpit does not guess a directory layout. For each root, every non-hidden child directory counts as a project if it contains `.git`, `package.json`, `CLAUDE.md`, `AGENTS.md`, `pyproject.toml`, `README.md` or `.claude`. If a child has none of those, its own non-hidden children are checked the same way (without `.claude`). Discovery goes no deeper than two levels.
3. **Projects known to Claude Code.** These are the paths under `projects` in `~/.claude.json`.
4. **Projects known to Codex.** These are the `[projects."…"]` entries in `~/.codex/config.toml`.

Every path except Cockpit itself must still exist. After resolving symlinks, it also must not be the filesystem root, your home directory, or an ancestor of your home directory: Claude Code and Codex record whatever directory a session ran in, including `~` or `/`, and those are never treated as projects. Without `COCKPIT_PROJECT_ROOTS`, Cockpit sees itself plus the projects Claude Code and Codex already know about.

When a project is scanned, each file Cockpit reads from it (`package.json`, `CLAUDE.md`, `AGENTS.md`, `CLAUDE.local.md`, `.claude/…`, `.mcp.json`, `.agents/skills`) is used only if its real path lies inside the project's real root. A `CLAUDE.md` symlinked to somewhere outside the project is treated as missing.

## Environment visibility

Every rescan, manual or triggered by the watcher, is diffed against the previous one. The differences are appended to `data/changes.jsonl` and shown as **Recent configuration changes** on the Environment view and as `change` rows in Activity. Tracked changes include:

- skills added, edited or removed
- instruction files changed (with size delta)
- hook, MCP and agent counts
- CLI versions
- Claude settings and Codex config edits
- exec-policy rule counts
- git branch, commit and dirty transitions per project
- trust changes
- new transcripts and plans

This is how "why did the model behave differently today" gets a first answer.

**⌘K** (or `/`) searches skills, instruction files (including their text), projects, sessions, transcripts and rules at once. The **Attention** panel on the Environment view lists issues derived from the scan: broken `[[skill]]` links, unresolved `@include`s, Codex trust on `~`, exec-policy rules that allow network or install commands without approval, code without git, dirty repos, and failed or interrupted sessions. Nothing there is hard-coded; each line is computed from what was found, using simple heuristics.

Views (left rail):

- **Environment**: Claude and Codex cards (including Claude's plan files), the toolchain, and where hidden state lives (sizes of everything under the Claude and Codex homes, with databases and credentials marked as not read). Also inventory counts, the "how configuration reaches a task" spine, live processes, recent Claude prompts and Codex threads, and environment variable names.
- **Activity**: one chronological feed of everything observable, including prompts typed into Claude Code (from its `history.jsonl`), Codex thread updates, Cockpit sessions and each finding disposition, Cockpit processes, and transcript files being written. Every row jumps to its source.
- **Projects**: git branch/dirty state, inferred stack, scripts, Claude/Codex trust status, AI config present or absent, the per-project configuration spine, Claude session transcripts on disk, and Cockpit sessions. The **act** tab holds the project's actions.
- **Workflows**: Cockpit's Claude → Codex → Claude collaboration sessions (see below).
- **Transcripts**: the agents' own logs, parsed read-only into timelines. This covers every Claude Code session under `~/.claude/projects` and every Codex rollout under `~/.codex/sessions`.
  - Per session: cwd, CLI version, model(s), permission modes or sandbox policy, time span, tool-use counts, files edited, and cost or tokens where recorded.
  - Then a filterable timeline: user, assistant, tool_use, tool_result, thinking, slash commands, mode changes and system context. Hidden reasoning is labelled UNAVAILABLE.
  - Transcripts are watched: a session being written right now, whether Cockpit launched it or you ran `claude`/`codex` in a terminal, shows a live marker, and its timeline refreshes as the log grows.
- **Processes**: every subprocess Cockpit started, with command, cwd, pid, elapsed time, exit status, live output stream and a stop button.
- **Skills**: searchable and filterable, with a **graph** tab that places all Claude skills on a ring, draws directed `[[link]]`/`/mention` edges, and calls out the most-referenced and isolated skills. Per skill: path, scope, source, invocation, frontmatter, files, outgoing and incoming relationships, and the full body.
- **Instructions & Rules**: the precedence spine per provider (GLOBAL → GLOBAL-LOCAL → PROJECT → PROJECT-LOCAL → MEMORY), with absent layers shown as absent. Claude's per-project memory files are their own layer because Claude Code auto-loads them. Also every settings, `CLAUDE.md`, `AGENTS.md` and rules file, `@include` resolution, and parsed Codex exec-policy rules.
- **Hooks & Policy**: Claude hooks (or, when there are none, what was checked), Codex exec-policy rules as EVENT → RULE → DECISION → EFFECT flows, and the permission boundaries Cockpit applies to each workflow stage.
- **MCP & Plugins**: MCP servers from Claude and Codex configuration, Claude plugin marketplaces and installed plugins, and the Codex plugin cache.
- **Agents**: agent definition files, and the roles Cockpit assigns in its workflow (labelled as a Cockpit definition).
- **Controller**: the optional Xbox controller view (see below).

Any path shown in amber opens in Cockpit's file viewer (see [Privacy and security](#privacy-and-security) for what it will and won't open).

## Operability

These are real controls; nothing on screen is a placeholder. From a project's **act** tab, or from the views:

- run any script from the project's `package.json` (`npm test`, `npm run dev`, …) with live output
- `git status`, `git diff --stat` and `git log --oneline -20` as processes, plus the full inline diff
- open the project in Finder or in VS Code
- open an **interactive** `claude` or `codex` session in Terminal.app in that project. Cockpit launches it and records the launch, but it does not own or observe the interactive session.
- run a headless **Claude** task in the project: `plan` mode (read-only) or `acceptEdits`, with a chosen model and a $2 budget cap
- request an ad-hoc **Codex** read-only review of the working tree's unstaged changes (`git diff`, plus untracked file names)
- start, cancel or retry a collaboration session
- stop any running process (SIGTERM to its process group, then SIGKILL after 3 s)
- rescan the environment. Usually you don't need to: Cockpit watches the Claude and Codex homes, `.claude.json`, each project's top-level files, its `.claude/` and `.agents/`, and its `.git` `index`/`HEAD`, and rescans when they change. When a rescan finds a different set of projects, the watcher is rebuilt for the new set.

Allow-listing: every action requires a project path that is in the current discovered-project list, and `npm.run` accepts only scripts present in that project's `package.json`. The action names are fixed and there is no free-form shell endpoint. A project's scripts are still that project's code: running one executes it as you.

## Visual workflow model

The same "spine" component renders three things: configuration precedence, hook/policy chains, and collaboration sessions. Nodes are square, colour shows state (queued, running, complete, failed, skipped, cancelled), and the participant label shows who acted. Selecting a stage node shows its command line, the exact prompt the agent received, timings, retries, errors, and the live or recorded process output. Findings branch off the review node with their disposition badge.

## Claude / Codex collaboration

Claude is the lead engineer and the **only writer**. Codex is an **independent read-only reviewer**. Cockpit orchestrates:

```
context → investigate (claude, plan) → implement (claude, acceptEdits, --resume)
→ diff (cockpit, vs pre-task snapshot) → review-1 (codex, --sandbox read-only, JSON schema)
→ disposition-1 (claude, --json-schema: ACCEPTED | PARTIALLY ACCEPTED | REJECTED | DEFERRED, applies accepted)
→ [review-2 → disposition-2 only if round-1 accepted findings changed files]
→ tests (npm test if the project has a test script, else UNAVAILABLE) → complete
```

Limits enforced in code:

- at most 2 review rounds
- at most 1 retry per failed stage (from the UI)
- no recursion
- round 2 is skipped when Codex reports no material findings or no accepted finding changed files
- findings Claude returns no disposition for are recorded as DEFERRED

Codex may return `noMaterialFindings: true`, and Cockpit never manufactures disagreement. Each Claude stage has a budget cap, set per session in the new-task form (default $3; implement and disposition stages get twice that).

**Context.** The `context` stage records what surrounded the run, each item labelled OBSERVED, INFERRED or UNAVAILABLE. It covers the working directory, git state and baseline, project and global instruction files, Claude memory files, skills on disk, hooks, MCP servers, the test command, the inferred stack, and the exact CLI command lines. Once the run starts, the model, skills and tools Claude actually loaded are added from its init event.

**Read-only review.** Codex is launched with `--sandbox read-only --ephemeral`. Cockpit records every command Codex ran, counts sandbox denials in the output, and flags write-like commands, all shown per review. Because `--ephemeral` is set, Cockpit-driven reviews leave no session in Codex's own store.

**Traceability.** Each finding appears on one card with its disposition (by whom, and why), the files changed, and the test result.

## Inspecting a session

Every session is one JSON file, `data/sessions/<id>.json`. It holds the task, project, participants, limits, and stages with timings, commands and errors. It also holds the evidence-labelled context, the investigation, the implementation summary, every captured diff, every review with the commands Codex ran, every disposition, the tests, and an event log.

Process output is stored in `data/runs/<runId>.json`. `GET /api/sessions/<id>/report` (the **markdown report** link on a session) renders the same record as one Markdown document. The UI reads the same files, so a session from a previous server run can be fully replayed from **Workflows**. A session that was running when the server stopped is shown as `interrupted`.

## Privacy and security

Cockpit is a local developer tool for a trusted user on their own machine. It is not a security product, and the measures below are defence in depth, not a boundary against a hostile local user.

**Network exposure**
- The server binds to `127.0.0.1` only and rejects requests whose `Host` header is not `127.0.0.1` or `localhost`, which guards against DNS rebinding.
- Every request other than GET/HEAD (all actions, sessions, stop, cancel, retry) must carry the exact `Origin` of Cockpit's own UI (`http://127.0.0.1:<port>` or `http://localhost:<port>`) and a `Content-Type: application/json` body. No CORS headers are sent. This stops other web pages from driving Cockpit through your browser.
- There is no authentication. Any local process that can reach the port can read the GET API.
- Cockpit's server makes no outbound network calls and has no telemetry. The `claude` and `codex` processes it launches talk to their own providers as usual, and what they send is governed by those tools.

**Where actions can point**
- Action, git and session targets must be discovered projects (see [Project discovery](#project-discovery)); a request naming any other path is refused.

**File viewer**
- The viewer can open only these roots:
  - the Claude and Codex homes (unless one is set to your home directory or above)
  - `.claude.json`
  - Cockpit's own checkout
  - discovered projects
- Paths are resolved through symlinks before the check, so an alias cannot escape those roots.
- It always refuses `auth.json`, `.env` and `.env.*`, `.netrc`, `.npmrc`, `.git-credentials`, credentials files, SQLite databases, `history.jsonl`, `.pem` files and SSH private-key files, wherever they are.
- Everything it does show passes through the redactor. Files over 1.5 MB are not displayed.
- The transcript parser only reads `.jsonl` files under the Claude `projects` and Codex `sessions` directories.

**Redaction**
- `lib/redact.mjs` recognises credentials by pattern and structure. That covers known token formats (`sk-…`, `ghp_…`, AWS keys, JWTs, Slack tokens, …), private-key blocks, `Authorization` headers, sensitive key names (`*key*`, `*token*`, `*secret*`, `*password*`, …) in JSON, TOML and `key = value` lines, URL query parameters and userinfo, `.npmrc` and `.netrc` syntax, and sensitive flags and headers in hook commands and MCP args.
- It is applied to scanned configuration and instruction files, hook commands, MCP definitions, recent prompts, transcript timelines, and the file viewer.
- It is also applied to the diffs Cockpit captures for sessions and sends in Codex review prompts (collaboration and ad-hoc), and to settings files quoted in review prompts.
- Redaction is not a guarantee. An opaque secret in free-form text with no recognisable shape or key name will pass through.
- Environment variable values are never sent to the UI; only names, whether each is set, and value length are.

**What is not redacted**
- **The Projects → git full-diff view** shows the real local `git diff`, unfiltered, because it is your working tree shown to you. It is not passed through the redaction that applies to material Cockpit sends to models.
- **Process output** in Processes and in `data/runs/` is stored as the process produced it.
- **Codex reviews.** Codex runs with `--sandbox read-only` in the project directory, so it can read project files itself during a review. Redaction applies only to the prompt Cockpit sends, not to what Codex reads. Review prompts also quote the project's instruction files (`CLAUDE.md`, `AGENTS.md`, memory) as written.
- **Claude stages** have broader capabilities than the reviewer:
  - `investigate` runs in `plan` mode.
  - `implement` and `disposition` run in `acceptEdits` with an allow-list that includes `Edit`/`Write` and `Bash` prefixes such as `npm run`, `node` and `python3`, which can execute arbitrary code in the project.
  - Claude Code also applies your own Claude permission settings.
  - Those subprocesses are not sandboxed by Cockpit; they run as you, with your environment, just as they would from a terminal.
  - The prompts tell Claude not to commit, and `git commit`/`git push` are not in the allow-list Cockpit passes, but that is not a hard guarantee.

**What Cockpit writes**
- Apart from its own `data/` directory, Cockpit's own code does not edit files in `~/.claude`, `~/.codex` or your projects. Changes there come only from subprocesses you launch: Claude runs, project scripts, and the CLIs themselves. For example, a headless `claude -p` run updates Claude Code's own `.claude.json` and transcripts, exactly as any Claude session does.
- Git inspection can have the ordinary side effects of running git. `git status` may refresh `.git/index`, and the workflow's pre-task snapshot (`git stash create`) writes unreferenced objects into `.git` without touching the working tree or the stash list.
- Codex review runs write their output schema and last message to a temporary directory under the OS temp dir.

**Runtime data**
- `data/` (or `COCKPIT_DATA_DIR`) holds `sessions/`, `runs/` and `changes.jsonl`.
- That includes prompts, full process output, captured diffs, Codex review text, costs, local paths and other machine-local state. Treat it as private.
- `data/` is listed in `.gitignore`. Delete it to clear Cockpit's history.

**Shutdown.** On Ctrl-C or SIGTERM, Cockpit sends SIGTERM to every subprocess group it owns, sends SIGKILL 1.5 s later, and marks running sessions `interrupted`.

## Tests

```sh
npm test               # default suite
npm run test:machine   # default suite + the real-machine scan
```

The default suite needs no Claude Code or Codex installation and uses fixture homes. It covers:

- redaction, including redaction in scans and review prompts
- frontmatter parsing, the scanner, and project discovery and containment
- file-viewer roots and credential-file refusal
- request admission (Host/Origin/Content-Type)
- adapters, transcripts, the watcher, env diff, the report, and Terminal launch argument handling
- server tests that boot the real server on a spare port
- the controller core and adapter

One test is skipped by default: the real-machine scan in `test/machine.test.mjs`. It scans your actual Claude and Codex homes and expects both CLIs to be installed, so it runs only under `npm run test:machine`.

## Current limits

- One collaboration session at a time is the intended use; concurrent sessions in the same project would share a working tree.
- The pre-task baseline is a `git stash create` snapshot. Edits made by anything other than Claude during the session appear in the diff, and Codex will correctly flag them as out of scope. Non-git projects get no diff.
- The tests stage only knows `npm test`. Projects without a `test` script, including Python projects, show tests as UNAVAILABLE.
- Claude's "files touched" is inferred from Edit/Write tool calls in the stream; the diff is the ground truth.
- The Codex model defaults to whatever the Codex config says; Cockpit does not enumerate Codex models. The Claude model picker is a short built-in list plus the CLI default.
- Skill relationship analysis covers `[[name]]` links and `/name` mentions only.
- Transcript timelines show what the CLIs stored. Claude thinking blocks are usually empty, Codex's base system prompt is counted but not displayed, and very long sessions are capped at 3000 events in the UI.
- The transcript "what shaped this session" panel is INFERRED from the current disk state, not a snapshot taken at the time of that session.
- The Attention panel uses simple heuristics (prefix matches on exec-policy rules, presence checks). It is a prompt to look, not a verdict.
- Plugins: Cockpit lists marketplace contents and the installed-plugins file; it does not resolve plugin-provided commands or MCP servers.
- The Terminal launch buttons use AppleScript. The first use may trigger a macOS automation permission prompt for the app hosting the `node` process.
- Project discovery covers only the sources in [Project discovery](#project-discovery). A project that Claude Code and Codex don't know about and that isn't under `COCKPIT_PROJECT_ROOTS` does not appear.

## Optional: Xbox controller

Cockpit can also be navigated with an Xbox Wireless Controller. It is an optional peripheral layered onto Cockpit's existing navigation, and mouse and keyboard behaviour is unchanged. It is not a keyboard imitation: the whole physical-input path is visible in the **Controller** view (left rail, or press **View** on the pad):

```
PHYSICAL INPUT → RAW GAMEPAD INPUT → NORMALIZED EVENT → MAPPING → COCKPIT ACTION → RESULT
   A pressed       button[0] = 1.0      controller.select   cockpit.activateSelected   opened: cockpit
```

**How it works.** It uses the browser Gamepad API only, with no Node component, no driver and nothing to install. Chrome exposes the controller with the W3C `standard` mapping.

- **`public/controller-core.js`** is pure and unit-tested. `normalize()` turns a raw snapshot into named buttons, with a radial dead zone of 0.12 and analog triggers. `step()` produces edge-triggered presses, D-pad/left-stick repeat (350 ms, then every 110 ms) and stick hysteresis (0.6 on, 0.4 off). `resolve()` applies the mapping table.
- **`public/controller.js`** polls with `requestAnimationFrame`, paints the schematic, dispatches named actions, tracks the last changed raw input, and keeps the last 60 meaningful events (transitions and actions only, never one per frame) in `sessionStorage` for the tab.
- **`public/app.js`** owns every behaviour in `window.Cockpit.actions`; the controller only calls that registry.

Row navigation moves real DOM focus over the current list's rows (`data-key`, `tabindex="0"`), so the same rows are reachable with Tab, and Enter or Space activates the focused row through its own click. Focus survives Cockpit's live re-renders and is never taken from an input.

**Mappings** (the table in the Controller view is the source of truth):

| Input | Event | Cockpit action |
|---|---|---|
| D-pad / left stick ↑ ↓ | `controller.nav.up/down` | move focus to the previous / next row of the current list (repeats while held) |
| D-pad / left stick ← → | `controller.nav.left/right` | previous / next tab in the detail pane |
| A | `controller.select` | open the focused row (with no focused row, focus the selected one) |
| B | `controller.back` | close the file viewer, else browser history back |
| LB / RB | `controller.prevView/nextView` | previous / next view in the left rail |
| LT / RT (analog) | `controller.lt/rt.engage` | scroll the detail pane; speed follows the trigger value |
| View | `controller.inspect` | open the Controller view |
| Menu | `controller.launcher` | open Workflows → new task form (starts nothing) |

**Safety boundary.** The controller can only navigate:

- X, Y, L3, R3, the Xbox button and the right stick are diagnostic only. They show in the schematic and in `last changed input`, and the trace says `unmapped`.
- The focus set is exactly the list rows, whose clicks only change the route. Buttons, links, inputs and selects are never in it, and no mapping performs a `POST`.
- So nothing that launches Claude or Codex, runs scripts, starts a workflow, stops a process or touches files is reachable from the controller. Menu opens the new-task form but cannot submit it.
- Row navigation is ignored while an input, textarea or select has focus.
- Actions are suspended (and the view says so) when the Cockpit window is not focused; input is still visualised.
- A pad without the `standard` mapping shows raw buttons and axes only and drives nothing.

**Honesty labels.** Everything in the view is OBSERVED from `navigator.getGamepads()`. When no gamepad is listed, the view says so and why: Chrome lists a pad only after a button press. When the tab is hidden, `requestAnimationFrame` polling stops and the view shows the visibility state.

**Tests.** `test/controller.test.mjs` covers:

- normalisation, last-changed raw input, the dead zone, and stick hysteresis and drift
- edge-triggered presses, repeat timing, trigger transitions, and disconnect while held
- a 16-button layout
- the mapping allow-list: every accepted raw index resolves to an existing app action, and nothing else does
- diagnostic-only inputs, including Y held then A
- left-stick parity with the D-pad
- the DOM-focus contract: clamping, activation, remembered row, text-field ignore, Enter/Space, restoration across re-renders, and view change
- an adapter test that steps `tick()` with a fake pad: one activation per press, once-per-frame scrolling, and no clicks or POSTs from the adapter itself

**Limits.** The tests use synthetic gamepad snapshots, not a physical controller. `DEAD_ZONE`, `TRIGGER_ON` and `REPEAT_*` in `controller-core.js` are the tuning knobs for real hardware. The feature targets Chrome; Safari and Firefox are untested. It uses one primary pad: an Xbox pad is preferred, and other pads are listed as ignored. Views without a `data-key` list report "no list rows". Event history lives in `sessionStorage` for the tab, not on disk.
