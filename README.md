# pi-agent-view

Concurrent sub-agents for [pi](https://pi.dev), each rendered by pi itself.

> **Status: early / actively developed.** Expect rough edges and breaking
> changes between versions. This extension mirrors agent transcripts into your
> main session's `.jsonl` and patches how pi renders it, so a bug here can
> corrupt or otherwise mess up your session history. Use it on sessions you
> don't mind losing, and keep backups if that matters to you.

Press `←` on an empty prompt to open the agent list. Attach to any agent and its
conversation replaces the transcript — live streaming, markdown, tool boxes, all
drawn with pi's own components. Switching never interrupts anything: a background
agent keeps working while you look at another one.

```
  ◆ Agents  3 agents · 1 working
  ──────────────────────────────────────────────────────────
  Working (1)
   ▸ ✽ write-the-fix-pr
       4 msgs · claude-sonnet-4-5   Opening a branch and…
  Idle (1)
     ∙ main (attached)
       27 msgs · claude-sonnet-4-5
  Completed (1)
     ✓ update-the-unit-tests
       9 msgs · claude-sonnet-4-5   Updated 12 test files.
```

## Install

```bash
pi install git:github.com/AllanZyne/pi-agent-view
```

## Usage

| key | effect |
| --- | --- |
| `←` | open/close the agent list (empty prompt only) |
| `↑` `↓` | move the selection (empty prompt only) |
| `Enter` / `→` | attach to the selected agent |
| `Enter` + text | list open: new agent with exactly that first prompt, then attach immediately · attached: steer the agent |
| `Esc` | detach — back to `main`, the agent keeps running |
| `Ctrl+X` | on an agent, press twice within 2 seconds to delete it outright; on `main`, interrupt |
| `Ctrl+L` | model selector for the agent you are looking at |
| `Ctrl+P` / `Shift+Ctrl+P` | cycle the attached agent's model |
| `?` | help |

`↑`/`↓` only drive the list while the prompt is empty, so prompt history still
works as soon as you type.

## Talking to agents

Just ask in plain language. Whichever conversation you're talking to (main,
or an agent you're attached to) reads the request and calls the matching
tool itself:

```
@reviewer take a look at this diff        → agent_create
what agents are available?                 → agent_list
search the reviewer's auth findings         → agent_inspect (regex search)
tell the reviewer to also check auth.ts    → agent_send
kill the reviewer, it's stuck              → agent_remove
```

Typing `@` opens a discovery picker that inserts `@<name> ` at the cursor —
it's just a convenience for referring to an agent by name in your message.

Five tools, one per intent, so the model expresses intent by *which tool it
calls* rather than arguments a tool would have to guess from. **Every
agent gets all five** — including sub-agents themselves, via `customTools`
(`agent-runtime.ts`) — so delegation nests to any depth. Agents are peers:
no parent/child tracking, and removing one never cascades to anything it
spawned.

- **`agent_create`** — spawn one task or several in parallel
  (`tasks: [...]`, max 8). `model` takes a full id or a unique substring
  (`opus`, `haiku`). Waits for completion by default; `wait: false` fires
  and returns immediately.
- **`agent_send`** — message an existing agent by name (or def name →
  most recent instance), reviving it if needed. Fire-and-forget by
  default; `wait: true` waits for the response. Never creates — errors if
  `name` is unknown.
- **`agent_list`** — list every sub-agent's name, model, and state, plus the
  root session's used/available slots. Use it to find an agent to reuse.
- **`agent_inspect`** — inspect one agent's compact status, page through a
  bounded window of its user/assistant turns, or search its chat with a regular
  expression. It never returns an unbounded full transcript.
- **`agent_remove`** — delete outright, irreversibly. `main` can never be
  targeted.
- A root session can retain at most **32 sub-agents**, shared across every
  delegation depth. Completed, failed, stopped, and idle agents still occupy a
  slot; `agent_remove` frees it. Prefer `agent_list` + `agent_send` to reuse a
  suitable agent, and remove agents created only for one-off work after their
  results have been collected.

## Sub-agent definitions (`.pi/agents/`)

Drop Markdown files under `.pi/agents/` (project, highest priority),
`~/.pi/agent/agents/` (user), or this extension's own `agents/` directory
(bundled with pi-agent-view itself, lowest priority — e.g. `btw`, a
read-only Q&A agent shipped in the box) to predefine reusable agents — same
idea as Claude Code's `.claude/agents/`. A name defined in more than one
scope resolves to the higher-priority one; the others are still visible via
`/agents`, which lists source paths. Format:

```markdown
---
name: code-reviewer
description: Reviews diffs for correctness, style, and obvious bugs.
model: anthropic/claude-sonnet-4-5
thinkingLevel: medium
---

You are a strict code reviewer. When invoked, analyse the code and provide
specific, actionable feedback on quality, security, and best practices.
```

Only `name` and `description` are required. The Markdown body is *appended*
to pi's base system prompt, so `AGENTS.md`, skills, prompt templates etc.
still load. `model` (`provider/id` or `inherit`) and `thinkingLevel` are just
defaults for a freshly spawned agent; once an agent has run, it keeps its
own model.

`/agents` rescans all three scopes and prints what it found; `agent_create`
also rescans on every call, so newly added files show up without a reload.

Don't want to hand-write the frontmatter? Run `/skill:create-agent` and the
bundled **`create-agent` skill** will walk you through picking a name,
description and system prompt, then write the file for you.

## Models

Every agent owns its own model. A new agent inherits whatever `main` is
using at spawn time, and from then on the two are fully independent — a
later `/model` on `main` never moves an already-spawned agent, and nothing
an agent does changes pi's global default.

- **Attached to an agent:** `/model`, `/model <provider/id>`, `Ctrl+L`, or
  `Ctrl+P`/`Shift+Ctrl+P` to cycle.
- **Agent list open:** `/model [search]` + `⏎` sets the model of the
  currently **selected** row (including `main`).
- **Via a tool call:** `agent_create`/`agent_send`'s `model` parameter (see
  "Talking to agents" above).

