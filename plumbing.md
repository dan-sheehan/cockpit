# plumbing

How cockpit is wired together. Other docs cover the rest:

- What cockpit may read, write, run and expose: [docs/access-given.md](docs/access-given.md).
- What happens during each runtime flow: [docs/workflows.md](docs/workflows.md).
- Vocabulary: [docs/definitions.md](docs/definitions.md).

## Shape

cockpit is one Node process, `server.mjs`. It has no npm dependencies and no build step. It serves a vanilla-JS page from `public/` and a JSON + SSE API under `/api/`, on `127.0.0.1` only (default port 4848). The rest of the code is ES modules in `lib/`.

```
public/app.js ── GET/POST /api/* ──▶ server.mjs ──▶ lib/scan.mjs      reads Claude/Codex homes, projects, CLIs
      ▲                                  │      ──▶ lib/runs.mjs      spawns and tracks child processes
      │                                  │      ──▶ lib/workflow.mjs  drives collaboration sessions
      └──── SSE /api/events ◀── bus ◀────┘      ◀── lib/watch.mjs     fs.watch → rescan / transcript events
```

`bus` is the single `EventEmitter` exported by `lib/runs.mjs`. Runs, sessions, scans and watchers emit on it, and `server.mjs` forwards every event to every SSE client.

## Modules

| Path | Responsibility |
|---|---|
| `server.mjs` | HTTP server, request admission, API routing, static files, file-viewer allow-list (`fileAllowed`, `BLOCKED_FILE`), scan cache, change log, watcher setup, shutdown |
| `lib/homes.mjs` | Where Claude Code and Codex keep state (`CLAUDE_HOME`, `CLAUDE_JSON`, `CODEX_HOME`), `coversPath`, `realPathWithin`. The only place these locations are defined |
| `lib/scan.mjs` | `scanEnvironment()`: the read-only inventory of the machine. `discoverProjectPaths()`. `COCKPIT_ROOT` |
| `lib/frontmatter.mjs` | Minimal frontmatter parser for `SKILL.md` and agent files |
| `lib/redact.mjs` | `redactText`, `redactInline`, `redactArgs`, `redactObject`, `safeEnvNames` |
| `lib/git.mjs` | `gitSummary`, `gitDiff`, `treeSnapshot` (`git stash create`), `diffSince` |
| `lib/runs.mjs` | Process manager. Every child process is a run. `bus` lives here |
| `lib/adapters/claude.mjs` | `claude -p` argv builder, launcher, stream-json parser, `CLAUDE_MODELS` |
| `lib/adapters/codex.mjs` | `codex exec` argv builder (always `--sandbox read-only`), `REVIEW_SCHEMA`, JSONL parser |
| `lib/workflow.mjs` | Collaboration session state machine, prompts, limits, `redactDiff`, `captureDiff` |
| `lib/report.mjs` | Markdown rendering of a saved session |
| `lib/transcripts.mjs` | Lists and parses Claude Code and Codex session logs, read-only |
| `lib/watch.mjs` | `startWatching` (config roots → rescan) and `watchTranscripts` (log files → events) |
| `lib/envdiff.mjs` | Pure diff of two scans into human-readable change entries |
| `lib/store.mjs` | JSON files under the data dir. Creates `sessions/` and `runs/` on import |
| `lib/terminal.mjs` | `osascript` argv that opens Terminal.app in a project and starts `claude` or `codex` |
| `public/index.html` | Loads `app.js` (classic script) and `controller.js` (module) |
| `public/app.js` | The whole UI: state `S`, the `h()` DOM helper, hash routing, data loading, SSE handling, every view, `window.Cockpit.actions` |
| `public/controller-core.js` | Pure gamepad logic: normalize, step, `MAPPINGS`. Shared by browser and tests |
| `public/controller.js` | Browser adapter: Gamepad API polling, Controller view, dispatch into `window.Cockpit.actions` |
| `public/style.css` | Design tokens (`:root`) and every class. See [docs/design.md](docs/design.md) |

