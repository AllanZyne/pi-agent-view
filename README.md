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
  ──────────────────────────────────────────────────────────
  ↑↓ select · ⏎ attach · type+⏎ new agent · ctrl+x delete · ← close · ? help
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
| `Enter` + text | list open: new agent with that first prompt · attached: steer the agent |
| `Esc` | detach — back to `main`, the agent keeps running |
| `Ctrl+X` | delete that agent outright — abort its turn, drop its session and erase its record (on `main`: pi's interrupt) |
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
tell the reviewer to also check auth.ts    → agent_send
how's the reviewer doing?                  → agent_inspect
kill the reviewer, it's stuck              → agent_remove
```

Typing `@` opens a discovery picker that inserts `@<name> ` at the cursor —
it's just a convenience for referring to an agent by name in your message.

Four tools, one per intent, so the model expresses intent by *which tool it
calls* rather than arguments a tool would have to guess from. **Every
agent gets all four** — including sub-agents themselves, via `customTools`
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
- **`agent_inspect`** — read-only: state, model, task, recent activity,
  latest output (or `full: true` for the whole transcript), even mid-turn.
  Omit `name` to list every sub-agent.
- **`agent_remove`** — delete outright, irreversibly. `main` can never be
  targeted.

## Sub-agent definitions (`.pi/agents/`)

Drop Markdown files under `.pi/agents/` (project, higher priority) or
`~/.pi/agent/agents/` (user) to predefine reusable agents — same idea as
Claude Code's `.claude/agents/`. Format:

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

`/agents` rescans both scopes and prints what it found; `agent_create` also
rescans on every call, so newly added files show up without a reload.

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
  `/scoped-models`, `/name`) are blocked with a notice instead of silently
  running against the wrong session.
- Anything else is sent to the agent as chat text, same as any other
  message.

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
- `Ctrl+X` is a hard delete, not a pause: the agent's turn is aborted, its
  manifest entry removed and its `.jsonl` erased. There is nothing left to
  revive afterward. If you were attached to it, you land back on `main`.

## Tests

```sh
node tests/run.mjs          # unit tests, offline, ~1s
node tests/run.mjs --e2e    # also runs real agents (needs model credentials)
```

## License

MIT
