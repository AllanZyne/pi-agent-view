# pi-agent-views

Run and manage multiple agents inside one [pi](https://pi.dev) session — every agent
natively rendered, all of them genuinely concurrent.

Press `←` on an empty prompt to open the agent list. Attach to any agent and you get
pi's real interface: live streaming, markdown, tool rendering, footer stats, `/compact`,
`/tree`, `Ctrl+O`. Switching agents never interrupts anything — a background agent keeps
working while you look at another one.

```
  ◆ Agents  3 agents · 1 working
  ──────────────────────────────────────────────────────────
  Working (1)
   ▸ ✽ write the fix PR                                  2m
       4 msgs · claude-sonnet-4-5   Opening a branch and…

  Idle (1)
     ∙ Main [main] (attached)                            9m
       27 msgs · claude-sonnet-4-5

  Completed (1)
     ✓ update the unit tests                             6m
       9 msgs · claude-sonnet-4-5   Updated 12 test files.
  ──────────────────────────────────────────────────────────
  ↑↓ select · ⏎ attach · type+⏎ new agent · ctrl+x abort · ← close · ? help
```

## Requirements

Needs pi's concurrent-session API (`ctx.spawnSession` / `ctx.activateSession`). Without
it, agents cannot run in parallel and this extension will not work.

## Install

```bash
pi install git:github.com/AllanZyne/pi-agent-views
```

## Usage

### The agent list

Press `←` on an empty prompt.

| Key | Action |
|-----|--------|
| `↑` `↓` | Select an agent |
| `Enter` / `→` | Attach to the selected agent |
| type text + `Enter` | Spawn a new agent with that text as its first prompt |
| `Ctrl+X` | Abort the selected agent's current turn |
| `←` / `Esc` | Close |
| `?` | Help |

`↑`/`↓` only drive the list while the prompt is empty, so prompt history still works as
soon as you type.

### Delegating without leaving

```
/agent write the fix PR based on what we just found
```

Spawns a background agent, hands it the task, and returns immediately. You stay exactly
where you are and your current turn is not interrupted — extension commands are
dispatched before pi's streaming guard, so this works mid-response.

### Agent state

| Icon | State |
|------|-------|
| `✽` | Working — the agent is streaming right now |
| `✗` | Failed |
| `∙` | Idle |
| `✓` | Completed |

The list groups by state (working first) and refreshes while open, so you can watch a
background agent go from Working to Completed without attaching to it.

### Model per agent

A new agent inherits the model of the agent that spawned it. To change it, attach and use
`/model` — the same as anywhere else in pi.

## How it works

Every agent is a real pi session in the same process:

```
pi process
├── Main            ← the session pi started with
├── agent 1         ← concurrent, own turn loop, own JSONL
└── agent 2         ← concurrent
```

Attaching calls `ctx.activateSession(key)`, which swaps only which session owns the TUI.
The outgoing session is retained and keeps running: nothing is aborted, shut down, or
disposed. That is why background work survives switching, and why the transcript is
pi's own rather than something this extension draws.

Sub-agent sessions are stored separately so they stay out of `/resume`:

```
<sessionDir>/__agents__/<rootId>/manifest.json
<sessionDir>/__agents__/<rootId>/<agentId>.jsonl
```

`SessionManager.list()` does not descend into `__agents__/`, so only your top-level
sessions show up in the session picker. Agents created in an earlier pi run are revived
from disk on demand when you attach to them.

`/agent` works from any agent, not just Main: the owning root is recovered from the
session path, so new agents always join the same group.

## License

MIT
