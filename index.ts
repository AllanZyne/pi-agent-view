/**
 * Agent Views — per-session agents, rendered by pi itself, truly concurrent.
 *
 * Two problems this solves:
 *
 * 1. Concurrency. Every agent is its own `AgentSession` created through the pi
 *    SDK (see agent-runtime.ts) and owned by this extension, NOT by pi's
 *    session runtime. pi's `switchSession()/newSession()/fork()` all funnel
 *    through `AgentSessionRuntime.teardownCurrent()`, which does
 *    `await session.abort()` then `session.dispose()` — anything hosted by pi's
 *    live session is killed when you navigate away. Agent Views never calls
 *    those APIs, so switching between agents interrupts nothing.
 *
 * 2. Native rendering. Agent output is mirrored into pi's own transcript as
 *    custom entries (`pi.appendEntry` + `pi.registerEntryRenderer`) rendered
 *    with pi's real components — `UserMessageComponent`,
 *    `AssistantMessageComponent` (markdown, thinking blocks) and
 *    `ToolExecutionComponent` (tool call/result boxes). Nothing about a
 *    transcript is drawn in a widget; the widget is only the agent picker.
 *
 * 3. Separation. The main session and every agent are independent
 *    conversations, so a view shows exactly one of them. pi appends everything
 *    to one chat container and persisted custom entries cannot be removed, so
 *    both directions are filtered at render time: an agent's entries draw only
 *    while that agent is attached, and while attached pi's own chat children
 *    draw nothing (see transcript-view.ts). Nothing is deleted — detaching
 *    restores the main transcript, including what it streamed meanwhile — and
 *    mirror progress is kept per agent so re-attaching never duplicates.
 *
 *   ┌────────────────────────────┐
 *   │ transcript                 │  ← the main session's, or one agent's;
 *   │  ▸ you: …                  │    nothing is injected, an agent view
 *   │  ⏵ bash(…)                 │    reads like a fresh session
 *   ├────────────────────────────┤
 *   │ ◆ Agents (picker widget)   │  ← only while the picker is open
 *   ├──────────────── ◆ main ────┤  ← current view, on the editor frame
 *   │ editor  /  footer          │
 *   └────────────────────────────┘
 *
 * Keys
 *   ←              open/close the agent picker (empty editor only)
 *   ↑ ↓            move selection (empty editor only)
 *   Enter / →      attach: stream that agent into the transcript
 *   Enter + text   picker open: new agent with that first prompt
 *                  attached:    steer the attached agent
 *   Esc            detach (agent keeps running)
 *   Ctrl+X         abort that agent's turn
 *   Ctrl+L         model selector for the conversation on screen
 *   Ctrl+P         cycle the attached agent's model
 *   ?              help
 *
 * Commands
 *   /agent <task>   start a background agent without leaving or interrupting
 *                   the session you are in
 *   /model [name]   while attached (or with the picker open): set that agent's
 *                   model. pi's own /model is intercepted by interactive mode
 *                   and always targets pi's session, so an agent view has to
 *                   recognise it itself.
 *
 * Storage: agent sessions live in
 *   <sessionDir>/__agents__/<rootId>/<agentId>.jsonl
 * with a sibling manifest.json. That directory is not scanned by
 * SessionManager.list(), so agents stay out of /resume. Agents are named after
 * their first prompt, slugified to letters and hyphens (see storage.ts).
 */

import * as fs from "node:fs";
import * as path from "node:path";
import {
  AssistantMessageComponent,
  CustomEditor,
  getAgentDir,
  getMarkdownTheme,
  ModelSelectorComponent,
  SessionManager,
  SettingsManager,
  ToolExecutionComponent,
  UserMessageComponent,
  type ExtensionAPI,
  type ExtensionContext,
  type Theme,
} from "@earendil-works/pi-coding-agent";
import type { AssistantMessage, Model } from "@earendil-works/pi-ai";
import {
  matchesKey,
  truncateToWidth,
  visibleWidth,
  wrapTextWithAnsi,
  type Component,
  type MarkdownTheme,
  type TUI,
} from "@earendil-works/pi-tui";
import {
  abortAgent,
  cycleAgentModel,
  disposeAll,
  ensureAgent,
  getAgent,
  isLoadingSubAgent,
  modelOf,
  readTranscript,
  runAgent,
  setAgentModel,
  setOnChange,
  sharedModelRuntime,
  steerAgent,
  type TranscriptItem,
} from "./agent-runtime.ts";
import {
  agentName,
  listAgentEntries,
  registerAgent,
  resolveRoot,
  ROOT_AGENT_NAME,
  type RootCtx,
} from "./storage.ts";
import { findChatContainer, installChatFilter, type RenderNode } from "./transcript-view.ts";
import { initToolRenderers, toolRenderersFor } from "./tool-renderers.ts";
import {
  attachTo,
  buildRows,
  isVisible,
  moveSelection,
  noteMirrored,
  reconcileSelection,
  renderable,
  selectedRow,
  syncMirror,
  type AgentRow,
  type AgentState,
  type ItemRef,
  type MirrorState,
  type Selection,
} from "./view-model.ts";

