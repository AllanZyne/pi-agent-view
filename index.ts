/**
 * Agent Views — per-session agents, natively rendered, truly concurrent.
 *
 * Every agent is a real pi session running in the same process, so each one
 * gets the full native experience: live streaming, markdown, tool rendering,
 * footer stats, /compact, /tree, Ctrl+O — everything.
 *
 * Switching between agents uses `ctx.activateSession()`, which never tears
 * anything down. A background agent keeps working while you look at another
 * one, and you can come back to find it further along (or finished).
 *
 * Layout: a list widget above the editor. The transcript is pi's own.
 *
 *   ┌────────────────────────────┐
 *   │ ◆ Agents   (list widget)   │   ← only while the list is open
 *   ├────────────────────────────┤
 *   │ transcript (pi native)     │
 *   ├────────────────────────────┤
 *   │ editor  /  footer          │
 *   └────────────────────────────┘
 *
 * Keys
 *   ←            open/close the list (empty editor only)
 *   ↑ ↓          move selection (empty editor only)
 *   Enter / →    attach to the selected agent
 *   Enter + text spawn a new agent with that text as its first prompt
 *   Ctrl+X       abort the selected agent's current turn
 *   ? / Esc      help / close
 *
 * Commands
 *   /agent <task>   spawn a background agent and hand it <task>, without
 *                   leaving the current agent or interrupting it.
 *
 * Storage: sub-agent sessions live in
 *   <sessionDir>/__agents__/<rootId>/<agentId>.jsonl
 * with a sibling manifest.json. That directory is not scanned by
 * SessionManager.list(), so sub-agents stay out of /resume.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import {
  CustomEditor,
  SessionManager,
  type ExtensionAPI,
  type ExtensionCommandContext,
  type ExtensionContext,
  type LiveSessionInfo,
  type Theme,
} from "@earendil-works/pi-coding-agent";
import { matchesKey, truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";

// ── Storage ────────────────────────────────────────────────────────

interface AgentEntry {
  id: string;
  name: string;
  file: string;
  createdAt: string;
}

interface AgentManifest {
  rootId: string;
  rootFile: string;
  agents: AgentEntry[];
}

const AGENTS_DIR = "__agents__";

const groupDir = (sessionDir: string, rootId: string) => path.join(sessionDir, AGENTS_DIR, rootId);
const manifestFile = (sessionDir: string, rootId: string) => path.join(groupDir(sessionDir, rootId), "manifest.json");

function loadManifest(sessionDir: string, rootId: string): AgentManifest | null {
  try {
    return JSON.parse(fs.readFileSync(manifestFile(sessionDir, rootId), "utf-8")) as AgentManifest;
  } catch {
    return null;
  }
}

function saveManifest(sessionDir: string, m: AgentManifest): void {
  fs.mkdirSync(groupDir(sessionDir, m.rootId), { recursive: true });
  fs.writeFileSync(manifestFile(sessionDir, m.rootId), JSON.stringify(m, null, 2));
}

/** Root context: the top-level session that owns a group of agents. */
interface RootCtx {
  rootId: string;
  rootFile: string;
  sessionDir: string;
}

/**
 * Resolve the owning root regardless of which agent is currently active.
 *
 * Sub-agent files live at `<sessionDir>/__agents__/<rootId>/<id>.jsonl`, so we
 * can recover the root from the path alone. That makes every command work the
 * same whether you run it from the root agent or from a sub-agent.
 */
function resolveRoot(ctx: ExtensionContext): RootCtx | null {
  const file = ctx.sessionManager.getSessionFile();
  if (!file) return null;

  const marker = `${path.sep}${AGENTS_DIR}${path.sep}`;
  const at = file.indexOf(marker);
  if (at < 0) {
    return { rootId: ctx.sessionManager.getSessionId(), rootFile: file, sessionDir: path.dirname(file) };
  }

  const sessionDir = file.slice(0, at);
  const rootId = file.slice(at + marker.length).split(path.sep)[0]!;
  const manifest = loadManifest(sessionDir, rootId);
  if (!manifest) return null;
  return { rootId, rootFile: manifest.rootFile, sessionDir };
}

