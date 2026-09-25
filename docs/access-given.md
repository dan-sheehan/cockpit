# Access given

This page covers what you allow when you run `npm start`.

cockpit runs as you, with your user's file permissions and your environment. It is a local tool for one trusted user on their own machine. It is **not a sandbox and not a security boundary**. The protections below stop mistakes, other web pages and the agents' own write access from reaching further than intended. They do not stop a hostile local process or a misbehaving agent that runs code as you.

In short:

- cockpit **reads** a lot: your Claude Code and Codex configuration, prompts and transcripts, and the projects they know about.
- Its own code **writes** only its data dir and a temp dir.
- It **launches** processes only when you click something. Some of those processes (`claude` in `acceptEdits`, project scripts) can change your projects and run arbitrary code.
- It **serves** what it reads, mostly redacted, on `127.0.0.1` with no authentication.

How each piece is implemented: [plumbing.md](../plumbing.md). What each flow does step by step: [workflows.md](workflows.md).

## Reads

The scanner reads everything below at startup, on every watched change, and on every rescan. "Claude home" means `~/.claude`, or `CLAUDE_CONFIG_DIR` if it is set. "Codex home" means `~/.codex`, or `CODEX_HOME`.

**Claude home**
- `settings.json` and `settings.local.json`
- `CLAUDE.md`
- `skills/*/SKILL.md`, and the names of the other files in each skill dir
- `agents/*.md`, `commands/*.md`, `rules/*.md` and `plans/*.md`
- `plugins/known_marketplaces.json`, `plugins/installed_plugins.json`, and the directory names under `plugins/marketplaces/`
- `history.jsonl`. The last 40 prompts within its first 200 KB are kept, redacted and cut to 200 characters ([large files](../plumbing.md#known-limits))
- `projects/`: session-file counts per project, and each discovered project's `memory/*.md`
- the size of every top-level entry, via `du -sk`. Contents are not read, but sizes are, including databases and credential files

**`.claude.json`** (in `HOME`, or in `CLAUDE_CONFIG_DIR` if set)
- The whole file, up to 200 KB: project paths and trust flags, MCP servers, install method, and similar fields. A larger file is not parsed ([large files](../plumbing.md#known-limits)).

**Codex home**
- `config.toml`, `AGENTS.md` and `rules/*`
- `skills/` and `skills/.system/`
- `session_index.jsonl` (thread names) and `version.json`
- the directory names under `plugins/cache/`
- `du -sk` sizes, as above
- `auth.json` is only checked for existence. It is never read.

**Each discovered project** (discovery rules: [plumbing.md](../plumbing.md#project-discovery))
- The top-level file list.
- `package.json`, `CLAUDE.md`, `CLAUDE.local.md` and `AGENTS.md`.
- For each `@import` in `CLAUDE.md` and each relative Markdown link in those three files: whether the target exists inside the project and, for a file, its size. Targets are never read. A target whose path, or a symlink on the way, leaves the project is reported only as `outside`, never sized.
- `.mcp.json`, `.claude/settings.json` and `.claude/settings.local.json`.
- `.claude/skills`, `.claude/agents`, `.claude/commands` and `.claude/swag.md`, plus `.agents/skills`.
- Git state (branch, status, last 5 commits, remote names).
- A file is used only if its real path is inside the project. A symlink that points out of the project is treated as missing.

**The machine**
- Hostname, user name, OS release, CPU count and memory.
- The version and path of `claude`, `codex`, `node`, `npm`, `git`, `gh`, `python3` and `jq`, and of `ollama`, `lms`, `bun`, `deno`, `uv` and `docker` if they are on `PATH`.
- The **names** of environment variables whose names match an AI or dev-tool prefix list, whether each is set, and its length. Values are never read into the UI.

**On demand**, when you open something in the UI:
- File viewer: any file or directory under the viewer roots (see [Refuses](#refuses)).
- Transcripts: any `.jsonl` file under `<Claude home>/projects` or `<Codex home>/sessions`, read in full up to 400 MB.
- A project's Claude sessions: every session file in that project's directory under the Claude home.
- A project's full `git diff`.

## Runs

**During every scan**, without asking:
- `claude`, `codex`, `node`, `npm`, `git`, `gh`, `python3` and `jq` with `--version`, plus `which` for those and for `ollama`, `lms`, `bun`, `deno`, `uv` and `docker`. `--version` also runs for any of the last six that are found.
- `du -sk` on each top-level entry of both homes.
- In every discovered project: `git rev-parse`, `git branch --show-current`, `git status --porcelain`, `git log -5` and `git remote -v`.

**When you click**, from a project's **act** or **git** tab (all run in that project, as you):
- Any script in its `package.json`, via `npm test` or `npm run <script>`. That is the project's own code.
- `git status`, `git diff --stat` and `git log --oneline -20`.
- `open <project>` (Finder) and `code <project>` (VS Code).
- `osascript`, which tells Terminal.app to `cd` into the project and start an interactive `claude` or `codex`.

**Behind the scenes**, as part of something you started or opened (all in that project, as you):
- A collaboration session runs the scan's git commands, `git stash create` for its baseline, and `git diff <baseline>` and `git ls-files --others` at each diff capture. At the end it runs `npm test` if the project has a `test` script. That is the project's own code, run after Claude's edits.
- An ad-hoc Codex review runs `git diff` and `git ls-files --others` to build its prompt.
- The **git** tab's full diff runs the same two commands.

cockpit has no free-form command endpoint. The action set is fixed in `server.mjs`.

## Launches agents

These are the Claude and Codex processes cockpit itself starts: launched agents, in the sense of [definitions.md](definitions.md#words-that-collide).

| Launched by | Command | Mode | Tools | Budget |
|---|---|---|---|---|
| Ad-hoc Claude task, `plan` | `claude -p` | `--permission-mode plan` | Claude Code's defaults for plan mode | $2 |
| Ad-hoc Claude task, `acceptEdits` | `claude -p` | `--permission-mode acceptEdits` | `Read Edit Write Glob Grep`, `Bash(git status*)`, `Bash(git diff*)`, `Bash(npm test*)`, `Bash(ls*)` | $2 |
| Session: investigate | `claude -p` | `plan` | Claude Code's defaults for plan mode | per-stage budget (default $3) |
| Session: implement, disposition | `claude -p --resume` | `acceptEdits` | `Read Edit Write MultiEdit Glob Grep`, `Bash(git status*)`, `Bash(git diff*)`, `Bash(git log*)`, `Bash(npm test*)`, `Bash(npm run *)`, `Bash(node *)`, `Bash(ls*)`, `Bash(cat *)`, `Bash(python3 *)` | 2× the per-stage budget |
| Session: review; ad-hoc Codex review | `codex exec` | `--sandbox read-only --ephemeral` | Codex's read-only sandbox | Codex config |
| Terminal button | interactive `claude` / `codex` | your normal settings | your normal settings | none from cockpit |

What that means in practice:

- **Claude runs are not sandboxed by cockpit.** `Bash(node *)`, `Bash(python3 *)` and `Bash(npm run *)` can execute arbitrary code, as you, with your environment. Your own Claude Code permission settings still apply on top of the flags above.
- **Nothing hard stops a commit.** Prompts tell Claude not to commit, and `git commit` and `git push` are not in the allow-list. Neither is a guarantee.
- **Claude can be steered by the project.** Project content (`CLAUDE.md`, code, test output) flows into the agents' context. Running a session on a project means trusting that project.
- **Codex is always launched with `--sandbox read-only`** (`buildCodexArgs`; asserted in `test/adapters.test.mjs`). Inside the project it can still read files and run read-only commands. cockpit records every command Codex ran and counts sandbox-denial messages.
- **Launched agents cost money and write their own state.** They call their providers and spend against your accounts. Claude Code writes its own transcripts and `.claude.json` as it always does. The interactive Terminal sessions are not owned by cockpit: it cannot stop them, and it sees them only through their transcript files.

## Writes

cockpit's own code writes only:

- **The data dir** (`data/` in the checkout, or `COCKPIT_DATA_DIR`): `sessions/`, `runs/` and `changes.jsonl`.
- **A `cockpit-codex-*` directory in the OS temp dir** for each Codex review, holding the output schema and Codex's last message. These directories are not deleted afterwards.

It does not edit files in the Claude home, the Codex home or your projects. Changes there come from the processes above, plus two ordinary git side effects:

- `git status` may refresh `.git/index`.
- The session baseline (`git stash create`) writes unreferenced objects into `.git`. It does not touch the working tree or the stash list.

## Persists

The data dir keeps:

- task prompts and the full prompts sent to each stage;
- **full process output, unredacted**, including Claude's and Codex's streamed output;
- captured session diffs (redacted), review findings and dispositions;
- costs, local paths, and the configuration change log.

Treat it as private. `data/` is in `.gitignore`. Delete it to clear cockpit's history.

The browser keeps the Controller view's last 60 events in `sessionStorage` for the tab.

## Watches

`fs.watch` runs, with no writes, on:

- the Claude and Codex homes (recursive), and `.claude.json`;
- each project's top level, its `.claude/` and `.agents/` (recursive), and its `.git/` (`index`, `HEAD`, `ORIG_HEAD`, `FETCH_HEAD`);
- `<Claude home>/projects` and `<Codex home>/sessions`, for live transcripts.

## Exposes locally

- **Where it listens.** An HTTP server on `127.0.0.1:<port>` (default 4848). It never listens on other interfaces.
- **No authentication.** Any process on this machine that can reach the port can call the GET API. That includes the scan (redacted), the file viewer (redacted), transcripts (redacted), **run output and the SSE stream (unredacted)**, and **a project's full `git diff` (unredacted)**.
- **DNS rebinding.** Requests whose `Host` is not `127.0.0.1`, `localhost` or `[::1]` are refused.
- **Other web pages.** Every request other than GET or HEAD needs the exact `Origin` of cockpit's own page and a JSON content type, and no CORS headers are sent. Another site open in your browser therefore cannot start runs, sessions or stops, or read responses. `test/request-admission.test.mjs` covers this.
- **No outbound calls.** The server itself makes no outbound network calls and has no telemetry. The processes it launches talk to whatever they talk to.

## Refuses

- **File viewer roots.** The viewer opens paths whose real path (symlinks resolved) is inside one of:
  - the Claude home and the Codex home, except that a home set to `HOME` or above is dropped as a root;
  - `.claude.json`;
  - cockpit's own checkout;
  - a discovered project.
- **Blocked files**, anywhere, even inside a root. The rule is the `BLOCKED_FILE` regex in `server.mjs`, matched on the real file name:
  - `auth.json`, `credentials`, `.git-credentials`, `.netrc` and `.npmrc`;
  - names containing `.sqlite`, `.credentials` or `.env.`, and names ending in `.env`, `.pem` or `history.jsonl`;
  - names containing `id_rsa`, `id_dsa`, `id_ecdsa` or `id_ed25519`, including `.pub` files.

  Directory listings still show these names.
- **Files over 1.5 MB** are not displayed.
- **Projects.** `/`, `HOME` and any ancestor of `HOME` are never projects, whatever Claude Code or Codex recorded.
- **Action targets.** Actions, git requests and sessions must name a discovered project. `npm.run` accepts only scripts in that project's `package.json`. Unknown actions are refused.
- **Transcripts** must be `.jsonl` files under `<Claude home>/projects` or `<Codex home>/sessions`.
- **Codex never gets write access** from cockpit.
- **The Xbox controller** can only navigate. No mapping sends a POST ([workflows.md](workflows.md#controller-navigation)).

## Redaction

`lib/redact.mjs` recognises credentials by shape and by key name:

- known token formats, private-key blocks and `Authorization` headers;
- sensitive key names in JSON, TOML and `key = value` lines;
- URL query parameters and userinfo;
- `.npmrc` and `.netrc` syntax;
- flags and headers in hook commands and MCP args.

It is applied to:

- scanned settings, config, instruction files and hook/MCP definitions;
- the recent-prompts list;
- file-viewer content;
- transcript timelines and first prompts;
- session diffs;
- diffs and settings quoted in Codex review prompts.

It is **not** applied to:

- process output (Processes, `data/runs/`, SSE);
- the project full-diff view;
- prose instruction files quoted in review prompts;
- anything an agent reads for itself with its own tools.

Redaction is not a guarantee. A secret with no recognisable shape and no telling key name passes through.

## Limits of these protections

- The transcript path check is lexical (`path.resolve`, not `realpath`). A symlink placed inside a log directory is followed.
- `claude-sessions?project=` is not checked against discovered projects. It is confined to one directory under `<Claude home>/projects`, because `/` and `.` in the value become `-`.
- Everything above assumes the local user is you. Another local account that can reach `127.0.0.1:<port>` can read the GET API.