// Storage and view logic live in storage.ts / view-model.ts so they can be unit
// tested without a terminal. This file is rendering and key handling only.

function rootOf(ctx: ExtensionContext): RootCtx | null {
  return resolveRoot(ctx.sessionManager.getSessionFile(), ctx.sessionManager.getSessionId());
}

// ── View state (survives per-session extension reloads) ────────────

interface ViewState extends MirrorState, Selection {
  /** Picker widget visible. */
  open: boolean;
  showHelp: boolean;
  rows: AgentRow[];
  refresh?: () => void;
  /** Removes the chat-container render filter (see transcript-view.ts). */
  unfilter?: () => void;
}

const VIEW_KEY = "__piAgentViewsState";

function getView(): ViewState {
  const g = globalThis as Record<string, unknown>;
  if (!g[VIEW_KEY]) {
    g[VIEW_KEY] = { open: false, showHelp: false, mirrored: {}, rows: [], selected: 0, scroll: 0 } satisfies ViewState;
  }
  const view = g[VIEW_KEY] as ViewState;
  // Older builds stored a single counter; normalise so a reload cannot crash.
  if (typeof view.mirrored !== "object" || view.mirrored === null) view.mirrored = {};
  return view;
}

// ── Native transcript rendering ────────────────────────────────────

const ITEM_ENTRY = "agent-view-item";
const OWNED_ENTRIES: ReadonlySet<string> = new Set([ITEM_ENTRY]);

/**
 * Everything pi feeds its own message components, read from settings once so an
 * agent transcript is laid out and coloured exactly like the main session's.
 */
export interface RenderSettings {
  /** `outputPad` setting: horizontal padding of message bodies (pi default 1). */
  outputPad: number;
  markdownTheme: MarkdownTheme;
  hideThinkingBlock: boolean;
  tool: { showImages: boolean; imageWidthCells: number };
}

export function defaultRenderSettings(): RenderSettings {
  return {
    outputPad: 1,
    markdownTheme: getMarkdownTheme(),
    hideThinkingBlock: false,
    tool: { showImages: true, imageWidthCells: 60 },
  };
}

/** Read the same settings pi's interactive mode reads for rendering. */
function readRenderSettings(cwd: string): RenderSettings {
  const fallback = defaultRenderSettings();
  try {
    const settings = SettingsManager.create(cwd, getAgentDir());
    return {
      outputPad: settings.getOutputPad(),
      markdownTheme: { ...getMarkdownTheme(), codeBlockIndent: settings.getCodeBlockIndent() },
      hideThinkingBlock: settings.getHideThinkingBlock(),
      tool: { showImages: settings.getShowImages(), imageWidthCells: settings.getImageWidthCells() },
    };
  } catch {
    return fallback;
  }
}

/** Cheap change detector for a (possibly streaming) assistant message. */
function assistantSignature(item: { message: AssistantMessage; streaming: boolean }): string {
  let size = 0;
  for (const part of (item.message.content ?? []) as Array<Record<string, any>>) {
    size += String(part.text ?? part.thinking ?? "").length + 1;
  }
  const message = item.message as any;
  return `${size}:${item.streaming}:${message.stopReason ?? ""}:${message.errorMessage ?? ""}`;
}

/**
 * Renders one agent transcript item using pi's own message components, so an
 * agent's output is indistinguishable from a normal pi session's.
 */
export class AgentItemComponent implements Component {
  private user?: UserMessageComponent;
  private assistant?: AssistantMessageComponent;
  private tool?: ToolExecutionComponent;
  private lastSignature = "";
  private lastExpanded?: boolean;

  constructor(
    private readonly ref: ItemRef,
    private readonly theme: Theme,
    private readonly settings: RenderSettings,
    /** Ctrl+O state, forwarded to tool boxes exactly like pi does. */
    private readonly expanded: boolean,
    private readonly tui: TUI | undefined,
    private readonly cwd: string,
    /** Entries are persisted forever; only the attached agent may draw. */
    private readonly visible: (file: string) => boolean,
    /** Test seam; defaults to the live agent pool. */
    private readonly read: (file: string) => TranscriptItem[] = readTranscript,
  ) {}

  invalidate(): void {
    this.user?.invalidate?.();
    this.assistant?.invalidate();
    this.tool?.invalidate();
  }

