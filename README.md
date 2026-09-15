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

There is **no `/agent` command** and **no `@<slug>` routing operator** —
`@name` is just text. Whichever conversation you're talking to (`main`, or
an agent you're attached to) decides from the message's content what to do
and calls the matching tool itself:

```
@reviewer take a look at this diff        → the LLM calls agent_create
tell the reviewer to also check auth.ts    → the LLM calls agent_send
how's the reviewer doing?                  → the LLM calls agent_inspect
kill the reviewer, it's stuck              → the LLM calls agent_remove
```

No position rule, no escaping (`\@name` isn't needed — `@name` was never
intercepted to begin with), no `:<model>` micro-syntax — just ask for what
you want in plain language and the model picks the right tool call. See
"LLM-callable tools" below for exactly what each one does.

Typing `@` in the editor still opens an agent picker (instead of pi's file
picker) as a **discovery convenience only** — it lists `agent` plus every
live agent and discovered def, and selecting one inserts `@<name> ` at the
cursor. It doesn't route or intercept anything; it's purely there so you
don't have to remember exact names.

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
- **Via a tool call:** `agent_create`'s and `agent_send`'s `model` parameter —
  see "LLM-callable tools" below.

## Slash commands while attached

While attached to an agent, typed text is sent to the agent as a chat
message — pi's own slash commands don't run there, except `/model` (above).
Commands that only make sense for pi's own session (`/resume`, `/fork`,
`/new`, `/tree`, ...) have no meaning for an agent, so `/` completion while
attached only offers what's actually implemented (currently just `/model`).

## LLM-callable tools

Four tools let the assistant itself — not just a human at the keyboard —
create, message, inspect, and delete sub-agents from inside a turn. **Every
agent has the same four**, including sub-agents themselves, so delegation
nests to any depth: a sub-agent can spawn, message, check on, or delete its
own sub-agents, exactly like main can. There is no parent/child tracking —
every agent is a peer that can address any other agent in the session by
name, and terminating one never cascades to anything it spawned.

They're deliberately split by intent rather than merged into one
do-everything tool, so the calling model doesn't have to guess: "create" vs
"message an existing one" is a decision the model makes by picking the
tool, not something a tool infers from the arguments.

- **`agent_create`** — *create.* Delegate one task (`{ task, agent?, model? }`)
  or several in parallel (`{ tasks: [...] }`, max 8) to new sub-agents. `model`
  forces which model that sub-agent runs on — a full `provider/id`, a bare
  `id`, or any short substring that uniquely matches one available model
  (e.g. `opus`, `haiku`) — no need to know the exact string. By default
  **waits** for every task to finish and returns each sub-agent's final
  response; pass `wait: false` to fire-and-forget instead — spawn and
  return immediately without blocking this turn, then check in later with
  `agent_inspect`/`agent_send`. Every spawned agent shows up live in the
  picker (press `←`) while the tool call is in flight, so a human can
  attach and watch it work.
- **`agent_send`** — *message an existing one.* Send a message to a
  sub-agent by name (or by def name, picking its most recent instance),
  reviving it first if it isn't currently live. Optionally switches its
  model first (`model`, same fuzzy matching as `agent_create`). Defaults to
  fire-and-forget (returns immediately, background); pass `wait: true` to
  wait for the turn and get the response back, same as `agent_create`.
  **Never creates** — if `name` doesn't match a known sub-agent it errors
  out and points at `agent_create` instead of guessing.
- **`agent_inspect`** — *read, without waiting or sending anything.* Given a
  name, reports that agent's current state, model, original task, recent
  tool activity and latest output (or, with `full: true`, its entire
  transcript) — even while it's still `working`, mid-turn. Omit `name` to
  list every sub-agent in the session with a one-line state + preview.
  Read-only: never spawns, messages, or changes anything.
- **`agent_remove`** — *delete.* Aborts a sub-agent's turn, disposes its
  session, and removes it from the picker. Cannot be undone. `main` (this
  session's own root conversation) can never be targeted this way — the
  call errors instead of doing anything.

Technically: sub-agents are built with `noExtensions: true` so they never
recursively load this whole extension, but `createAgentSession`'s
`customTools` option hands every one of them these same four tool
definitions directly (see `setManagedTools`/`ensureAgent` in
`agent-runtime.ts`) — each gets a fully-scoped `ExtensionContext` pointing
at *its own* session, so `agent_inspect`/`agent_send`/etc. called from
inside a sub-agent see the same shared pool main does.

## Agent list details

- Agents are named after their first prompt, slugified (lowercase, single
  hyphens); collisions get a letter suffix (`run-tests`, `run-tests-b`, …).
  `main` is always pi's own session, whatever the session name is. Agents
  spawned from a `.pi/agents/*.md` def show a `[<def>]` badge next to their
  name.
- Icons: `✽` Working, `✓` Completed, `✗` Failed, `⊘` Stopped (aborted or
  died mid-turn — `Ctrl+X` now deletes an agent outright instead of leaving
  it Stopped), `∙` Idle.
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