function registerAgent(root: RootCtx, name: string, cwd: string): string {
  const dir = groupDir(root.sessionDir, root.rootId);
  fs.mkdirSync(dir, { recursive: true });
  const sm = SessionManager.create(cwd, dir, { parentSession: root.rootFile });
  const file = sm.getSessionFile();
  if (!file) throw new Error("agent session is not persisted");

  const m = loadManifest(root.sessionDir, root.rootId) ?? {
    rootId: root.rootId,
    rootFile: root.rootFile,
    agents: [],
  };
  m.agents.push({ id: sm.getSessionId(), name, file, createdAt: new Date().toISOString() });
  saveManifest(root.sessionDir, m);

  // Name it up front so it shows up correctly in the list and in /resume-style
  // pickers without waiting for a first response.
  sm.appendSessionInfo(name);
  return file;
}

// ── Agent list model ───────────────────────────────────────────────

type AgentState = "working" | "idle" | "completed" | "failed";

interface AgentRow {
  key: string;
  name: string;
  isRoot: boolean;
  isActive: boolean;
  state: AgentState;
  messageCount: number;
  lastModified: Date;
  summary?: string;
  model?: string;
}

/** Read display info for an agent from its session file. */
function readAgentFile(file: string): Pick<AgentRow, "messageCount" | "lastModified" | "summary" | "model"> & {
  fileState: AgentState;
} {
  const fallback = { messageCount: 0, lastModified: new Date(0), fileState: "idle" as AgentState };
  try {
    const sm = SessionManager.open(file);
    const branch = sm.getBranch();
    const messageCount = sm.getEntries().filter((e) => e.type === "message").length;

    let model: string | undefined;
    let summary: string | undefined;
    let fileState: AgentState = "idle";

    for (let i = branch.length - 1; i >= 0; i--) {
      const entry = branch[i];
      if (entry.type !== "message" || entry.message.role !== "assistant") continue;
      const msg = entry.message;
      model ??= msg.model;
      if (msg.stopReason === "error" || msg.errorMessage) fileState = "failed";
      else if (fileState === "idle") fileState = "completed";
      if (!summary) {
        for (const part of msg.content ?? []) {
          if (part.type === "text" && part.text) {
            summary = part.text.replace(/\s+/g, " ").trim().slice(0, 300);
            break;
          }
        }
      }
      break;
    }

    return { messageCount, lastModified: fs.statSync(file).mtime, summary, model, fileState };
  } catch {
    return fallback;
  }
}

function buildRows(root: RootCtx, live: LiveSessionInfo[], cwd: string): AgentRow[] {
  const liveByKey = new Map(live.map((s) => [s.key, s]));
  const manifest = loadManifest(root.sessionDir, root.rootId);

  const make = (file: string, name: string, isRoot: boolean): AgentRow => {
    const info = readAgentFile(file);
    const liveInfo = liveByKey.get(file);
    return {
      key: file,
      name,
      isRoot,
      isActive: liveInfo?.active === true,
      // A live streaming session is authoritatively "working"; otherwise fall
      // back to what its transcript says.
      state: liveInfo?.isStreaming ? "working" : info.fileState,
      messageCount: info.messageCount,
      lastModified: info.lastModified,
      summary: info.summary,
      model: info.model,
    };
  };

  const rootName = liveByKey.get(root.rootFile)?.name ?? "Main";
  const rows = [make(root.rootFile, rootName, true)];
  for (const agent of manifest?.agents ?? []) {
    if (!fs.existsSync(agent.file)) continue;
    rows.push(make(agent.file, agent.name, false));
  }

  // Group order mirrors the rendered order so the selection index always
  // matches the visible row.
  const order: AgentState[] = ["working", "failed", "idle", "completed"];
  return rows.sort((a, b) => {
    const d = order.indexOf(a.state) - order.indexOf(b.state);
    return d !== 0 ? d : b.lastModified.getTime() - a.lastModified.getTime();
  });
}

// ── View state (survives per-session extension reloads) ────────────

interface ViewState {
  open: boolean;
  showHelp: boolean;
  rows: AgentRow[];
  selected: number;
  scroll: number;
  refresh?: () => void;
  timer?: NodeJS.Timeout;
}

const VIEW_KEY = "__piAgentViewsState";

function getView(): ViewState {
  const g = globalThis as Record<string, unknown>;
  if (!g[VIEW_KEY]) {
    g[VIEW_KEY] = { open: false, showHelp: false, rows: [], selected: 0, scroll: 0 } satisfies ViewState;
  }
  return g[VIEW_KEY] as ViewState;
}

// ── Rendering ──────────────────────────────────────────────────────

const STATE_LABEL: Record<AgentState, string> = {
  working: "Working",
  failed: "Failed",
  idle: "Idle",
  completed: "Completed",
};

