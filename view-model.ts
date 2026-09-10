/**
 * view-model.ts — headless view logic.
 *
 * Everything the agent picker and the transcript mirror need to decide *what*
 * to show, with no TUI dependency, so it can be unit tested. index.ts only adds
 * rendering and key handling on top.
 */

import * as fs from "node:fs";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import {
  assistantHasContent,
  getAgent,
  modelOf,
  readTranscript,
  stateOf,
  type AgentState,
  type TranscriptItem,
} from "./agent-runtime.ts";
import type { AgentEntry } from "./storage.ts";

export type { AgentState };

// ── Picker rows ────────────────────────────────────────────────────

export interface AgentRow {
  key: string;
  name: string;
  isRoot: boolean;
  isAttached: boolean;
  state: AgentState;
  messageCount: number;
  /** Last activity. Informational: ordering uses group join order. */
  lastModified: Date;
  summary?: string;
  model?: string;
  /**
   * Sub-agent def name (from `.pi/agents/<def>.md`) that spawned this agent, if
   * any. The picker draws it as a `[def]` badge next to the name so a
   * catalog-backed agent is immediately recognisable.
   */
  def?: string;
}

export interface AgentFileInfo {
  messageCount: number;
  lastModified: Date;
  summary?: string;
  model?: string;
  fileState: AgentState;
}

/**
 * State of an agent that is not live here, from its last assistant message.
 *
 * A turn that ends on `toolUse` was cut off while a tool was running — nothing
 * followed it, so the agent died mid-turn (this is what a crashed or killed
 * agent looks like on disk) and belongs in Stopped, not Completed.
 */
function fileStateOf(message: Record<string, any>): AgentState {
  if (message.errorMessage || message.stopReason === "error") return "failed";
  if (message.stopReason === "aborted" || message.stopReason === "toolUse") return "stopped";
  return "completed";
}

/** Display info for an agent that is not live in this process. */
export function readAgentFile(file: string): AgentFileInfo {
  const fallback: AgentFileInfo = { messageCount: 0, lastModified: new Date(0), fileState: "idle" };
  try {
    const sm = SessionManager.open(file);
    const branch = sm.getBranch();
    const messageCount = sm.getEntries().filter((e) => e.type === "message").length;

    let model: string | undefined;
    let summary: string | undefined;
    let fileState: AgentState = "idle";

    // Each agent owns its model, and a `/model` switch is recorded as a
    // model_change entry, so the session context — not just the last assistant
    // message — is the source of truth for what it will use next.
    try {
      model = sm.buildSessionContext().model?.modelId;
    } catch {
      /* fall back to the last assistant message below */
    }

    for (let i = branch.length - 1; i >= 0; i--) {
      const entry = branch[i]!;
      if (entry.type !== "message" || entry.message.role !== "assistant") continue;
      const msg = entry.message as any;
      model ??= msg.model;
      fileState = fileStateOf(msg);
      for (const part of msg.content ?? []) {
        if (part.type === "text" && part.text) {
          summary = String(part.text).replace(/\s+/g, " ").trim().slice(0, 300);
          break;
        }
      }
      break;
    }

    return { messageCount, lastModified: fs.statSync(file).mtime, summary, model, fileState };
  } catch {
    return fallback;
  }
}

export interface BuildRowsInput {
  /** pi's own session file. */
  rootFile: string;
  rootName: string;
  /** True when pi's own session is streaming. */
  rootBusy: boolean;
  agents: AgentEntry[];
  /** Agent currently mirrored into pi's transcript, if any. */
  attached?: string;
}

/** Order rows the way they are rendered, so a selection index maps to a row. */
const STATE_ORDER: AgentState[] = ["working", "failed", "stopped", "idle", "completed"];

/**
 * Within a group, rows are ordered by *when they joined that group*, not by
 * last activity: an agent's mtime keeps moving while it streams, which made
 * rows swap places under the cursor on every refresh. A join ticket is minted
 * the first time an agent is seen in a state and kept until its state changes,
 * so a group's order is fixed and new members are appended at the bottom.
 */
const groupTickets = new Map<string, { state: AgentState; ticket: number }>();
let nextTicket = 0;

