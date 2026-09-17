/**
 * agent-lookup.ts — resolve a `name` string (from an LLM tool call) to a
 * known sub-agent's `AgentEntry`.
 *
 * Shared by every LLM-callable tool that takes a `name` parameter
 * (`agent-inspect-tool.ts`, `agent-control-tool.ts`): own name first (an
 * exact picker slug), then def name (picking the most recently touched
 * instance if several share a def). No fuzzy/partial matching — an LLM can
 * call `agent_list` first to discover the exact picker names.
 *
 * Headless: no TUI, no extension context.
 */

import * as fs from "node:fs";
import type { AgentEntry } from "./storage.ts";

function mtimeOf(file: string): number {
  try {
    return fs.statSync(file).mtimeMs;
  } catch {
    return 0;
  }
}

export function resolveEntry(entries: readonly AgentEntry[], name: string): AgentEntry | undefined {
  const byName = entries.find((e) => e.name === name);
  if (byName) return byName;
  const byDef = entries.filter((e) => e.def === name);
  if (byDef.length === 0) return undefined;
  return [...byDef].sort((a, b) => mtimeOf(b.file) - mtimeOf(a.file))[0];
}
