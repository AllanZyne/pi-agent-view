/**
 * agent-inspect-tool.ts — an LLM-callable `agent_inspect` tool that reads a
 * sub-agent's input/output/progress *without* spawning or waiting on it.
 *
 * `agent_create` (agent-create-tool.ts) is synchronous: it blocks the calling turn
 * until the sub-agent finishes, and that finish is the only moment the
 * caller would otherwise see that agent's output. This tool is the
 * non-blocking escape hatch: it works on *any* sub-agent in this session,
 * however it was created (by this agent, by another agent, or revived from
 * an earlier turn) and however it's doing right now (including `working`,
 * mid-turn).
 *
 * Given a picker name or def name, it reports that agent's current state,
 * model, original task, and latest output (or, with `full: true`, its whole
 * transcript including tool calls/results) by reading straight from the
 * shared in-process registry / on-disk jsonl (`agent-runtime.ts`'s
 * `readTranscript`/`stateOf`/`modelOf`) — the exact same data the picker UI
 * renders. Read-only: it never sends a message, switches a model, or starts
 * anything.
 */

import { Type } from "typebox";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { defineTool } from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import { assistantText, getAgent, modelOf, readTranscript, stateOf, type TranscriptItem } from "./agent-runtime.ts";
import { resolveEntry } from "./agent-lookup.ts";
import { listAgentEntries, resolveRoot, type AgentEntry } from "./storage.ts";

const AgentInspectParams = Type.Object({
  name: Type.Optional(
    Type.String({
      description:
        "Picker name of a specific sub-agent instance (e.g. 'review-storage-ts', as shown in the agent list or a previous agent_create/agent_inspect result), or a def name to pick its most recently active instance (e.g. 'reviewer'). Omit to list every sub-agent known in this session, live or not.",
    }),
  ),
  full: Type.Optional(
    Type.Boolean({
      description:
        "Return the agent's whole transcript (every user/assistant turn, tool call and tool result) instead of just its current state and latest output. Default false. Only meaningful together with `name`.",
    }),
  ),
});

function truncate(text: string, max: number): string {
  const trimmed = text.trim();
  return trimmed.length > max ? `${trimmed.slice(0, max)}…` : trimmed;
}

function firstUserText(items: readonly TranscriptItem[]): string {
  const item = items.find((i) => i.kind === "user");
  return item?.kind === "user" ? item.text : "";
}

function lastAssistantTextFromItems(items: readonly TranscriptItem[]): string {
  for (let i = items.length - 1; i >= 0; i--) {
    const it = items[i]!;
    if (it.kind === "assistant") return assistantText(it.message).trim();
  }
  return "";
}

/** `→ toolName` / `← toolName (error)` lines, most recent last — a cheap progress readout. */
function recentToolActivity(items: readonly TranscriptItem[], max = 8): string[] {
  const lines: string[] = [];
  for (const it of items) {
    if (it.kind === "toolCall") lines.push(`→ ${it.name}`);
    else if (it.kind === "toolResult") lines.push(`← ${it.name}${it.isError ? " (error)" : ""}`);
  }
  return lines.slice(-max);
}

function renderFullTranscript(items: readonly TranscriptItem[]): string {
  const lines: string[] = [];
  for (const it of items) {
    switch (it.kind) {
      case "user":
        lines.push(`User: ${it.text}`);
        break;
      case "assistant": {
        const t = assistantText(it.message).trim();
        if (t) lines.push(`Assistant: ${t}`);
        break;
      }
      case "toolCall":
        lines.push(`Tool call → ${it.name}(${truncate(JSON.stringify(it.args ?? {}), 300)})`);
        break;
      case "toolResult":
        lines.push(`Tool result ← ${it.name}${it.isError ? " (error)" : ""}: ${truncate(it.text || "(empty)", 500)}`);
        break;
      case "error":
        lines.push(`Error: ${it.text}`);
        break;
    }
  }
  return lines.join("\n\n");
}

