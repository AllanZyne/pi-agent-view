/**
 * agent-inspect-tool.ts — bounded inspection of one sub-agent.
 *
 * Discovery belongs to agent_list. This tool reports one agent's compact
 * status, pages through its chat turns, or searches those turns with a regular
 * expression. It deliberately has no "return everything" option: every result
 * is bounded so a long-running agent cannot flood the caller's context.
 */

import { Worker } from "node:worker_threads";
import { Type } from "typebox";
import { StringEnum } from "@earendil-works/pi-ai";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { defineTool } from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import { assistantText, getAgent, modelOf, readTranscript, stateOf, type TranscriptItem } from "./agent-runtime.ts";
import { resolveEntry } from "./agent-lookup.ts";
import { listAgentEntries, resolveRoot, type AgentEntry } from "./storage.ts";

const DEFAULT_LIMIT = 5;
const MAX_LIMIT = 10;
const TURN_MAX_CHARS = 800;
const SEARCH_ITEM_MAX_CHARS = 20_000;
const SEARCH_TOTAL_MAX_CHARS = 1_000_000;
const QUERY_MAX_CHARS = 200;
const REGEX_TIMEOUT_MS = 200;

const AgentInspectParams = Type.Object({
  name: Type.String({
    description:
      "Picker name of one sub-agent instance, or a def name to pick its most recently active instance. Use agent_list to discover names.",
  }),
  mode: Type.Optional(
    StringEnum(["summary", "history", "search"] as const, {
      description:
        "summary (default) returns compact status; history returns one bounded page of user/assistant turns; search returns bounded regular-expression matches.",
    }),
  ),
  query: Type.Optional(
    Type.String({
      description:
        "Regular expression for search mode. A raw pattern is case-insensitive; /pattern/flags syntax may specify JavaScript flags. Maximum 200 characters.",
    }),
  ),
  cursor: Type.Optional(
    Type.Integer({
      minimum: 0,
      description: "History cursor returned by the previous history page. Omit for the newest page.",
    }),
  ),
  limit: Type.Optional(
    Type.Integer({
      minimum: 1,
      maximum: MAX_LIMIT,
      description: `Maximum turns or matches to return. Default ${DEFAULT_LIMIT}; max ${MAX_LIMIT}.`,
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
    const item = items[i]!;
    if (item.kind === "assistant") return assistantText(item.message).trim();
  }
  return "";
}

/** `→ toolName` / `← toolName (error)` lines, most recent last. */
function recentToolActivity(items: readonly TranscriptItem[], max = 8): string[] {
  const lines: string[] = [];
  for (const item of items) {
    if (item.kind === "toolCall") lines.push(`→ ${item.name}`);
    else if (item.kind === "toolResult") lines.push(`← ${item.name}${item.isError ? " (error)" : ""}`);
  }
  return lines.slice(-max);
}

function describeAgent(entry: AgentEntry): string {
  const model = modelOf(entry.file);
  const tags = [entry.def, model ? `${model.provider}/${model.id}` : undefined].filter(Boolean);
  return tags.length > 0 ? `${entry.name} [${tags.join(" · ")}]` : entry.name;
}

interface ChatTurn {
  index: number;
  role: "User" | "Assistant";
  text: string;
}

function chatTurnAt(items: readonly TranscriptItem[], index: number): ChatTurn | undefined {
  const item = items[index];
  if (item?.kind === "user") return { index, role: "User", text: item.text };
  if (item?.kind === "assistant") {
    const text = assistantText(item.message).trim();
    if (text) return { index, role: "Assistant", text };
  }
  return undefined;
}

function historyPage(items: readonly TranscriptItem[], cursor: number | undefined, limit: number): string {
  const before = Math.min(cursor ?? items.length, items.length);
  const turns: ChatTurn[] = [];
  for (let i = before - 1; i >= 0 && turns.length < limit; i--) {
    const turn = chatTurnAt(items, i);
    if (turn) turns.push(turn);
  }
  turns.reverse();
  if (turns.length === 0) return "No chat history in this range.";

  const body = turns.map((turn) => `${turn.role}: ${truncate(turn.text, TURN_MAX_CHARS)}`).join("\n\n");
  const oldest = turns[0]!.index;
  let hasOlder = false;
  for (let i = oldest - 1; i >= 0; i--) {
    if (chatTurnAt(items, i)) {
      hasOlder = true;
      break;
    }
  }
  const next = hasOlder ? `\n\nOlder history available. Continue with cursor: ${oldest}` : "\n\nStart of history.";
  return `History: ${turns.length} turn${turns.length === 1 ? "" : "s"}\n\n${body}${next}`;
}

export function parseRegexQuery(query: string): { source: string; flags: string } {
  const trimmed = query.trim();
  if (!trimmed) throw new Error("Search query cannot be empty.");
  if (trimmed.length > QUERY_MAX_CHARS) throw new Error(`Search query is limited to ${QUERY_MAX_CHARS} characters.`);

  let source = trimmed;
  let flags = "i";
  if (trimmed.startsWith("/")) {
    const slash = trimmed.lastIndexOf("/");
    if (slash > 0) {
      const candidateFlags = trimmed.slice(slash + 1);
      if (!/^[dgimsuvy]*$/.test(candidateFlags)) throw new Error(`Invalid regular-expression flags: ${candidateFlags}`);
      source = trimmed.slice(1, slash);
      flags = candidateFlags;
    }
  }
  // Global/sticky state is irrelevant when each chat turn is tested once.
  flags = [...new Set(flags.replace(/[gy]/g, ""))].join("");
  try {
    new RegExp(source, flags);
  } catch (err) {
    throw new Error(`Invalid regular expression: ${err instanceof Error ? err.message : String(err)}`);
  }
  return { source, flags };
}

interface SearchCandidate extends ChatTurn {}
interface SearchMatch extends SearchCandidate {
  matchIndex: number;
  matchLength: number;
}

/** Run untrusted/generated regexes off-thread so pathological patterns time out. */
function regexMatches(
  candidates: SearchCandidate[],
  source: string,
  flags: string,
  limit: number,
  signal?: AbortSignal,
): Promise<SearchMatch[]> {
  if (signal?.aborted) return Promise.reject(new Error("Search cancelled."));
  return new Promise((resolve, reject) => {
    const worker = new Worker(
      `const { parentPort, workerData } = require("node:worker_threads");
       const regex = new RegExp(workerData.source, workerData.flags);
       const matches = [];
       for (const item of workerData.candidates) {
         regex.lastIndex = 0;
         const match = regex.exec(item.text);
         if (!match) continue;
         matches.push({ ...item, matchIndex: match.index, matchLength: match[0].length });
         if (matches.length >= workerData.limit) break;
       }
       parentPort.postMessage(matches);`,
      { eval: true, workerData: { candidates, source, flags, limit } },
    );
    let settled = false;
    const finish = (fn: () => void) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
      fn();
    };
    const onAbort = () => finish(() => {
      void worker.terminate();
      reject(new Error("Search cancelled."));
    });
    const timer = setTimeout(() => finish(() => {
      void worker.terminate();
      reject(new Error(`Regular-expression search exceeded ${REGEX_TIMEOUT_MS}ms. Use a simpler pattern.`));
    }), REGEX_TIMEOUT_MS);
    signal?.addEventListener("abort", onAbort, { once: true });
    worker.once("message", (matches: SearchMatch[]) => finish(() => resolve(matches)));
    worker.once("error", (err) => finish(() => reject(err)));
    worker.once("exit", (code) => {
      if (code !== 0) finish(() => reject(new Error(`Regular-expression worker exited with code ${code}.`)));
    });
  });
}

function searchCandidates(items: readonly TranscriptItem[]): SearchCandidate[] {
  const candidates: SearchCandidate[] = [];
  let chars = 0;
  // Search newest first so a bounded result returns the most relevant recent matches.
  for (let i = items.length - 1; i >= 0 && chars < SEARCH_TOTAL_MAX_CHARS; i--) {
    const turn = chatTurnAt(items, i);
    if (!turn) continue;
    const text = turn.text.slice(0, SEARCH_ITEM_MAX_CHARS);
    chars += text.length;
    candidates.push({ ...turn, text });
  }
  return candidates;
}

function matchSnippet(match: SearchMatch): string {
  const radius = 240;
  const start = Math.max(0, match.matchIndex - radius);
  const end = Math.min(match.text.length, match.matchIndex + Math.max(match.matchLength, 1) + radius);
  const prefix = start > 0 ? "…" : "";
  const suffix = end < match.text.length ? "…" : "";
  return `${prefix}${match.text.slice(start, end).trim()}${suffix}`;
}

async function searchHistory(
  items: readonly TranscriptItem[],
  query: string | undefined,
  limit: number,
  signal?: AbortSignal,
): Promise<string> {
  if (query === undefined) throw new Error("Search mode requires `query`.");
  const { source, flags } = parseRegexQuery(query);
  const matches = await regexMatches(searchCandidates(items), source, flags, limit, signal);
  if (matches.length === 0) return `No matches for regular expression ${JSON.stringify(query)}.`;
  const body = matches
    .map((match) => `[turn ${match.index} · ${match.role}]\n${matchSnippet(match)}`)
    .join("\n\n");
  return `${matches.length} match${matches.length === 1 ? "" : "es"} for ${JSON.stringify(query)}:\n\n${body}`;
}

export const agentInspectTool = defineTool({
  name: "agent_inspect",
  label: "Agent inspect",
  description: [
    "Inspect one sub-agent without spawning, messaging, or waiting on it.",
    "Summary mode (default) returns compact status, task, recent activity, and latest output.",
    "History mode returns a bounded page of user/assistant turns and a cursor for older turns.",
    "Search mode applies a bounded regular-expression query to chat turns. Raw patterns are case-insensitive; /pattern/flags syntax is supported.",
    "There is intentionally no full-history response; use history pagination or search so long transcripts cannot flood the caller's context.",
  ].join(" "),
  promptSnippet: "Inspect one sub-agent's status or bounded conversation history",
  parameters: AgentInspectParams,

  async execute(_toolCallId, params, signal, _onUpdate, ctx) {
    const root = resolveRoot(ctx.sessionManager.getSessionFile(), ctx.sessionManager.getSessionId());
    if (!root) {
      return {
        content: [{ type: "text", text: "This session has no saved file yet, so it has no sub-agents to inspect." }],
        isError: true,
      };
    }

    const entries = listAgentEntries(root, (file) => getAgent(file) !== undefined);
    if (entries.length === 0) return { content: [{ type: "text", text: "No sub-agents in this session yet." }] };

    const entry = resolveEntry(entries, params.name);
    if (!entry) {
      const available = entries.map((candidate) => candidate.name).join(", ") || "none";
      return {
        content: [{ type: "text", text: `No sub-agent named or def'd "${params.name}" in this session. Known: ${available}.` }],
        isError: true,
      };
    }

    const items = readTranscript(entry.file);
    const state = stateOf(entry.file) ?? "idle";
    const header = `${describeAgent(entry)} — ${state}`;
    const limit = Math.min(params.limit ?? DEFAULT_LIMIT, MAX_LIMIT);
    const mode = params.mode ?? "summary";

    try {
      if (mode === "history") {
        return { content: [{ type: "text", text: `${header}\n\n${historyPage(items, params.cursor, limit)}` }] };
      }
      if (mode === "search") {
        const result = await searchHistory(items, params.query, limit, signal);
        return { content: [{ type: "text", text: `${header}\n\n${result}` }] };
      }

      const task = firstUserText(items) || "(none recorded)";
      const progress = recentToolActivity(items);
      const latest = truncate(lastAssistantTextFromItems(items) || "(no output yet)", TURN_MAX_CHARS);
      const body = [
        `Task: ${truncate(task, TURN_MAX_CHARS)}`,
        progress.length > 0 ? `Recent activity:\n${progress.join("\n")}` : undefined,
        `Latest output:\n${latest}`,
      ]
        .filter(Boolean)
        .join("\n\n");
      return { content: [{ type: "text", text: `${header}\n\n${body}` }] };
    } catch (err) {
      return {
        content: [{ type: "text", text: err instanceof Error ? err.message : String(err) }],
        isError: true,
      };
    }
  },

  renderCall(args, theme) {
    const mode = args.mode ?? "summary";
    const tags = [mode, args.query ? `/${args.query}/` : undefined].filter(Boolean).join(" · ");
    return new Text(
      theme.fg("toolTitle", theme.bold("agent_inspect ")) +
        theme.fg("accent", args.name) +
        theme.fg("dim", ` · ${tags}`),
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

export function registerAgentInspectTool(pi: ExtensionAPI): void {
  pi.registerTool(agentInspectTool);
}