## Sources of truth

- **The machine** is the source of truth for everything in the environment views. cockpit keeps one scan result in memory (`envCache` in `server.mjs`) and never persists it. A rescan replaces it, and concurrent requests share one in-flight scan.
- **The discovered-project list** is `envCache.projects`. Every action, git request, session and file-viewer check is made against the current list.
- **cockpit's own records** live in the data dir (`data/` in the checkout, or `COCKPIT_DATA_DIR`):
  - `sessions/<ses_…>.json`: one file per collaboration session.
  - `runs/<run_…>.json`: one file per process, including its captured output.
  - `changes.jsonl`: one JSON line per detected configuration change. It is append-only and never trimmed; the server keeps the last 500 entries in memory.
- **Live state** is held in memory: `runs` in `lib/runs.mjs` and `live` in `lib/workflow.mjs`. It is written to the data dir as it changes. Writes are debounced (sessions 250 ms, runs 1 s) and atomic (`.tmp` then rename), and a final write happens at exit or completion. After a restart the files are all that is left. The list endpoints report a file still marked running as `interrupted`; `GET /api/runs/<id>` and `GET /api/sessions/<id>` return it as stored.
- Session fields that start with `_` (`_snapshot`, the baseline; `_testCmd`; `_project`) are working state. `publicSession()` strips them from API responses, debounced saves and in-progress `session.update` events. The final save and event when `runFrom` ends use the whole object, so a finished, failed or cancelled session file does contain them. Retry depends on this ([docs/workflows.md](docs/workflows.md#collaboration-session)).
- The UI holds no state of its own beyond view filters and the controller's `sessionStorage` history. It rebuilds from `/api/*` on load and after an SSE reconnect.

## Configuration

Configuration is by environment variable only. There is no config file.

| Variable | Read in | Effect |
|---|---|---|
| `COCKPIT_PORT` | `server.mjs` | Port (default `4848`). `npm run open` always opens 4848 |
| `COCKPIT_PROJECT_ROOTS` | `lib/scan.mjs` | Extra directories searched for projects, split on `path.delimiter`. Relative entries are ignored |
| `COCKPIT_DATA_DIR` | `lib/store.mjs` | Data dir (default `data/` in the checkout) |
| `CLAUDE_CONFIG_DIR` | `lib/homes.mjs` | Replaces `~/.claude`. `.claude.json` is then read from inside it |
| `CODEX_HOME` | `lib/homes.mjs` | Replaces `~/.codex` |
| `COCKPIT_MACHINE_TESTS=1` | `test/machine.test.mjs` | Enables the real-machine test |

## Server

Every request passes through the same checks in order:

1. **Host check.** The `Host` header must be `127.0.0.1`, `localhost` or `[::1]`, otherwise the response is 403.
2. **Admission** (`admissionRefusal`). Anything other than GET or HEAD needs an `Origin` equal to `http://127.0.0.1:<port>` or `http://localhost:<port>` and `Content-Type: application/json`.
3. `x-content-type-options: nosniff` is set. No CORS headers are ever sent.
4. The request goes to `/api/*` or to a static file under `public/`.

| Endpoint | Does |
|---|---|
| `GET /api/env[?refresh]` | The cached scan, or a fresh one with `refresh` |
| `GET /api/changes` | Recent configuration changes, newest first |
| `GET /api/events` | SSE stream (`hello`, then bus events, pings every 15 s) |
| `GET /api/file?path=` | File viewer: directory listing or redacted text, if `fileAllowed` |
| `GET /api/claude-sessions?project=` | Claude session files for one project dir under the Claude home, with redacted first prompts |
| `GET /api/transcripts` | Lists Claude and Codex transcript files |
| `GET /api/transcript?path=` | One parsed transcript, if `transcriptAllowed` |
| `GET /api/git?path=` / `GET /api/git/diff?path=` | `gitSummary` / raw `gitDiff` for a discovered project |
| `GET /api/runs`, `GET /api/runs/<id>` | Runs (list without output; one with output). A run from disk is loaded only if its id matches `run_[A-Za-z0-9_]+` |
| `POST /api/runs/<id>/stop` | `stopRun` |
| `POST /api/actions` | The fixed action set; see [docs/workflows.md](docs/workflows.md#project-actions) |
| `GET /api/sessions`, `GET /api/sessions/<id>`, `GET /api/sessions/<id>/report` | Sessions, one session, Markdown report |
| `POST /api/sessions`, `POST /api/sessions/<id>/cancel`, `POST /api/sessions/<id>/retry` | Create, cancel or retry a collaboration session |
| `GET /api/meta` | Port, root, version, `CLAUDE_MODELS`, pid, start time |

### SSE events

| Type | Emitted by | Carries |
|---|---|---|
| `hello` | `server.mjs` on connect | Active run ids. On a reconnect the UI reloads everything |
| `run.start`, `run.exit` | `lib/runs.mjs` | The run without output chunks |
| `run.output` | `lib/runs.mjs` | One stdout or stderr chunk, unredacted |
| `session.update` | `lib/workflow.mjs` | The whole session |
| `env.changed` | watcher callback in `server.mjs` | Changed paths, before the rescan |
| `env.scanned` | `getEnv` in `server.mjs` | Scan time and the changes found |
| `transcript.changed` | transcript watcher in `server.mjs` | Path, size, mtime, provider |

## Scan

`scanEnvironment()` (`lib/scan.mjs`) builds one object: `machine`, `tools`, `claude`, `codex`, `skills`, `hooks`, `mcp`, `agents`, `instructions`, `commands`, `projects`, `footprint`, `env`, `scannedAt` and `scanMs`. It reads files, runs `--version`, `which`, `du -sk` and `git` subprocesses, and never writes. What it reads is listed in [docs/access-given.md](docs/access-given.md#reads), and what is and is not redacted in [docs/access-given.md](docs/access-given.md#redaction).

A scan runs:

- when the server starts;
- when a watched file changes (debounced 1.5 s);
- when the UI asks for `?refresh` (the **rescan** link).

Each finished scan is diffed against the previous one by `diffEnv` (`lib/envdiff.mjs`). The resulting changes are appended to `changes.jsonl`, logged to stdout and emitted as `env.scanned`.

### Project discovery

`discoverProjectPaths()` collects projects from four sources:

1. **cockpit's own checkout** (`COCKPIT_ROOT`, derived from the module's location, not the cwd). It is always included.
2. **Each `COCKPIT_PROJECT_ROOTS` directory.** A non-hidden child counts as a project if it contains `.git`, `package.json`, `CLAUDE.md`, `AGENTS.md`, `pyproject.toml`, `README.md` or `.claude`. If a child has none of those, its non-hidden children are checked the same way, without `.claude`. Discovery goes no deeper than two levels. There is no default root.
3. **Paths under `projects` in `.claude.json`.**
4. **`[projects."…"]` entries in the Codex `config.toml`.**

A candidate is dropped if its real path does not exist, or is `/`, `HOME` or an ancestor of `HOME` (`tooBroadForProject`).

Inside a project, every file the scanner reads goes through `within()`. It is used only if its real path stays inside the project's real root, so a symlink that escapes the project reads as missing. The Claude and Codex homes are read without that check.

## Processes

`startRun()` in `lib/runs.mjs` is the only way cockpit starts a long-lived child. The scanner's short `execFile` calls and `lib/git.mjs` are the exception.

- It uses `spawn(cmd, args)` with argv and no shell, and `detached: true` so the child gets its own process group.
- The child's environment is `process.env` minus `CLAUDECODE`, `CLAUDE_CODE_ENTRYPOINT` and `CLAUDE_CODE_SSE_PORT` (`childEnv`), so a nested `claude -p` starts even when cockpit was launched from inside Claude Code.
- stdout and stderr become `chunks` (`{t, s, d}`), capped at 4000 per run (`truncated`). Runs of kind `claude` and `codex` are line-buffered so every chunk holds whole JSONL lines.
- `stopRun` sends SIGTERM to the process group, then SIGKILL after 3 s. On SIGINT or SIGTERM, `shutdown()` in `server.mjs` calls `markInterruptedOnShutdown()` (`lib/workflow.mjs`), then `stopAll()` and `killAllHard()`. The sequence and its current limitation are in [docs/workflows.md](docs/workflows.md#shutdown).

A run records `kind`, `participant` (`cockpit`, `claude` or `codex`), and `sessionId`/`stageId` when a workflow stage started it.

## Agent adapters

Provider-specific command lines live in `lib/adapters/`:

- **`claude.mjs`.** `buildClaudeArgs` produces `claude -p <prompt> --output-format stream-json --verbose --permission-mode <mode>`, plus `--model`, `--resume`, `--max-budget-usd`, `--allowedTools` (comma-joined, after the prompt), `--json-schema` and `--append-system-prompt` when given. `parseClaudeOutput` reads the init event, text, tool calls, Edit/Write targets (`filesTouched`), result, structured output and cost.
- **`codex.mjs`.** `buildCodexArgs` always produces `codex exec --sandbox read-only --skip-git-repo-check --json --ephemeral --color never -C <cwd>`, plus `-m`, `--output-schema` and `-o`, with the prompt on stdin (`-`). `startCodexReview` writes `REVIEW_SCHEMA` into a fresh `cockpit-codex-*` directory under the OS temp dir. `parseCodexOutput` reads commands run, messages, usage and sandbox-denial counts, and parses the review JSON from the `-o` file or the last message.

The prompts themselves are built by the callers: `lib/workflow.mjs` for sessions, and `server.mjs` for the ad-hoc `claude.task` and `codex.review` actions.

## Collaboration workflow

`lib/workflow.mjs` holds sessions in `live` and persists each one through `emit()`, which saves the session and broadcasts `session.update`.

- `createSession` validates the task and project, then starts `runFrom(s, 0)` without awaiting it.
- `runFrom` walks `s.stages` in order and calls `STAGES[<id without -N>]`. It skips stages already `complete` or `skipped`.
- A `StageError` fails the session at that stage, unless the status is already `cancelled`. `checkCancel` throws once the status is `cancelled`. An `interrupted` status is not checked, which causes the shutdown limitation in [docs/workflows.md](docs/workflows.md#collaboration-session).
- Limits live in the constants at the top: `MAX_REVIEW_ROUNDS = 2`, `MAX_RETRIES = 1`, `IMPLEMENT_TOOLS` and `DISPOSITION_SCHEMA`.

Stage behaviour, limits and outcomes are described in [docs/workflows.md](docs/workflows.md#collaboration-session).

`captureDiff` is the one place session diffs are made. It runs `diffSince(snapshot)`, then `redactDiff`, then truncates to 400,000 characters. The stored diff, the session file, the API, the UI, the report and the Codex prompt therefore all carry the same redacted text.

## Watchers

Both watchers use `fs.watch` and never write. What they watch is listed in [docs/access-given.md](docs/access-given.md#watches).

- **`startWatching`** filters paths inside each config root by `RELEVANT` and `IGNORE` (applied to the path inside the root, never to the root's own location). A project's `.git/` is watched separately, for `index`, `HEAD`, `ORIG_HEAD` and `FETCH_HEAD` only. A match triggers a debounced rescan (1.5 s). When a rescan finds a different set of project paths, the `listen` callback in `server.mjs` closes the watcher and builds a new one.
- **`watchTranscripts`** emits `transcript.changed` per `.jsonl` file (debounced 800 ms), so the UI can follow sessions cockpit did not start.

## Frontend

There is no framework and no bundler. `public/app.js` is one classic script:

- **State** lives in one object, `S` (`env`, `meta`, `sessions`, `runs`, `transcripts`, `changes`, `route`, `filters`, caches).
- **Routing** uses the hash: `#<view>/<id>/<tab>`, parsed at boot and on `hashchange`. `go()` sets it.
- **Rendering.** `render()` rebuilds the rail and the current view on every change, with `h()`. Views are named `viewOverview`, `viewProjects`, `viewSessions` and so on. View keys differ from rail labels ([docs/definitions.md](docs/definitions.md#ui-names-and-code-names)).
- **Data** comes from `loadAll()` (six GETs) and `connectSSE()`, which reconnects after 3 s.
- **Behaviour.** `window.Cockpit.actions` is the registry of navigation actions. The controller calls only these. Rows that take part in keyboard and controller focus carry `data-key` and `tabindex="0"` via `rowAttrs()`.

The controller pipeline is: `navigator.getGamepads()` → `snapshot` → `normalize` → `step` (named events) → `resolve` (`MAPPINGS`) → `window.Cockpit.actions[name]`. `controller-core.js` is pure, and `controller.js` owns polling and the Controller view.

## Caps

| What | Cap | Where |
|---|---|---|
| Request body | 2 MB | `readBody` in `server.mjs` |
| File viewer | 1.5 MB (larger files: size only) | `server.mjs` |
| Text read by the scanner | First 200 KB per file (see Known limits) | `readText` in `lib/scan.mjs` |
| Transcript parse | 400 MB file; 3000 events returned | `lib/transcripts.mjs` |
| Run output | 4000 chunks | `lib/runs.mjs` |
| Session diff stored | 400,000 chars | `captureDiff` |
| Diff in a session review prompt | 120,000 chars | `reviewDiffText` |
| Diff in an ad-hoc review prompt | 100,000 chars | `server.mjs` |
| Changes kept in memory | 500 | `server.mjs` |

## Tests

`npm test` runs `node --test test/`. The default suite never touches the real homes and needs neither CLI installed:

- **`test/fixtures/homes.mjs`** builds a temp `HOME`, `CLAUDE_CONFIG_DIR` and `CODEX_HOME` with planted fake secrets. It puts stub `claude`, `codex` and `osascript` executables first on `PATH`. The `osascript` stub records its argv and never drives Terminal.
- **`test/fixtures/server.mjs`** boots the real `server.mjs` on a random port with a temp `COCKPIT_DATA_DIR`.
- **`test/machine.test.mjs`** scans the real machine. It is skipped unless `COCKPIT_MACHINE_TESTS=1` (`npm run test:machine`).

Unit tests that import `lib/workflow.mjs` also import `lib/store.mjs`, which creates `data/sessions/` and `data/runs/` in the checkout unless `COCKPIT_DATA_DIR` is set. `test/report.test.mjs` renders whatever sessions are in `data/sessions/`.

Which test covers which subsystem: [harness.md](harness.md#where-to-look).

## Known limits

- **Skill relationships** cover `[[name]]` links and `/name` mentions in `SKILL.md` only.
- **`@include` resolution** (Instructions view, Attention panel) matches only files the scanner already collected. An import of any other file, such as this repo's own `CLAUDE.md` → `harness.md`, is reported as "could not find among scanned instruction files".
- **Plugins.** Marketplace directories and `installed_plugins.json` are listed. Plugin-provided commands and MCP servers are not resolved.
- **Transcripts** show what the CLIs stored. Claude thinking blocks are usually empty, and Codex's base instructions are counted, not shown. The "what shaped this session" panel is built from the current disk state, not a snapshot from the time of the session.
- **The Attention panel** uses simple heuristics (presence checks and prefix matches on exec-policy rules).
- **Models.** Codex models are not enumerated. The Claude model picker is the fixed `CLAUDE_MODELS` list plus the settings default.
- **Discovery** covers only the four sources above.
- **Large state files.** The scanner keeps only the first 200 KB of a file. A larger `.claude.json` fails to parse, so its projects, trust flags and MCP servers silently disappear. A larger `history.jsonl` shows older prompts instead of the latest, and a larger Codex `session_index.jsonl` stops updating the thread list.
