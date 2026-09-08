/**
 * Agent Views — per-session agent management
 *
 * Data model:
 *   Session (pi-managed, appears in /resume)
 *   ├── Agent 1 (the session itself — default agent)
 *   ├── Agent 2 (sub-session in __agents__/ dir, hidden from /resume)
 *   └── Agent 3 (sub-session)
 *
 * When you press ← on an empty editor, Agent Views shows the agents
 * belonging to the current session. Type text and press Enter to
 * dispatch a new agent. ↑/↓ navigate, Enter/→ attach, ← close.
 *
 * Sub-agent sessions are stored in:
 *   <sessionDir>/__agents__/<parentId>/<agentId>.jsonl
 * with a manifest at:
 *   <sessionDir>/__agents__/<parentId>/manifest.json
 */

import { spawn } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import {
  CustomEditor,
  type ExtensionAPI,
  type ExtensionCommandContext,
  type ExtensionContext,
  type Theme,
  SessionManager,
  convertToLlm,
  serializeConversation,
} from "@earendil-works/pi-coding-agent";
import {
  matchesKey,
  truncateToWidth,
  visibleWidth,
} from "@earendil-works/pi-tui";

// ─── Agent Manifest ─────────────────────────────────────────────────

interface AgentEntry {
  id: string;
  name: string;
  file: string;
  createdAt: string;
  /** Optional model override: "provider/modelId". When absent, inherits the main agent's model. */
  model?: string;
}

interface AgentManifest {
  parentId: string;
  parentFile: string;
  agents: AgentEntry[];
}

function agentsBaseDir(sessionDir: string): string {
  return path.join(sessionDir, "__agents__");
}

function agentGroupDir(sessionDir: string, parentId: string): string {
  return path.join(agentsBaseDir(sessionDir), parentId);
}

function manifestPath(sessionDir: string, parentId: string): string {
  return path.join(agentGroupDir(sessionDir, parentId), "manifest.json");
}

function loadManifest(sessionDir: string, parentId: string): AgentManifest | null {
  const p = manifestPath(sessionDir, parentId);
  try {
    return JSON.parse(fs.readFileSync(p, "utf-8"));
  } catch {
    return null;
  }
}

function saveManifest(sessionDir: string, manifest: AgentManifest): void {
  const dir = agentGroupDir(sessionDir, manifest.parentId);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(manifestPath(sessionDir, manifest.parentId), JSON.stringify(manifest, null, 2));
}

/** Check if a session file is a sub-agent by path convention */
function isSubAgent(sessionFile: string): boolean {
  return sessionFile.includes("/__agents__/");
}

