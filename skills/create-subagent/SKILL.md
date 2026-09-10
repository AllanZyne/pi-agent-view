---
name: create-subagent
description: Author a new sub-agent definition file for pi-agent-view under .pi/agents/ (project) or ~/.pi/agents/ (user). Use when the user asks to create, add, define, or design a new sub-agent — for example "create a code-reviewer subagent" or "add an agent that writes commit messages". Gathers a name, description, and system-prompt body, optionally a model, writes the .md file, and shows how to summon it with @name.
---

# Create a sub-agent definition

pi-agent-view discovers sub-agent definitions under two roots:

- `<cwd>/.pi/agents/**/*.md` — **project scope** (checked into the repo, shared with the team; higher priority)
- `~/.pi/agents/**/*.md` — **user scope** (personal, available in every project)

Each file is Markdown with YAML frontmatter. The body is *appended* to pi's
base system prompt (supplement, not replace), so `AGENTS.md`, skills and
prompt templates all still load.

Users summon these by putting `@<name>` anywhere in a prompt, e.g.
`@code-reviewer take a look at storage.ts`.

## Your job

When the user asks to create a new sub-agent:

1. **Understand what they want the agent to do.** If their request is one
   line, ask one or two focused follow-ups — never a wall of questions. What
   task, what tone, what to focus on, what to avoid. Skip this step entirely
   if the request is already specific.
2. **Pick a scope.** Default to **project** (`<cwd>/.pi/agents/`) when the
   agent is codebase-specific (references files in this repo, this project's
   conventions, this team's checklist). Default to **user** (`~/.pi/agents/`)
   when it's a generic role the user would use anywhere. If unclear, ask
   once. Never write to both.
3. **Draft a slug.** Lowercase letters, digits, hyphens; starts with a
   letter; 2–3 words max. Examples: `code-reviewer`, `commit-writer`,
   `security-auditor`. Reject `agent` (reserved by pi-agent-view for the
   adhoc spawn form `@agent <task>`). Also avoid common English words the
   user might write conversationally at the start of a message
   (`help`, `test`, `note`, `todo`) — the slug becomes an `@<slug>`
   routing address, and a message that starts with such a word would
   otherwise get hijacked. Prose *containing* the slug is fine because
   the interception rule is message-start only, but a bare
   "help me with X" would still route to `@help`.
4. **Draft a description.** One sentence, present tense, third-person. Say
   *what it does* and *when to invoke it*. This shows up in `/agents` and in
   the `@`-completion picker, so keep it short and specific. Bad:
   "Helps with code." Good: "Reviews Python diffs for correctness, style,
   and obvious bugs. Invoke after writing or changing code."
5. **Draft the system-prompt body.** This is the interesting part. See
   [Writing a good system prompt](#writing-a-good-system-prompt) below.
6. **Optional fields.** Only include `model` or `thinkingLevel` when the
   user has a real reason; otherwise omit them (the agent inherits main's
   model at spawn time, which is what most people want).
7. **Write the file** with the `write` tool at the chosen path. Do not
   overwrite an existing file without confirming.
8. **Verify** by asking the user to run `/agents` — it force-rescans both
   roots and prints what it found — and show them the invocation form:
   `@<name> <the task>`. Also worth mentioning once, per session: the
   same `@<name>` prefix will **route to the running agent** the second
   time it's used (once one is live), instead of spawning a duplicate.

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

Write `~/.pi/agents/py-reviewer.md`:

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

Then tell the user: *"Written to `~/.pi/agents/py-reviewer.md`. Run
`/agents` to confirm pi-agent-view sees it, then summon it with
`@py-reviewer <diff or file to review>` anywhere in your prompt."*

## Guardrails

- If the slug already exists in the same scope, either pick a different
  slug or ask before overwriting. Use `read` on the target path first.
- Never write to a file path outside `.pi/agents/` or `~/.pi/agents/`.
- Never invent fields the user asked about that aren't in the frontmatter
  reference above — reply with the unsupported-fields list instead.
- If the user says "and give it access to bash / restrict it to read-only /
  hook it up to MCP", tell them tool restrictions and MCP aren't supported
  in pi-agent-view v1 yet, and ask whether they still want the def with
  those wishes captured as a comment in the body (a `# Notes` section) or
  in the description.
