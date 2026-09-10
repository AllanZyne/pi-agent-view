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
  ↑↓ select · ⏎ attach · type+⏎ new agent · ctrl+x abort · ← close · ? help
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
| `Ctrl+X` | terminate that agent — abort its turn and drop its session (on `main`: pi's interrupt) |
| `Ctrl+L` | model selector for the agent you are looking at |
| `Ctrl+P` / `Shift+Ctrl+P` | cycle the attached agent's model |
| `?` | help |

`↑`/`↓` only drive the list while the prompt is empty, so prompt history still
works as soon as you type.

## Summoning agents

There is **no `/agent` command** — `@<slug>` mentions do the job. `@<slug>` is
a **routing operator**: it addresses an agent by priority, spawning a new
one only as a fallback.

### Position rule (message-start)

Interception only fires when the `@` is at the **start of the message**,
with at most whitespace before it. Any non-whitespace character before `@`
turns it into prose — no interception, no accidental redirect. This is the
difference between *addressing* an agent and *talking about* one:

| you type | what happens |
| --- | --- |
| `@pinger ping 3` | intercept → route/spawn |
| `   @pinger ping 3` | intercept (leading spaces are fine) |
| `let me look at @pinger's config` | prose → goes to main |
| `please @pinger help` | prose → goes to main |
| `first do X, then @pinger take over` | prose → goes to main |

### Slug resolution (once the position check passes)

1. `@agent` — always spawn a new adhoc agent (inherits main's model).
2. **Live agent whose picker name equals the slug** — route to that
   instance. Use this to address a specific running agent by its slug
   (`@review-storage-ts add view-model.ts too`).
3. **Live agents whose `def` equals the slug** — route to the most
   recently active one. Natural `@reviewer` shorthand: "give more work to
   the reviewer I have running".
4. **Catalog def named slug** — spawn a new def-backed agent from
   `.pi/agents/<slug>.md`.
5. Otherwise — not intercepted, message flows to main / the attached agent
   as normal chat.

The whole message goes to the target **verbatim**; the `@` mention is not
stripped, so the target sees who was addressed and multi-mention messages
are safe (the first that resolves wins, the rest are text).

**Attached views work the same way.** If you're attached to agent A and
type `@reviewer next diff`, `A` keeps working on its current task and
`reviewer` gets the new message — spawned or routed as above. The
attached agent is excluded from name/def matching so `@slug` addresses
*another* agent; if the only reachable target would be self, the message
falls through to A as normal chat.

### Escaping a leading `@`

Sometimes you *want* to write `@name` at the start of a message and have
it go to main as plain text — e.g. "the `@pinger` def has a bug". Any of
these work:

- **Backslash**: `\@pinger has a bug` — the `\` is stripped before send,
  so main sees clean `@pinger has a bug`. Slack-style, easiest to type.
- **Backticks**: `` `@pinger` has a bug `` — inline code, most natural in
  code discussion.
- **Quotes**: `"@pinger" is the def name`.

The first form is preserved as-is in the sent message except for the
leading `\`, which is dropped so it doesn't leak into the transcript.

## Sub-agent definitions (`.pi/agents/`)

Drop Markdown files under `.pi/agents/` (project, higher priority) or
`~/.pi/agent/agents/` (user — `getAgentDir()/agents/`, so it moves with
`PI_CODING_AGENT_DIR` or a rebrand) to predefine reusable agents — same idea
as Claude Code's `.claude/agents/`. Format:

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
to pi's base system prompt (via `DefaultResourceLoader.appendSystemPrompt`),
so `AGENTS.md`, skills, prompt templates etc. all still load — the def
supplements, it doesn't replace. `model` (`provider/id` or `inherit`) and
`thinkingLevel` are inheritance defaults for a fresh agent; a revived agent
keeps its own recorded model. Discovery is recursive; project overrides user
on `name` collisions; files without `name`/`description`, with unparseable
YAML, or claiming the reserved `agent` slug are skipped silently (and
listed as diagnostics by `/agents`).

`/agents` force-rescans both scopes and prints what it found; every
`@<name>` interception also rescans, so newly added files show up without
reload.

Don't want to hand-write the frontmatter? This extension ships a
**`create-subagent` skill**: ask pi something like *"create a code-reviewer
subagent"* and the skill walks it through picking a name, description, and
system prompt, then writes the file for you. Run `/skill:create-subagent`
to invoke it explicitly.

**Editor autocomplete:** typing `@` in the editor opens an **agent picker**
(not pi's file picker) while this extension is loaded — the list includes
`agent` and every discovered def, and selecting one inserts `@<name> ` at
the cursor.

Differences from Claude Code's `.claude/agents/`:

| Claude Code | pi-agent-view v1 |
| --- | --- |
| `.claude/agents/` | `.pi/agents/` (project) / `~/.pi/agent/agents/` (user) |
| body **replaces** the system prompt | body **appends** to pi's base prompt |
| `tools`, `disallowedTools`, `hooks`, `mcpServers`, `permissionMode`, `skills`, `isolation`, `color`, `memory`, `effort` | not in v1 |
| built-in Explore/Plan/general-purpose auto-delegation | none — v1 is explicit summoning only |
| `@` completes files | `@` completes agents; pi's file completion is suppressed |

`Ctrl+X` is a hard stop, not a pause: the agent's session is disposed, so
nothing of it keeps running. Its transcript stays on disk, so it stays in the
list as **Stopped** and attaching to it revives it.

Which conversation you are talking to is shown on the editor frame, always, next
to *that conversation's* working state — an idle agent never inherits "Working"
from a busy main session, and a working agent shows it even when main is idle:

```
──────────────────────────────────── ◆ main ────
│ > 
└────────────────────────────────────────────────
```

Agents are named after their first prompt, slugified to lowercase letters and
single hyphens (`agentName()` in `storage.ts`): no spaces, underscores or digits.
Collisions get a letter suffix (`run-tests`, `run-tests-b`, …). pi's own session
is listed as the agent called `main`, whatever the session name is — one flat
list of slugs. Selecting it detaches, exactly like `Esc`. Agents spawned via
`@<name>` show a `[<def>]` badge next to their name in the picker.

| icon | group | meaning |
| --- | --- | --- |
| `✽` | Working | streaming right now |
| `✗` | Failed | the task ended with an error |
| `⊘` | Stopped | not running and never reached a verdict: terminated with `Ctrl+X`, aborted, or died mid-turn |
| `∙` | Idle | nothing has run yet |
| `✓` | Completed | the task finished successfully |

An agent that was killed while a tool was running looks like a turn ending on a
tool call nobody answered, which is why that shape is read as **Stopped** rather
than Completed (`fileStateOf()` in `view-model.ts`) — a hung agent is visible
instead of masquerading as finished.

The list is a **snapshot**, not a live view: rows are built when it is opened (and
when this extension adds or aborts an agent), never on a timer. Building rows
stats every agent file and re-sorts by state, so refreshing while the list is
open burned I/O and reshuffled rows under the cursor. Reopen (`←` twice) to
refresh. Selection is anchored to the selected **agent**, not to a row index
(`reconcileSelection()` / `selectedRow()` in `view-model.ts`), so acting on a
snapshot always hits the agent you were pointing at.

## Models

**Every agent owns its model.** A new agent inherits whatever `main` is using at
spawn time (pinned into its own session right away, so a later `/model` on
`main` does not move it), and from then on the two are independent in both
directions — nothing is ever written to the global default either.

| where | how |
| --- | --- |
| attached | `/model`, `/model <provider/id>`, `Ctrl+L`, `Ctrl+P` |
| picker open | `/model [search]` + `⏎` targets the **selected** row (including `main`) |

pi's built-in `/model` is handled by interactive mode before extensions see it
and always targets pi's own session, so an attached view recognises the command
itself (`parseModelCommand()` in `index.ts`) and runs pi's real
`ModelSelectorComponent` against the agent's own `AgentSession.setModel(model,
{ persist: false })`. The choice lands as a `model_change` entry in that agent's
jsonl, which is also how it survives: `ensureAgent()` passes the inherited model
to `createAgentSession()` **only** when the agent has no recorded model of its
own (`ownSettings()` in `agent-runtime.ts`), so reviving an agent restores its
model instead of resetting it to the main session's. The picker shows a live
agent's current model immediately, without waiting for its next assistant
message.

## Slash commands while attached

pi's own slash-command dispatch never runs while an agent is attached: typed
text (other than `/model`, above) is sent to the agent as a chat message
instead, exactly like typing anything else. Commands that operate on pi's own
session/tree — `/resume`, `/fork`, `/new`, `/tree`, and so on — have no
meaning for an agent, so `/` completion only lists commands actually
implemented for an attached view (`SUPPORTED_ATTACHED_COMMANDS` in
`index.ts`, currently just `/model`) instead of suggesting every pi built-in
as if it would work.

## How it works

### Agents are not pi sessions

pi hosts one *session runtime* per process, and every session-replacing API
(`switchSession`, `newSession`, `fork`) goes through
`AgentSessionRuntime.teardownCurrent()`, which does `await session.abort()` then
`session.dispose()`. Anything hosted by pi's live session is killed when you
navigate away.

So agents are **not** pi sessions here. `agent-runtime.ts` builds each agent as
its own `AgentSession` through the SDK (`createAgentSession` +
`DefaultResourceLoader({ noExtensions: true })`) and keeps them in a pool on
`globalThis`. Switching which agent you look at only changes rendering, so
nothing is ever aborted.

Output is rendered by pi, not by a widget: transcript items are mirrored into
pi's own transcript as custom entries (`pi.appendEntry` +
`pi.registerEntryRenderer`) drawn with `UserMessageComponent`,
`AssistantMessageComponent` and `ToolExecutionComponent`. The only widget is the
agent list.

### The editor frame belongs to the view

pi's working indicator tracks pi's *own* session, so while an agent is attached
the editor's embedded status is replaced by that agent's (`AgentWorkingStatus` in
`index.ts`, a `Loader` that animates exactly like pi's). Otherwise the two leak
into each other in both directions: an idle agent showing "Working" borrowed from
a busy main session, and a working agent showing nothing while main is idle.
`CustomEditor` draws whatever indicator it was handed, so the extension swaps
its own in for the length of one `renderTopBorder()` call rather than
reimplementing pi's border layout.

### Identical to the main session, on purpose

Using pi's components is not enough — they have to be fed what pi feeds them:

| input | why it matters |
| --- | --- |
| `outputPad`, `markdown.codeBlockIndent`, `hideThinkingBlock`, `terminal.showImages`/`imageWidthCells` (read via `SettingsManager`) | body padding, code indentation, thinking blocks and images; a wrong `outputPad` shifts every agent line by a column |
| whole `AssistantMessage` objects, thinking parts included | pi renders text, thinking and stop-reason notices in *one* component with its own spacing — synthesising per-part items cannot reproduce it |
| `Spacer(1)` before a user message | pi separates a user turn from what precedes it |
| pi's **built-in tool renderers** (`withBuiltInRenderers`) | without them a tool call degrades to a bold name plus a raw JSON argument dump; with them `bash` shows `$ ls -la`, `edit` shows a diff, exactly like the main session |
| `options.expanded` from the entry renderer | `Ctrl+O` expands agent tool output too |

The tool renderers live in a package path that pi's `exports` map does not
expose. `tool-renderers.ts` reaches them without guessing an install path, by
walking out of the alias the host already set up for the package entry
(`"@earendil-works/pi-coding-agent/../core/tools/renderers/index.js"`), and
degrades to the generic rendering if that ever fails.

`tests/unit.render.mjs` renders agent items and asserts they are line-for-line
identical to what pi's own components produce for the same messages.

### Transcripts stay separate

One view shows exactly one conversation — the main session's or one agent's,
never a mix. That needs both directions, because pi appends everything to a
single chat container and custom entries are *persisted* (they cannot be removed,
and pi has no API to hide its own messages):

| you are looking at | what draws |
| --- | --- |
| the main session (detached) | pi's own messages; every agent entry renders nothing (`isVisible()` in `view-model.ts`) |
| an agent (attached) | that agent's entries only; pi's own chat children render nothing (`installChatFilter()` in `transcript-view.ts`) |

`installChatFilter()` finds pi's chat container through the TUI tree (the node
holding our entries) and filters *rendering* only: nothing is removed or
reordered, pi keeps mutating its container as usual, and detaching restores the
full main transcript — including whatever the main agent streamed while you were
away. Switching views forces a full repaint since the visible transcript is
replaced wholesale.

An agent view contains **nothing but the agent's own messages** — no header, no
banner, exactly like a fresh session.

Because entries cannot be replayed away either, mirror progress is tracked *per
agent file* (`MirrorState.mirrored[file]`). Re-attaching resumes after the last
item pi already holds instead of appending the transcript a second time; on
session start the counters are rebuilt from the persisted entries.

`/reload` keeps the current view: the session, its chat container and everything
already mirrored into it survive an extension reload, so `session_start` with
`reason: "reload"` does not detach or drop the render filter.

### Storage

Agent sessions live next to the root session but out of `/resume`:

```
<sessionDir>/__agents__/<rootId>/manifest.json
<sessionDir>/__agents__/<rootId>/<agentId>.jsonl
```

`SessionManager.list()` does not descend into `__agents__/`, so only top-level
sessions show up in the session picker. Agents created in an earlier pi run are
revived from disk on demand when you attach to them. `/agent` works from any
agent, not just `main`: the owning root is recovered from the session path, so
new agents always join the same group.

## Layout

| file | role |
| --- | --- |
| `agent-runtime.ts` | in-process concurrent agent pool (headless) |
| `storage.ts` | `__agents__/<rootId>/*.jsonl` + manifest, agent naming (headless) |
| `agent-catalog.ts` | discover `.pi/agents/*.md` sub-agent definitions (headless) |
| `at-mention.ts` | parse `@<slug>` mentions in submitted prompts (headless) |
| `autocomplete.ts` | swap pi's `@` file completion for agent completion (headless) |
| `view-model.ts` | list rows, selection, mirror bookkeeping (headless) |
| `transcript-view.ts` | main-vs-agent transcript separation (headless) |
| `tool-renderers.ts` | pi's built-in tool renderers, for agent tool calls (headless) |
| `index.ts` | rendering, key handling, extension wiring (TUI) |
| `skills/create-subagent/` | packaged skill: walk the user through authoring a new `.pi/agents/*.md` |
| `tests/` | test harness and tests |

Everything except `index.ts` is free of TUI/extension-context dependencies so it
can be tested directly.

## Tests

```sh
node tests/run.mjs          # unit tests, offline, ~1s
node tests/run.mjs --e2e    # also runs real agents (needs model credentials)
```

The harness (`tests/harness.mjs`) loads the extension's TypeScript with jiti —
the same loader pi uses — so there is no build step. It locates the installed pi
package next to the running node binary; override with `PI_PACKAGE_DIR`.

The `--e2e` suite is the interesting one: it starts three real agents, flips the
attached agent every 300 ms while they work, and then asserts that each agent
completed its own multi-step task (marker file + final message), recorded no
error items, is still live and not streaming, and that re-attaching appends only
what is new (never a duplicate, never another agent's item). That is the
executable version of "switching agents interrupts nothing".

## License

MIT
