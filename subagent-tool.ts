/**
 * subagent-tool.ts — an LLM-callable `subagent` tool, wired into the same
 * in-process agent pool as the interactive `@<slug>` picker (agent-runtime.ts
 * / storage.ts / agent-catalog.ts).
 *
 * Without this file, pi-agent-view's concurrency is a *human* affordance
 * only: a person types `@name task` into the prompt editor and at-mention.ts
 * intercepts that keystroke. The assistant itself has no tool call that does
 * the same thing, so from inside a single turn it cannot dispatch parallel
 * sub-agents — it can only ever act as one agent.
 *
 * This tool closes that gap: it lets the model spawn (or route to) one or
 * more sub-agents and await their results, the same way the built-in
 * `examples/extensions/subagent` tool does, but sharing this extension's pool
 * instead of shelling out to a `pi` subprocess per task. That means a
 * spawned agent is a real, live entry in the agent picker (press `←`) while
 * the tool call is still running — a human can attach to it, watch it
 * stream, or steer it, exactly like an agent spawned by `@name`.
 */

import { Type } from "typebox";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { Model } from "@earendil-works/pi-ai";
import { Text } from "@earendil-works/pi-tui";
import { assistantText, getAgent, resolveModelId, runAgentAndWait, type LiveAgent } from "./agent-runtime.ts";
import { loadCatalog, type SubAgentDef } from "./agent-catalog.ts";
import { agentName, listAgentEntries, registerAgent, resolveRoot } from "./storage.ts";

const MAX_TASKS = 8;

const MODEL_DESCRIPTION =
  "Model to run this sub-agent on, as provider/id (e.g. a small/cheap model like a Haiku-class model for a quick, narrow pass, or a large/capable model like a Sonnet-class model for a deep review pass). Overrides both the def's own model and this session's model. Omit to inherit the def's model (if any) or this session's model.";

const TaskItem = Type.Object({
  agent: Type.Optional(
    Type.String({
      description:
        "Name of a sub-agent def from .pi/agents/ or ~/.pi/agent/agents/ (see /agents). Omit for a plain adhoc agent that inherits this session's model.",
    }),
  ),
  task: Type.String({ description: "The task/prompt to send to this sub-agent." }),
  model: Type.Optional(Type.String({ description: MODEL_DESCRIPTION })),
});

const SubagentParams = Type.Object({
  task: Type.Optional(Type.String({ description: "Task for a single sub-agent (single-task shorthand)." })),
  agent: Type.Optional(Type.String({ description: "Def name to pair with `task` (single-task shorthand)." })),
  model: Type.Optional(Type.String({ description: `${MODEL_DESCRIPTION} (single-task shorthand.)` })),
  tasks: Type.Optional(
    Type.Array(TaskItem, {
      description: `One entry per sub-agent, run concurrently. Max ${MAX_TASKS}. Each entry may pick its own \`model\`.`,
    }),
  ),
});

/** The most recent assistant message text in a live agent's transcript. */
function lastAssistantText(agent: LiveAgent): string {
  for (let i = agent.transcript.length - 1; i >= 0; i--) {
    const item = agent.transcript[i]!;
    if (item.kind === "assistant") return assistantText(item.message).trim();
  }
  return "";
}

function isFailed(agent: LiveAgent): boolean {
  return agent.state === "failed" || agent.state === "stopped";
}

