/**
 * agent-summary.ts — one place for the status text every agent-facing tool
 * shows a caller: the model label, the last assistant turn, and whether a
 * run ended in failure.
 *
 * Before this module, `agent-create-tool.ts`, `agent-control-tool.ts`, and
 * `agent-inspect-tool.ts` each carried their own near-identical copy of
 * these three helpers, drifting apart in small ways (only `agent-list-tool.ts`
 * fell back to the on-disk model when an agent wasn't live; the others
 * didn't). This module is the single interface all of them call instead.
 *
 * Headless: no TUI, no extension context.
 */

import { assistantText, modelOf, type AgentState, type TranscriptItem } from "./agent-runtime.ts";
import { readAgentFile } from "./view-model.ts";
import { templateId, type AgentEntry } from "./storage.ts";

/** The most recent assistant message's text in a transcript, trimmed. */
export function lastAssistantText(items: readonly TranscriptItem[]): string {
  for (let i = items.length - 1; i >= 0; i--) {
    const item = items[i]!;
    if (item.kind === "assistant") return assistantText(item.message).trim();
  }
  return "";
}

/** `provider/id` for a live agent, else its last-known model on disk. */
function resolveModelLabel(file: string): string | undefined {
  const live = modelOf(file);
  if (live) return `${live.provider}/${live.id}`;
  return readAgentFile(file).model;
}

/**
 * `name [template · provider/id]` — the label every tool shows a human or
 * the calling model for one agent. Always resolves the model itself (live,
 * falling back to disk) so callers never need to pass one in.
 */
export function describeAgentLabel(entry: AgentEntry): string {
  const tags = [templateId(entry), resolveModelLabel(entry.file)].filter(Boolean);
  return tags.length > 0 ? `${entry.name} [${tags.join(" · ")}]` : entry.name;
}

/** True once an agent's turn ended in failure, or was aborted/died mid-turn. */
export function isTerminalFailure(state: AgentState): boolean {
  return state === "failed" || state === "stopped";
}
