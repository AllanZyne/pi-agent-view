---
name: create-agent
description: Author a reusable agent template file for pi-agent-view under .pi/agents/ (project) or ~/.pi/agent/agents/ (user). Use when the user asks to create, add, define, or design a new (sub-)agent — for example "create a agent", "create an agent", "create a code-reviewer subagent", or "add an agent that writes commit messages". Gathers a name, description, and system-prompt body, optionally a model, writes the .md file, and shows how to invoke it via the `agent_create` tool.
---

# Create an agent template

pi-agent-view discovers agent templates under three roots (highest
priority first):

- `<cwd>/.pi/agents/**/*.md` — **project scope** (checked into the repo, shared with the team; highest priority)
- `~/.pi/agent/agents/**/*.md` — **user scope** (personal, available in every project; this is `getAgentDir()/agents/`, so it follows `$PI_CODING_AGENT_DIR` if the user has overridden or rebranded it — do not assume the literal `~/.pi/agent/` path without checking)
- `<pi-agent-view's own install dir>/agents/**/*.md` — **extension scope**, lowest priority. These ship *inside* the pi-agent-view package itself (e.g. `btw`, a read-only Q&A agent) and are the same for every project/user regardless of `cwd` or `$PI_CODING_AGENT_DIR`. This skill only ever writes to project or user scope — never write here; it's for defs bundled with the extension's own source.

Each file is Markdown with YAML frontmatter. The body is *appended* to pi's
base system prompt (supplement, not replace), so `AGENTS.md`, skills and
prompt templates all still load.

Users invoke these just by asking naturally — e.g. "have the code-reviewer
take a look at storage.ts" — and whichever LLM is listening calls the
`agent_create` tool with `template: "code-reviewer"` itself. There is no
`@name` routing syntax: `@` is editor autocomplete only: `@agent:<name> `
selects a template and `@<instance> ` refers to a live instance.

## Your job

When the user asks to create a new sub-agent:

1. **Understand what they want the agent to do.** If their request is one
   line, ask one or two focused follow-ups — never a wall of questions. What
   task, what tone, what to focus on, what to avoid. Skip this step entirely
   if the request is already specific.
