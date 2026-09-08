# pi-agent-views

Claude Code-style **Agent Views** for [pi](https://pi.dev) — manage multiple agents per session.

## Features

- **Per-session agent management**: Each pi session has its own agent list. The session itself is the "Main" agent; additional agents are sub-sessions stored separately from normal session management.
- **Background execution**: Agents created via `/agent` run in background pi subprocesses. Switch between agents freely — running agents continue in the background.
- **Grouped by state**: Agents are displayed grouped as **Working → Failed → Idle → Completed** with colored icons.
- **Context-aware dispatch**: `/agent <task>` serializes the current conversation, lets the background LLM extract relevant context, and starts the new agent — all without blocking.
- **Real-time refresh**: Agent Views auto-refreshes every 3 seconds while open so you can watch Working → Completed transitions.

## Install

```bash
pi install git:github.com/AllanZyne/pi-agent-views
```

Or for project-local:
```bash
pi install -l git:github.com/AllanZyne/pi-agent-views
```

## Usage

### Open Agent Views

| Method | How |
|--------|-----|
| `←` on empty editor | Toggle Agent Views on/off |
| `/agents` | Toggle via command |
| `Ctrl+Shift+A` | Keyboard shortcut |

### Inside Agent Views

| Key | Action |
|-----|--------|
| `↑/↓` | Navigate agents (when editor is empty) |
| `Enter` (empty) | Attach to selected agent |
| `Enter` (with text) | Dispatch a new agent with that text |
| `→` | Attach to selected agent |
| `←` / `Esc` | Close Agent Views |
| `Space` | Toggle peek panel |
| `?` | Show keyboard help |

### Create agents

**From Agent Views** — type a prompt and press `Enter`:
```
fix the flaky test in auth_test.go
```

**From any agent** — use `/agent` to create with LLM-curated context:
```
/agent based on our analysis, write a fix PR
```
The current conversation is serialized and sent to the background agent along with the task. The LLM extracts relevant context and works on the task — all in the background.

### Per-agent model

Each agent can use a different model. Attach to an agent and use `/model` to change it, just like the main session.

## Architecture

```
~/.pi/agent/sessions/<cwd>/
├── session.jsonl              ← Main session (visible in /resume)
└── __agents__/
    └── <sessionId>/
        ├── manifest.json       ← Agent list metadata
        ├── agent-1.jsonl       ← Sub-agent (hidden from /resume)
        └── agent-2.jsonl
```

- **Main agent** = the session itself (always shown as `[main]`)
- **Sub-agents** = stored in `__agents__/<parentId>/` so `SessionManager.list()` won't discover them
- **Background execution** via detached `pi -p --session <file>` subprocesses
- **State tracking** from background process lifecycle (running → exit code 0/non-zero)

## Agent States

| State | Icon | Color | Meaning |
|-------|------|-------|---------|
| Working | `✽` | Yellow | Background subprocess running |
| Failed | `✗` | Red | Subprocess exited non-zero or LLM error |
| Idle | `∙` | Grey | No background process, waiting |
| Completed | `✓` | Green | Subprocess finished successfully |

## License

MIT
