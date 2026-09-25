# Workflows

This page covers what cockpit does at runtime: what happens when it starts, when something changes, and when you press each control. It describes cockpit's behaviour, including the Claude and Codex processes it launches. Rules for an agent working on this repository are in [harness.md](../harness.md).

Terms are defined in [definitions.md](definitions.md). What each flow is allowed to touch is covered in [access-given.md](access-given.md).

## Startup and change detection

1. `npm start` binds `127.0.0.1:4848` and runs the first scan.
2. It starts the config watcher and the transcript watcher, then prints the counts.
3. When a watched file changes, the server emits `env.changed` and the rail shows "change detected · rescanning".
4. 1.5 s after the last change, it rescans.
5. The new scan is diffed against the previous one. Each difference becomes a **change**: it is appended to `data/changes.jsonl`, shown under **Recent configuration changes** on Environment, and shown as a `change` row in Activity.
6. If the set of project paths changed, the watcher is rebuilt for the new set.

Changes that are detected:

- skills added, edited or removed;
- instruction and settings files appearing, changing or disappearing;
- hook, MCP-server and agent-definition counts;
- CLI version changes;
- Codex exec-policy rule counts;
- projects discovered or gone;
- per-project branch, new commit, and clean/dirty transitions;
- `CLAUDE.md` or `AGENTS.md` added or removed;
- Claude and Codex trust changes;
- transcript and plan-file counts.

The **rescan** link in the rail forces a scan.

## Looking around

