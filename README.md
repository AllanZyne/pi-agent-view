# pi-agent-views

Concurrent sub-agents for [pi](https://pi.dev), each rendered by pi itself.

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
pi install git:github.com/AllanZyne/pi-agent-views
```

## Usage

| key | effect |
| --- | --- |
| `←` | open/close the agent list (empty prompt only) |
| `↑` `↓` | move the selection (empty prompt only) |
| `Enter` / `→` | attach to the selected agent |
| `Enter` + text | list open: new agent with that first prompt · attached: steer the agent |
| `Esc` | detach — back to `main`, the agent keeps running |
| `Ctrl+X` | abort that agent's current turn |
| `Ctrl+L` | model selector for the agent you are looking at |
| `Ctrl+P` / `Shift+Ctrl+P` | cycle the attached agent's model |
| `?` | help |

`↑`/`↓` only drive the list while the prompt is empty, so prompt history still
works as soon as you type.

The one command is `/agent <task>`: it starts a background agent and returns
immediately, without leaving or interrupting the session you are in (extension
commands are dispatched before pi's streaming guard, so it works mid-response).

Which conversation you are talking to is shown on the editor frame, always:

```
──────────────────────────────────── ◆ main ────
│ > 
└────────────────────────────────────────────────
```

Agents are named after their first prompt, slugified to lowercase letters and
single hyphens (`agentName()` in `storage.ts`): no spaces, underscores or digits.
Collisions get a letter suffix (`run-tests`, `run-tests-b`, …). pi's own session
is listed as the agent called `main`, whatever the session name is — one flat
list of slugs. Selecting it detaches, exactly like `Esc`.

| icon | state |
| --- | --- |
| `✽` | working — streaming right now |
| `✗` | failed |
| `∙` | idle |
| `✓` | completed |

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
| `view-model.ts` | list rows, selection, mirror bookkeeping (headless) |
| `transcript-view.ts` | main-vs-agent transcript separation (headless) |
| `tool-renderers.ts` | pi's built-in tool renderers, for agent tool calls (headless) |
| `index.ts` | rendering, key handling, extension wiring (TUI) |
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