export function registerSubagentTool(pi: ExtensionAPI): void {
  pi.registerTool({
    name: "subagent",
    label: "Subagent",
    description: [
      "Delegate one or more tasks to sub-agents that run concurrently in this process, each with its own isolated context window.",
      "Single mode: { task } or { agent, task }. Parallel mode: { tasks: [{ agent?, task, model? }, ...] } — all entries run at the same time.",
      "`agent` selects a def from .pi/agents/ or ~/.pi/agent/agents/ (list them with /agents); omit it for a plain agent that inherits this session's model and default tools.",
      "`model` (provider/id) picks which model runs that sub-agent, e.g. a small/cheap Haiku-class model for a fast, narrow check (eligibility, a quick summary, scoring one issue) versus a large/capable Sonnet-class model for a deep review pass — mix cheap and expensive sub-agents in the same `tasks` array to control cost and latency per task. Overrides the def's own model when both are given. Omit to inherit the def's model, or this session's model.",
      "Every spawned agent is a live entry in this extension's agent picker (press Left) for as long as it lives, so a human can attach, watch it stream, or steer it while this call is in flight.",
      "This call waits for every task to finish and returns each sub-agent's final response.",
    ].join(" "),
    promptSnippet: "Delegate one or more tasks to concurrent sub-agents and wait for their results",
    parameters: SubagentParams,

    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      const root = resolveRoot(ctx.sessionManager.getSessionFile(), ctx.sessionManager.getSessionId());
      if (!root) {
        return {
          content: [
            {
              type: "text",
              text: "This session has no saved file yet, so it cannot own sub-agents. Send one more message, then retry.",
            },
          ],
          isError: true,
        };
      }

      const requested =
        params.tasks && params.tasks.length > 0
          ? params.tasks
          : params.task
            ? [{ agent: params.agent, task: params.task, model: params.model }]
            : [];

      if (requested.length === 0) {
        return {
          content: [{ type: "text", text: "Provide `task` (optionally with `agent`), or `tasks`." }],
          isError: true,
        };
      }
      if (requested.length > MAX_TASKS) {
        return {
          content: [{ type: "text", text: `Too many tasks (${requested.length}). Max is ${MAX_TASKS}.` }],
          isError: true,
        };
      }

      const catalog = loadCatalog(ctx.cwd);
      const unknownDefs = [...new Set(requested.map((t) => t.agent).filter((a): a is string => Boolean(a)))].filter(
        (a) => !catalog.agents.has(a),
      );
      if (unknownDefs.length > 0) {
        const available = [...catalog.agents.keys()].join(", ") || "none";
        return {
          content: [
            { type: "text", text: `Unknown agent def(s): ${unknownDefs.join(", ")}. Available: ${available}.` },
          ],
          isError: true,
        };
      }

      // Resolve every explicitly requested `model` up front so a typo fails
      // the whole call before any agent spawns, instead of silently falling
      // back per task.
      const requestedModelIds = [...new Set(requested.map((t) => t.model).filter((m): m is string => Boolean(m)))];
      const resolvedModels = new Map<string, Model<any> | undefined>();
      for (const id of requestedModelIds) {
        resolvedModels.set(id, await resolveModelId(id));
      }
      const unknownModels = requestedModelIds.filter((id) => !resolvedModels.get(id));
      if (unknownModels.length > 0) {
        return {
          content: [
            {
              type: "text",
              text: `Unknown or unavailable model(s): ${unknownModels.join(", ")}. Use \`provider/id\` for a model with auth configured in this pi install (see /model or settings.json).`,
            },
          ],
          isError: true,
        };
      }

      // Slugs must not collide with each other or with agents already in
      // this root's manifest — same naming rule the `@<slug>` picker uses.
      const existingNames = listAgentEntries(root, (f) => getAgent(f) !== undefined).map((a) => a.name);
      const spawned = requested.map((t) => {
        const def: SubAgentDef | undefined = t.agent ? catalog.agents.get(t.agent) : undefined;
        const forcedModel = t.model ? resolvedModels.get(t.model) : undefined;
        const name = agentName(t.task, existingNames);
        existingNames.push(name);
        const file = registerAgent(root, name, ctx.cwd, def?.name);
        return { name, file, task: t.task, def, modelId: t.model, forcedModel };
      });

      const results = await Promise.all(
        spawned.map(async (s) => {
          const agent = await runAgentAndWait(
            s.file,
            s.task,
            ctx.cwd,
            ctx.model,
            ctx.thinkingLevel,
            s.def,
            s.forcedModel,
          );
          return { ...s, agent };
        }),
      );

      const summaries = results.map(({ name, def, modelId, task, agent }) => {
        const tags = [def?.name, modelId ?? agent.session.model?.id].filter(Boolean);
        const label = tags.length > 0 ? `${name} [${tags.join(" · ")}]` : name;
        const failed = isFailed(agent);
        const status = failed ? `failed${agent.error ? `: ${agent.error}` : ""}` : "completed";
        const output = lastAssistantText(agent) || "(no output)";
        return `### ${label} — ${status}\n\nTask: ${task}\n\n${output}`;
      });

      const successCount = results.filter(({ agent }) => !isFailed(agent)).length;
      const header =
        results.length === 1
          ? undefined
          : `${successCount}/${results.length} sub-agent(s) succeeded.\n\n`;

      return {
        content: [{ type: "text", text: `${header ?? ""}${summaries.join("\n\n---\n\n")}` }],
        details: {
          agents: results.map((r) => ({
            name: r.name,
            file: r.file,
            def: r.def?.name,
            model: r.modelId ?? r.agent.session.model?.id,
            state: r.agent.state,
          })),
        },
        isError: successCount === 0,
      };
    },

    renderCall(args, theme) {
      const tasks: Array<{ agent?: string; task: string; model?: string }> =
        args.tasks && args.tasks.length > 0
          ? args.tasks
          : args.task
            ? [{ agent: args.agent, task: args.task, model: args.model }]
            : [];
      let text =
        theme.fg("toolTitle", theme.bold("subagent ")) +
        theme.fg("accent", `${tasks.length} task${tasks.length === 1 ? "" : "s"}`);
      for (const t of tasks.slice(0, 3)) {
        const preview = t.task.length > 50 ? `${t.task.slice(0, 50)}...` : t.task;
        const tags = [t.agent, t.model].filter(Boolean).join(" · ");
        text += `\n  ${tags ? theme.fg("accent", `[${tags}] `) : ""}${theme.fg("dim", preview)}`;
      }
      if (tasks.length > 3) text += `\n  ${theme.fg("muted", `... +${tasks.length - 3} more`)}`;
      return new Text(text, 0, 0);
    },

    renderResult(result, _opts, theme) {
      const text = result.content[0];
      const body = text?.type === "text" ? text.text : "(no output)";
      const icon = result.isError ? theme.fg("error", "✗") : theme.fg("success", "✓");
      return new Text(`${icon} ${theme.fg("dim", body)}`, 0, 0);
    },
  });
}