- **File viewer.** Amber paths open in the file viewer (the `← back` bar replaces the detail pane). Directories list their entries. Content is redacted, and blocked files are refused ([access-given.md](access-given.md#refuses)).
- **Search.** ⌘K or `/` focuses the search box. It matches, in the browser, against already-loaded skills, instruction files (including their text), projects, sessions, transcripts, MCP servers, hooks and Codex exec-policy rules.
- **Attention.** The Attention panel on Environment is recomputed in the browser on every render, from the scan and the session list. It flags:
  - broken `[[skill]]` links and unresolved `@include`s;
  - Codex trust on `~`, and Codex trust on paths that are not projects;
  - exec-policy rules that allow `curl`, `pip install`, `npm install`, `sudo` or `rm`;
  - code without git, and dirty repos;
  - a missing global `CLAUDE.md` and a Codex version behind the latest known;
  - failed or interrupted sessions.
- **Transcripts.** Opening one parses the log file into a redacted timeline. When the transcript watcher reports that a log grew, the entry is marked live for 60 s, and an open timeline reloads. This works for sessions cockpit did not start, including interactive ones in a terminal.

## Project actions

These live on a project's **act** tab (and the git ones also on the **git** tab). Each posts to `/api/actions` and becomes a run shown in **Processes**, with live output.

| Button | Action | Runs |
|---|---|---|
| `npm test`, `npm run <script>` | `npm.run` | That script, only if it is in the project's `package.json` |
| `git status`, `git diff --stat`, `git log` | `git.status`, `git.diff`, `git.log` | The git command in the project |
| open in Finder / VS Code | `open.finder`, `open.editor` | `open <path>` / `code <path>` |
| claude / codex · interactive in Terminal | `launch.terminal` | `osascript` → Terminal.app: `cd <path> && claude` (or `codex`) |
| run Claude here | `claude.task` | Ad-hoc Claude task, below |
| Codex read-only review of working tree | `codex.review` | Ad-hoc Codex review, below |
| start collaboration session → | none | Opens Workflows → new task, prefilled. Starts nothing |

The **git** tab also shows the full `git diff` inline, fetched from `/api/git/diff` and unredacted.

**Terminal launch.** The recorded run is the `osascript` call, which exits at once. The interactive session belongs to Terminal: cockpit cannot stop it and sees it only through its transcript. The first use may trigger a macOS automation permission prompt.

**Stopping.** Any running process can be stopped from Processes. cockpit sends SIGTERM to its process group, then SIGKILL after 3 s.

## Ad-hoc Claude task

The act tab takes a prompt, a permission mode (`plan` or `acceptEdits`) and a model (the settings default or a `CLAUDE_MODELS` entry). cockpit runs `claude -p` once in the project with a $2 budget. `acceptEdits` gets a small tool allow-list ([access-given.md](access-given.md#launches-agents)).

The run's stream-json output is summarised line by line in Processes, and its result panel shows the final text and cost. The task is not saved as a session.

## Ad-hoc Codex review

cockpit builds a read-only reviewer prompt. It contains:

- the optional focus text from the prompt box;
- the list of untracked files;
- the project's `git diff`: unstaged changes against the index, redacted, capped at 100,000 characters.

It runs `codex exec --sandbox read-only` with the review schema. Processes shows the parsed findings. Staged changes are not in the quoted diff, though Codex can inspect the tree itself.

## Collaboration session

This is the one multi-step flow. It is started from **Workflows → new task** with:

- a writable project;
- a task;
- a Claude model (the default is `claude-sonnet-5`) and an optional Codex model;
- a Claude budget per stage (default $3).

Claude is the lead engineer and the **only writer**. Codex is an **independent read-only reviewer**. cockpit assembles context, snapshots the tree, captures diffs, runs tests and records everything.

| Stage | Who | What happens | Fails the session when |
|---|---|---|---|
| `context` | cockpit | Reads git state and snapshots the tree (`git stash create`; HEAD if the tree is clean; nothing for non-git projects). Picks `npm test` if the project has a `test` script. Records every input as evidence-labelled context | — |
| `investigate` | Claude, `plan` | Reads the task and the project's instruction-file paths. Returns up to 350 words on relevant files, the planned change, risks and how to verify | `claude` exits non-zero or reports an error |
| `implement` | Claude, `acceptEdits`, same Claude session (`--resume`) | Implements within scope, does not commit, runs the test command | as above |
| `diff` | cockpit | Captures the redacted diff against the baseline ("not a git repo" otherwise) | — |
| `review-1` | Codex, `--sandbox read-only` | Gets the task, Claude's plan and summary, the project instruction files (re-read from inside the project, settings redacted), the changed-file list and the diff. Returns schema JSON: findings with severity, category, file, line, evidence and suggestion, or `noMaterialFindings` | `codex` exits non-zero or returns no parseable review |
| `disposition-1` | Claude, `acceptEdits`, `--json-schema` | Skipped if there are no findings. Otherwise Claude gives each finding ACCEPTED, PARTIALLY ACCEPTED, REJECTED or DEFERRED with a reason, applies the accepted ones, and lists the files changed. Findings Claude leaves out are recorded as DEFERRED by cockpit | Claude errors or returns no structured dispositions |
| `review-2`, `disposition-2` | as above | Run only if a round-1 ACCEPTED or PARTIALLY ACCEPTED disposition lists changed files (Claude's own report). The diff is recaptured first, and Codex also sees the round-1 dispositions. Otherwise both are skipped | as above |
| `tests` | cockpit | Captures the final diff and runs `npm test` in the project. Skipped (UNAVAILABLE) if there is no test script | the tests fail |
| `complete` | cockpit | Records the result: paths changed, findings, dispositions, test status, Claude cost, review rounds | — |

The prompts are in `lib/workflow.mjs`. Each stage's detail view shows the exact prompt, command line, timings, retries, errors and process output.

**Hard limits in code.** At most 2 review rounds. At most 1 retry per stage. No stage starts another session. Codex never writes. Nothing is committed or pushed by cockpit.

**Read-only check.** For every review, cockpit shows the commands Codex ran, the sandbox denials seen in its output, and how many of its commands look like writes.

**Cancel.** Cancel works on a running or queued session. It stops that session's processes, and the current stage is recorded as `cancelled`.

**Retry.** A `failed` session shows **retry \<stage\>**, which re-runs from the failed stage. Each stage allows one retry. `interrupted` and `cancelled` sessions cannot be retried. A retry reuses the session's own baseline snapshot, test command and project record. After a server restart these come from the session file ([plumbing.md](../plumbing.md#sources-of-truth)). The context stage is not re-run, and the project is not re-checked against the current discovered list.

**Interrupted.** On shutdown, cockpit marks a running session and its running stage `interrupted`. **Current limitation:** stopping the stage's process then makes the stage fail, and that failure overwrites the status. So a session running at Ctrl-C is usually recorded as `failed`, and can be retried, rather than `interrupted`. A session file still marked running, for example after a crash, is listed as `interrupted`.

**Afterwards.** Every session is replayable from Workflows, because it is one file, `data/sessions/<id>.json`. **markdown report ↗** (`/api/sessions/<id>/report`) renders the same record as one Markdown document. The Claude transcript of the session opens as a timeline from the session overview.

**Things to know.**
- One session per project at a time is the intended use. Nothing prevents two, but they would share one working tree.
- Edits made by anything other than Claude during a session appear in its diff.
- Non-git projects get no diff. Codex is told to inspect the tree directly.
- The tests stage only knows `npm test`. A Python project, or any project without a `test` script, shows tests as UNAVAILABLE.
- "Files touched" comes from Claude's Edit/Write tool calls. The diff is the ground truth.

## Shutdown

On Ctrl-C or SIGTERM the server:

1. marks running sessions `interrupted`;
2. sends SIGTERM to every process group it owns;
3. sends SIGKILL to what is left after 1.5 s;
4. exits.

A session whose stage process exits during steps 2–3 is usually re-recorded as `failed` (see **Interrupted** under [Collaboration session](#collaboration-session)). Interactive Terminal sessions are not affected.

## Controller navigation

An Xbox Wireless Controller can drive cockpit's navigation through the browser Gamepad API (Chrome, `standard` mapping). There is no driver and no server component. The **Controller** view shows every step, from physical input to raw value, named event, mapping, action and result.

| Input | Action |
|---|---|
| D-pad or left stick ↑ ↓ | Focus the previous or next row of the current list (repeats while held) |
| D-pad or left stick ← → | Previous or next tab in the detail pane |
| A | Open the focused row, or focus the selected row if none is focused |
| B | Close the file viewer, else browser back |
| LB / RB | Previous or next view in the rail |
| LT / RT | Scroll the detail pane, at a speed set by the trigger value |
| View | Open the Controller view |
| Menu | Open Workflows → new task form. Starts nothing |

The source of truth is `MAPPINGS` in `public/controller-core.js`.

**Safety boundary:**

- The controller only navigates. Its focus set is the list rows (`data-key`), whose clicks only change the route. Buttons, links and inputs are never in it, and no mapping sends a request that changes anything.
- X, Y, L3, R3, the Xbox button and the right stick are shown but unmapped.
- Actions are suspended while the window is unfocused or a text field has focus.
- A pad without the `standard` mapping is displayed raw and drives nothing.

Tuning constants (`DEAD_ZONE`, `STICK_NAV_*`, `TRIGGER_ON`, `REPEAT_*`) are at the top of `controller-core.js`. The tests use synthetic snapshots. Safari and Firefox are untested.