  render(width: number): string[] {
    if (!this.visible(this.ref.file)) return [];
    const items = this.read(this.ref.file);
    const item = items[this.ref.index];
    if (!item) return [];
    const pad = this.settings.outputPad;

    switch (item.kind) {
      case "user": {
        this.user ??= new UserMessageComponent(item.text, this.settings.markdownTheme, pad);
        const lines = this.user.render(width);
        // pi separates a user message from whatever precedes it with a blank
        // line (`Spacer(1)` when the chat is not empty).
        return items.slice(0, this.ref.index).some(renderable) ? ["", ...lines] : lines;
      }

      case "assistant": {
        // The component draws text, thinking blocks and stop-reason notices,
        // and adds its own leading spacer — same call pi makes.
        this.assistant ??= new AssistantMessageComponent(
          undefined,
          this.settings.hideThinkingBlock,
          this.settings.markdownTheme,
          undefined,
          pad,
        );
        const signature = assistantSignature(item);
        if (signature !== this.lastSignature) {
          this.lastSignature = signature;
          this.assistant.updateContent(item.message, item.streaming);
        }
        return this.assistant.render(width);
      }

      case "toolCall": {
        if (!this.tui) {
          return [truncateToWidth(`${" ".repeat(pad)}${this.theme.fg("warning", `⏵ ${item.name}`)}`, width)];
        }
        if (!this.tool) {
          this.tool = new ToolExecutionComponent(
            item.name,
            item.id,
            item.args,
            this.settings.tool,
            // Without pi's built-in renderers a tool call degrades to its bare
            // name plus raw output, which is the one thing that never looked
            // like the main session.
            toolRenderersFor(item.name) as never,
            this.tui,
            this.cwd,
          );
          this.tool.setArgsComplete();
          this.tool.markExecutionStarted();
        }
        if (this.lastExpanded !== this.expanded) {
          this.lastExpanded = this.expanded;
          this.tool.setExpanded(this.expanded);
        }
        // Pair the call with its result so pi renders the usual call+result box.
        const result = items.find((it) => it.kind === "toolResult" && it.toolCallId === item.id);
        if (result && result.kind === "toolResult") {
          this.tool.updateResult(
            { content: result.content, details: result.details, isError: result.isError },
            false,
          );
        }
        return this.tool.render(width);
      }

      // Results are rendered together with their call.
      case "toolResult":
        return [];

      case "error": {
        const out: string[] = [];
        for (const raw of item.text.split("\n")) {
          for (const line of wrapTextWithAnsi(raw, Math.max(20, width - pad * 2))) {
            out.push(`${" ".repeat(pad)}${this.theme.fg("error", line)}`);
          }
        }
        return out;
      }
    }
  }
}

// ── Picker rendering ───────────────────────────────────────────────

const STATE_LABEL: Record<AgentState, string> = {
  working: "Working",
  failed: "Failed",
  idle: "Idle",
  completed: "Completed",
};

function clip(s: string, n: number): string {
  return s.length <= n ? s : `${s.slice(0, Math.max(1, n - 1))}…`;
}

/** Border characters kept to the right of the editor's view label. */
const LABEL_TAIL = 4;

function viewportRows(): number {
  return Math.max(3, Math.floor((process.stdout.rows || 30) / 2) - 4);
}

