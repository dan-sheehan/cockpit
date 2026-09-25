# Why the docs are shaped like this

cockpit's documentation is split by the question each file answers, so a person or an agent can go straight to the file they need. This page explains the split for people. The working rules for agents are in [harness.md](../harness.md).

| Layer | Files | Answers | For |
|---|---|---|---|
| Product | [README.md](../README.md), [about.md](about.md), [access-given.md](access-given.md), [workflows.md](workflows.md), [definitions.md](definitions.md), [design.md](design.md) | What is it, what does it touch, what does it do, what do the words mean, how does it look | Anyone deciding to run it, and anyone changing it |
| Plumbing | [plumbing.md](../plumbing.md) | How is it wired together | Anyone changing the code |
| Harness | [harness.md](../harness.md) | Before I change it, what must I know and not break | Coding agents working on the repo, and the person reviewing their work |
| Entry points | [AGENTS.md](../AGENTS.md), [CLAUDE.md](../CLAUDE.md) | Where do I start | Codex, Claude Code and other agents, each through the file its tool looks for |

The layers stay separate for these reasons:

- **Product docs are organised by behaviour.** They name code where that is the precise answer, but they answer "what does this do" rather than "where is it implemented". `access-given.md` has its own page because cockpit reads prompts, transcripts and config, and can launch agents that edit code. That deserves a direct answer.
- **Plumbing is a map, not a manual.** It names files and says what connects to what, so a change starts in the right place. It links to the product docs rather than repeating them.
- **The harness is short because agents load it every session.** It holds orientation, invariants, what to leave alone, how to validate, and where to look. It links out for everything else.
- **Entry points hold no content.** `CLAUDE.md` is `@harness.md`, which Claude Code expands at session start. `AGENTS.md` is a pointer, which Codex reads natively. Neither can drift from the other.
- **cockpit's own agents are product behaviour.** The prompts and limits of the `claude` and `codex` processes cockpit launches live in the product docs, not the harness, so changing them is visibly a product change ([harness.md](../harness.md#two-kinds-of-agents)).

Each topic has one canonical doc ([harness.md](../harness.md#canonical-docs)). With one maintainer, there is deliberately no contributing guide, changelog, decision log or roadmap. Code comments carry the local "why", and git history carries the past.
