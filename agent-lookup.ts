/**
 * agent-lookup.ts — resolve a `name` string (from an LLM tool call) to a
 * known sub-agent instance's `AgentEntry`.
 *
 * Only an exact picker instance name resolves. Template IDs deliberately do
 * not alias instances: callers must use `agent_create` to create another
 * instance or `agent_list` to discover an instance name.
 *
 * Headless: no TUI, no extension context.
 */

import type { AgentEntry } from "./storage.ts";

export function resolveEntry(entries: readonly AgentEntry[], name: string): AgentEntry | undefined {
  return entries.find((e) => e.name === name);
}