## Slash commands while attached

While attached to an agent, typed text is sent to the agent as a chat
message. A few kinds of slash command are handled differently:

- **`/model`** runs against the attached agent's own model (see "Models"
  above).
- **Commands that don't touch a session** — auth, folder trust, settings,
  reload, quitting, and a few static/info screens — run normally, always
  against pi itself, regardless of which agent is on screen.
- **Commands that only make sense for pi's own session** (`/resume`,
  `/fork`, `/new`, `/tree`, `/clone`, `/export`, `/import`, `/share`,
  `/scoped-models`, `/name`), and **per-session commands not yet implemented
  against the attached agent** (`/thinking`, `/compact`, `/copy`,
  `/session` — each has a direct equivalent on `AgentSession`, just not
  wired up here yet), are blocked with a notice instead of either silently
  running against the wrong session or being sent to the agent as a literal
  chat message pretending to be a command.
- Anything else — extension commands, skills, prompt templates, plain chat
  text — is sent to the agent's own session via `prompt()`, exactly like
  typing it on `main` would.

`/` completion while attached hides the blocked commands, since typing one
would just produce a notice.

## Agent list details

- Agents are named after their first prompt, slugified (lowercase, single
  hyphens); collisions get a letter suffix (`run-tests`, `run-tests-b`, …).
  `main` is always pi's own session, whatever the session name is. Agents
  spawned from a `.pi/agents/*.md` def show a `[<def>]` badge next to their
  name.
- Icons: `✽` Working, `✓` Completed, `✗` Failed, `⊘` Stopped (aborted or
  died mid-turn), `∙` Idle.
- The list is a **snapshot**: it's rebuilt when opened, not on a timer.
  Reopen (`←` twice) to refresh.
- The list sizes itself to what pi's layout can spare (in fullscreen a widget
  is a fixed pane, and an oversized one squeezes the transcript to a single
  line and then gets cut off): long lists scroll inside the widget with
  `↑ N more` / `↓ N more` markers instead of growing past the screen.
- `Ctrl+X` is a confirmed hard delete, not a pause: press it twice on the same
  agent within 2 seconds. While confirmation is armed, that row shows the
  second-press instruction. Deletion aborts the turn, removes the manifest entry
  and erases the `.jsonl`; there is nothing left to revive afterward. If you
  were attached to it, you land back on `main`. `Ctrl+X` on `main` remains an
  immediate interrupt.
- Typing a prompt while the list is open creates a plain agent, passes exactly
  that text as its task (without conversation context), and immediately opens
  the new agent's view.

## Notices, scrolling, and what a switch costs

- Notices this extension raises (model switched, agent started, blocked
  command, errors) are shown **in the conversation they were raised from**.
  pi's `notify` appends to its own transcript, which is hidden while an agent
  is attached, so those children are tagged with the view that owns them —
  otherwise a notice raised in an agent view would be invisible and then
  reappear in `main`'s transcript on detach.
- Attaching or detaching **scrolls to the newest message** and clears any text
  selection. pi has one scroll offset for the whole document, so a switch would
  otherwise inherit the previous view's offset (clamped to a completely
  different height) and leave a selection highlighting unrelated rows.
- Rendering an agent view costs the same per frame as pi's own transcript.
  That is not automatic: fullscreen re-renders the entire document on every
  frame (keystroke, scroll tick, spinner), so anything an entry does per render
  is paid per keystroke. Entries therefore hand pi's components their content
  **once** (a tool result is applied when it arrives, not on every frame — that
  rebuild used to discard pi's line caches and made typing and scrolling in a
  tool-heavy agent view visibly lag while `main` stayed smooth), and a
  background agent's streaming deltas no longer request repaints of a view they
  cannot change.
- **Compaction.** An agent's session is created with pi's own settings, so it
  auto-compacts on threshold/overflow just like `main` does. When it happens the
  agent view shows pi's collapsible `[compaction]` block and its token/cost
  notice, and stops drawing everything older — the same thing `main` does, since
  that history is no longer in the agent's context. (Known gap: if pi's *own*
  session compacts, whatever mirrored agent entries fall before its cut point
  are pruned from the transcript by pi and are not redrawn.)

## Tests

```sh
node tests/run.mjs          # unit tests, offline, ~1s
node tests/run.mjs --e2e    # also runs real agents (needs model credentials)
```

## License

MIT
