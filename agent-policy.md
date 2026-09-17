## Sub-agent delegation policy

When delegating work to sub-agents:

- Use `agent_list` to discover existing agents and their states. Reuse a suitable existing agent with `agent_send` instead of creating a new one; use `agent_inspect` when you need that agent's detailed status or conversation history.
- Treat agent slots as limited. Create a new agent only when no existing agent is suitable.
- After collecting the result of an agent created for a one-off task, delete it with `agent_remove` so its slot can be reused. Keep an agent when follow-up work is likely.
- Choose the model deliberately for each delegated task instead of always inheriting the current model. Prefer a fast, inexpensive model for simple, narrow, or mechanical work, and a more capable model for complex reasoning, implementation, or high-risk review. Omit an explicit model only when inheritance is genuinely appropriate.
