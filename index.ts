/**
 * Agent Views — per-session agents with true in-process concurrency
 *
 * Architecture (codex-style, adapted to pi):
 *
 *   pi's own session   = "Main" agent. Stays pi-native forever: real
 *                        streaming, markdown, tool rendering, footer stats,
 *                        /compact, /tree all work. We NEVER switchSession,
 *                        so it is never torn down and never aborted.
 *
 *   sub-agents         = in-process `AgentSession` objects (agent-runtime.ts).
 *                        They run concurrently and are rendered by our own
 *                        widget when focused. Navigating between them is a
 *                        pure view change — nothing is ever aborted.
 *
 * View modes:
 *   hidden      normal pi chat (Main agent)
 *   list        agent list  (← from hidden)
 *   transcript  focused sub-agent's live transcript (Enter from list)
 *
 * Storage:
 *   <sessionDir>/__agents__/<parentId>/manifest.json
 *   <sessionDir>/__agents__/<parentId>/<agentId>.jsonl   (hidden from /resume)
 */

import * as fs from "node:fs";
import * as path from "node:path";
import {
  CustomEditor,
  getMarkdownTheme,
  SessionManager,
  type ExtensionAPI,
  type ExtensionCommandContext,
  type ExtensionContext,
  type Theme,
} from "@earendil-works/pi-coding-agent";
import { Markdown, matchesKey, truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import {
  abortAgent,
  disposeAll,
  ensureAgent,
  getAgent,
  runAgent,
  setOnChange,
  stateOf,
  steerAgent,
  type RunState,
  type TranscriptItem,
} from "./agent-runtime.ts";

// ─── Manifest / storage ─────────────────────────────────────────────

interface AgentEntry {
  id: string;
  name: string;
  file: string;
  createdAt: string;
}

interface AgentManifest {
  parentId: string;
  parentFile: string;
  agents: AgentEntry[];
}

const agentsBase = (sessionDir: string) => path.join(sessionDir, "__agents__");
const groupDir = (sessionDir: string, parentId: string) => path.join(agentsBase(sessionDir), parentId);
const manifestPath = (sessionDir: string, parentId: string) =>
  path.join(groupDir(sessionDir, parentId), "manifest.json");

function loadManifest(sessionDir: string, parentId: string): AgentManifest | null {
  try {
    return JSON.parse(fs.readFileSync(manifestPath(sessionDir, parentId), "utf-8"));
  } catch {
    return null;
  }
}

function saveManifest(sessionDir: string, m: AgentManifest): void {
  fs.mkdirSync(groupDir(sessionDir, m.parentId), { recursive: true });
  fs.writeFileSync(manifestPath(sessionDir, m.parentId), JSON.stringify(m, null, 2));
}

const isSubAgentPath = (f: string) => f.includes("/__agents__/");

function sessionDirOf(file: string): string {
  const i = file.indexOf("/__agents__/");
  return i >= 0 ? file.slice(0, i) : path.dirname(file);
}

interface ParentCtx {
  parentId: string;
  parentFile: string;
  sessionDir: string;
}

/** pi's session is always the parent (we never switch into a sub-agent). */
function resolveParent(ctx: ExtensionContext): ParentCtx | null {
  const f = ctx.sessionManager.getSessionFile();
  if (!f) return null;
  return {
    parentId: ctx.sessionManager.getSessionId(),
    parentFile: f,
    sessionDir: sessionDirOf(f),
  };
}

function createSubAgent(parent: ParentCtx, name: string, cwd: string): string {
  const dir = groupDir(parent.sessionDir, parent.parentId);
  fs.mkdirSync(dir, { recursive: true });
  const sm = SessionManager.create(cwd, dir, { parentSession: parent.parentFile });
  const file = sm.getSessionFile()!;

  const m =
    loadManifest(parent.sessionDir, parent.parentId) ??
    { parentId: parent.parentId, parentFile: parent.parentFile, agents: [] };
  m.agents.push({ id: sm.getSessionId(), name, file, createdAt: new Date().toISOString() });
  saveManifest(parent.sessionDir, m);
  return file;
}

// ─── Agent list for display ─────────────────────────────────────────

interface AgentRow {
  /** null file == Main (pi's own session) */
  file: string | null;
  name: string;
  isMain: boolean;
  isFocused: boolean;
  state: RunState;
  messageCount: number;
  lastModified: Date;
  summary?: string;
}

function summarize(items: TranscriptItem[]): string | undefined {
  for (let i = items.length - 1; i >= 0; i--) {
    const it = items[i]!;
    if (it.kind === "assistant" && it.text) return it.text.slice(0, 200).replace(/\s+/g, " ");
    if (it.kind === "error") return `Error: ${it.text.slice(0, 120)}`;
  }
  return undefined;
}

function buildRows(ctx: ExtensionContext, parent: ParentCtx, focused: string | null): AgentRow[] {
  const rows: AgentRow[] = [];

  // Main = pi's own session
  let mainCount = 0;
  let mainSummary: string | undefined;
  try {
    for (const e of ctx.sessionManager.getBranch()) {
      const en = e as any;
      if (en.type === "message") mainCount++;
    }
    const branch = ctx.sessionManager.getBranch();
    for (let i = branch.length - 1; i >= 0; i--) {
      const en = branch[i] as any;
      if (en.type === "message" && en.message?.role === "assistant") {
        for (const c of en.message.content ?? []) {
          if (c.type === "text" && c.text) {
            mainSummary = c.text.slice(0, 200).replace(/\s+/g, " ");
            break;
          }
        }
        if (mainSummary) break;
      }
    }
  } catch {
    /* ignore */
  }

  rows.push({
    file: null,
    name: ctx.sessionManager.getSessionName() ?? "Main",
    isMain: true,
    isFocused: focused === null,
    state: ctx.isIdle() ? "idle" : "working",
    messageCount: mainCount,
    lastModified: new Date(),
    summary: mainSummary,
  });

  const m = loadManifest(parent.sessionDir, parent.parentId);
  for (const entry of m?.agents ?? []) {
    const live = getAgent(entry.file);
    let mtime = new Date(entry.createdAt);
    let count = 0;
    try {
      mtime = fs.statSync(entry.file).mtime;
    } catch {
      /* ignore */
    }
    if (live) {
      count = live.transcript.filter((t) => t.kind === "user" || t.kind === "assistant").length;
    } else {
      try {
        count = SessionManager.open(entry.file)
          .getEntries()
          .filter((e: any) => e.type === "message").length;
      } catch {
        /* ignore */
      }
    }
    rows.push({
      file: entry.file,
      name: entry.name,
      isMain: false,
      isFocused: focused === entry.file,
      state: stateOf(entry.file) ?? "idle",
      messageCount: count,
      lastModified: mtime,
      summary: live ? summarize(live.transcript) : undefined,
    });
  }

  return rows;
}

// ─── Helpers ────────────────────────────────────────────────────────

function relTime(d: Date): string {
  const s = Math.floor((Date.now() - d.getTime()) / 1000);
  if (s < 60) return "now";
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h`;
  return `${Math.floor(h / 24)}d`;
}

const clip = (s: string, n: number) => (s.length <= n ? s : s.slice(0, n - 1) + "…");

const STATE_ICON: Record<RunState, [string, string]> = {
  working: ["✽", "warning"],
  failed: ["✗", "error"],
  completed: ["✓", "success"],
  idle: ["∙", "dim"],
};

// ─── View state ─────────────────────────────────────────────────────

type Mode = "hidden" | "list" | "transcript";

interface View {
  mode: Mode;
  /** null = Main (pi-native). Non-null = sub-agent file. */
  focused: string | null;
  rows: AgentRow[];
  selected: number;
  listScroll: number;
  /** transcript scroll from bottom; 0 = follow tail */
  tScroll: number;
  showHelp: boolean;
  parent: ParentCtx | null;
  tui?: any;
}

const view: View = {
  mode: "hidden",
  focused: null,
  rows: [],
  selected: 0,
  listScroll: 0,
  tScroll: 0,
  showHelp: false,
  parent: null,
};

function rerender(): void {
  view.tui?.requestRender();
}

function rowsHeight(): number {
  return Math.max(6, (process.stdout.rows || 30) - 12);
}

// ─── Renderers ──────────────────────────────────────────────────────

function renderList(th: Theme, width: number): string[] {
  const lines: string[] = [];
  const inner = Math.min(width - 4, 100);

  if (view.showHelp) {
    lines.push(truncateToWidth("  " + th.fg("accent", th.bold("Agent Views")), width));
    lines.push(truncateToWidth("  " + th.fg("dim", "─".repeat(Math.min(width - 4, 60))), width));
    for (const [k, d] of [
      ["↑ / ↓", "Select agent"],
      ["Enter / →", "Open agent (view its output here)"],
      ["← / Esc", "Back"],
      ["Ctrl+X", "Abort selected agent's current turn"],
      ["?", "Toggle help"],
      ["", "Type a prompt + Enter = create a new agent"],
    ] as const)
      lines.push(truncateToWidth("    " + th.fg("accent", k.padEnd(12)) + th.fg("text", d), width));
    return lines;
  }

  const working = view.rows.filter((r) => r.state === "working").length;
  lines.push(
    truncateToWidth(
      "  " + th.fg("accent", th.bold("◆ Agents")) +
        th.fg("muted", `  ${view.rows.length}`) +
        (working > 0 ? th.fg("warning", `  ${working} working`) : ""),
      width,
    ),
  );
  lines.push(truncateToWidth("  " + th.fg("dim", "─".repeat(inner)), width));

  const h = rowsHeight();
  const maxRows = Math.max(2, Math.floor(h / 2));
  if (view.selected < view.listScroll) view.listScroll = view.selected;
  if (view.selected >= view.listScroll + maxRows) view.listScroll = view.selected - maxRows + 1;

  const end = Math.min(view.listScroll + maxRows, view.rows.length);
  if (view.listScroll > 0) lines.push(truncateToWidth(th.fg("dim", `  ↑ ${view.listScroll}`), width));

  for (let i = view.listScroll; i < end; i++) {
    const r = view.rows[i]!;
    const sel = i === view.selected;
    const [ic, col] = STATE_ICON[r.state];
    const icon = r.isFocused ? th.fg("accent", "●") : th.fg(col as any, ic);
    const ptr = sel ? th.fg("accent", " ▸ ") : "   ";
    const nm = sel ? th.fg("accent", clip(r.name, 38)) : clip(r.name, 38);
    const tag = r.isMain ? th.fg("dim", " [main]") : "";
    const cur = r.isFocused ? th.fg("success", " (open)") : "";
    const t = th.fg("dim", relTime(r.lastModified));
    const left = ptr + icon + " " + nm + tag + cur;
    const gap = Math.max(1, width - visibleWidth(left) - visibleWidth(t) - 2);
    lines.push(truncateToWidth(left + " ".repeat(gap) + t, width));

    const meta = `${r.messageCount} msg`;
    const sum = r.summary ? "  " + clip(r.summary, Math.max(10, width - 30)) : "";
    lines.push(truncateToWidth("     " + th.fg("muted", meta) + th.fg("dim", sum), width));
  }

  if (end < view.rows.length)
    lines.push(truncateToWidth(th.fg("dim", `  ↓ ${view.rows.length - end}`), width));

  lines.push(truncateToWidth("  " + th.fg("dim", "─".repeat(inner)), width));
  lines.push(
    truncateToWidth(
      "  " +
        th.fg("dim", "↑↓") + th.fg("muted", " select") +
        th.fg("dim", "  ⏎") + th.fg("muted", " open") +
        th.fg("dim", "  ←") + th.fg("muted", " back") +
        th.fg("dim", "  ^X") + th.fg("muted", " abort") +
        th.fg("dim", "  ?") + th.fg("muted", " help") +
        th.fg("dim", "   type+⏎") + th.fg("muted", " new agent"),
      width,
    ),
  );
  return lines;
}

function renderTranscript(th: Theme, width: number): string[] {
  const file = view.focused!;
  const agent = getAgent(file);
  const row = view.rows.find((r) => r.file === file);
  const lines: string[] = [];
  const inner = Math.min(width - 4, 100);

  const st = stateOf(file) ?? "idle";
  const [ic, col] = STATE_ICON[st];
  lines.push(
    truncateToWidth(
      "  " + th.fg(col as any, ic) + " " +
        th.fg("accent", th.bold(clip(row?.name ?? "agent", 44))) +
        th.fg("muted", `   ${st}`),
      width,
    ),
  );
  lines.push(truncateToWidth("  " + th.fg("dim", "─".repeat(inner)), width));

  // Build the body from the transcript
  const body: string[] = [];
  const mdTheme = getMarkdownTheme();
  const contentW = Math.max(20, width - 4);

  for (const it of agent?.transcript ?? []) {
    switch (it.kind) {
      case "user": {
        for (const l of it.text.split("\n"))
          body.push(truncateToWidth("  " + th.fg("userMessageText", "› " + l), width));
        body.push("");
        break;
      }
      case "assistant": {
        try {
          const md = new Markdown(it.text, 0, 0, mdTheme);
          for (const l of md.render(contentW)) body.push(truncateToWidth("  " + l, width));
        } catch {
          for (const l of it.text.split("\n")) body.push(truncateToWidth("  " + l, width));
        }
        if (it.streaming) body.push(truncateToWidth("  " + th.fg("dim", "▌"), width));
        body.push("");
        break;
      }
      case "thinking": {
        const t = clip(it.text.replace(/\s+/g, " "), contentW);
        body.push(truncateToWidth("  " + th.fg("dim", "◈ " + t), width));
        break;
      }
      case "toolCall": {
        const a = JSON.stringify(it.args ?? {});
        body.push(
          truncateToWidth(
            "  " + th.fg("muted", "→ ") + th.fg("toolTitle", it.name) +
              th.fg("dim", " " + clip(a, Math.max(10, contentW - it.name.length - 6))),
            width,
          ),
        );
        break;
      }
      case "toolResult": {
        const c = it.isError ? "error" : "toolOutput";
        const first = it.text.split("\n").slice(0, 6);
        for (const l of first)
          body.push(truncateToWidth("    " + th.fg(c as any, clip(l, contentW - 2)), width));
        if (it.text.split("\n").length > 6)
          body.push(truncateToWidth("    " + th.fg("dim", "…"), width));
        body.push("");
        break;
      }
      case "error": {
        body.push(truncateToWidth("  " + th.fg("error", "✗ " + clip(it.text, contentW)), width));
        body.push("");
        break;
      }
    }
  }

  if (body.length === 0) {
    body.push(truncateToWidth("  " + th.fg("dim", "(no output yet — type below to prompt it)"), width));
  }

  // Window: follow the tail unless the user scrolled up
  const h = rowsHeight();
  const maxScroll = Math.max(0, body.length - h);
  if (view.tScroll > maxScroll) view.tScroll = maxScroll;
  const start = Math.max(0, body.length - h - view.tScroll);
  const end = Math.min(body.length, start + h);
  if (start > 0) lines.push(truncateToWidth(th.fg("dim", `  ↑ ${start} more`), width));
  for (let i = start; i < end; i++) lines.push(body[i]!);
  if (end < body.length) lines.push(truncateToWidth(th.fg("dim", `  ↓ ${body.length - end} more`), width));

  lines.push(truncateToWidth("  " + th.fg("dim", "─".repeat(inner)), width));
  lines.push(
    truncateToWidth(
      "  " +
        th.fg("dim", "←") + th.fg("muted", " agents") +
        th.fg("dim", "  ↑↓") + th.fg("muted", " scroll") +
        th.fg("dim", "  ^X") + th.fg("muted", " abort") +
        th.fg("dim", "   type+⏎") + th.fg("muted", st === "working" ? " steer" : " prompt"),
      width,
    ),
  );
  return lines;
}

function renderWidget(th: Theme, width: number): string[] {
  if (view.mode === "hidden") return [];
  if (view.mode === "list") return renderList(th, width);
  return renderTranscript(th, width);
}

// ─── Custom editor ──────────────────────────────────────────────────

type Action =
  | { t: "openList" }
  | { t: "close" }
  | { t: "openAgent"; file: string | null }
  | { t: "newAgent"; prompt: string }
  | { t: "send"; file: string; text: string }
  | { t: "abort"; file: string };

class AgentEditor extends CustomEditor {
  private act: (a: Action) => void;

  constructor(tui: any, theme: any, kb: any, act: (a: Action) => void) {
    super(tui, theme, kb);
    this.act = act;
    view.tui = tui;
  }

  handleInput(data: string): void {
    const text = this.getText();
    const empty = !text || text.trim() === "";

    // ── Normal pi chat (Main agent) ──────────────────────────────
    if (view.mode === "hidden") {
      if (matchesKey(data, "left") && empty) {
        this.act({ t: "openList" });
        return;
      }
      super.handleInput(data);
      return;
    }

    // ── Help overlay ─────────────────────────────────────────────
    if (view.showHelp) {
      view.showHelp = false;
      rerender();
      return;
    }
    if (data === "?" && empty) {
      view.showHelp = true;
      rerender();
      return;
    }

    // ── Agent list ───────────────────────────────────────────────
    if (view.mode === "list") {
      if ((matchesKey(data, "left") || matchesKey(data, "escape")) && empty) {
        this.act({ t: "close" });
        return;
      }
      if (empty && (matchesKey(data, "up") || matchesKey(data, "ctrl+p"))) {
        view.selected = Math.max(0, view.selected - 1);
        rerender();
        return;
      }
      if (empty && (matchesKey(data, "down") || matchesKey(data, "ctrl+n"))) {
        view.selected = Math.min(view.rows.length - 1, view.selected + 1);
        rerender();
        return;
      }
      if (matchesKey(data, "enter")) {
        if (!empty) {
          const p = text!.trim();
          this.setText("");
          this.act({ t: "newAgent", prompt: p });
          return;
        }
        const r = view.rows[view.selected];
        if (r) this.act({ t: "openAgent", file: r.file });
        return;
      }
      if (matchesKey(data, "right") && empty) {
        const r = view.rows[view.selected];
        if (r) this.act({ t: "openAgent", file: r.file });
        return;
      }
      if (matchesKey(data, "ctrl+x") && empty) {
        const r = view.rows[view.selected];
        if (r?.file) this.act({ t: "abort", file: r.file });
        return;
      }
      super.handleInput(data);
      rerender();
      return;
    }

    // ── Focused sub-agent transcript ─────────────────────────────
    if ((matchesKey(data, "left") || matchesKey(data, "escape")) && empty) {
      this.act({ t: "openList" });
      return;
    }
    if (empty && matchesKey(data, "up")) {
      view.tScroll += 1;
      rerender();
      return;
    }
    if (empty && matchesKey(data, "down")) {
      view.tScroll = Math.max(0, view.tScroll - 1);
      rerender();
      return;
    }
    if (empty && matchesKey(data, "ctrl+u")) {
      view.tScroll += rowsHeight();
      rerender();
      return;
    }
    if (empty && matchesKey(data, "ctrl+d")) {
      view.tScroll = Math.max(0, view.tScroll - rowsHeight());
      rerender();
      return;
    }
    if (matchesKey(data, "ctrl+x") && empty) {
      this.act({ t: "abort", file: view.focused! });
      return;
    }
    if (matchesKey(data, "enter") && !empty) {
      const t = text!.trim();
      this.setText("");
      this.act({ t: "send", file: view.focused!, text: t });
      return;
    }
    super.handleInput(data);
    rerender();
  }
}

// ─── Extension ──────────────────────────────────────────────────────

export default function (pi: ExtensionAPI) {
  let refresh: ReturnType<typeof setInterval> | null = null;

  function refreshRows(ctx: ExtensionContext): void {
    const parent = view.parent ?? resolveParent(ctx);
    if (!parent) return;
    view.parent = parent;
    view.rows = buildRows(ctx, parent, view.focused);
    if (view.selected >= view.rows.length) view.selected = Math.max(0, view.rows.length - 1);
  }

  function showWidget(ctx: ExtensionContext): void {
    ctx.ui.setWidget("agent-views", (_tui, theme) => ({
      render: (w: number) => renderWidget(theme, w),
      invalidate: () => {},
    }));
  }

  function setMode(ctx: ExtensionContext, mode: Mode): void {
    view.mode = mode;
    view.showHelp = false;
    if (mode === "hidden") {
      ctx.ui.setWidget("agent-views", undefined);
      ctx.ui.setStatus("agent-views", undefined);
      if (refresh) {
        clearInterval(refresh);
        refresh = null;
      }
      return;
    }
    refreshRows(ctx);
    showWidget(ctx);
    if (!refresh) {
      refresh = setInterval(() => {
        if (view.mode === "hidden") return;
        refreshRows(ctx);
        rerender();
      }, 1000);
    }
  }

  function statusLine(ctx: ExtensionContext): void {
    const working = view.rows.filter((r) => r.state === "working" && !r.isMain).length;
    ctx.ui.setStatus(
      "agent-views",
      working > 0 ? ctx.ui.theme.fg("warning", `✽ ${working} agent${working > 1 ? "s" : ""}`) : undefined,
    );
  }

  // ── Commands ───────────────────────────────────────────────────

  pi.registerCommand("agents", {
    description: "Open Agent Views",
    handler: async (_a: string, ctx: ExtensionCommandContext) => {
      if (ctx.mode !== "tui") return;
      setMode(ctx, view.mode === "hidden" ? "list" : "hidden");
    },
  });

  pi.registerCommand("agent", {
    description: "Create a new agent with context from this conversation — /agent <task>",
    handler: async (args: string, ctx: ExtensionCommandContext) => {
      if (ctx.mode !== "tui") return;
      const task = args.trim();
      if (!task) {
        ctx.ui.notify("Usage: /agent <task>", "error");
        return;
      }
      const parent = resolveParent(ctx);
      if (!parent) return;

      const name = task.length > 40 ? task.slice(0, 40) + "…" : task;
      const file = createSubAgent(parent, name, ctx.cwd);

      // Give the new agent the conversation so far plus the task.
      // It reads the transcript itself and decides what matters.
      let convo = "";
      try {
        const parts: string[] = [];
        for (const e of ctx.sessionManager.getBranch()) {
          const en = e as any;
          if (en.type !== "message") continue;
          const m = en.message;
          const t = (m?.content ?? [])
            .filter((c: any) => c.type === "text")
            .map((c: any) => c.text)
            .join("\n");
          if (t) parts.push(`${m.role}: ${t}`);
        }
        convo = parts.join("\n\n");
      } catch {
        /* ignore */
      }

      const prompt = convo
        ? `Below is a conversation from another agent, followed by your task. Review the conversation, take what is relevant, and do the task.\n\n## Conversation\n\n${convo}\n\n## Your task\n\n${task}`
        : task;

      await runAgent(file, prompt, ctx.cwd, ctx.model, ctx.thinkingLevel);

      pi.sendMessage({
        customType: "agent-views:spawned",
        content: `→ Agent started: **${name}**\n\nRunning concurrently. Press ← to open Agent Views.`,
        display: true,
      });
      if (view.mode !== "hidden") refreshRows(ctx);
      statusLine(ctx);
      rerender();
    },
  });

  // ── Editor + lifecycle ─────────────────────────────────────────

  pi.on("session_start", (_e, ctx) => {
    if (ctx.mode !== "tui") return;

    view.mode = "hidden";
    view.focused = null;
    view.parent = resolveParent(ctx);

    // Any in-process agent change repaints the widget / status
    setOnChange(() => {
      if (view.mode !== "hidden") refreshRows(ctx);
      statusLine(ctx);
      rerender();
    });

    ctx.ui.setEditorComponent((tui, theme, kb) => {
      const ed = new AgentEditor(tui, theme, kb, (a) => {
        void (async () => {
          switch (a.t) {
            case "openList":
              setMode(ctx, "list");
              break;

            case "close":
              setMode(ctx, "hidden");
              break;

            case "openAgent": {
              if (a.file === null) {
                // Back to Main: pi-native rendering
                view.focused = null;
                setMode(ctx, "hidden");
                break;
              }
              view.focused = a.file;
              view.tScroll = 0;
              // Materialize the in-process session so we can stream it
              try {
                await ensureAgent(a.file, ctx.cwd, ctx.model, ctx.thinkingLevel);
              } catch (err) {
                ctx.ui.notify(`Failed to open agent: ${err}`, "error");
                break;
              }
              setMode(ctx, "transcript");
              break;
            }

            case "newAgent": {
              const parent = view.parent ?? resolveParent(ctx);
              if (!parent) break;
              const name = a.prompt.length > 40 ? a.prompt.slice(0, 40) + "…" : a.prompt;
              const file = createSubAgent(parent, name, ctx.cwd);
              await runAgent(file, a.prompt, ctx.cwd, ctx.model, ctx.thinkingLevel);
              view.focused = file;
              view.tScroll = 0;
              setMode(ctx, "transcript");
              break;
            }

            case "send":
              await steerAgent(a.file, a.text);
              view.tScroll = 0;
              break;

            case "abort":
              await abortAgent(a.file);
              break;
          }
          refreshRows(ctx);
          statusLine(ctx);
          rerender();
        })();
      });

      // Restore prompt history from Main's user messages
      try {
        for (const e of ctx.sessionManager.getBranch()) {
          const en = e as any;
          if (en.type === "message" && en.message?.role === "user") {
            for (const c of en.message.content ?? []) {
              if (c.type === "text" && c.text) ed.addToHistory(c.text);
            }
          }
        }
      } catch {
        /* ignore */
      }

      return ed;
    });
  });

  pi.on("session_shutdown", async () => {
    setOnChange(undefined);
    if (refresh) {
      clearInterval(refresh);
      refresh = null;
    }
    await disposeAll();
  });
}
