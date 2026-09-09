/**
 * view-model.ts — headless view logic.
 *
 * Everything the agent picker and the transcript mirror need to decide *what*
 * to show, with no TUI dependency, so it can be unit tested. index.ts only adds
 * rendering and key handling on top.
 */

import * as fs from "node:fs";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import { getAgent, readTranscript, stateOf, type AgentState, type TranscriptItem } from "./agent-runtime.ts";
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
  /** Last activity, used for ordering only — the picker does not show it. */
  lastModified: Date;
  summary?: string;
  model?: string;
}

export interface AgentFileInfo {
  messageCount: number;
  lastModified: Date;
  summary?: string;
  model?: string;
  fileState: AgentState;
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

    for (let i = branch.length - 1; i >= 0; i--) {
      const entry = branch[i]!;
      if (entry.type !== "message" || entry.message.role !== "assistant") continue;
      const msg = entry.message as any;
      model ??= msg.model;
      fileState = msg.stopReason === "error" || msg.errorMessage ? "failed" : "completed";
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
const STATE_ORDER: AgentState[] = ["working", "failed", "idle", "completed"];

export function buildRows(input: BuildRowsInput): AgentRow[] {
  const make = (file: string, name: string, isRoot: boolean): AgentRow => {
    const info = readAgentFile(file);
    const live = getAgent(file);
    const liveState = stateOf(file);
    // A live agent whose file pi has not flushed yet has no mtime: treat it as
    // fresh so it does not sink to the bottom of its group.
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
      model: info.model,
    };
  };

  const rows = [make(input.rootFile, input.rootName, true)];
  for (const agent of input.agents) rows.push(make(agent.file, agent.name, false));

  return rows.sort((a, b) => {
    const d = STATE_ORDER.indexOf(a.state) - STATE_ORDER.indexOf(b.state);
    return d !== 0 ? d : b.lastModified.getTime() - a.lastModified.getTime();
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
    case "assistant":
    case "thinking":
    case "error":
      return item.text.trim().length > 0;
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
