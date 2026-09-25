# harness

Shared operating context for any coding agent working on this repository. `AGENTS.md` and `CLAUDE.md` point here.

## What this is

cockpit is a small personal tool: a local web app that inspects and operates one machine's Claude Code and Codex environment. It is one Node server with no dependencies and a vanilla-JS page. One person uses it, on macOS. Scope and non-goals: [docs/about.md](docs/about.md).

## Two kinds of agents

You are a **repository agent**: you work *on* this code.

cockpit also **launches its own agents**: `claude -p` and `codex exec` processes with specific prompts, permission modes, tool allow-lists, budgets and limits. Those are product behaviour. They live in `lib/workflow.mjs`, `lib/adapters/` and the `claude.task` and `codex.review` actions in `server.mjs`, and they are documented in [docs/workflows.md](docs/workflows.md) and [docs/access-given.md](docs/access-given.md).

This harness does not define their behaviour. Changing them is a product change, not a tooling change.

There is one overlap. cockpit always discovers its own checkout. If a session or ad-hoc Claude task targets cockpit itself, the launched `claude -p` loads this repo's `CLAUDE.md`, and with it this file, the same way it would load any project's instructions.

## Read first

1. [docs/about.md](docs/about.md): what is in and out of scope.
2. [plumbing.md](plumbing.md): how the pieces connect.
3. The row for your task in [Where to look](#where-to-look), and the docs it names.

## Stack

- Node ≥20 (tested only on Node 26), ES modules (`.mjs`), `node:http`.
- **No npm dependencies. No build step.**
- Frontend: vanilla JS in `public/`.
- Tests: `node --test`.
- macOS commands for Finder, Terminal and `npm run open`.

## Commands

- Run: `npm start` (→ http://127.0.0.1:4848/).
- Run without touching the real `data/`: `COCKPIT_DATA_DIR=$(mktemp -d) COCKPIT_PORT=4851 npm start`.
- Test: `npm test`. It needs no Claude Code or Codex, uses fixture homes, and skips one test.
- Real-machine scan test: `npm run test:machine`. It reads the real Claude and Codex homes, and needs both CLIs.
- Env vars: [plumbing.md](plumbing.md#configuration).
- There is no linter, formatter or CI.

## Where to look

| Changing… | Code | Tests (`test/…test.mjs`) | Keep true |
|---|---|---|---|
| API, request admission, file viewer | `server.mjs` | `server`, `request-admission`, `file-safety`, `file-roots` | plumbing (Server), access-given |
| Scanner, project discovery, homes | `lib/scan.mjs`, `lib/homes.mjs`, `lib/frontmatter.mjs` | `scan`, `scan-redaction`, `project-containment`, `file-safety`, `frontmatter`, `machine` | plumbing (Scan), access-given (Reads) |
| Redaction | `lib/redact.mjs`, `redactDiff` in `lib/workflow.mjs` | `redact`, `scan-redaction`, `review-redaction`, `adhoc-review-redaction`, `file-safety`, `transcripts` | access-given (Redaction) |
| Collaboration session | `lib/workflow.mjs`, `lib/git.mjs`, `lib/report.mjs` | `review-redaction`, `report`, `server` (input validation only) | workflows, access-given (Launches agents) |
| Agent command lines | `lib/adapters/claude.mjs`, `lib/adapters/codex.mjs` | `adapters` | access-given, workflows |
| Project actions, Terminal launch | `server.mjs` (`/api/actions`), `lib/terminal.mjs` | `server`, `request-admission`, `terminal`, `adhoc-review-redaction` | workflows (Project actions), access-given (Runs) |
| Processes | `lib/runs.mjs` | `server` | plumbing (Processes) |
| Watchers, change log | `lib/watch.mjs`, `lib/envdiff.mjs`, the `listen` callback in `server.mjs` | `watch`, `server-watch`, `envdiff` | plumbing (Watchers), workflows |
| Transcripts | `lib/transcripts.mjs` | `transcripts`, `server` | plumbing |
| UI views | `public/app.js`, `public/style.css` | `controller` (focus contract only) | docs/design.md |
| Controller | `public/controller-core.js`, `public/controller.js`, `window.Cockpit` in `app.js` | `controller` | workflows (Controller navigation) |

## Invariants

Preserve these. Where a test enforces one, it is named.

- **Local only.**
  - Listen on `127.0.0.1` only.
  - Refuse any `Host` that is not local.
  - Every request other than GET or HEAD needs cockpit's own `Origin` and `Content-Type: application/json`.
  - Never send CORS headers.
  - Enforced by `request-admission` and `server`.
- **No free-form execution.**
  - The action set is fixed.
  - Every target must be a discovered project, and `npm.run` accepts only scripts in that project's `package.json`.
  - Processes are spawned with argv, never through a shell. Paths are passed as data (see `lib/terminal.mjs`).
  - Enforced by `server` and `terminal`.
- **cockpit's own code writes only the data dir and the Codex temp dir.** The scanner, watchers and transcript parser never write. The only exceptions are the git side effects listed in [docs/access-given.md](docs/access-given.md#writes).
- **Codex is always `--sandbox read-only`** (enforced by `adapters`). In a session, Claude is the only writer. The limits are 2 review rounds, 1 retry per stage, and no recursion.
- **Redaction.**
  - What cockpit shows, or sends to a model, goes through `lib/redact.mjs`, except the exceptions listed in [docs/access-given.md](docs/access-given.md#redaction).
  - Session diffs are redacted in exactly one place, `captureDiff`.
- **Containment.**
  - The file viewer checks real paths against its roots and `BLOCKED_FILE`. A home at or above `HOME` is not a root.
  - Project files are read only if they resolve inside the project (`within`/`realPathWithin`).
  - `/`, `HOME` and ancestors of `HOME` are never projects.
  - Enforced by `file-safety`, `file-roots`, `project-containment` and `scan`.
- **Claude and Codex locations come only from `lib/homes.mjs`**, so `CLAUDE_CONFIG_DIR` and `CODEX_HOME` are honoured everywhere.
- **cockpit's own process environment values never reach the UI.** Only names, whether each is set, and lengths do. Values written in config files, such as a `settings.json` `env` block, are shown like other config, through redaction.
- **Honest labels.** Never present something inferred or unavailable as `OBSERVED`. Empty states say what was checked. Known exceptions in the current UI copy are listed in [docs/design.md](docs/design.md#worth-considering-later).
- **The controller only navigates.** `MAPPINGS` resolve to `window.Cockpit.actions` and never to a POST. The focus set is the `data-key` rows. Enforced by `controller`.
- **The default tests never touch the real homes, need no CLIs, and never drive Terminal.** Use `test/fixtures/homes.mjs` and `test/fixtures/server.mjs`. Two caveats:
  - They may create an empty `data/` in the checkout.
  - `report.test` renders any sessions already in `data/sessions/`.
- **No npm dependencies and no build step.**

## Don't change casually

Stop and ask before any of these:

- Anything about launched agents: prompts, permission modes, `--allowedTools` lists, budgets, sandbox flags, stage order, limits.
- Anything that widens access: new actions, new file-viewer roots, a looser `BLOCKED_FILE`, discovery sources or depth, new things the scanner reads or runs, or new data sent to the UI or to models.
- Persisted formats: `data/sessions/*.json`, `data/runs/*.json`, `data/changes.jsonl`. Old files are replayed by the UI, the report and `test/report.test.mjs`.
- Adding a dependency, a build step or a framework.
- The visual language: the tokens and the colour meanings in [docs/design.md](docs/design.md).
- Scope: anything listed as a non-goal in [docs/about.md](docs/about.md).

## Validation

- **Run `npm test`.** Everything must pass, with only the machine test skipped. Add or adjust tests next to the subsystem you changed, using the fixtures.
- **Session stage logic has no automated tests.** That covers sequencing, skip, retry, cancel, shutdown and the round-2 rule in `lib/workflow.mjs`. Reason through the code carefully.
  - Running a real session launches Claude and Codex, spends money, and edits the target project. Ask first. Never point one at anything but a throwaway repo: `git init` a temp dir with one commit, and start cockpit with `COCKPIT_PROJECT_ROOTS` set to its parent.
- **UI changes have no DOM tests** outside the controller. Check them in a browser against a scratch data dir (see [Commands](#commands)). Clicking **act** buttons runs real commands. Avoid the ones that launch agents or run project scripts unless the task needs them.
- **Update the docs.** If behaviour changed, update its [canonical doc](#canonical-docs) in the same change.

## Canonical docs

Each topic has one home. Other docs link to it rather than repeating it.

| Topic | Canonical doc |
|---|---|
| What cockpit is, scope, non-goals | [docs/about.md](docs/about.md) |
| Modules, data flow, API, persistence, config, caps | [plumbing.md](plumbing.md) |
| What it reads, writes, runs, launches, exposes, refuses | [docs/access-given.md](docs/access-given.md) |
| Runtime flows, session stages, controller mapping | [docs/workflows.md](docs/workflows.md) |
| Vocabulary | [docs/definitions.md](docs/definitions.md) |
| Visual and interaction design | [docs/design.md](docs/design.md) |
| Front door, requirements, quick start | [README.md](README.md) |
| Rules for repository agents | this file |
| Why the docs are split this way | [docs/why-harness.md](docs/why-harness.md) |

Write `cockpit` in lowercase in prose.

## When evidence is insufficient

- **Read the code.** Don't infer behaviour from names or from the docs alone.
- **If docs and code disagree,** the code is what runs. Say so, and fix the doc if that is within the task. Don't change behaviour to match a doc without asking.
- **If a change would alter scope, access, launched-agent behaviour or persisted data,** or the right choice depends on intent, stop and ask.
