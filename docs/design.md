# Design

This page records the design system and interaction rules visible in cockpit as it is now. The tokens are defined in `public/style.css` (`:root`). The markup is built in `public/app.js` and `public/controller.js`. Suggestions are kept apart, in [Worth considering later](#worth-considering-later).

## Current design

### Character

- **Dark only** (`color-scheme: dark`). There is no light theme.
- **Monospace only.**
- **Square.** `border-radius: 0` everywhere.
- **Hairlines, not shadows.** 1 px borders separate everything, and nothing floats.
- **Dense.** Small type and tight rows, so a lot of state fits on one screen.

### Tokens

Exact values live in `public/style.css` (`:root`), which is the source of truth.

| Token | Used for |
|---|---|
| `--bg` | Page, process output wells |
| `--surface` | Rail, inputs, tiles |
| `--raised` | Hover, selected row, `pre` blocks |
| `--text` | Primary text |
| `--muted` | Secondary text, labels |
| `--dim` | Tertiary text, inactive or skipped states |
| `--border` / `--border-strong` | Hairlines / emphasis and hover |
| `--accent` = `--amber` | Selection, focus, links, primary buttons, cockpit |
| `--cyan` | Claude, running or live |
| `--violet` | Codex, findings |
| `--green` | OBSERVED, complete, clean, accepted |
| `--red` | Failed, dirty, missing, rejected, destructive buttons |
| `--mono` | All text (a monospace stack led by SF Mono) |

**Type scale.** The base is 13 px with a 1.55 line height. Sizes:

| Size | Used for |
|---|---|
| 10 px | badges, meta, `.nano` |
| 11 px | tabs, eyebrows, labels, `.small` |
| 12 px | rail items, key/value grids, `pre` |
| 13 px | row names |
| 15 px | brand, detail titles |
| 22 px | view titles, big numbers |

Rail items, eyebrows, badges, tabs and tile labels are uppercase, letter-spaced .06–.12em.

### Colour means something

- **Participant.** Claude is cyan, Codex is violet, cockpit is amber. The same colour shows as a row's left rail, a badge, a `who` label or a tile edge. The Controller view adds green for the Xbox pad.
- **Evidence.** `OBSERVED` is green, `INFERRED` is amber and `UNAVAILABLE` is dim, always as outlined badges.
- **Status.** Green means done or good. Cyan (blinking) means running or live. Amber means waiting, queued, warn, deferred or partial. Red means failed or bad. Dim means skipped, cancelled, stopped or interrupted.
- **Amber is interactive.** Links, file paths that open in the viewer, the selected nav item, the active tab and focus outlines all use amber.

### Building blocks

| Block | Class | Shape |
|---|---|---|
| Rail | `nav` | 200 px column: brand and hostname, search, the 12 views with counts, then a footer with scan time, **rescan** and the port |
| View head | `.viewhead` | 22 px title, muted one-line description, optional control on the right |
| List / detail | `.split` | List at `minmax(300px,36%)`, detail filling the rest; each side scrolls on its own |
| Row | `.row` | 2 px left rail (participant or state colour), name and description, right-aligned meta. Selected: raised background and amber rail |
| Eyebrow | `.eyebrow` | Small uppercase section label. Amber when it heads the active thing |
| Key/value | `.kv` | Two-column grid: muted keys, values that wrap anywhere |
| Badge | `.badge` | Outlined, uppercase, 10 px. The class is derived from the text (`badge('failed')` → `.failed`) |
| Tabs | `.tabs` | Uppercase, amber underline on the active one |
| Tiles | `.grid` | 1 px gaps drawn as borders, 2 px coloured left edge |
| Spine | `.spine` `.node` | Square dot, connecting line, participant label, status on the right. Used for precedence, "how configuration reaches a task" and session stages. Findings branch off review nodes (`.branch`) |
| Flow | `.hookflow` | Four cells: event → rule → decision → effect |
| Note | `.note` | Amber left rail, for caveats and limits |
| Empty state | `.empty` | Muted prose that says what was checked and what that means |

### Motion

- Hover and colour changes take `.12s ease-out`.
- Running and live markers blink (`steps(2)`, 1.2 s).
- Nothing else moves.

### Interaction

- **Every place is a URL.** `#<view>/<id>/<tab>`, so the back button, reloads and links all work.
- **Live without refresh.** Server events re-render the current view. Process output streams into its panel.
- **Keyboard.**
  - ⌘K or `/` focuses search.
  - List rows are real focusable elements: Tab reaches them, and Enter or Space opens one.
  - Re-renders put focus back on the row that had it, and never take focus from an input.
- **Controller.** An Xbox pad moves the same row focus and switches views and tabs ([workflows.md](workflows.md#controller-navigation)). The Controller view traces each input from the physical button to its result.
- **Buttons say what they run.** Labels are the command or effect ("git diff --stat", "claude · interactive in Terminal", "stop process (SIGTERM)").
  - Amber fill is the primary action.
  - A red outline marks stop and cancel.
  - Starting anything needs an explicit click. There is no confirmation dialog.
- **Copy shows its evidence.** Paths are shown `~`-shortened. Command lines, prompts and exact flags are shown verbatim. Empty states name the files that were checked.

### Implementation notes

- DOM is built with the `h(tag, attrs, ...children)` helper. There are no templates and no framework.
- Many one-off layouts use inline `style` attributes in `app.js` rather than classes.
- The controller schematic is SVG drawn in `controller.js`, styled with the same tokens.

## Worth considering later

These are observations about the current code, not decisions.

- **The token source comment.** The header of `style.css` says the tokens come from `.claude/swag.md`. That file is not in this repository, so `style.css` is the de facto source.
- **Fixed copy that asserts facts.** A few strings read like observations but do not depend on the scan:
  - The Environment spine's "HOOKS · MCP · AGENTS" node always ends with "none configured, so no command interception or external tools reach the agents", even when counts are non-zero.
  - The MCP empty state mentions `codex mcp list` and "this Claude Code session", which cockpit does not check.

  Making these conditional would match the "say how it knows" rule.
- **Role text in Agents.** It lists `Bash(git *)` for implement, but the real allow-list is `git status`, `git diff` and `git log` only (see `IMPLEMENT_TOOLS`). "May not … touch other projects" is also not enforced ([access-given.md](access-given.md#launches-agents)).
- **Inline styles.** If views keep growing, the repeated inline layouts in `app.js` are the first thing that would benefit from named classes.