function relativeTime(d: Date): string {
  const s = Math.max(0, Math.floor((Date.now() - d.getTime()) / 1000));
  if (s < 60) return `${s}s`;
  if (s < 3600) return `${Math.floor(s / 60)}m`;
  if (s < 86400) return `${Math.floor(s / 3600)}h`;
  return `${Math.floor(s / 86400)}d`;
}

function clip(s: string, n: number): string {
  return s.length <= n ? s : `${s.slice(0, Math.max(1, n - 1))}…`;
}

function renderList(view: ViewState, th: Theme, width: number): string[] {
  if (!view.open) return [];
  const out: string[] = [];
  const rule = th.fg("dim", "─".repeat(Math.max(4, Math.min(width - 4, 100))));

  if (view.showHelp) {
    out.push(truncateToWidth(`  ${th.fg("accent", th.bold("Agents — keys"))}`, width));
    out.push(truncateToWidth(`  ${rule}`, width));
    for (const [k, d] of [
      ["↑ ↓", "Select agent"],
      ["Enter / →", "Attach to selected agent"],
      ["Enter + text", "Spawn a new agent with that prompt"],
      ["Ctrl+X", "Abort the selected agent's turn"],
      ["← / Esc", "Close"],
      ["/agent <task>", "Spawn a background agent without leaving this one"],
    ] as const) {
      out.push(truncateToWidth(`    ${th.fg("accent", k.padEnd(15))}${th.fg("text", d)}`, width));
    }
    out.push(truncateToWidth(`  ${th.fg("dim", "? to close help")}`, width));
    return out;
  }

  const working = view.rows.filter((r) => r.state === "working").length;
  const title = th.fg("accent", th.bold("◆ Agents"));
  const count = th.fg("muted", `${view.rows.length} agent${view.rows.length === 1 ? "" : "s"}`);
  const busy = working > 0 ? th.fg("warning", ` · ${working} working`) : "";
  out.push(truncateToWidth(`  ${title}  ${count}${busy}`, width));
  out.push(truncateToWidth(`  ${rule}`, width));

  const maxRows = Math.max(3, (process.stdout.rows || 30) - 16);
  if (view.scroll > 0) out.push(truncateToWidth(th.fg("dim", `  ↑ ${view.scroll} more`), width));

  const end = Math.min(view.scroll + maxRows, view.rows.length);
  let lastState: AgentState | undefined;

  for (let i = view.scroll; i < end; i++) {
    const row = view.rows[i]!;
    if (row.state !== lastState) {
      lastState = row.state;
      const n = view.rows.filter((r) => r.state === row.state).length;
      out.push(truncateToWidth(`  ${th.fg("muted", `${STATE_LABEL[row.state]} (${n})`)}`, width));
    }

    const icon =
      row.state === "working"
        ? th.fg("warning", "✽")
        : row.state === "failed"
          ? th.fg("error", "✗")
          : row.state === "completed"
            ? th.fg("success", "✓")
            : th.fg("dim", "∙");

    const pointer = i === view.selected ? th.fg("accent", " ▸ ") : "   ";
    const name = clip(row.name || "(unnamed)", 40);
    const nameStr = i === view.selected ? th.fg("accent", name) : th.fg("text", name);
    const tags =
      (row.isRoot ? th.fg("dim", " [main]") : "") + (row.isActive ? th.fg("success", " (attached)") : "");
    const time = th.fg("dim", relativeTime(row.lastModified));

    const left = pointer + icon + " " + nameStr + tags;
    const gap = Math.max(1, width - visibleWidth(left) - visibleWidth(time) - 2);
    out.push(truncateToWidth(left + " ".repeat(gap) + time, width));

    const meta = th.fg("muted", `${row.messageCount} msg${row.messageCount === 1 ? "" : "s"}`);
    const model = row.model ? th.fg("dim", ` · ${clip(row.model, 28)}`) : "";
    const summary = row.summary ? th.fg("dim", `  ${clip(row.summary, Math.max(10, width - 46))}`) : "";
    out.push(truncateToWidth(`     ${meta}${model}${summary}`, width));
  }

  if (end < view.rows.length) {
    out.push(truncateToWidth(th.fg("dim", `  ↓ ${view.rows.length - end} more`), width));
  }

  out.push(truncateToWidth(`  ${rule}`, width));
  out.push(
    truncateToWidth(
      `  ${th.fg("dim", "↑↓ select · ⏎ attach · type+⏎ new agent · ctrl+x abort · ← close · ? help")}`,
      width,
    ),
  );
  return out;
}

// ── Editor ─────────────────────────────────────────────────────────

type Action =
  | { t: "open" }
  | { t: "close" }
  | { t: "help" }
  | { t: "attach"; key: string }
  | { t: "spawn"; prompt: string }
  | { t: "abort"; key: string };

