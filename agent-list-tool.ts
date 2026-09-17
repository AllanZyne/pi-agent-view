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
import { loadCatalog } from "./agent-catalog.ts";
import {
  agentCount,
  listAgentEntries,
  MAX_AGENTS_PER_SESSION,
  resolveRoot,
  templateId,
  type AgentEntry,
} from "./storage.ts";

function agentLine(entry: AgentEntry): string {
  const liveModel = modelOf(entry.file);
  const persisted = readAgentFile(entry.file);
  const model = liveModel ? `${liveModel.provider}/${liveModel.id}` : persisted.model;
  const tags = [templateId(entry), model].filter(Boolean);
  const label = tags.length > 0 ? `${entry.name} [${tags.join(" · ")}]` : entry.name;
  return `- ${label} — ${stateOf(entry.file) ?? persisted.fileState}`;
}

function templateLine(template: { name: string; description: string; scope: string; model?: string }): string {
  return `- ${template.name} — ${template.description} [${template.scope}; default model: ${template.model ?? "inherit"}]`;
}

export const agentListTool = defineTool({
  name: "agent_list",
  label: "Agent list",
  description:
    "List existing sub-agent instances and available agent templates. Instances include name, model, and current state; templates include ID, routing description, scope, and default model. Also reports used and available instance slots. Read-only and non-blocking. Use this before delegation to reuse a suitable instance or choose a template for agent_create; use agent_inspect for one instance's conversation or detailed status.",
  promptSnippet: "Discover existing sub-agent instances, reusable templates, and session slot usage",
  parameters: Type.Object({}),

  async execute(_toolCallId, _params, _signal, _onUpdate, ctx) {
    const catalog = loadCatalog(ctx.cwd);
    const templates = [...catalog.agents.values()].sort((a, b) => a.name.localeCompare(b.name));
    const root = resolveRoot(ctx.sessionManager.getSessionFile(), ctx.sessionManager.getSessionId());
    if (!root) {
      const templateSection = templates.length > 0 ? templates.map(templateLine).join("\n") : "(none)";
      return { content: [{ type: "text", text: `Existing instances\n(none — this root session is not saved yet)\n\nAvailable templates\n${templateSection}` }] };
    }

    const used = agentCount(root);
    const available = Math.max(0, MAX_AGENTS_PER_SESSION - used);
    const header = `Existing instances: ${used}/${MAX_AGENTS_PER_SESSION} (${available} slot${available === 1 ? "" : "s"} available)`;
    const allEntries = listAgentEntries(root, (file) => getAgent(file) !== undefined);
    const callerFile = ctx.sessionManager.getSessionFile();
    const callerIsInstance = allEntries.some((entry) => entry.file === callerFile);
    const entries = allEntries.filter((entry) => entry.file !== callerFile);
    const instances = entries.length > 0 ? entries.map(agentLine).join("\n") : "(none)";
    const callerNote = callerIsInstance ? "\n(current calling instance omitted)" : "";
    const templateSection = templates.length > 0 ? templates.map(templateLine).join("\n") : "(none)";
    return { content: [{ type: "text", text: `${header}\n${instances}${callerNote}\n\nAvailable templates\n${templateSection}` }] };
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