function describeAgent(entry: AgentEntry): string {
  const model = modelOf(entry.file);
  const tags = [entry.def, model ? `${model.provider}/${model.id}` : undefined].filter(Boolean);
  return tags.length > 0 ? `${entry.name} [${tags.join(" · ")}]` : entry.name;
}

export const agentInspectTool = defineTool({
  name: "agent_inspect",
  label: "Agent inspect",
  description: [
    "Read-only check on one or all sub-agents in this session, without spawning or waiting on anything.",
    "Works on any sub-agent in this session, however it was created.",
    "Omit `name` to list every known sub-agent with its state and a short preview of its latest output.",
    "Pass `name` (a picker name, or a def name to pick its most recent instance) to get that agent's model, original task, recent tool activity, and latest output.",
    "Add `full: true` to get the agent's entire transcript instead of just the latest output — useful to see everything it has done so far while it is still working.",
    "This never blocks: a `working` agent is reported exactly as it stands right now, mid-turn.",
  ].join(" "),
  promptSnippet: "Check the state/output/progress of a sub-agent without waiting for it",
  parameters: AgentInspectParams,

  async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
    const root = resolveRoot(ctx.sessionManager.getSessionFile(), ctx.sessionManager.getSessionId());
    if (!root) {
      return {
        content: [{ type: "text", text: "This session has no saved file yet, so it has no sub-agents to inspect." }],
        isError: true,
      };
    }

    const entries = listAgentEntries(root, (f) => getAgent(f) !== undefined);
    if (entries.length === 0) {
      return {
        content: [{ type: "text", text: "No sub-agents in this session yet. Use `agent_create` to start one." }],
      };
    }

    if (!params.name) {
      const lines = entries.map((e) => {
        const state = stateOf(e.file) ?? "idle";
        const preview = truncate(lastAssistantTextFromItems(readTranscript(e.file)) || "(no output yet)", 160);
        return `- ${describeAgent(e)} — ${state}: ${preview}`;
      });
      return { content: [{ type: "text", text: lines.join("\n") }] };
    }

    const entry = resolveEntry(entries, params.name);
    if (!entry) {
      const available = entries.map((e) => e.name).join(", ") || "none";
      return {
        content: [
          { type: "text", text: `No sub-agent named or def'd "${params.name}" in this session. Known: ${available}.` },
        ],
        isError: true,
      };
    }

    const items = readTranscript(entry.file);
    const state = stateOf(entry.file) ?? "idle";
    const task = firstUserText(items) || "(none recorded)";
    const header = `${describeAgent(entry)} — ${state}`;

    if (params.full) {
      const body = renderFullTranscript(items) || "(no turns yet)";
      return { content: [{ type: "text", text: `${header}\n\nTask: ${task}\n\n${body}` }] };
    }

    const progress = recentToolActivity(items);
    const latest = lastAssistantTextFromItems(items) || "(no output yet)";
    const body = [
      `Task: ${task}`,
      progress.length > 0 ? `Recent activity:\n${progress.join("\n")}` : undefined,
      `Latest output:\n${latest}`,
    ]
      .filter(Boolean)
      .join("\n\n");
    return { content: [{ type: "text", text: `${header}\n\n${body}` }] };
  },

  renderCall(args, theme) {
    const text =
      theme.fg("toolTitle", theme.bold("agent_inspect ")) +
      theme.fg("accent", args.name ? args.name : "(all agents)") +
      (args.full ? theme.fg("dim", " · full") : "");
    return new Text(text, 0, 0);
  },

  renderResult(result, _opts, theme) {
    const text = result.content[0];
    const body = text?.type === "text" ? text.text : "(no output)";
    const icon = result.isError ? theme.fg("error", "✗") : theme.fg("success", "✓");
    return new Text(`${icon} ${theme.fg("dim", body)}`, 0, 0);
  },
});

export function registerAgentInspectTool(pi: ExtensionAPI): void {
  pi.registerTool(agentInspectTool);
}
