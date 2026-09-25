# About cockpit

## What it is

cockpit is a local web app for inspecting and operating an AI development environment built on Claude Code and Codex, on the machine it runs on. What it shows and what you can do from it are listed in the [README](../README.md#what-it-does). This page covers why it exists and where its scope ends.

## Why it exists

cockpit answers one question about the machine it runs on:

> What is happening in my AI environment, why is it happening, and what can I do from here?

Claude Code and Codex keep most of what shapes their behaviour in files scattered across their homes and your projects. cockpit puts that state in one place. It notices when the state changes, so "why did the model behave differently today" gets a first answer from the change log.

## Intended use

- **One person, on their own macOS machine**, with Claude Code and Codex installed.
- The projects it covers are the ones those tools already know about, plus any directories listed in `COCKPIT_PROJECT_ROOTS`.
- cockpit is **started when wanted, looked at, and acted on deliberately**. Nothing runs until a button is pressed, apart from scans and file watching.

## Principles visible in the product

- **Say how it knows.** Numbers, paths and states on screen come from disk, from a CLI, or from a process cockpit launched. Anything else is meant to be labelled `INFERRED` or `UNAVAILABLE` ([definitions.md](definitions.md#cockpits-concepts)), and empty states say what was checked. A few fixed strings still break this rule ([design.md](design.md#worth-considering-later)).
- **Local only.** The server binds `127.0.0.1`, makes no outbound calls, and has no telemetry.
- **Look freely, act deliberately.** Reading is automatic. Every action is a fixed, named operation on a discovered project.
- **Bounded collaboration.** Claude is the only writer. Codex is read-only. Review rounds, retries and recursion are capped in code.
- **Small.** No npm dependencies, no build step, no framework. `node server.mjs` is the whole deployment.

## Scope

| Area | In scope |
|---|---|
| Visibility | Scanning Claude Code, Codex and project configuration. Change detection. Transcript timelines. The file viewer. Search |
| Operability | Allow-listed project actions, ad-hoc Claude runs and Codex reviews, Terminal launch, stopping processes |
| Collaboration | The one collaboration workflow described in [workflows.md](workflows.md#collaboration-session) |
| Input | Mouse and keyboard, plus optional Xbox-controller navigation |

## Non-goals

- **Not a chat window.** There is no open-ended conversation with an agent.
- **Not a general file browser.** The viewer is limited to the Claude and Codex homes, `.claude.json`, cockpit itself and discovered projects.
- **Not a dashboard of static counts.** Figures come from the current scan and link to their source.
- **Not a shell or command runner.** There is no free-form command endpoint.
- **Not an editor of agent configuration.** cockpit's own code never edits files in the Claude home, the Codex home or your projects. Its only writes inside a project are ordinary git side effects in `.git`. Everything else it writes goes to its data dir and a temp dir ([access-given.md](access-given.md#writes)).
- **Not an autonomous agent loop.** Sessions are capped ([workflows.md](workflows.md#collaboration-session)), and cockpit never commits or pushes.
- **Not a security product or a multi-user service.** There is no authentication. It is safe only in the sense described in [access-given.md](access-given.md).
- **Not cross-platform in practice.** Finder, Terminal and `npm run open` use macOS commands. Other platforms have not been tried.
