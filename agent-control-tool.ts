/**
 * agent-control-tool.ts — LLM-callable `agent_send` and `agent_remove`
 * tools: the "message an existing one" and "delete one" halves of agent
 * management (`agent_create` creates; `agent_inspect` reads without touching
 * anything).
 *
 * Deliberately strict, not merged into one do-everything tool: `agent_send`
 * never creates — if `name` doesn't resolve to a known sub-agent it errors
 * out and points at `agent_create`, rather than guessing whether the caller
 * meant "message this" or "create this". The calling model decides which
 * tool matches the user's intent; these tools don't second-guess it.
 */

import { Type } from "typebox";
import { defineTool, type ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { Model } from "@earendil-works/pi-ai";
import { Text } from "@earendil-works/pi-tui";
import {
  assistantText,
  ensureAgent,
  forgetAgent,
  getAgent,
  modelOf,
  resolveModelSearch,
  runAgentAndWait,
  setAgentModel,
  stateOf,
  steerAgent,
  type LiveAgent,
} from "./agent-runtime.ts";
import { loadCatalog } from "./agent-catalog.ts";
import { resolveEntry } from "./agent-lookup.ts";
import { listAgentEntries, removeAgentEntry, resolveRoot, ROOT_AGENT_NAME, templateId, type AgentEntry } from "./storage.ts";

const MODEL_DESCRIPTION =
  "Switch the agent's model before delivering the message: a full provider/id, a bare id, or any short case-insensitive substring that uniquely matches one available model's id (e.g. 'opus'). Omit to leave its current model alone.";

function unknownAgentError(name: string, entries: readonly AgentEntry[]) {
  const available = entries.map((e) => e.name).join(", ") || "none";
  const main = name.trim().toLowerCase() === ROOT_AGENT_NAME ? " (main is not a sub-agent and can't be addressed this way)" : "";
  return {
    content: [
      {
        type: "text" as const,
        text: `No sub-agent instance named "${name}" in this session${main}. Known instances: ${available}. Template IDs are not instance aliases; use \`agent_create\` to create an instance.`,
      },
    ],
    isError: true,
  };
}

function describeAgent(entry: AgentEntry, model?: { provider: string; id: string }): string {
  const tags = [templateId(entry), model ? `${model.provider}/${model.id}` : undefined].filter(Boolean);
  return tags.length > 0 ? `${entry.name} [${tags.join(" · ")}]` : entry.name;
}

/** The most recent assistant message text in a live agent's transcript. */
function lastAssistantText(agent: LiveAgent): string {
  for (let i = agent.transcript.length - 1; i >= 0; i--) {
    const item = agent.transcript[i]!;
    if (item.kind === "assistant") return assistantText(item.message).trim();
  }
  return "";
}

// ── agent_send ───────────────────────────────────────────────────────

const AgentSendParams = Type.Object({
  name: Type.String({
    description:
      "Picker name of a specific sub-agent instance. Must already exist (see agent_inspect) — this never creates a new agent; template IDs are not aliases.",
  }),
  text: Type.String({ description: "The message to send." }),
  model: Type.Optional(Type.String({ description: MODEL_DESCRIPTION })),
  wait: Type.Optional(
    Type.Boolean({
      description:
        "Wait for this turn to finish and return its final response, like `agent_create` does. Default false: fire-and-forget, returns immediately (use `agent_inspect` afterwards to check progress/output).",
    }),
  ),
});

export const agentSendTool = defineTool({
  name: "agent_send",
  label: "Agent send",
  description: [
    "Send a message to an existing sub-agent instance by name (revives it first if it isn't currently live).",
    "Errors if `name` doesn't match an instance — template IDs never resolve to instances; use `agent_create` for that.",
    "Optionally switches the agent's model first (`model`), and optionally waits for the turn to finish and returns its response (`wait: true`); by default this is fire-and-forget.",
  ].join(" "),
  promptSnippet: "Message an existing sub-agent by name",
  parameters: AgentSendParams,

  async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
    const root = resolveRoot(ctx.sessionManager.getSessionFile(), ctx.sessionManager.getSessionId());
    if (!root) {
      return {
        content: [{ type: "text", text: "This session has no saved file yet, so it has no sub-agents to message." }],
        isError: true,
      };
    }

    const entries = listAgentEntries(root, (f) => getAgent(f) !== undefined);
    const entry = resolveEntry(entries, params.name);
    if (!entry) return unknownAgentError(params.name, entries);

    let forcedModel: Model<any> | undefined;
    if (params.model) {
      const result = await resolveModelSearch(params.model);
      if (!result.ok) {
        const detail =
          result.reason === "ambiguous"
            ? `matches multiple models: ${result.candidates.join(", ")}`
            : "is not a known/available model";
        return {
          content: [{ type: "text", text: `"${params.model}" ${detail}. Use provider/id (see /model).` }],
          isError: true,
        };
      }
      forcedModel = result.model;
    }

    const catalog = loadCatalog(ctx.cwd);
    const template = templateId(entry);
    const def = template ? catalog.agents.get(template) : undefined;
    try {
      await ensureAgent(entry.file, ctx.cwd, ctx.model, ctx.thinkingLevel, def);
    } catch (err) {
      return { content: [{ type: "text", text: `Could not revive ${entry.name}: ${String(err)}` }], isError: true };
    }
    if (forcedModel) await setAgentModel(entry.file, forcedModel);
    const model = modelOf(entry.file);

    if (!params.wait) {
      const ok = await steerAgent(entry.file, params.text);
      if (!ok) {
        return { content: [{ type: "text", text: `${entry.name} is not live and could not be revived.` }], isError: true };
      }
      return {
        content: [
          {
            type: "text",
            text: `Sent to ${describeAgent(entry, model)}. It's running in the background — use agent_inspect to check on it.`,
          },
        ],
      };
    }

    const agent = await runAgentAndWait(entry.file, params.text, ctx.cwd, ctx.model, ctx.thinkingLevel, def, forcedModel);
    const failed = agent.state === "failed" || agent.state === "stopped";
    const status = failed ? `failed${agent.error ? `: ${agent.error}` : ""}` : "completed";
    const output = lastAssistantText(agent) || "(no output)";
    return {
      content: [{ type: "text", text: `${describeAgent(entry, model)} — ${status}\n\n${output}` }],
      isError: failed,
    };
  },

  renderCall(args, theme) {
    const tags = [args.model, args.wait ? "wait" : undefined].filter(Boolean).join(" · ");
    const preview = args.text.length > 60 ? `${args.text.slice(0, 60)}...` : args.text;
    return new Text(
      theme.fg("toolTitle", theme.bold("agent_send ")) +
        theme.fg("accent", args.name) +
        (tags ? theme.fg("accent", ` [${tags}]`) : "") +
        `\n  ${theme.fg("dim", preview)}`,
      0,
      0,
    );
  },

  renderResult(result, _opts, theme) {
    const text = result.content[0];
    const body = text?.type === "text" ? text.text : "(no output)";
    const icon = result.isError ? theme.fg("error", "✗") : theme.fg("success", "✓");
    return new Text(`${icon} ${theme.fg("dim", body)}`, 0, 0);
  },
});