function groupTicket(key: string, state: AgentState): number {
  const previous = groupTickets.get(key);
  if (previous && previous.state === state) return previous.ticket;
  const ticket = ++nextTicket;
  groupTickets.set(key, { state, ticket });
  return ticket;
}

/** Forget agents that vanished, so tickets do not leak across long sessions. */
function pruneTickets(live: Set<string>): void {
  for (const key of groupTickets.keys()) if (!live.has(key)) groupTickets.delete(key);
}

/** Test hook: drop all join tickets. */
export function resetGroupOrder(): void {
  groupTickets.clear();
  nextTicket = 0;
}

export function buildRows(input: BuildRowsInput): AgentRow[] {
  const make = (entry: AgentEntry | undefined, file: string, name: string, isRoot: boolean): AgentRow => {
    const info = readAgentFile(file);
    const live = getAgent(file);
    const liveState = stateOf(file);
    // A live agent whose file pi has not flushed yet has no mtime: report now,
    // so callers never see a 1970 timestamp for a running agent.
    const lastModified = info.lastModified.getTime() === 0 && live ? new Date() : info.lastModified;
    return {
      key: file,
      name,
      isRoot,
      isAttached: isRoot ? input.attached === undefined : input.attached === file,
      state: isRoot ? (input.rootBusy ? "working" : info.fileState) : (liveState ?? info.fileState),
      messageCount: live ? live.transcript.filter((t) => t.kind === "user").length : info.messageCount,
      lastModified,
      summary: info.summary,
      // A live agent's session knows its model right away; the file only learns
      // it from the next assistant message, so `/model` would look like a no-op.
      model: (isRoot ? undefined : modelOf(file)?.id) ?? info.model,
      // Def name comes from the manifest, not the session file: the def is a
      // spawn-time input, so revived agents keep the same badge.
      ...(entry?.def ? { def: entry.def } : {}),
    };
  };

  const rows = [make(undefined, input.rootFile, input.rootName, true)];
  for (const agent of input.agents) rows.push(make(agent, agent.file, agent.name, false));

  pruneTickets(new Set(rows.map((r) => r.key)));
  const tickets = new Map(rows.map((r) => [r.key, groupTicket(r.key, r.state)]));

  return rows.sort((a, b) => {
    const d = STATE_ORDER.indexOf(a.state) - STATE_ORDER.indexOf(b.state);
    return d !== 0 ? d : tickets.get(a.key)! - tickets.get(b.key)!;
  });
}

// ── Selection ──────────────────────────────────────────────────────
//
// Rows are re-sorted on every refresh (an agent finishing moves it from
// "Working" to "Completed"), so a row *index* is not a stable handle: the agent
// under the cursor would silently change while the user is deciding. Selection
// is therefore anchored to the agent's key, and the index is derived from it.

export interface Selection {
  /** Row index of the selected agent, derived from `key`. */
  selected: number;
  scroll: number;
  /** The selected agent, the source of truth across re-sorts. */
  key?: string;
}

/** Keep `selected` inside the visible window, and the window inside the list. */
export function clampScroll(selected: number, scroll: number, maxRows: number, total: number): number {
  const last = Math.max(0, total - maxRows);
  let next = Math.min(Math.max(0, scroll), last);
  if (selected < next) next = selected;
  else if (selected >= next + maxRows) next = selected - maxRows + 1;
  return Math.max(0, next);
}

/**
 * Re-resolve the selection against freshly built rows.
 *
 * The cursor follows the *same agent* even when it changed group and moved in
 * the list. If that agent is gone, the cursor keeps its position in the list.
 */
export function reconcileSelection(rows: AgentRow[], previous: Selection, maxRows: number): Selection {
  if (rows.length === 0) return { selected: 0, scroll: 0, key: undefined };

  let selected = previous.key ? rows.findIndex((r) => r.key === previous.key) : -1;
  if (selected < 0) selected = Math.min(Math.max(0, previous.selected), rows.length - 1);

  return {
    selected,
    scroll: clampScroll(selected, previous.scroll, maxRows, rows.length),
    key: rows[selected]!.key,
  };
}