/** Extract parent ID from a sub-agent's file path */
function parentIdFromAgentPath(sessionFile: string): string | null {
  const match = sessionFile.match(/__agents__\/([^/]+)\//);
  return match?.[1] ?? null;
}

/** Derive session dir from a session file (go up to the encoded-cwd dir) */
function sessionDirFromFile(sessionFile: string): string {
  if (isSubAgent(sessionFile)) {
    // ../__agents__/<parentId>/agent.jsonl → go up past __agents__
    const idx = sessionFile.indexOf("/__agents__/");
    return sessionFile.slice(0, idx);
  }
  return path.dirname(sessionFile);
}

// ─── Agent Info for display ─────────────────────────────────────────

type AgentState = "working" | "completed" | "failed" | "idle";

interface AgentInfo {
  id: string;
  name: string;
  file: string;
  isCurrent: boolean;
  isDefault: boolean;
  messageCount: number;
  lastModified: Date;
  lastAssistantText?: string;
  model?: string;
  configuredModel?: string;
  state: AgentState;
}

function loadAgentInfo(file: string, currentFile: string | undefined): AgentInfo | null {
  try {
    const sm = SessionManager.open(file);
    const branch = sm.getBranch();
    const entries = sm.getEntries();
    const msgCount = entries.filter((e: any) => e.type === "message").length;

    let model: string | undefined;
    let lastText: string | undefined;
    for (let i = branch.length - 1; i >= 0; i--) {
      const e = branch[i] as any;
      if (e.type === "message" && e.message?.role === "assistant") {
        model ??= e.message.model;
        if (!lastText) {
          for (const c of e.message.content ?? []) {
            if (c.type === "text" && c.text) {
              lastText = c.text.slice(0, 300).replace(/\n/g, " ");
              break;
            }
          }
        }
        if (model && lastText) break;
      }
    }

    // Detect session-level state from entries
    let sessionState: AgentState = "idle";
    if (msgCount > 0) {
      const last = branch[branch.length - 1] as any;
      if (last?.type === "message" && last.message?.role === "assistant") {
        // Check if the assistant message indicates an error
        if (last.message.stopReason === "error" || last.message.errorMessage) {
          sessionState = "failed";
        } else {
          sessionState = "completed";
        }
      }
    }

    // Override with background process state (working/failed takes precedence)
    const state = getAgentState(file, sessionState);

    const stat = fs.statSync(file);

    return {
      id: sm.getSessionId(),
      name: sm.getSessionName() ?? "",
      file,
      isCurrent: currentFile === file,
      isDefault: false,
      messageCount: msgCount,
      lastModified: stat.mtime,
      lastAssistantText: lastText,
      model,
      state,
    };
  } catch {
    return null;
  }
}

// ─── Resolve parent context from any session ────────────────────────

interface ParentContext {
  parentId: string;
  parentFile: string;
  sessionDir: string;
}

function resolveParent(ctx: ExtensionContext): ParentContext | null {
  const currentFile = ctx.sessionManager.getSessionFile();
  if (!currentFile) return null;

  if (isSubAgent(currentFile)) {
    const parentId = parentIdFromAgentPath(currentFile);
    if (!parentId) return null;
    const sessionDir = sessionDirFromFile(currentFile);
    const manifest = loadManifest(sessionDir, parentId);
    return manifest
      ? { parentId: manifest.parentId, parentFile: manifest.parentFile, sessionDir }
      : null;
  }

  // Current session IS the parent
  return {
    parentId: ctx.sessionManager.getSessionId(),
    parentFile: currentFile,
    sessionDir: sessionDirFromFile(currentFile),
  };
}

/** List all agents for a parent session */
function listAgents(parent: ParentContext, currentFile: string | undefined): AgentInfo[] {
  const agents: AgentInfo[] = [];

  // Agent 0: the parent session itself (default agent)
  const parentInfo = loadAgentInfo(parent.parentFile, currentFile);
  if (parentInfo) {
    parentInfo.isDefault = true;
    parentInfo.name = parentInfo.name || "Main";
    agents.push(parentInfo);
  }

  // Sub-agents from manifest
  const manifest = loadManifest(parent.sessionDir, parent.parentId);
  if (manifest) {
    for (const entry of manifest.agents) {
      const info = loadAgentInfo(entry.file, currentFile);
      if (info) {
        info.name = entry.name || info.name || `Agent ${agents.length + 1}`;
        info.configuredModel = entry.model;
        agents.push(info);
      }
    }
  }

  return agents;
}

/** Create a new sub-agent and return its file path */
function createSubAgent(parent: ParentContext, opts: { name: string; cwd: string; model?: string }): string {
  const dir = agentGroupDir(parent.sessionDir, parent.parentId);
  fs.mkdirSync(dir, { recursive: true });

  // Create session in the agents subdirectory
  const sm = SessionManager.create(opts.cwd, dir, { parentSession: parent.parentFile });
  const file = sm.getSessionFile()!;

  // Update manifest
  let manifest = loadManifest(parent.sessionDir, parent.parentId);
  if (!manifest) {
    manifest = { parentId: parent.parentId, parentFile: parent.parentFile, agents: [] };
  }
  manifest.agents.push({
    id: sm.getSessionId(),
    name: opts.name,
    file,
    createdAt: new Date().toISOString(),
    model: opts.model,
  });
  saveManifest(parent.sessionDir, manifest);

  return file;
}


// ─── Helpers ────────────────────────────────────────────────────────

function relativeTime(date: Date): string {
  const diff = Date.now() - date.getTime();
  const s = Math.floor(diff / 1000);
  if (s < 60) return "just now";
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h`;
  const d = Math.floor(h / 24);
  return d < 7 ? `${d}d` : date.toLocaleDateString();
}

function clip(str: string, max: number): string {
  return str.length <= max ? str : str.slice(0, max - 1) + "…";
}

// ─── Shared State ───────────────────────────────────────────────────

interface ViewState {
  active: boolean;
  agents: AgentInfo[];
  selected: number;
  scroll: number;
  peekIdx: number;
  showHelp: boolean;
  parent: ParentContext | null;
  widgetInvalidate?: () => void;
  tui?: any;
}

function createViewState(): ViewState {
  return {
    active: false, agents: [], selected: 0, scroll: 0,
    peekIdx: -1, showHelp: false, parent: null,
  };
}

function ensureVisible(st: ViewState): void {
  const mv = Math.max(3, (process.stdout.rows || 30) - 14);
  if (st.selected < st.scroll) st.scroll = st.selected;
  else if (st.selected >= st.scroll + mv) st.scroll = st.selected - mv + 1;
}

function reqRender(st: ViewState): void {
  st.widgetInvalidate?.();
  st.tui?.requestRender();
}

// ─── Widget Renderer ────────────────────────────────────────────────

function renderWidget(st: ViewState, theme: Theme, width: number): string[] {
  if (!st.active) return [];
  const th = theme;
  const lines: string[] = [];

  // Help
  if (st.showHelp) {
    lines.push(truncateToWidth("  " + th.fg("accent", th.bold("Agent Views — Shortcuts")), width));
    lines.push(truncateToWidth("  " + th.fg("dim", "─".repeat(Math.min(width - 4, 60))), width));
    for (const [k, d] of [
      ["↑ / ↓", "Navigate agents"],
      ["Enter / →", "Attach to agent"],
      ["← / Esc", "Close agent view"],
      ["Space", "Toggle peek panel"],
      ["?", "Toggle help"],
      ["", "Type text + Enter → dispatch new agent"],
      ["", "/model in agent → change its model"],
    ] as const)
      lines.push(truncateToWidth("    " + th.fg("accent", k.padEnd(16)) + th.fg("text", d), width));
    lines.push(truncateToWidth("  " + th.fg("dim", "Press ? to close"), width));
    return lines;
  }

  // Header
  const title = th.fg("accent", th.bold("◆ Agents"));
  const cnt = th.fg("muted", `${st.agents.length} agent${st.agents.length !== 1 ? "s" : ""}`);
  lines.push(truncateToWidth("  " + title + "  " + cnt, width));
  lines.push(truncateToWidth("  " + th.fg("dim", "─".repeat(Math.min(width - 4, 100))), width));

  // Agent list — grouped by state
  const maxVis = Math.max(3, (process.stdout.rows || 30) - 14);
  const peekOpen = st.peekIdx >= 0 && st.peekIdx < st.agents.length;
  const peekH = peekOpen ? Math.min(5, Math.max(2, Math.floor(maxVis / 4))) : 0;
  const listH = maxVis - peekH;

  // Group agents by state
  const stateOrder: AgentState[] = ["working", "failed", "idle", "completed"];
  const stateLabels: Record<AgentState, string> = {
    working: "Working", failed: "Failed", idle: "Idle", completed: "Completed",
  };
  const stateColors: Record<AgentState, string> = {
    working: "warning", failed: "error", idle: "muted", completed: "success",
  };
  const groups: Record<string, AgentInfo[]> = {};
  for (const a of st.agents) (groups[a.state] ??= []).push(a);

  // Build flat list with group headers
  type FlatItem = { kind: "hdr"; label: string; n: number; state: AgentState }
                | { kind: "row"; a: AgentInfo; gi: number };
  const flat: FlatItem[] = [];
  let gi = 0;
  for (const s of stateOrder) {
    const g = groups[s];
    if (g && g.length > 0) {
      flat.push({ kind: "hdr", label: stateLabels[s], n: g.length, state: s });
      for (const a of g) { flat.push({ kind: "row", a, gi }); gi++; }
    }
  }

  // Scroll to first visible item
  let fi = 0; let seen = 0;
  for (let i = 0; i < flat.length; i++) {
    if (flat[i].kind === "row") {
      if (seen === st.scroll) { fi = i; if (i > 0 && flat[i - 1].kind === "hdr") fi = i - 1; break; }
      seen++;
    }
  }

  if (st.scroll > 0) {
    lines.push(truncateToWidth(th.fg("dim", "  ↑ " + st.scroll + " above"), width));
  }

  let rendered = 0;
  for (let i = fi; i < flat.length && rendered < listH - 1; i++) {
    const it = flat[i];
    if (it.kind === "hdr") {
      const hdrColor = stateColors[it.state] as any;
      lines.push(truncateToWidth("  " + th.fg(hdrColor, th.bold(it.label)) + th.fg("dim", ` (${it.n})`), width));
      rendered++;
      continue;
    }
    const a = it.a;
    const sel = it.gi === st.selected;

    // State icon
    let icon: string;
    if (a.isCurrent) icon = th.fg("accent", "●");
    else switch (a.state) {
      case "working":   icon = th.fg("warning", "✽"); break;
      case "failed":    icon = th.fg("error", "✗"); break;
      case "completed": icon = th.fg("success", "✓"); break;
      default:          icon = th.fg("dim", "∙");
    }

    const ptr = sel ? th.fg("accent", " ▸ ") : "   ";
    const tag = a.isDefault ? th.fg("dim", " [main]") : "";
    const curBadge = a.isCurrent ? th.fg("success", " (active)") : "";
    const dn = a.name ? clip(a.name, 35) : th.fg("dim", a.id.slice(0, 12));
    const nameStr = sel ? th.fg("accent", dn) : dn;
    const time = th.fg("dim", relativeTime(a.lastModified));

    const left = ptr + icon + " " + nameStr + tag + curBadge;
    const gap = Math.max(1, width - visibleWidth(left) - visibleWidth(time) - 2);
    lines.push(truncateToWidth(left + " ".repeat(gap) + time, width));

    // Detail line
    const msgs = `${a.messageCount} msg${a.messageCount !== 1 ? "s" : ""}`;
    const modelLabel = a.configuredModel
      ? th.fg("accent", a.configuredModel)
      : a.model ? th.fg("dim", a.model) : "";
    const mdl = modelLabel ? ` · ${clip(modelLabel, 30)}` : "";
    const sum = a.lastAssistantText ? "  " + clip(a.lastAssistantText, Math.max(10, width - 40)) : "";
    lines.push(truncateToWidth("     " + th.fg("muted", msgs) + mdl + th.fg("dim", sum), width));
    rendered += 2;
  }

  const endVis = st.scroll + Math.floor(listH / 2);
  if (endVis < st.agents.length) {
    lines.push(truncateToWidth(th.fg("dim", "  ↓ " + (st.agents.length - endVis) + " below"), width));
  }


  // Peek
  if (peekOpen) {
    const ps = st.agents[st.peekIdx]!;
    lines.push(truncateToWidth("  " + th.fg("dim", "─".repeat(Math.min(width - 4, 100))), width));
    lines.push(truncateToWidth(
      "  " + th.fg("accent", th.bold("Peek: ")) + th.fg("text", ps.name || ps.id.slice(0, 12)), width));
    if (ps.lastAssistantText) {
      const words = ps.lastAssistantText.split(/\s+/);
      let line = ""; let lc = 0;
      for (const w of words) {
        if (lc >= peekH - 2) break;
        if (line.length + w.length + 1 > width - 8) {
          lines.push(truncateToWidth("    " + th.fg("muted", line), width)); line = w; lc++;
        } else line = line ? line + " " + w : w;
      }
      if (line && lc < peekH - 2) lines.push(truncateToWidth("    " + th.fg("muted", line), width));
    } else {
      lines.push(truncateToWidth("    " + th.fg("dim", "(no output yet)"), width));
    }
  }

  // Hints
  lines.push(truncateToWidth("  " + th.fg("dim", "─".repeat(Math.min(width - 4, 100))), width));
  lines.push(truncateToWidth(
    "  " +
    th.fg("dim", "↑↓") + th.fg("muted", " nav") +
    th.fg("dim", "  ⏎") + th.fg("muted", " attach") +
    th.fg("dim", "  ←") + th.fg("muted", " back") +
    th.fg("dim", "  space") + th.fg("muted", " peek") +
    th.fg("dim", "  ?") + th.fg("muted", " help") +
    th.fg("dim", "  ") + th.fg("muted", "type + ⏎ = new agent"),
    width));

  return lines;
}

// ─── Custom Editor ──────────────────────────────────────────────────

class AgentViewEditor extends CustomEditor {
  private st: ViewState;
  private act: (action: string, arg?: string) => void;

  constructor(tui: any, theme: any, kb: any, st: ViewState, act: (a: string, arg?: string) => void) {
    super(tui, theme, kb);
    this.st = st;
    this.act = act;
    st.tui = tui;
  }

  handleInput(data: string): void {
    const st = this.st;
    const text = this.getText();
    const empty = !text || text.trim() === "";

    // ── Not in agent view ────────────────────────────────────────
    if (!st.active) {
      if (matchesKey(data, "left") && empty) { this.act("open"); return; }
      super.handleInput(data);
      return;
    }

    // ── In agent view ────────────────────────────────────────────

    if (st.showHelp) { st.showHelp = false; reqRender(st); return; }
    if (data === "?") { st.showHelp = true; reqRender(st); return; }

    // Close
    if ((matchesKey(data, "left") && empty) || matchesKey(data, "escape")) {
      if (matchesKey(data, "escape") && st.peekIdx >= 0) {
        st.peekIdx = -1; reqRender(st); return;
      }
      this.act("close"); return;
    }

    // Navigation (only when editor is empty)
    if (empty && (matchesKey(data, "up") || matchesKey(data, "ctrl+p"))) {
      st.selected = Math.max(0, st.selected - 1);
      ensureVisible(st); reqRender(st); return;
    }
    if (empty && (matchesKey(data, "down") || matchesKey(data, "ctrl+n"))) {
      st.selected = Math.min(st.agents.length - 1, st.selected + 1);
      ensureVisible(st); reqRender(st); return;
    }
    if (empty && matchesKey(data, "ctrl+u")) {
      st.selected = Math.max(0, st.selected - 10);
      ensureVisible(st); reqRender(st); return;
    }
    if (empty && matchesKey(data, "ctrl+d")) {
      st.selected = Math.min(st.agents.length - 1, st.selected + 10);
      ensureVisible(st); reqRender(st); return;
    }

    // Peek
    if (matchesKey(data, "space") && empty) {
      st.peekIdx = st.peekIdx === st.selected ? -1 : st.selected;
      reqRender(st); return;
    }

    // Model change for selected agent
    if (data === "m" && empty) {
      // Not handled here — user should attach to the agent and use /model
    }

    // Attach
    if (matchesKey(data, "enter")) {
      if (!empty) {
        const t = text!.trim(); this.setText("");
        this.act("dispatch", t); return;
      }
      const a = st.agents[st.selected];
      if (a) {
        if (a.isCurrent) this.act("close");
        else this.act("switch", a.file);
      }
      return;
    }
    if (matchesKey(data, "right") && empty) {
      const a = st.agents[st.selected];
      if (a && !a.isCurrent) this.act("switch", a.file);
      else if (a?.isCurrent) this.act("close");
      return;
    }

    // Normal editor input (typing dispatch text)
    super.handleInput(data);
    reqRender(st);
  }
}

// ─── Extension ──────────────────────────────────────────────────────

// ── Background process tracking ───────────────────────────────────────

interface BgProcess {
  proc: ReturnType<typeof spawn>;
  startedAt: number;
}

interface BgResult {
  exitCode: number;
  finishedAt: number;
}

/** Track running background agents and their results */
const bgRunning = new Map<string, BgProcess>();   // agentFile -> running process
const bgFinished = new Map<string, BgResult>();    // agentFile -> exit result

function getAgentState(agentFile: string, sessionState: AgentState): AgentState {
  if (bgRunning.has(agentFile)) return "working";
  const result = bgFinished.get(agentFile);
  if (result) return result.exitCode === 0 ? "completed" : "failed";
  return sessionState;
}

// ── Background pi subprocess ───────────────────────────────────────────

function getPiInvocation(args: string[]): { command: string; args: string[] } {
  const currentScript = process.argv[1];
  if (currentScript && !currentScript.startsWith("/$bunfs/") && fs.existsSync(currentScript)) {
    return { command: process.execPath, args: [currentScript, ...args] };
  }
  const execName = path.basename(process.execPath).toLowerCase();
  if (!/^(node|bun)(\.exe)?$/.test(execName)) {
    return { command: process.execPath, args };
  }
  return { command: "pi", args };
}

/** Spawn a pi subprocess to process a session in the background.
 *  Writes the prompt to a temp file, runs `pi -p --session <file> @<tempfile>`, and cleans up. */
function runAgentInBackground(
  sessionFile: string,
  prompt: string,
  cwd: string,
  model?: string,
): void {
  // Write prompt to temp file (avoids shell arg length limits)
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-agent-"));
  const promptFile = path.join(tmpDir, "prompt.md");
  fs.writeFileSync(promptFile, prompt, "utf-8");

  const args = ["-p", "--session", sessionFile, "--no-context-files"];
  if (model) args.push("--model", model);
  args.push(`@${promptFile}`);

  // Capture output to a log file so failures are diagnosable
  const logFile = path.join(tmpDir, "agent.log");
  const logFd = fs.openSync(logFile, "a");

  const invocation = getPiInvocation(args);
  const proc = spawn(invocation.command, invocation.args, {
    cwd,
    shell: false,
    stdio: ["ignore", logFd, logFd],
    detached: true,
  });

  // Track as running
  bgRunning.set(sessionFile, { proc, startedAt: Date.now() });

  proc.on("error", (err) => {
    bgRunning.delete(sessionFile);
    bgFinished.set(sessionFile, { exitCode: 1, finishedAt: Date.now() });
    try { fs.appendFileSync(logFile, `\nspawn error: ${err}\n`); } catch {}
  });

  proc.on("exit", (code) => {
    bgRunning.delete(sessionFile);
    bgFinished.set(sessionFile, { exitCode: code ?? 1, finishedAt: Date.now() });
    try { fs.closeSync(logFd); } catch {}
    try { fs.unlinkSync(promptFile); } catch {}
    // Keep the log on failure for debugging; clean up on success
    if ((code ?? 1) === 0) {
      try { fs.unlinkSync(logFile); } catch {}
      try { fs.rmdirSync(tmpDir); } catch {}
    }
  });

  // Detach so the subprocess outlives us if needed
  proc.unref();
}

// ── Extension ──────────────────────────────────────────────────

export default function (pi: ExtensionAPI) {
  const st = createViewState();

  let refreshTimer: ReturnType<typeof setInterval> | null = null;

  function closeView(ctx: ExtensionContext): void {
    st.active = false;
    st.peekIdx = -1;
    st.showHelp = false;
    ctx.ui.setWidget("agent-views", undefined);
    if (refreshTimer) { clearInterval(refreshTimer); refreshTimer = null; }
  }

// Sort agents in display order: working → failed → idle → completed
const stateOrderMap: Record<AgentState, number> = { working: 0, failed: 1, idle: 2, completed: 3 };
function sortAgentsByState(agents: AgentInfo[]): AgentInfo[] {
  return agents.sort((a, b) => (stateOrderMap[a.state] ?? 9) - (stateOrderMap[b.state] ?? 9));
}

  function openView(ctx: ExtensionContext): void {
    const parent = resolveParent(ctx);
    if (!parent) { ctx.ui.notify("No session file", "error"); return; }
    st.parent = parent;
    st.agents = sortAgentsByState(listAgents(parent, ctx.sessionManager.getSessionFile()));
    st.selected = Math.max(0, st.agents.findIndex((a) => a.isCurrent));
    st.scroll = 0;
    st.peekIdx = -1;
    st.showHelp = false;
    st.active = true;

    ctx.ui.setWidget("agent-views", (_tui, theme) => ({
      render(w: number): string[] { return renderWidget(st, theme, w); },
      invalidate(): void {},
    }));

    // Periodically refresh while any agents are working
    if (refreshTimer) clearInterval(refreshTimer);
    refreshTimer = setInterval(() => {
      if (!st.active) { clearInterval(refreshTimer!); refreshTimer = null; return; }
      const parent = resolveParent(ctx);
      if (!parent) return;
      st.agents = sortAgentsByState(listAgents(parent, ctx.sessionManager.getSessionFile()));
      reqRender(st);
    }, 3000);
  }

  // ── Commands ───────────────────────────────────────────────────


  /**
   * If the current agent is busy, hand its work off to a background pi
   * subprocess before we switch away.
   *
   * IMPORTANT: ctx.abort() is async. We must await it so pi finishes
   * flushing the session file before the subprocess opens it, otherwise
   * both processes write the same file and the work is lost.
   */
  async function handoffCurrentIfBusy(ctx: ExtensionCommandContext): Promise<void> {
    if (ctx.isIdle()) return;
    const currentFile = ctx.sessionManager.getSessionFile();
    if (!currentFile) return;

    const modelStr = ctx.model ? `${ctx.model.provider}/${ctx.model.id}` : undefined;

    // Stop the in-flight turn and wait for pi to settle/flush
    await ctx.abort();
    await ctx.waitForIdle();

    // Now it is safe for a subprocess to take over this session file
    runAgentInBackground(currentFile, "continue from where you left off", ctx.cwd, modelStr);
  }

  pi.registerCommand("__av-switch", {
    description: "(internal) Switch to an agent",
    handler: async (args: string, ctx: ExtensionCommandContext) => {
      const file = args.trim();
      if (!file) return;
      await handoffCurrentIfBusy(ctx);
      closeView(ctx);
      await ctx.switchSession(file);
    },
  });

  pi.registerCommand("__av-dispatch", {
    description: "(internal) Dispatch a new agent",
    handler: async (args: string, ctx: ExtensionCommandContext) => {
      const prompt = args.trim();
      if (!prompt) return;
      const parent = resolveParent(ctx);
      if (!parent) { ctx.ui.notify("No parent session", "error"); return; }

      const agentName = prompt.length > 40 ? prompt.slice(0, 40) + "…" : prompt;
      const agentFile = createSubAgent(parent, { name: agentName, cwd: ctx.cwd });

      await handoffCurrentIfBusy(ctx);
      closeView(ctx);

      await ctx.switchSession(agentFile, {
        withSession: async (rCtx) => {
          await rCtx.sendUserMessage(prompt);
        },
      });
    },
  });

  // ── /agent — delegate a task to a new agent with LLM-curated context ──

  function getConversationMessages(ctx: ExtensionContext): AgentMessage[] {
    const branch = ctx.sessionManager.getBranch();
    const messages: AgentMessage[] = [];
    // Find latest compaction if any
    let compIdx = -1;
    for (let i = branch.length - 1; i >= 0; i--) {
      if (branch[i].type === "compaction") { compIdx = i; break; }
    }
    const start = compIdx >= 0 ? compIdx : 0;
    for (let i = start; i < branch.length; i++) {
      const e = branch[i] as any;
      if (e.type === "compaction") {
        messages.push({ role: "compactionSummary" as any, summary: e.summary, tokensBefore: e.tokensBefore, timestamp: Date.now() });
      } else if (e.type === "message") {
        messages.push(e.message);
      }
    }
    return messages;
  }

  pi.registerCommand("agent", {
    description: "Create a new agent with LLM-curated context — /agent <task>",
    handler: async (args: string, ctx: ExtensionCommandContext) => {
      if (ctx.mode !== "tui") { ctx.ui.notify("Requires interactive mode", "error"); return; }
      const task = args.trim();
      if (!task) { ctx.ui.notify("Usage: /agent <task description>", "error"); return; }
      if (!ctx.model) { ctx.ui.notify("No model selected", "error"); return; }

      const parent = resolveParent(ctx);
      if (!parent) { ctx.ui.notify("No parent session", "error"); return; }

      // Everything runs in the background — zero blocking.
      const agentMessages = getConversationMessages(ctx);
      const llmMessages = convertToLlm(agentMessages);
      const conversationText = serializeConversation(llmMessages);

      const agentName = task.length > 40 ? task.slice(0, 40) + "\u2026" : task;
      const agentFile = createSubAgent(parent, { name: agentName, cwd: ctx.cwd });

      // Build a self-contained prompt for the background subprocess.
      // The LLM reads the conversation, extracts relevant context, and works on the task — all in one shot.
      const bgPrompt = `You are given a conversation from another agent and a task.
First, review the conversation and identify the relevant context for the task.
Then, execute the task using that context.

## Conversation from parent agent

${conversationText}

## Your task

${task}`;

      const modelStr = ctx.model ? `${ctx.model.provider}/${ctx.model.id}` : undefined;
      runAgentInBackground(agentFile, bgPrompt, ctx.cwd, modelStr);

      // Notify — user stays right here, no interruption
      pi.sendMessage({
        customType: "agent-views:delegated",
        content: `\u2192 Agent started: **${agentName}**\n\nRunning in background. Press \u2190 to check in Agent Views.`,
        display: true,
      });
      ctx.ui.notify(`Agent started: ${agentName}`, "info");

      // Refresh Agent Views if it's open
      if (st.active) openView(ctx);
    },
  });


  // ── Install custom editor ─────────────────────────────────────

  pi.on("session_start", (_event, ctx) => {
    if (ctx.mode !== "tui") return;

    // Reset view state on session switch
    st.active = false;
    st.agents = [];

    ctx.ui.setEditorComponent((tui, theme, kb) => {
      const editor = new AgentViewEditor(tui, theme, kb, st, (action, arg) => {
        // Extension commands execute immediately even while streaming,
        // so the command handler can await abort() before switching.
        const opts: any = { expandPromptTemplates: true };

        switch (action) {
          case "open": openView(ctx); break;
          case "close": closeView(ctx); break;
          case "switch": pi.sendUserMessage(`/__av-switch ${arg}`, opts); break;
          case "dispatch": pi.sendUserMessage(`/__av-dispatch ${arg}`, opts); break;
        }
      });

      // Restore prompt history from session's user messages
      // so ↑/↓ recall works after switching agents
      try {
        const branch = ctx.sessionManager.getBranch();
        for (const entry of branch) {
          const e = entry as any;
          if (e.type === "message" && e.message?.role === "user") {
            for (const c of e.message.content ?? []) {
              if (c.type === "text" && c.text) {
                editor.addToHistory(c.text);
              }
            }
          }
        }
      } catch { /* ignore */ }

      return editor;
    });
  });
}