// ── agent_remove ──────────────────────────────────────────────────

const AgentRemoveParams = Type.Object({
  name: Type.String({
    description: "Picker name of the sub-agent instance to delete outright (aborts its turn, disposes its session, removes it from the picker). Template IDs are not aliases. Cannot be undone.",
  }),
});

export const agentRemoveTool = defineTool({
  name: "agent_remove",
  label: "Agent remove",
  description: [
    "Delete a sub-agent instance outright: aborts anything it's doing, disposes its session, and removes it from the agent picker. Cannot be undone.",
    "`main` (this session's own root conversation) and the currently calling instance can never be targeted this way — ask a peer/root to remove the caller.",
    "Errors if `name` doesn't match any known instance; template IDs are not aliases.",
  ].join(" "),
  promptSnippet: "Delete a sub-agent instance by name",
  parameters: AgentRemoveParams,

  async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
    if (params.name.trim().toLowerCase() === ROOT_AGENT_NAME) {
      return {
        content: [{ type: "text", text: "main cannot be removed through this tool." }],
        isError: true,
      };
    }

    const root = resolveRoot(ctx.sessionManager.getSessionFile(), ctx.sessionManager.getSessionId());
    if (!root) {
      return {
        content: [{ type: "text", text: "This session has no saved file yet, so it has no sub-agents to delete." }],
        isError: true,
      };
    }

    const entries = listAgentEntries(root, (f) => getAgent(f) !== undefined);
    const entry = resolveEntry(entries, params.name);
    if (!entry) return unknownAgentError(params.name, entries);
    if (entry.file === ctx.sessionManager.getSessionFile()) {
      return {
        content: [{ type: "text", text: "An agent cannot remove itself from inside its own tool call. Ask main or another agent to remove this instance." }],
        isError: true,
      };
    }

    await forgetAgent(entry.file);
    removeAgentEntry(root, entry.file);
    return { content: [{ type: "text", text: `Deleted ${entry.name}.` }] };
  },

  renderCall(args, theme) {
    return new Text(theme.fg("toolTitle", theme.bold("agent_remove ")) + theme.fg("accent", args.name), 0, 0);
  },

  renderResult(result, _opts, theme) {
    const text = result.content[0];
    const body = text?.type === "text" ? text.text : "(no output)";
    const icon = result.isError ? theme.fg("error", "✗") : theme.fg("success", "✓");
    return new Text(`${icon} ${theme.fg("dim", body)}`, 0, 0);
  },
});

export function registerAgentControlTools(pi: ExtensionAPI): void {
  pi.registerTool(agentSendTool);
  pi.registerTool(agentRemoveTool);
}