/** Move the cursor by `delta` rows, keeping the key anchor in sync. */
export function moveSelection(rows: AgentRow[], previous: Selection, delta: number, maxRows: number): Selection {
  if (rows.length === 0) return { selected: 0, scroll: 0, key: undefined };
  const selected = Math.max(0, Math.min(rows.length - 1, previous.selected + delta));
  return {
    selected,
    scroll: clampScroll(selected, previous.scroll, maxRows, rows.length),
    key: rows[selected]!.key,
  };
}

/**
 * The row the user is actually looking at.
 *
 * Always prefer the key: acting on `rows[selected]` can hit a different agent
 * if the list was re-sorted since the last render.
 */
export function selectedRow(rows: AgentRow[], selection: Selection): AgentRow | undefined {
  return rows.find((r) => r.key === selection.key) ?? rows[selection.selected];
}

// ── Transcript mirroring ───────────────────────────────────────────

/** Entry payload persisted in pi's session and rendered by pi. */
export interface ItemRef {
  file: string;
  index: number;
}

/**
 * Attachment bookkeeping. Lives in the extension's view state.
 *
 * `mirrored` is per agent file, because entries handed to pi are *persisted*:
 * they can never be taken back. Detaching only hides them (see `isVisible`),
 * so re-attaching must resume where the previous attachment stopped instead of
 * replaying the transcript and duplicating every item.
 */
export interface MirrorState {
  attached?: string;
  /** Per agent file: how many of its transcript items pi already holds. */
  mirrored: Record<string, number>;
}

/** How many items of `file` pi already holds. */
export function mirroredCount(state: MirrorState, file: string): number {
  return state.mirrored[file] ?? 0;
}

/**
 * Record that pi holds at least `count` items of `file`. Monotonic: used both
 * by `syncMirror` and when rebuilding counters from a reloaded session.
 */
export function noteMirrored(state: MirrorState, file: string, count: number): void {
  if (count > mirroredCount(state, file)) state.mirrored[file] = count;
}

/**
 * True when an entry belonging to `file` should draw itself.
 *
 * Every agent's items stay in pi's transcript forever, so visibility — not
 * appending — is what keeps one agent's output out of another's view.
 */
export function isVisible(state: MirrorState, file: string): boolean {
  return state.attached === file;
}

/**
 * True when pi would render something for this item right now.
 *
 * `addCustomEntryToChat()` drops entries whose renderer produces no lines, so
 * an assistant item must not be mirrored before its first delta arrives, and
 * tool results are drawn inside their tool call's box.
 */
export function renderable(item: TranscriptItem): boolean {
  switch (item.kind) {
    case "user":
    case "error":
      return item.text.trim().length > 0;
    // An assistant message draws nothing until its first delta arrives.
    case "assistant":
      return assistantHasContent(item.message);
    case "toolCall":
      return true;
    case "toolResult":
      return false;
  }
}

/**
 * Hand pi every transcript item of the attached agent it has not rendered yet.
 *
 * Pure bookkeeping: the caller supplies `append` (pi.appendEntry in the
 * extension, a collector in tests) and optionally `read` (defaults to the live
 * agent pool, falling back to the agent's jsonl).
 *
 * Returns the number of refs appended.
 */
export function syncMirror(
  state: MirrorState,
  append: (ref: ItemRef) => void,
  read: (file: string) => TranscriptItem[] = readTranscript,
): number {
  const file = state.attached;
  if (!file) return 0;
  state.mirrored ??= {};
  const items = read(file);
  let cursor = mirroredCount(state, file);
  let appended = 0;

  while (cursor < items.length) {
    const item = items[cursor]!;
    if (item.kind === "toolResult") {
      cursor++;
      continue;
    }
    if (!renderable(item)) {
      // The streaming tail has no text yet: wait for the next update.
      if (cursor === items.length - 1) break;
      cursor++;
      continue;
    }
    append({ file, index: cursor });
    cursor++;
    appended++;
  }
  state.mirrored[file] = cursor;
  return appended;
}

/**
 * Switch which agent is mirrored. Rendering-only: no agent is touched, and no
 * already-mirrored item is replayed — the previous agent's entries simply stop
 * being visible.
 */
export function attachTo(state: MirrorState, file: string | undefined): void {
  state.attached = file;
  state.mirrored ??= {};
}
