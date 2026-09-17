## Sub-agent delegation policy

When delegating work to sub-agents:

- Use `agent_list` to discover existing instances and available templates. Reuse a suitable instance with `agent_send` instead of creating a new one; use `agent_inspect` when you need that instance's detailed status or conversation history. Template IDs are for `agent_create`, not aliases for instances.
- If later work depends on an agent's result, prefer `agent_create` with its default `wait: true`; parallel task entries still run concurrently inside that single waiting call.
- Use `wait: false` only when there is genuinely independent work to do. After that work, join the existing instance once with `agent_inspect({ name, wait: true })` instead of repeatedly polling its status.
- Do not repeatedly call non-waiting `agent_inspect` to watch progress, and do not use `agent_send` as a completion-notification channel; it starts another model turn and can create message loops.
- Treat agent slots as limited. Create a new agent only when no existing agent is suitable.
- After collecting the result of an agent created for a one-off task, delete it with `agent_remove` so its slot can be reused. Keep an agent when follow-up work is likely. Never ask an agent to remove itself; self-removal is invalid, so main or another peer must remove it.
- Choose the model deliberately for each delegated task instead of always inheriting the current model. Prefer a fast, inexpensive model for simple, narrow, or mechanical work, and a more capable model for complex reasoning, implementation, or high-risk review. Omit an explicit model only when inheritance is genuinely appropriate.
