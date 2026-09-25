# Definitions

This page covers only terms that have a specific meaning in cockpit, or that mean more than one thing here.

## Words that collide

**Session.** On its own, in cockpit's code, API and data, "session" means a **collaboration session**: one run of the Claude → Codex → Claude workflow. Its id looks like `ses_…`, it is stored at `data/sessions/<id>.json`, and it is listed in the **Workflows** view. It is not:
- a **Claude Code session**: one conversation in Claude Code's own log, `<Claude home>/projects/<dir>/<uuid>.jsonl`. A collaboration session records the one it used as `claudeSessionId`;
- a **Codex thread**: one Codex conversation, logged as a rollout under `<Codex home>/sessions/`.

**Action.** Two unrelated things share the word:
- A **project action** is one of the fixed server-side operations posted to `/api/actions` (`npm.run`, `git.status`, `claude.task`, …). It runs a process.
- A **UI action** is an entry in `window.Cockpit.actions` (`cockpit.selectNext`, `cockpit.prevView`, …). It is navigation only, and it is what the controller calls.

**Agent.** Three unrelated things share the word:
- A **launched agent** is a `claude` or `codex` process that cockpit starts. Its prompts, permissions and limits are part of cockpit's behaviour ([workflows.md](workflows.md)).
- A **repository agent** is any coding agent working *on* this repository. It follows [harness.md](../harness.md). It is unrelated to what cockpit does at runtime.
- An **agent definition** is a Claude Code subagent file (`agents/*.md`) that cockpit displays in the Agents view.

**Workflow.** In the UI, **Workflows** is the view for collaboration sessions. In these docs, [workflows.md](workflows.md) covers every runtime flow, not only sessions.

## UI names and code names

| Rail label | Route / code name |
|---|---|
| Environment | `overview` |
| Workflows | `sessions` (`/api/sessions`, `lib/workflow.mjs`) |
| Processes | `runs` (`/api/runs`, `lib/runs.mjs`) |
| Hooks & Policy | `hooks` |
| MCP & Plugins | `mcp` |
| Activity, Projects, Transcripts, Skills, Instructions, Agents, Controller | same name, lowercase |

## cockpit's concepts

**Scan.** The in-memory inventory of the machine built by `scanEnvironment()` (`/api/env`). It is rebuilt on change and never persisted.

**Claude home / Codex home.** Where each CLI keeps its state: `~/.claude` or `CLAUDE_CONFIG_DIR`, and `~/.codex` or `CODEX_HOME`. Resolved only in `lib/homes.mjs`.

**Project** (discovered project). A directory cockpit found through one of its four discovery sources ([plumbing.md](../plumbing.md#project-discovery)). Only a project can be an action target or a session target, and each project is a file-viewer root. Being a git repo is not enough to count.

**Run.** Any process cockpit started through `startRun()` and therefore owns. Its id looks like `run_…`, it is shown in **Processes**, and it is stored at `data/runs/<id>.json` with its output. A run has:
- a `kind`: `command`, `claude`, `codex` or `tests`;
- a `participant`: who it acted for.

**Owned vs observed.** cockpit *owns* its runs: it started them, streams their output, and can stop them. It only *observes* everything else, such as your own `claude`/`codex` sessions (through their transcripts) and your configuration (through scans).

**Transcript.** An agent's own JSONL log file, parsed read-only into a timeline. It is live when the transcript watcher has seen its file change within the last 60 s.

**Participant.** Who acted: `cockpit`, `claude` or `codex`. Shown in amber, cyan and violet respectively.

**Stage.** One step of a collaboration session: `context`, `investigate`, `implement`, `diff`, `review-N`, `disposition-N`, `tests` and `complete`. Stage statuses are `queued`, `running`, `complete`, `failed`, `skipped`, `cancelled` and `interrupted`.

**Round.** One Codex review and the Claude disposition that follows it. There are at most two rounds.

**Finding.** One issue Codex reports in a review, with an id (`F1`, `F2`, …), severity, category, file, line, evidence and suggestion.

**Material finding / `noMaterialFindings`.** Codex is asked to report only findings with concrete evidence. It may answer that there are none, and cockpit never manufactures any.

**Disposition.** The decision on one finding: `ACCEPTED`, `PARTIALLY ACCEPTED`, `REJECTED` or `DEFERRED`. It is recorded with who made it (`claude`, or `cockpit` when Claude gave none), the reason, and the files changed.

**Baseline.** The pre-task state a session diffs against. That is a `git stash create` snapshot of the working tree, or HEAD if the tree was clean.

**Context** (session context). The record of what surrounded a session: working directory, git state, instruction files, memory, skills, hooks, MCP servers, test command, stack and the exact CLI lines. Each item carries an evidence label.

**Evidence labels.** How sure cockpit is of what it shows:
- `OBSERVED`: read from disk, from a CLI, or from a process's output;
- `INFERRED`: derived by cockpit, such as a project's stack from its files, or an Attention item;
- `UNAVAILABLE`: cannot be observed, such as hidden model reasoning or a missing test command.

**Scope labels.** Where an instruction, setting, skill or MCP entry applies:
- `GLOBAL` / `GLOBAL-LOCAL`: the home's own files / its `*.local` variants;
- `PROJECT` / `PROJECT-LOCAL`: a project's files / its `*.local` variants;
- `PROJECT-USER`: MCP servers stored per project inside `.claude.json`;
- `MEMORY`: Claude's per-project memory files under the Claude home.

**Instruction file.** Any file that can steer an agent, of kind `instructions` (`CLAUDE.md`, `AGENTS.md`), `settings`, `rule`, `memory` or `memory-index`.

**Import** and **link.** Two ways a project entry point (`CLAUDE.md`, `CLAUDE.local.md`, `AGENTS.md`) can point at another file, kept apart in the scan:
- an **import** is a line-start `@path` in `CLAUDE.md`, which Claude Code expands when it loads the file (`includes`, resolved in `includesResolved`);
- a **link** is a relative Markdown link such as `[harness.md](harness.md)`. It is only text: no tool loads the target because of it (`linksResolved`).

**Change.** One difference between two consecutive scans, such as "skill added" or "branch a → b". Stored in `data/changes.jsonl`.

**Attention item.** A possible problem derived from the scan by a heuristic. It is a prompt to look, not a verdict.

**Spine.** The vertical node-and-line component used for configuration precedence, "how configuration reaches a task", and session stages.

**Footprint.** The size of each top-level entry in the Claude and Codex homes (`du -sk`). Shown as "where hidden state lives".

**`.claude/swag.md`.** A project file cockpit detects and shows as "design system present (used by the swag skill)". Neither the file nor the skill is part of this repository.

**Interrupted.** A run or session that was running when the server stopped. It is final: an interrupted session cannot be retried. A session running during a graceful shutdown is currently often recorded as `failed` instead ([workflows.md](workflows.md#collaboration-session)).