function renderPicker(view: ViewState, th: Theme, width: number): string[] {
  if (!view.open) return [];
  const out: string[] = [];
  const rule = th.fg("dim", "─".repeat(Math.max(4, Math.min(width - 4, 100))));

  if (view.showHelp) {
    out.push(truncateToWidth(`  ${th.fg("accent", th.bold("Agents — keys"))}`, width));
    out.push(truncateToWidth(`  ${rule}`, width));
    for (const [k, d] of [
      ["↑ ↓", "Select agent"],
      ["Enter / →", "Attach: stream it into the transcript"],
      ["Enter + text", "New agent (picker) · steer (attached)"],
      ["Esc", "Detach (agent keeps running)"],
      ["Ctrl+X", "Abort that agent's turn"],
      ["/model [name]", "Set that agent's model (Ctrl+L when attached)"],
      ["←", "Close the picker (reopen to refresh the list)"],
      ["/agent <task>", "Start a background agent"],
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

  // The cursor is the *agent* it is on, so it cannot drift onto a neighbour
  // when a state change re-sorts the list between refreshes.
  const cursor = view.rows.findIndex((r) => r.key === view.key);
  const maxRows = viewportRows();
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

    const pointer = i === cursor ? th.fg("accent", " ▸ ") : "   ";
    const name = clip(row.name || "(unnamed)", 48);
    const nameStr = i === cursor ? th.fg("accent", name) : th.fg("text", name);
    // The state icon + group header already say everything about the agent's
    // status, so no "(live)" tag and no ticking mtime column.
    // No "[main]" tag: the root session is just the agent called "main".
    const tags = row.isAttached ? th.fg("success", " (attached)") : "";
    out.push(truncateToWidth(`${pointer}${icon} ${nameStr}${tags}`, width));

    const meta = th.fg("muted", `${row.messageCount} msg${row.messageCount === 1 ? "" : "s"}`);
    const model = row.model ? th.fg("dim", ` · ${clip(row.model, 28)}`) : "";
    const summary = row.summary ? th.fg("dim", `  ${clip(row.summary, Math.max(10, width - 24))}`) : "";
    out.push(truncateToWidth(`     ${meta}${model}${summary}`, width));
  }

  if (end < view.rows.length) {
    out.push(truncateToWidth(th.fg("dim", `  ↓ ${view.rows.length - end} more`), width));
  }

  out.push(truncateToWidth(`  ${rule}`, width));
  out.push(
    truncateToWidth(
      `  ${th.fg("dim", "↑↓ select · ⏎ attach · type+⏎ new agent · /model · ctrl+x abort · ← close · ? help")}`,
      width,
    ),
  );
  return out;
}

// ── Editor ─────────────────────────────────────────────────────────

type Action =
  | { t: "openPicker" }
  | { t: "closePicker" }
  | { t: "help" }
  | { t: "attach"; key: string }
  | { t: "detach" }
  | { t: "spawn"; prompt: string }
  | { t: "steer"; key: string; text: string }
  | { t: "model"; key: string; search?: string }
  | { t: "cycleModel"; key: string; direction: "forward" | "backward" }
  | { t: "abort"; key: string };

/**
 * `/model` typed while an agent is attached.
 *
 * pi's own `/model` is handled by interactive mode before extensions see it and
 * always targets pi's session, so an attached view has to recognise it itself —
 * otherwise the command text would be sent to the agent as a prompt.
 */
function parseModelCommand(text: string): { search?: string } | undefined {
  if (text !== "/model" && !text.startsWith("/model ")) return undefined;
  const search = text.slice("/model".length).trim();
  return { search: search || undefined };
}

class AgentViewEditor extends CustomEditor {
  constructor(
    tui: ConstructorParameters<typeof CustomEditor>[0],
    theme: ConstructorParameters<typeof CustomEditor>[1],
    /** Kept: `CustomEditor.keybindings` is private, and model keys are remappable. */
    private readonly kb: ConstructorParameters<typeof CustomEditor>[2],
    private readonly view: ViewState,
    private readonly act: (a: Action) => void,
    /**
     * Current view's name for the right end of the top border, as plain text:
     * it is drawn in the editor's own border color.
     */
    private readonly label: () => string | undefined,
  ) {
    super(tui, theme, kb, { embedWorkingStatus: true });
  }

  /**
   * Show which conversation the editor is talking to on the editor frame
   * itself, so the transcript can stay exactly as clean as a normal session's.
   *
   * The label is inset from the right end — "──── ◆ main ────" — and is dropped
   * entirely when the frame is too narrow to keep the working status readable.
   */
  protected override renderTopBorder(width: number, hiddenLineCount: number): string {
    const border = super.renderTopBorder(width, hiddenLineCount);
    const text = this.label();
    if (!text) return border;
    const labelWidth = visibleWidth(text);
    if (labelWidth + LABEL_TAIL + 12 > width) return border;
    // `truncateToWidth` appends "..." unless the ellipsis is disabled, and a
    // border must be cut, not elided.
    return (
      truncateToWidth(border, width - labelWidth - LABEL_TAIL, "") +
      this.borderColor(text + "─".repeat(LABEL_TAIL))
    );
  }

  /**
   * The agent the user is looking at. Resolved by key, never by row index: the
   * list is re-sorted whenever an agent changes state, so an index captured at
   * render time can point at a different agent by the time a key is pressed.
   */
  private row(): AgentRow | undefined {
    return selectedRow(this.view.rows, this.view);
  }

  override handleInput(data: string): void {
    const empty = this.getText().length === 0;
    const view = this.view;

    // Model keys belong to the conversation on screen. The app handlers copied
    // in by pi (Ctrl+L, Ctrl+P) would switch the *main* session's model, which
    // is not what the user is looking at while attached.
    if (view.attached) {
      if (this.kb.matches(data, "app.model.select")) {
        this.act({ t: "model", key: view.attached });
        return;
      }
      if (this.kb.matches(data, "app.model.cycleForward")) {
        this.act({ t: "cycleModel", key: view.attached, direction: "forward" });
        return;
      }
      if (this.kb.matches(data, "app.model.cycleBackward")) {
        this.act({ t: "cycleModel", key: view.attached, direction: "backward" });
        return;
      }
    }

    // ← on an empty editor is the single entry point.
    if (!view.open) {
      if (empty && matchesKey(data, "left")) {
        this.act({ t: "openPicker" });
        return;
      }
      if (view.attached) {
        if (empty && matchesKey(data, "escape")) {
          this.act({ t: "detach" });
          return;
        }
        if (empty && matchesKey(data, "ctrl+x")) {
          this.act({ t: "abort", key: view.attached });
          return;
        }
        if (matchesKey(data, "return") || matchesKey(data, "enter")) {
          const text = this.getText().trim();
          if (text) {
            const model = parseModelCommand(text);
            this.setText("");
            if (model) this.act({ t: "model", key: view.attached, search: model.search });
            else this.act({ t: "steer", key: view.attached, text });
            return;
          }
        }
      }
      super.handleInput(data);
      return;
    }

    if (empty && data === "?") {
      this.act({ t: "help" });
      return;
    }
    if (empty && (matchesKey(data, "left") || matchesKey(data, "escape"))) {
      this.act(view.showHelp ? { t: "help" } : { t: "closePicker" });
      return;
    }
    if (empty && matchesKey(data, "ctrl+x")) {
      const row = this.row();
      if (row) this.act({ t: "abort", key: row.key });
      return;
    }

    // ↑/↓ drive the picker only while the editor is empty, so prompt history
    // still works as soon as you start typing.
    if (empty && (matchesKey(data, "up") || matchesKey(data, "down"))) {
      const next = moveSelection(view.rows, view, matchesKey(data, "up") ? -1 : 1, viewportRows());
      view.selected = next.selected;
      view.scroll = next.scroll;
      view.key = next.key;
      view.refresh?.();
      return;
    }

    if (matchesKey(data, "return") || matchesKey(data, "enter")) {
      const text = this.getText().trim();
      if (text) {
        const model = parseModelCommand(text);
        this.setText("");
        // `/model` in the picker retargets the selected agent instead of
        // spawning an agent called "model".
        if (model) {
          const row = this.row();
          if (row) this.act({ t: "model", key: row.key, search: model.search });
          return;
        }
        this.act({ t: "spawn", prompt: text });
      } else {
        const row = this.row();
        if (row) this.act(row.isRoot ? { t: "detach" } : { t: "attach", key: row.key });
      }
      return;
    }

    if (empty && matchesKey(data, "right")) {
      const row = this.row();
      if (row) this.act(row.isRoot ? { t: "detach" } : { t: "attach", key: row.key });
      return;
    }

    super.handleInput(data);
  }
}

// ── Extension ──────────────────────────────────────────────────────

export default function agentViews(pi: ExtensionAPI): void {
  // Sub-agents load resources with `noExtensions`, but guard anyway: this
  // factory must never run inside an agent session being constructed.
  if (isLoadingSubAgent()) return;

  const view = getView();
  /** Captured from the (invisible) tick widget so components can request renders. */
  let tui: TUI | undefined;
  /** Refreshed on every session start, like pi refreshes its own render settings. */
  let renderSettings = defaultRenderSettings();

  /**
   * Custom entries are persisted and can never be removed, so every agent's
   * items stay in pi's transcript for good. Visibility is what separates the
   * agents: an entry draws itself only while its own agent is attached, which
   * is why detaching to the main session (or switching agents) leaves no
   * foreign output behind, even for an agent that is still working.
   */
  const visible = (file: string) => isVisible(view, file);

  /**
   * The other half of the separation: while an agent is attached, pi's own chat
   * children (the main session's messages, notices, errors — anything pi
   * appends itself) must not draw into the agent's view. `installChatFilter`
   * makes pi's chat container render only this extension's entries for as long
   * as `view.attached` is set. Nothing is deleted: detaching restores the main
   * transcript exactly as pi built it.
   */
  function ensureChatFilter(): void {
    if (view.unfilter) return;
    const chat = findChatContainer(tui as unknown as RenderNode | undefined, OWNED_ENTRIES);
    if (!chat) return;
    view.unfilter = installChatFilter(chat, () => view.attached !== undefined, OWNED_ENTRIES);
    // The current frame may already have drawn the unfiltered container.
    tui?.requestRender(true);
  }

  /** Toggle between the main transcript and an agent transcript. */
  function redrawTranscript(): void {
    ensureChatFilter();
    // Force a full repaint: the visible transcript is replaced wholesale, not
    // appended to, so a differential frame would leave the old view behind.
    tui?.requestRender(true);
  }

  // Agent output is rendered by pi, through this renderer. `options.expanded`
  // is pi's Ctrl+O state, so agent tool boxes expand with everything else.
  pi.registerEntryRenderer<ItemRef>(ITEM_ENTRY, (entry, options, theme) =>
    entry.data
      ? new AgentItemComponent(
          entry.data,
          theme,
          renderSettings,
          options.expanded,
          tui,
          process.cwd(),
          visible,
        )
      : undefined,
  );

  function nameOf(file: string): string {
    const row = view.rows.find((r) => r.key === file);
    if (row) return row.name;
    try {
      return SessionManager.open(file).getSessionName() ?? path.basename(file);
    } catch {
      return path.basename(file);
    }
  }

  /** Append any agent transcript items that pi has not rendered yet. */
  function mirror(): void {
    syncMirror(view, (ref) => pi.appendEntry<ItemRef>(ITEM_ENTRY, ref));
    tui?.requestRender();
  }

  /**
   * Rebuild mirror progress from what pi already has in this session.
   *
   * A resumed session still holds every entry appended by earlier attachments,
   * so mirroring must resume after them instead of appending the whole
   * transcript a second time.
   */
  function restoreFromSession(ctx: ExtensionContext): void {
    view.mirrored = {};
    try {
      for (const entry of ctx.sessionManager.getEntries()) {
        if (entry.type !== "custom" || entry.customType !== ITEM_ENTRY) continue;
        const ref = entry.data as ItemRef | undefined;
        if (ref?.file) noteMirrored(view, ref.file, ref.index + 1);
      }
    } catch {
      /* best effort: a missing session just replays from scratch */
    }
  }

  function closePicker(ctx: ExtensionContext): void {
    view.open = false;
    view.showHelp = false;
    ctx.ui.setWidget("agent-views", undefined);
  }

  /**
   * Rebuild the picker rows.
   *
   * Deliberately *not* on a timer: building rows stats every agent file and
   * re-sorts by state, so a periodic refresh both burned I/O and reshuffled the
   * list under the cursor while you were choosing. Rows are a snapshot, taken
   * when the list is about to be shown or when this extension itself changed
   * the agent set. The cursor is key-anchored anyway (`reconcileSelection`), so
   * a snapshot is safe to act on.
   */
  function reloadRows(ctx: ExtensionContext): void {
    const root = rootOf(ctx);
    if (!root) return;
    view.rows = buildRows({
      rootFile: root.rootFile,
      rootName: ROOT_AGENT_NAME,
      rootBusy: !ctx.isIdle(),
      agents: listAgentEntries(root, (f) => getAgent(f) !== undefined),
      attached: view.attached,
    });
    const next = reconcileSelection(view.rows, view, viewportRows());
    view.selected = next.selected;
    view.scroll = next.scroll;
    view.key = next.key;
  }

  /** Refresh the rows only if the user is actually looking at them. */
  function refreshRowsIfOpen(ctx: ExtensionContext): void {
    if (!view.open) return;
    reloadRows(ctx);
    view.refresh?.();
  }

  function openPicker(ctx: ExtensionContext): void {
    if (!rootOf(ctx)) {
      ctx.ui.notify("Agents need a saved session", "error");
      return;
    }

    view.scroll = 0;
    reloadRows(ctx);
    // Open on the attached agent when there is one.
    const attached = view.rows.find((r) => r.isAttached);
    if (attached) {
      view.key = attached.key;
      reloadRows(ctx);
    }
    view.showHelp = false;
    view.open = true;

    ctx.ui.setWidget("agent-views", (_tui, theme) => ({
      render: (w: number) => renderPicker(view, theme, w),
      invalidate: () => {},
    }));
  }

  /**
   * Attach: stream an agent's output into pi's transcript. Only rendering
   * changes — the agent keeps running and pi's own session is untouched.
   */
  async function attach(ctx: ExtensionContext, file: string): Promise<void> {
    // A just-spawned agent is live before pi flushes its session file.
    if (!getAgent(file) && !fs.existsSync(file)) {
      ctx.ui.notify("That agent's session file is gone", "error");
      return;
    }
    if (view.attached === file) {
      closePicker(ctx);
      return;
    }
    try {
      await ensureAgent(file, ctx.cwd, ctx.model, ctx.thinkingLevel);
    } catch (err) {
      ctx.ui.notify(`Could not open agent: ${String(err)}`, "error");
      return;
    }
    if (view.attached) detach();

    attachTo(view, file);
    closePicker(ctx);
    // Nothing is injected into the agent's transcript: it reads exactly like a
    // fresh session. Which agent you are looking at is shown on the editor.
    mirror();
    redrawTranscript();
  }

  /**
   * Detach: stop showing the agent. Its entries stay in pi's session but render
   * nothing, so the main session's transcript is its own again even if the
   * agent keeps streaming.
   */
  function detach(): void {
    if (!view.attached) return;
    attachTo(view, undefined);
    redrawTranscript();
  }

  /**
   * Create a new agent and hand it the prompt. Returns as soon as the turn is
   * queued: the session you are in is never blocked or interrupted.
   */
  async function spawn(
    ctx: ExtensionContext,
    prompt: string,
    options: { attach: boolean },
  ): Promise<string | undefined> {
    const root = rootOf(ctx);
    if (!root) {
      ctx.ui.notify("Agents need a saved session", "error");
      return undefined;
    }

    const existing = listAgentEntries(root, (f) => getAgent(f) !== undefined);
    const name = agentName(prompt, existing.map((a) => a.name));
    const file = registerAgent(root, name, ctx.cwd);
    try {
      await runAgent(file, prompt, ctx.cwd, ctx.model, ctx.thinkingLevel);
    } catch (err) {
      ctx.ui.notify(`Could not start agent: ${String(err)}`, "error");
      return undefined;
    }
    if (options.attach) await attach(ctx, file);
    // A new agent changes the list; only rebuild it if it is on screen.
    else refreshRowsIfOpen(ctx);
    return file;
  }

  // ── Model selection ────────────────────────────────────────────
  //
  // pi's `/model` (and Ctrl+L / Ctrl+P) is wired to pi's own session, so it
  // cannot switch the model of the conversation you are actually looking at.
  // These handlers run the same UI against the attached agent's session, which
  // records the change in that agent's transcript like pi does for its own.

  function isRoot(ctx: ExtensionContext, file: string): boolean {
    return file === ctx.sessionManager.getSessionFile();
  }

  /** Apply a model to an agent (or to pi's own session for `main`). */
  async function applyModel(ctx: ExtensionContext, file: string, model: Model<any>): Promise<void> {
    try {
      if (isRoot(ctx, file)) {
        const ok = await pi.setModel(model);
        if (!ok) {
          ctx.ui.notify(`No auth configured for ${model.provider}`, "error");
          return;
        }
      } else if (!(await setAgentModel(file, model))) {
        ctx.ui.notify("That agent is not live", "warning");
        return;
      }
      ctx.ui.notify(`${nameOf(file)} → ${model.id}`, "info");
      refreshRowsIfOpen(ctx);
    } catch (err) {
      ctx.ui.notify(err instanceof Error ? err.message : String(err), "error");
    }
  }

  /**
   * `/model [search]` for one agent: exact `provider/id` (or `id`) matches are
   * applied directly, anything else opens pi's own model selector prefilled
   * with the search term.
   */
  async function chooseModel(ctx: ExtensionContext, file: string, search?: string): Promise<void> {
    if (!isRoot(ctx, file)) {
      try {
        await ensureAgent(file, ctx.cwd, ctx.model, ctx.thinkingLevel);
      } catch (err) {
        ctx.ui.notify(`Could not open agent: ${String(err)}`, "error");
        return;
      }
    }

    const runtime = await sharedModelRuntime();
    const available = [...runtime.getAvailableSnapshot()];
    const current = isRoot(ctx, file) ? ctx.model : modelOf(file);

    if (search) {
      const wanted = search.toLowerCase();
      const exact = available.find(
        (m) => `${m.provider}/${m.id}`.toLowerCase() === wanted || m.id.toLowerCase() === wanted,
      );
      if (exact) {
        await applyModel(ctx, file, exact);
        return;
      }
    }

    if (ctx.mode !== "tui") return;
    const picked = await ctx.ui.custom<Model<any> | undefined>((t, _theme, _kb, done) => {
      const selector = new ModelSelectorComponent(
        t,
        current,
        runtime,
        ctx.scopedModels,
        (model) => done(model),
        () => done(undefined),
        search,
      );
      return selector as unknown as Component & { dispose?(): void };
    });
    if (picked) await applyModel(ctx, file, picked);
  }

  /** Ctrl+P style cycling for the attached agent. */
  async function cycleModel(
    ctx: ExtensionContext,
    file: string,
    direction: "forward" | "backward",
  ): Promise<void> {
    if (isRoot(ctx, file)) return;
    try {
      const model = await cycleAgentModel(file, direction);
      if (!model) {
        ctx.ui.notify("No other model available", "warning");
        return;
      }
      ctx.ui.notify(`${nameOf(file)} → ${model.id}`, "info");
      refreshRowsIfOpen(ctx);
    } catch (err) {
      ctx.ui.notify(err instanceof Error ? err.message : String(err), "error");
    }
  }

  // ── Commands ───────────────────────────────────────────────────
  //
  // Extension commands execute immediately even while the agent is streaming,
  // so they never have to interrupt a turn.

  pi.registerCommand("agent", {
    description: "Start a background agent for a task — /agent <task>",
    handler: async (args, ctx) => {
      const task = args.trim();
      if (!task) {
        ctx.ui.notify("Usage: /agent <task>", "error");
        return;
      }
      const file = await spawn(ctx, task, { attach: false });
      if (file) ctx.ui.notify("Agent started in the background. Press ← to see it.", "info");
    },
  });

  // ── Wiring ─────────────────────────────────────────────────────

  pi.on("session_start", (event, ctx) => {
    if (ctx.mode !== "tui") return;

    // A reload rebuilds the extension runtime but keeps the session, its chat
    // container and everything already mirrored into it, so the view survives:
    // reloading while attached must not silently drop you back on "main".
    const reloaded = event.reason === "reload";

    // Same inputs pi's interactive mode uses to draw messages, plus the
    // built-in tool renderers it hands to every tool box.
    renderSettings = readRenderSettings(ctx.cwd);
    void initToolRenderers().then((ok) => {
      if (ok) tui?.requestRender();
    });

    view.open = false;
    if (!reloaded) {
      // A different session means a different chat container and a fresh view.
      // Live agents are unaffected: they are not pi sessions.
      view.attached = undefined;
      view.unfilter?.();
      view.unfilter = undefined;
    }
    restoreFromSession(ctx);
    ctx.ui.setWidget("agent-views", undefined);
    // Clear any footer status left behind by an older build of this extension.
    ctx.ui.setStatus("agent-views", undefined);

    // Zero-height widget used only to obtain a TUI handle: transcript content
    // lives in pi's transcript, never in a widget.
    ctx.ui.setWidget("agent-views-tick", (t) => {
      tui = t;
      view.refresh = () => t.requestRender();
      return {
        render: () => {
          // Cheap once installed; the container can only be found after pi has
          // built a child for one of our entries.
          if (view.attached) ensureChatFilter();
          return [];
        },
        invalidate: () => {},
      };
    });

    // Live agents push updates; mirror new items into pi's transcript.
    setOnChange(() => mirror());

    /**
     * Which conversation the editor is talking to, drawn on the editor frame.
     *
     * Always shown, including the main session (as the agent called "main"), so
     * there is never any doubt about where a prompt is going. Plain text: the
     * editor draws it in its border color. Names are slugs and short by
     * construction, so they are never truncated.
     */
    const viewLabel = (): string => ` ◆ ${view.attached ? nameOf(view.attached) : ROOT_AGENT_NAME} `;

    ctx.ui.setEditorComponent((t, theme, kb) => {
      const act = (action: Action) => {
        // Everything here runs against the extension-owned agent pool, so no pi
        // session is switched, aborted or disposed.
        switch (action.t) {
          case "openPicker":
            openPicker(ctx);
            break;
          case "closePicker":
            closePicker(ctx);
            break;
          case "help":
            view.showHelp = !view.showHelp;
            view.refresh?.();
            break;
          case "attach":
            void attach(ctx, action.key);
            break;
          case "detach":
            closePicker(ctx);
            detach();
            break;
          case "spawn":
            void spawn(ctx, action.prompt, { attach: true });
            break;
          case "steer":
            void steerAgent(action.key, action.text).then((ok) => {
              if (!ok) ctx.ui.notify("That agent is not live", "warning");
            });
            break;
          case "model":
            closePicker(ctx);
            void chooseModel(ctx, action.key, action.search);
            break;
          case "cycleModel":
            void cycleModel(ctx, action.key, action.direction);
            break;
          case "abort":
            if (action.key === ctx.sessionManager.getSessionFile()) ctx.abort();
            else void abortAgent(action.key).then(() => refreshRowsIfOpen(ctx));
            break;
        }
      };

      const editor = new AgentViewEditor(t, theme, kb, view, act, viewLabel);

      // Restore prompt history so ↑/↓ recall still works.
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
          if (text) editor.addToHistory(text);
        }
      } catch {
        /* history is best-effort */
      }

      return editor;
    });
  });

  pi.on("session_shutdown", (event, ctx) => {
    view.open = false;
    view.attached = undefined;
    view.mirrored = {};
    view.unfilter?.();
    view.unfilter = undefined;
    setOnChange(undefined);
    ctx.ui.setWidget("agent-views", undefined);
    ctx.ui.setWidget("agent-views-tick", undefined);
    ctx.ui.setStatus("agent-views", undefined);
    // Only release the pool when pi is really going away; a session switch or
    // extension reload must leave background agents running.
    if (event.reason === "quit") void disposeAll();
  });
}