2. **Pick a scope.** Default to **project** (`<cwd>/.pi/agents/`) when the
   agent is codebase-specific (references files in this repo, this project's
   conventions, this team's checklist). Default to **user**
   (`~/.pi/agent/agents/`, i.e. `getAgentDir()/agents/`) when it's a generic
   role the user would use anywhere. If unclear, ask once. Never write to
   both.
3. **Draft a template ID.** Lowercase letters, digits, hyphens; starts with a
   letter; 2–3 words max. Examples: `code-reviewer`, `commit-writer`,
   `security-auditor`. Reject `agent` — it is the namespace marker for
   template mentions (`@agent:<name>`), and accepting it would produce the
   confusing `@agent:agent` spelling.
4. **Draft a description.** One sentence, present tense, third-person. Say
   *what it does* and *when to invoke it*. This shows up in `/agents`, in
   the `@`-completion picker, and is the main thing an LLM has to go on when
   deciding whether to call `agent_create` with this template — keep it short
   and specific. Bad: "Helps with code." Good: "Reviews Python diffs for
   correctness, style, and obvious bugs. Invoke after writing or changing
   code."
5. **Draft the system-prompt body.** This is the interesting part. See
   [Writing a good system prompt](#writing-a-good-system-prompt) below.
6. **Optional fields.** Only include `model` or `thinkingLevel` when the
   user has a real reason; otherwise omit them (the agent inherits main's
   model at spawn time, which is what most people want).
7. **Write the file** with the `write` tool at the chosen path. For user
   scope, resolve the actual directory instead of assuming the literal
   `~/.pi/agent/agents/` — check `$PI_CODING_AGENT_DIR` first (e.g. `echo
   $PI_CODING_AGENT_DIR`); if unset, it's `~/.pi/agent/agents/`. Do not
   overwrite an existing file without confirming.
8. **Verify** by asking the user to run `/agents` — it force-rescans both
   roots and prints what it found — and tell them how to invoke it: just
   ask naturally (e.g. "have `<name>` look at this"), or explicitly with
   `@agent:<name> <the task>` if they want the autocomplete's help typing the
   template ID. Also worth mentioning once, per session: to continue talking to an
   *already-running* instance instead of spawning a duplicate, the calling
   LLM should use `agent_send` by that instance's name, not its template ID.

## Frontmatter reference

Only `name` and `description` are required.

```yaml
---
name: code-reviewer                          # required, [a-z][a-z0-9-]*, not "agent"
description: One sentence: what + when.      # required
model: anthropic/claude-sonnet-4-5           # optional; provider/id or "inherit"
thinkingLevel: medium                        # optional; off | low | medium | high
---
```

Unsupported fields (silently ignored — do NOT add them, listing them just to
tell the user what pi-agent-view v1 does *not* implement):
`tools`, `disallowedTools`, `hooks`, `mcpServers`, `permissionMode`,
`skills`, `isolation`, `cwd`, `color`, `memory`, `effort`.

## Writing a good system prompt

The body becomes the sub-agent's system prompt supplement. It should read
like an instruction to a specialist, not like a description of one. Keep it
under ~40 lines unless the user explicitly wants a heavy prompt.

A solid structure:

```markdown
You are a <role>. Your job is to <one-sentence purpose>.

When invoked:

1. <first concrete step>
2. <second concrete step>
3. <third concrete step>

Focus on:
- <specific thing 1>
- <specific thing 2>

Avoid:
- <specific thing 1>
- <specific thing 2>

Output format:
<what the reply should look like — bullets, sections, one paragraph, a diff, …>
```

Rules of thumb:

- **Address the model directly** ("You are …", "When invoked, …") rather
  than describing it in third person.
- **Be specific about the domain.** "Reviews TypeScript code" beats "reviews
  code". If the project has a language or framework, name it.
- **Say what to skip.** "Do not comment on formatting; a formatter handles
  it." "Do not restate the code back to the user." Negative examples save
  more tokens than any positive one.
- **Pin the output shape.** Reviewers should return a bulleted list of
  issues. Commit writers should return a single line. Explainers should
  return one paragraph, no headings. Ambiguity here is the top cause of
  disappointing sub-agent output.
- Don't repeat what's already in `AGENTS.md` / project context files. Those
  load automatically for sub-agents too. The body is a *supplement*.
- Don't reference `main`'s conversation. The sub-agent has its own context
  and won't see it.

## Worked example

User: *"make a subagent that reviews my Python diffs"*

Follow-up (one question): *"For this project, or a personal one across all
your Python work? And any specific things to focus on — security, perf,
type hints?"*

User: *"personal, focus on type hints and obvious bugs"*

Write `~/.pi/agent/agents/py-reviewer.md`:

```markdown
---
name: py-reviewer
description: Reviews Python diffs with a focus on type hints and obvious bugs. Invoke after writing or changing Python code.
---

You are a strict Python reviewer. Your job is to catch obvious bugs and
type-hint problems in the diff the user shows you.

When invoked:

1. Read the code the user references.
2. Check every function signature for missing or wrong type hints. Prefer
   `X | None` over `Optional[X]`. Flag `Any` unless it's justified.
3. Look for bugs a linter would miss: off-by-one, mutable default
   arguments, unreachable branches, silently-swallowed exceptions,
   comparison with `is` where `==` was meant, `range(len(...))` where
   `enumerate` would do.
4. Ignore formatting, import order, and docstring style — a formatter and
   the user's editor handle those.

Output format: a bulleted list of concrete issues. For each: the file and
line, one sentence describing the problem, and a suggested fix in one line
or a small code block. If there are no issues, say so in one sentence.
```

Then tell the user: *"Written to `~/.pi/agent/agents/py-reviewer.md`. Run
`/agents` to confirm pi-agent-view sees it, then just ask for it naturally
(e.g. `@agent:py-reviewer take a look at this diff`, or plain 'have py-reviewer
review this') — the LLM will call `agent_create` with `template:
"py-reviewer"`."*

## Guardrails

- If the slug already exists in the same scope, either pick a different
  slug or ask before overwriting. Use `read` on the target path first.
- Never write to a file path outside `.pi/agents/` or `~/.pi/agent/agents/`
  (the latter is `getAgentDir()/agents/` — resolve it, don't hardcode the
  literal path, in case `PI_CODING_AGENT_DIR` is set).
- Never invent fields the user asked about that aren't in the frontmatter
  reference above — reply with the unsupported-fields list instead.
- If the user says "and give it access to bash / restrict it to read-only /
  hook it up to MCP", tell them tool restrictions and MCP aren't supported
  in pi-agent-view v1 yet, and ask whether they still want the def with
  those wishes captured as a comment in the body (a `# Notes` section) or
  in the description.
