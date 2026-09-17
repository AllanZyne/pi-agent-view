/**
 * agent-create-tool.ts — an LLM-callable `agent_create` tool, wired into the
 * same in-process agent pool as `agent-inspect-tool.ts` /
 * `agent-control-tool.ts` (agent-runtime.ts / storage.ts / agent-catalog.ts).
 *
 * This is the "create" side of agent management (`agent_send` messages an
 * existing one, `agent_inspect` reads one, `agent_remove` deletes one): it
 * lets the model spawn one or more sub-agents and await their results,
 * similar to the built-in `examples/extensions/subagent` tool, but sharing
 * this extension's pool instead of shelling out to a `pi` subprocess per
 * task. That means a spawned agent is a real, live entry in the agent
 * picker (press `←`) while the tool call is still running — a human can
 * attach to it, watch it stream, or steer it, exactly like an agent spawned
 * by a human.
 *
 * Exported as a plain `agentCreateTool` (not just a `pi.registerTool(...)`
 * wrapper) so `index.ts` can both register it for main *and* hand it to
 * every sub-agent as a `customTool` (see `agent-runtime.ts`'s
 * `setManagedTools`/`ensureAgent`) — every agent gets the same delegation
 * power, to any depth.
 */

import { Type } from "typebox";
import { defineTool, type ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { Model } from "@earendil-works/pi-ai";
import { Text } from "@earendil-works/pi-tui";
import { assistantText, getAgent, resolveModelSearch, runAgent, runAgentAndWait, type LiveAgent } from "./agent-runtime.ts";
import { loadCatalog, type SubAgentDef } from "./agent-catalog.ts";
import {
  agentName,
  assertAgentCapacity,
  listAgentEntries,
  MAX_AGENTS_PER_SESSION,
  registerAgent,
  resolveRoot,
} from "./storage.ts";

const MAX_TASKS = 8;

const MODEL_DESCRIPTION =
  "Model to run this sub-agent on: a full provider/id, a bare id, or any short case-insensitive substring that uniquely matches one available model's id (e.g. 'opus', 'haiku', 'sonnet'). Overrides both the def's own model and this session's model. Omit to inherit the def's model (if any) or this session's model.";

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

const AgentCreateParams = Type.Object({
  task: Type.Optional(Type.String({ description: "Task for a single sub-agent (single-task shorthand)." })),
  agent: Type.Optional(Type.String({ description: "Def name to pair with `task` (single-task shorthand)." })),
  model: Type.Optional(Type.String({ description: `${MODEL_DESCRIPTION} (single-task shorthand.)` })),
  tasks: Type.Optional(
    Type.Array(TaskItem, {
      description: `One entry per sub-agent, run concurrently. Max ${MAX_TASKS}. Each entry may pick its own \`model\`.`,
    }),
  ),
  wait: Type.Optional(
    Type.Boolean({
      description:
        "Wait for every task to finish and return each sub-agent's final response. Default true. Set to false to fire-and-forget: returns immediately after spawning (with each agent's name so you can address it later), without blocking this turn on any of them — use agent_inspect to check progress/output, or agent_send to give a spawned-but-not-yet-finished agent more instructions.",
    }),
  ),
});

/**
 * The model catalog only knows `provider/id` model ids. Some models
 * (mis)read the "omit to inherit" wording in the tool/param descriptions as
 * license to pass the literal string `"inherit"` instead of actually
 * omitting the field. Normalize that (and empty-string) back to "omitted"
 * before it ever reaches `resolveModelSearch`, so it inherits as intended
 * instead of failing with "Unknown or unavailable model(s): inherit".
 */
function normalizeModelParam(model: string | undefined): string | undefined {
  if (!model) return undefined;
  const trimmed = model.trim();
  return trimmed && trimmed.toLowerCase() !== "inherit" ? trimmed : undefined;
}

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

export const agentCreateTool = defineTool({
  name: "agent_create",
  label: "Agent create",
  description: [
    "Delegate one or more tasks to sub-agents that run concurrently in this process, each with its own isolated context window.",
    `A root session may retain at most ${MAX_AGENTS_PER_SESSION} sub-agents across all delegation depths.`,
    "Single mode: { task } or { agent, task }. Parallel mode: { tasks: [{ agent?, task, model? }, ...] } — all entries run at the same time.",
    "`agent` selects a def from .pi/agents/ or ~/.pi/agent/agents/ (list them with /agents); omit it for a plain agent that inherits this session's model and default tools.",
    "`model` selects the model and overrides the def's model when both are given; omit it to inherit the def's model, or this session's model.",
    "Use this to *create* a sub-agent. To message, inspect, or delete an *existing* one by name, use `agent_send` / `agent_inspect` / `agent_remove` instead.",
    "Every spawned agent is a live entry in this extension's agent picker (press Left) for as long as it lives, so a human can attach, watch it stream, or steer it while this call is in flight.",
    "By default this call waits for every task to finish and returns each sub-agent's final response. Set `wait: false` to fire-and-forget instead — spawn and return immediately without blocking this turn, then use `agent_inspect`/`agent_send` afterward to check on or continue any of them.",
  ].join(" "),
  promptSnippet: "Delegate one or more tasks to concurrent sub-agents, optionally waiting for their results",
  parameters: AgentCreateParams,

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

    const requested = (
      params.tasks && params.tasks.length > 0
        ? params.tasks
        : params.task
          ? [{ agent: params.agent, task: params.task, model: params.model }]
          : []
    ).map((t) => ({ ...t, model: normalizeModelParam(t.model) }));

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
        content: [{ type: "text", text: `Unknown agent def(s): ${unknownDefs.join(", ")}. Available: ${available}.` }],
        isError: true,
      };
    }

    // Resolve every explicitly requested `model` up front so a typo fails
    // the whole call before any agent spawns, instead of silently falling
    // back per task.
    const requestedModelTokens = [...new Set(requested.map((t) => t.model).filter((m): m is string => Boolean(m)))];
    const resolvedModels = new Map<string, Model<any>>();
    const modelErrors: string[] = [];
    for (const token of requestedModelTokens) {
      const result = await resolveModelSearch(token);
      if (result.ok) resolvedModels.set(token, result.model);
      else if (result.reason === "ambiguous") {
        modelErrors.push(`"${token}" matches multiple models: ${result.candidates.join(", ")}`);
      } else {
        modelErrors.push(`Unknown model "${token}"`);
      }
    }
    if (modelErrors.length > 0) {
      return {
        content: [
          {
            type: "text",
            text: `${modelErrors.join("; ")}. Use provider/id, or a shorter unique substring (see /model).`,
          },
        ],
        isError: true,
      };
    }

    // Re-check immediately before the synchronous registration block. Model
    // resolution above awaits, so another agent_create call may have consumed
    // slots since this call began. Checking the whole batch here keeps this
    // request all-or-none; registerAgent also enforces the limit defensively
    // for direct picker creation and other callers.
    try {
      assertAgentCapacity(root, requested.length);
    } catch (err) {
      return {
        content: [{ type: "text", text: err instanceof Error ? err.message : String(err) }],
        isError: true,
      };
    }

    // Slugs must not collide with each other or with agents already in
    // this root's manifest — same naming rule the picker uses.
    const existingNames = listAgentEntries(root, (f) => getAgent(f) !== undefined).map((a) => a.name);
    const spawned = requested.map((t) => {
      const def: SubAgentDef | undefined = t.agent ? catalog.agents.get(t.agent) : undefined;
      const forcedModel = t.model ? resolvedModels.get(t.model) : undefined;
      const name = agentName(t.task, existingNames);
      existingNames.push(name);
      const file = registerAgent(root, name, ctx.cwd, def?.name);
      return { name, file, task: t.task, def, modelId: t.model, forcedModel };
    });

    if (params.wait === false) {
      // Fire-and-forget: start every task without waiting for any of them,
      // and return as soon as they're all registered/started. `runAgent`
      // (unlike `runAgentAndWait`) resolves once the agent session exists
      // and the prompt has been *sent*, not once it's *answered* — that's
      // what makes this non-blocking.
      const started = await Promise.allSettled(
        spawned.map((s) => runAgent(s.file, s.task, ctx.cwd, ctx.model, ctx.thinkingLevel, s.def, s.forcedModel)),
      );
      const lines = spawned.map((s, i) => {
        const tags = [s.def?.name, s.modelId ?? s.forcedModel?.id].filter(Boolean);
        const label = tags.length > 0 ? `${s.name} [${tags.join(" · ")}]` : s.name;
        const outcome = started[i]!;
        return outcome.status === "fulfilled"
          ? `- ${label} — started, running in the background`
          : `- ${label} — failed to start: ${String(outcome.reason)}`;
      });
      const failCount = started.filter((r) => r.status === "rejected").length;
      return {
        content: [
          {
            type: "text",
            text: `${lines.join("\n")}\n\nNot waiting for any of these — use agent_inspect to check on them, or agent_send to give one more instructions.`,
          },
        ],
        details: {
          agents: spawned.map((s) => ({ name: s.name, file: s.file, def: s.def?.name, model: s.modelId ?? s.forcedModel?.id })),
        },
        isError: failCount === spawned.length,
      };
    }

    const results = await Promise.all(
      spawned.map(async (s) => {
        const agent = await runAgentAndWait(s.file, s.task, ctx.cwd, ctx.model, ctx.thinkingLevel, s.def, s.forcedModel);
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
    const header = results.length === 1 ? undefined : `${successCount}/${results.length} sub-agent(s) succeeded.\n\n`;

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
      theme.fg("toolTitle", theme.bold("agent_create ")) +
      theme.fg("accent", `${tasks.length} task${tasks.length === 1 ? "" : "s"}`) +
      (args.wait === false ? theme.fg("accent", " [no-wait]") : "");
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

export function registerAgentCreateTool(pi: ExtensionAPI): void {
  pi.registerTool(agentCreateTool);
}