class AgentViewEditor extends CustomEditor {
  constructor(
    tui: ConstructorParameters<typeof CustomEditor>[0],
    theme: ConstructorParameters<typeof CustomEditor>[1],
    kb: ConstructorParameters<typeof CustomEditor>[2],
    private readonly view: ViewState,
    private readonly act: (a: Action) => void,
  ) {
    super(tui, theme, kb, { embedWorkingStatus: true });
  }

  override handleInput(data: string): void {
    const empty = this.getText().length === 0;
    const view = this.view;

    // ← on an empty editor is the single entry point.
    if (!view.open) {
      if (empty && matchesKey(data, "left")) {
        this.act({ t: "open" });
        return;
      }
      super.handleInput(data);
      return;
    }

    if (empty && (matchesKey(data, "left") || matchesKey(data, "escape"))) {
      this.act(view.showHelp ? { t: "help" } : { t: "close" });
      return;
    }
    if (empty && data === "?") {
      this.act({ t: "help" });
      return;
    }
    if (empty && matchesKey(data, "ctrl+x")) {
      const row = view.rows[view.selected];
      if (row) this.act({ t: "abort", key: row.key });
      return;
    }

    // ↑/↓ drive the list only while the editor is empty, so prompt history
    // still works as soon as you start typing.
    if (empty && (matchesKey(data, "up") || matchesKey(data, "down"))) {
      const delta = matchesKey(data, "up") ? -1 : 1;
      view.selected = Math.max(0, Math.min(view.rows.length - 1, view.selected + delta));
      const maxRows = Math.max(3, (process.stdout.rows || 30) - 16);
      if (view.selected < view.scroll) view.scroll = view.selected;
      else if (view.selected >= view.scroll + maxRows) view.scroll = view.selected - maxRows + 1;
      view.refresh?.();
      return;
    }

    if (matchesKey(data, "return") || matchesKey(data, "enter")) {
      const text = this.getText().trim();
      if (text) {
        this.setText("");
        this.act({ t: "spawn", prompt: text });
      } else {
        const row = view.rows[view.selected];
        if (row) this.act(row.isActive ? { t: "close" } : { t: "attach", key: row.key });
      }
      return;
    }

    if (empty && matchesKey(data, "right")) {
      const row = view.rows[view.selected];
      if (row) this.act(row.isActive ? { t: "close" } : { t: "attach", key: row.key });
      return;
    }

    super.handleInput(data);
  }
}

// ── Extension ──────────────────────────────────────────────────────

