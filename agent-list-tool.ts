/**
 * agent-list-tool.ts — compact discovery of every sub-agent owned by a root.
 *
 * Listing is deliberately separate from agent_inspect: list answers "what can
 * I reuse?", while inspect retrieves one agent's status and conversation.
 */

import { Type } from "typebox";
import { defineTool, type ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import { getAgent, modelOf, stateOf } from "./agent-runtime.ts";
import { readAgentFile } from "./view-model.ts";
import {
  agentCount,
  listAgentEntries,
  MAX_AGENTS_PER_SESSION,
  resolveRoot,
  type AgentEntry,
} from "./storage.ts";

function agentLine(entry: AgentEntry): string {
  const liveModel = modelOf(entry.file);
  const persisted = readAgentFile(entry.file);
  const model = liveModel ? `${liveModel.provider}/${liveModel.id}` : persisted.model;
  const tags = [entry.def, model].filter(Boolean);
  const label = tags.length > 0 ? `${entry.name} [${tags.join(" · ")}]` : entry.name;
  return `- ${label} — ${stateOf(entry.file) ?? persisted.fileState}`;
}

export const agentListTool = defineTool({
  name: "agent_list",
  label: "Agent list",
  description:
    "List every sub-agent in this root session with its name, model, and current state, plus used and available agent slots. Read-only and non-blocking. Use this to find an agent to reuse; use agent_inspect for one agent's conversation or detailed status.",
  promptSnippet: "List available sub-agents, their models and states, and session slot usage",
  parameters: Type.Object({}),

  async execute(_toolCallId, _params, _signal, _onUpdate, ctx) {
    const root = resolveRoot(ctx.sessionManager.getSessionFile(), ctx.sessionManager.getSessionId());
    if (!root) {
      return {
        content: [{ type: "text", text: "This session has no saved file yet, so it has no sub-agents to list." }],
        isError: true,
      };
    }

    const used = agentCount(root);
    const available = Math.max(0, MAX_AGENTS_PER_SESSION - used);
    const header = `Session agents: ${used}/${MAX_AGENTS_PER_SESSION} (${available} slot${available === 1 ? "" : "s"} available)`;
    const entries = listAgentEntries(root, (file) => getAgent(file) !== undefined);
    if (entries.length === 0) {
      return { content: [{ type: "text", text: `${header}\n\nNo sub-agents in this session.` }] };
    }

    const lines = entries.map(agentLine);
    return { content: [{ type: "text", text: `${header}\n\n${lines.join("\n")}` }] };
  },

  renderCall(_args, theme) {
    return new Text(theme.fg("toolTitle", theme.bold("agent_list")), 0, 0);
  },

  renderResult(result, _opts, theme) {
    const text = result.content[0];
    const body = text?.type === "text" ? text.text : "(no output)";
    const icon = result.isError ? theme.fg("error", "✗") : theme.fg("success", "✓");
    return new Text(`${icon} ${theme.fg("dim", body)}`, 0, 0);
  },
});

export function registerAgentListTool(pi: ExtensionAPI): void {
  pi.registerTool(agentListTool);
}