export default function agentViews(pi: ExtensionAPI): void {
  const view = getView();

  function close(ctx: ExtensionContext): void {
    view.open = false;
    view.showHelp = false;
    if (view.timer) {
      clearInterval(view.timer);
      view.timer = undefined;
    }
    ctx.ui.setWidget("agent-views", undefined);
  }

  function open(ctx: ExtensionCommandContext): void {
    const root = resolveRoot(ctx);
    if (!root) {
      ctx.ui.notify("Agents need a saved session", "error");
      return;
    }

    const reload = () => {
      view.rows = buildRows(root, ctx.listLiveSessions(), ctx.cwd);
      view.selected = Math.max(0, Math.min(view.selected, view.rows.length - 1));
    };

    reload();
    // Keep the selection on the attached agent when first opening.
    const attached = view.rows.findIndex((r) => r.isActive);
    if (attached >= 0) view.selected = attached;
    view.scroll = 0;
    view.showHelp = false;
    view.open = true;

    ctx.ui.setWidget("agent-views", (tui, theme) => {
      view.refresh = () => tui.requestRender();
      return {
        render: (w: number) => renderList(view, theme, w),
        invalidate: () => {},
      };
    });

    // Background agents change state on their own, so poll while open.
    if (view.timer) clearInterval(view.timer);
    view.timer = setInterval(() => {
      if (!view.open) return;
      reload();
      view.refresh?.();
    }, 1500);
  }

  /** Bring an agent to the foreground, reviving it from disk if needed. */
  async function attach(ctx: ExtensionCommandContext, key: string): Promise<void> {
    const live = ctx.listLiveSessions();
    if (!live.some((s) => s.key === key)) {
      // Not running in this process yet (e.g. created in an earlier pi run).
      await ctx.spawnSession({ sessionFile: key });
    }
    close(ctx);
    // Nothing is torn down: whatever we were looking at keeps running.
    if (!(await ctx.activateSession(key))) {
      ctx.ui.notify("Could not attach to that agent", "error");
    }
  }

  async function spawn(
    ctx: ExtensionCommandContext,
    prompt: string,
    options: { attach: boolean },
  ): Promise<string | undefined> {
    const root = resolveRoot(ctx);
    if (!root) {
      ctx.ui.notify("Agents need a saved session", "error");
      return undefined;
    }

    const name = prompt.length > 48 ? `${prompt.slice(0, 48)}…` : prompt;
    const file = registerAgent(root, name, ctx.cwd);
    const { key } = await ctx.spawnSession({ sessionFile: file, parentSession: root.rootFile });

    // Give it the task. This returns as soon as the turn is queued, so the
    // agent we are sitting in is never blocked or interrupted.
    await ctx.promptLiveSession(key, prompt);

    if (options.attach) await attach(ctx, key);
    return key;
  }

  // ── Commands ───────────────────────────────────────────────────
  //
  // Extension commands execute immediately even while the agent is streaming,
  // which is what lets these run without interrupting the current turn.

  pi.registerCommand("agent", {
    description: "Spawn a background agent for a task — /agent <task>",
    handler: async (args, ctx) => {
      const task = args.trim();
      if (!task) {
        ctx.ui.notify("Usage: /agent <task>", "error");
        return;
      }
      const key = await spawn(ctx, task, { attach: false });
      if (!key) return;
      ctx.ui.notify("Agent started in the background. Press ← to see it.", "info");
      if (view.open) open(ctx);
    },
  });

  pi.registerCommand("__av-attach", {
    description: "(internal) attach to an agent",
    handler: async (args, ctx) => {
      const key = args.trim();
      if (key) await attach(ctx, key);
    },
  });

  pi.registerCommand("__av-spawn", {
    description: "(internal) spawn an agent and attach",
    handler: async (args, ctx) => {
      const prompt = args.trim();
      if (prompt) await spawn(ctx, prompt, { attach: true });
    },
  });

  pi.registerCommand("__av-abort", {
    description: "(internal) abort an agent's turn",
    handler: async (args, ctx) => {
      const key = args.trim();
      if (!key) return;
      if (await ctx.abortLiveSession(key)) {
        ctx.ui.notify("Aborted", "info");
        if (view.open) open(ctx);
      }
    },
  });

  pi.registerCommand("__av-open", {
    description: "(internal) open the agent list",
    handler: async (_args, ctx) => {
      if (view.open) close(ctx);
      else open(ctx);
    },
  });

  // ── Editor ─────────────────────────────────────────────────────

  pi.on("session_start", (_event, ctx) => {
    if (ctx.mode !== "tui") return;

    // The widget belongs to whichever session is active, so drop it on rebind.
    view.open = false;
    if (view.timer) {
      clearInterval(view.timer);
      view.timer = undefined;
    }
    ctx.ui.setWidget("agent-views", undefined);

    ctx.ui.setEditorComponent((tui, theme, kb) => {
      const editor = new AgentViewEditor(tui, theme, kb, view, (action) => {
        switch (action.t) {
          case "open":
            pi.sendUserMessage("/__av-open", { expandPromptTemplates: true });
            break;
          case "close":
            close(ctx);
            break;
          case "help":
            view.showHelp = !view.showHelp;
            view.refresh?.();
            break;
          case "attach":
            pi.sendUserMessage(`/__av-attach ${action.key}`, { expandPromptTemplates: true });
            break;
          case "spawn":
            pi.sendUserMessage(`/__av-spawn ${action.prompt}`, { expandPromptTemplates: true });
            break;
          case "abort":
            pi.sendUserMessage(`/__av-abort ${action.key}`, { expandPromptTemplates: true });
            break;
        }
      });

      // Restore prompt history so ↑/↓ recall still works after attaching to a
      // different agent.
      try {
        for (const entry of ctx.sessionManager.getBranch()) {
          if (entry.type !== "message" || entry.message.role !== "user") continue;
          const content = entry.message.content;
          const text =
            typeof content === "string"
              ? content
              : content
                  ?.filter((c): c is { type: "text"; text: string } => c.type === "text")
                  .map((c) => c.text)
                  .join("");
          if (text && !text.startsWith("/__av-")) editor.addToHistory(text);
        }
      } catch {
        /* history is best-effort */
      }

      return editor;
    });
  });

  pi.on("session_shutdown", (_event, ctx) => {
    if (view.timer) {
      clearInterval(view.timer);
      view.timer = undefined;
    }
    view.open = false;
    ctx.ui.setWidget("agent-views", undefined);
  });
}
