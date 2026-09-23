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
 *   │ editor                     │
 *   └────────────────────────────┘
 *
 * Keys
 *   ←              open/close the agent picker (empty editor only)
 *   ↑ ↓            move selection (empty editor only)
 *   Enter / →      attach: stream that agent into the transcript
 *   Enter + text   picker open: create and attach to an agent with that prompt
 *                  attached:    steer the attached agent
 *   Esc            detach (agent keeps running)
 *   Ctrl+X         press twice: agent delete; main abort
 *   Ctrl+L         model selector for the conversation on screen
 *   Ctrl+P         cycle the attached agent's model
 *   ?              help
 *
 * Commands
 *   /agents         list agent templates discovered under .pi/agents/
 *                   (rescans on every call — no explicit reload flag needed).
 *   /model [name]   while attached (or with the picker open): set that agent's
 *                   model. pi's own /model is intercepted by interactive mode
 *                   and always targets pi's session, so an agent view has to
 *                   recognise it itself.
 *
 * LLM-callable tools (replaces the old `@<slug>` routing operator)
 *   `@name` in a message is now plain text — no position rule, no priority
 *   resolution, no escaping needed. Whichever conversation you're talking to
 *   (main, or an attached agent — every agent gets the same tools) decides
 *   from context what to do and calls the tool that matches:
 *     `agent_create`      — create one or more instances, with or without templates
 *     `agent_list`        — list existing instances, available templates, and slots
 *     `agent_inspect`     — inspect one instance's status/conversation
 *     `agent_send`        — message an existing instance by name
 *     `agent_remove`      — delete an instance outright (never `main`)
 *   See agent-create-tool.ts / agent-list-tool.ts / agent-inspect-tool.ts /
 *   agent-control-tool.ts and README "LLM-callable tools". Because every
 *   agent has the same five tools, delegation nests to any depth — a sub-agent
 *   can spawn its own.
 *
 *   Typing `@` at the start of the message still opens an agent picker:
 *   `@agent:<template>` is a template and `@<instance>` is a live instance;
 *   it remains purely cosmetic.
 *   mid-message `@` opens pi's file picker (see `autocomplete.ts`).
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
  CompactionSummaryMessageComponent,
  getAgentDir,
  getMarkdownTheme,
  ModelSelectorComponent,
  parseSkillBlock,
  SessionManager,
  SettingsManager,
  SkillInvocationMessageComponent,
  ToolExecutionComponent,
  UserMessageComponent,
  type ContextUsage,
  type ExtensionAPI,
  type ExtensionContext,
  type Theme,
} from "@earendil-works/pi-coding-agent";
import type { AssistantMessage, Model } from "@earendil-works/pi-ai";
import {
  Loader,
  matchesKey,
  truncateToWidth,
  visibleWidth,
  wrapTextWithAnsi,
  type Component,
  type MarkdownTheme,
  type TUI,
} from "@earendil-works/pi-tui";
import {
  cycleAgentModel,
  disposeAll,
  ensureAgent,
  forgetAgent,
  getAgent,
  isLoadingSubAgent,
  modelOf,
  readTranscript,
  runAgent,
  setAgentModel,
  setManagedTools,
  setOnChange,
  sharedModelRuntime,
  stateOf,
  steerAgent,
  type TranscriptItem,
} from "./agent-runtime.ts";
import {
  agentName,
  listAgentEntries,
  registerAgent,
  removeAgentEntry,
  resolveRoot,
  ROOT_AGENT_NAME,
  templateId,
  type RootCtx,
} from "./storage.ts";
import { loadCatalog, type Catalog, type SubAgentDef } from "./agent-catalog.ts";
import { AGENT_POLICY } from "./agent-policy.ts";
import { type LiveAgentInfo } from "./at-mention.ts";
import { wrapWithAgentMentions } from "./autocomplete.ts";
import {
  BLOCKED_ATTACHED_COMMANDS,
  commandName,
  GLOBAL_ATTACHED_COMMANDS,
  parseModelCommand,
  withAttachedCommandFilter,
} from "./command-routing.ts";
import { findChatContainer, includeChatChild, installChatFilter, tagRaisedChildren, type RenderNode } from "./transcript-view.ts";
import { initMarkdownTransformers, initToolRenderers, mermaidTransformerFactory, toolRenderersFor } from "./tool-renderers.ts";
import { registerAgentCreateTool, agentCreateTool } from "./agent-create-tool.ts";
import { registerAgentListTool, agentListTool } from "./agent-list-tool.ts";
import { registerAgentInspectTool, agentInspectTool } from "./agent-inspect-tool.ts";
import { registerAgentControlTools, agentSendTool, agentRemoveTool } from "./agent-control-tool.ts";
import {
  armDeleteConfirm,
  attachTo,
  buildRows,
  clearDeleteConfirm,
  DELETE_CONFIRM_MS,
  deleteConfirmed,
  isVisible,
  moveSelection,
  noteMirrored,
  reconcileSelection,
  selectedRow,
  syncMirror,
  type AgentRow,
  type AgentState,
  type DeleteConfirm,
  type ItemRef,
  type MirrorState,
  type Selection,
} from "./view-model.ts";

// Storage and view logic live in storage.ts / view-model.ts so they can be unit
// tested without a terminal. This file is rendering and key handling only.

function rootOf(ctx: ExtensionContext): RootCtx | null {
  return resolveRoot(ctx.sessionManager.getSessionFile(), ctx.sessionManager.getSessionId());
}

/**
 * Best-effort mtime for ordering "most recently active" agents. A live agent
 * whose session file pi has not flushed yet reads as "very recent" (Date.now)
 * so a just-spawned agent tops the ordering — which is what a user typing
 * `@name` right after spawning a sibling naturally expects.
 */
function statMtime(file: string): number {
  try {
    return fs.statSync(file).mtimeMs;
  } catch {
    return Date.now();
  }
}

/**
 * Snapshot the live-agent pool for the `@` completion list.
 *
 * Ordered most-recently-active first (see `statMtime`) so multiple
 * instances of the same def surface the freshest one first — usually "the
 * one I was just working with". `@` no longer does any routing itself (see
 * README "LLM-callable tools"); this snapshot only feeds editor
 * autocomplete suggestions.
 */
function computeLiveAgents(ctx: ExtensionContext): LiveAgentInfo[] {
  const root = rootOf(ctx);
  if (!root) return [];
  return listAgentEntries(root, (f) => getAgent(f) !== undefined)
    .filter((a) => getAgent(a.file) !== undefined)
    .sort((a, b) => statMtime(b.file) - statMtime(a.file))
    .map((a) => ({ file: a.file, name: a.name, ...(templateId(a) ? { template: templateId(a) } : {}) }));
}

// ── View state (survives per-session extension reloads) ────────────

export interface ViewState extends MirrorState, Selection {
  /** Picker widget visible. */
  open: boolean;
  showHelp: boolean;
  rows: AgentRow[];
  refresh?: () => void;
  /** Removes the chat-container render filter (see transcript-view.ts). */
  unfilter?: () => void;
  /** pi's chat container, once located. Kept so notices can be attributed. */
  chat?: RenderNode;
  /**
   * Which view a *pi-owned* chat child belongs to.
   *
   * `ui.notify` appends pi's own children; those are hidden while an agent is
   * attached, so a notice raised from an agent view was invisible and then
   * surfaced later in main's transcript out of nowhere. Children tagged here
   * draw in the tagged agent's view and nowhere else.
   */
  piChildOwner?: WeakMap<object, string>;
  /** Stops the current editor's agent working spinner. */
  stopStatus?: () => void;
  /** Target waiting for a second Ctrl+X before its action deadline. */
  pendingDeleteKey?: string;
  pendingDeleteUntil?: number;
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
  /**
   * pi's markdown transformers, the same list it hands its own message
   * components (today: the mermaid diagram renderer). Filled in lazily by
   * `ensureMarkdownTransformers` because building it needs the theme instance,
   * which only the entry renderer receives.
   */
  markdownTransformers: unknown[];
  /** `mermaidRenderingMode`, read per render exactly like pi reads it. */
  mermaidMode: () => string;
  /** `showCacheMissNotices`: gates the compaction token/cost notice, like pi. */
  showCostNotices: boolean;
}

export function defaultRenderSettings(): RenderSettings {
  return {
    outputPad: 1,
    markdownTheme: getMarkdownTheme(),
    hideThinkingBlock: false,
    markdownTransformers: [],
    mermaidMode: () => "off",
    showCostNotices: true,
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
      markdownTransformers: [],
      mermaidMode: () => {
        try {
          const get = (settings as { getMermaidRenderingMode?: () => string }).getMermaidRenderingMode;
          return get ? (get.call(settings) ?? "off") : "off";
        } catch {
          return "off";
        }
      },
      tool: { showImages: settings.getShowImages(), imageWidthCells: settings.getImageWidthCells() },
      showCostNotices: settings.getShowCacheMissNotices(),
    };
  } catch {
    return fallback;
  }
}

/**
 * pi's own token formatting (`formatTokens` in its footer component, which the
 * package does not export), so a compaction notice in an agent view reads
 * exactly like the main session's.
 */
function formatTokens(count: number): string {
  if (count < 1000) return count.toString();
  if (count < 10000) return `${(count / 1000).toFixed(1)}k`;
  if (count < 1000000) return `${Math.round(count / 1000)}k`;
  if (count < 10000000) return `${(count / 1000000).toFixed(1)}M`;
  return `${Math.round(count / 1000000)}M`;
}

/**
 * `42%/128k`, exactly like pi's own footer shows context usage for the
 * conversation on screen (`ContextUsage`, `AgentSession.getContextUsage()`).
 * `percent` is `null` right after compaction, before the next LLM response
 * makes a fresh estimate possible.
 */
function formatContextUsage(usage: ContextUsage): string {
  const percent = usage.percent === null ? "?" : usage.percent.toFixed(1);
  return `${percent}%/${formatTokens(usage.contextWindow)}`;
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
  /** pi's collapsible `[skill]` block, when the user text is a skill invocation. */
  private skill?: SkillInvocationMessageComponent;
  private assistant?: AssistantMessageComponent;
  private tool?: ToolExecutionComponent;
  /** pi's collapsible `[compaction]` block, for a compaction the agent did. */
  private compaction?: CompactionSummaryMessageComponent;
  private toolHasRenderers = false;
  /** Lifecycle revision already pushed into the tool box (see render). */
  private toolRevision?: number;
  private lastSignature = "";
  private lastExpanded?: boolean;
  /** True when the last render stripped a leading line (see `handleMouse`). */
  private droppedLeadingLine = false;
  /** Free-text part of a skill invocation, drawn after the `[skill]` block. */
  private skillUserMessage?: string;

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

  /**
   * Forward clicks to whichever of pi's components drew this item.
   *
   * pi's expand affordance for a truncated tool result is a `MouseRegion`
   * *inside* `ToolExecutionComponent`, so without this a click on an agent's
   * tool box did nothing (it started a text selection instead) while the same
   * box on `main` expanded.
   *
   * The `y` shift matters: `dropLeadingSpacer` removes one line from the top of
   * what the inner component produced, so the coordinates the parent hands us
   * are one line above the component's own.
   */
  handleMouse(event: unknown): unknown {
    const target = this.tool ?? this.assistant ?? this.user;
    const handler = (target as { handleMouse?: (e: unknown) => unknown } | undefined)?.handleMouse;
    if (!handler || !target) return undefined;
    const e = event as { y?: number };
    const shifted = this.droppedLeadingLine && typeof e?.y === "number" ? { ...e, y: e.y + 1 } : event;
    return handler.call(target, shifted);
  }

  render(width: number): string[] {
    if (!this.visible(this.ref.file)) return [];
    const items = this.read(this.ref.file);
    const item = items[this.ref.index];
    if (!item) return [];
    const pad = this.settings.outputPad;

    // pi's `CustomEntryComponent` (the wrapper around every custom entry pi
    // holds) unconditionally prepends `Spacer(1)` to whatever this renderer
    // returns. That Spacer plays the same role as pi's native "blank between
    // messages" convention — so if our render *also* starts with a Spacer's
    // truly-empty `""` line (assistant and tool components both do), or if we
    // add our own `""` prefix for a user message with preceding content, the
    // two double up and every message pair grows an extra blank. `dropLeadingSpacer`
    // borrows the CustomEntry Spacer as the between-messages gap: it strips
    // one leading zero-width line (empty string, or a line containing only
    // escape sequences like AssistantMessageComponent's OSC133 zone marker on
    // top of its `Spacer(1)`), while leaving Box padding lines (from
    // `applyBg("", w)`, which produce bg-tinted spaces — non-zero width)
    // untouched so a user message keeps its box top-padding.
    // ... and keeps whatever zero-width prefix that line carried. pi puts an
    // OSC133 prompt-zone marker there, which fullscreen's `Ctrl+↑`/`Ctrl+↓`
    // prompt navigation looks for — dropping it silently made prompt jumping in
    // an agent view skip every assistant turn.
    const dropLeadingSpacer = (lines: string[]): string[] => {
      this.droppedLeadingLine = lines.length > 0 && visibleWidth(lines[0]!) === 0;
      if (!this.droppedLeadingLine) return lines;
      const rest = lines.slice(1);
      const marker = lines[0]!;
      if (marker.length > 0 && rest.length > 0) rest[0] = `${marker}${rest[0]}`;
      return rest;
    };

    switch (item.kind) {
      case "user": {
        // A steer can be a skill invocation (`/skill:foo`), which pi does not
        // draw as plain text: it renders a collapsible `[skill]` block plus the
        // user's own message, if any. Same components, same order, so an agent
        // view shows what the main session would.
        const block = this.skill ? undefined : parseSkillBlock(item.text);
        if (block || this.skill) {
          if (!this.skill && block) {
            this.skill = new SkillInvocationMessageComponent(block, this.settings.markdownTheme);
            this.skillUserMessage = block.userMessage;
          }
          if (this.lastExpanded !== this.expanded) {
            this.lastExpanded = this.expanded;
            this.skill!.setExpanded(this.expanded);
          }
          const out = this.skill!.render(width);
          if (this.skillUserMessage !== undefined) {
            this.user ??= new UserMessageComponent(
              this.skillUserMessage,
              this.settings.markdownTheme,
              pad,
              this.settings.markdownTransformers as never,
            );
            // pi separates the two with a blank line.
            out.push("");
            out.push(...this.user.render(width));
          }
          this.droppedLeadingLine = false;
          return out;
        }
        this.user ??= new UserMessageComponent(
          item.text,
          this.settings.markdownTheme,
          pad,
          this.settings.markdownTransformers as never,
        );
        this.droppedLeadingLine = false;
        return this.user.render(width);
      }

      case "assistant": {
        // The component draws text, thinking blocks and stop-reason notices,
        // and adds its own leading spacer — same call pi makes, with the same
        // arguments (including its markdown transformers, so a ```mermaid block
        // becomes a diagram here too).
        this.assistant ??= new AssistantMessageComponent(
          undefined,
          this.settings.hideThinkingBlock,
          this.settings.markdownTheme,
          undefined,
          pad,
          this.settings.markdownTransformers as never,
        );
        const signature = assistantSignature(item);
        if (signature !== this.lastSignature) {
          this.lastSignature = signature;
          this.assistant.updateContent(item.message, item.streaming);
        }
        return dropLeadingSpacer(this.assistant.render(width));
      }

      case "toolCall": {
        if (!this.tui) {
          return [truncateToWidth(`${" ".repeat(pad)}${this.theme.fg("warning", `⏵ ${item.name}`)}`, width)];
        }
        // Renderers load asynchronously (see initToolRenderers): the first
        // render of a fresh agent view can race that load. `toolDefinition`
        // is constructor-only on `ToolExecutionComponent`, so a tool call
        // built before renderers were ready would be stuck rendering its
        // bare name plus raw JSON args forever. Rebuild once renderers show
        // up instead of caching that miss permanently.
        const renderers = toolRenderersFor(item.name);
        if (!this.tool || (!this.toolHasRenderers && renderers)) {
          this.tool = new ToolExecutionComponent(
            item.name,
            item.id,
            item.args,
            this.settings.tool,
            renderers as never,
            this.tui,
            this.cwd,
          );
          this.toolHasRenderers = Boolean(renderers);
          // A fresh box knows nothing: replay the call's whole lifecycle below.
          this.toolRevision = undefined;
          this.tool.setExpanded(this.expanded);
          this.lastExpanded = this.expanded;
        } else if (this.lastExpanded !== this.expanded) {
          this.lastExpanded = this.expanded;
          this.tool.setExpanded(this.expanded);
        }
        // Replay the call's state onto pi's component — the same calls pi's own
        // interactive mode makes, in the same order (args → execution started →
        // args complete → result), but only when something actually changed.
        //
        // Doing it per frame instead would be ruinous: each of these setters runs
        // `updateDisplay()`, which clears the box and re-invokes the tool's
        // renderers, throwing away the line caches pi's `Text`/`Markdown`
        // components keep. Fullscreen re-renders the whole document on every
        // frame, so that made typing and scrolling in a tool-heavy agent view
        // lag while `main` stayed smooth (~6x pi's own per-frame cost).
        if (this.toolRevision !== item.revision) {
          this.toolRevision = item.revision;
          this.tool.updateArgs(item.args);
          if (item.argsComplete) this.tool.setArgsComplete();
          if (item.executionStarted) this.tool.markExecutionStarted();
          if (item.result) {
            this.tool.updateResult(
              { content: item.result.content, details: item.result.details, isError: item.result.isError },
              item.result.isPartial,
            );
          }
        }
        return dropLeadingSpacer(this.tool.render(width));
      }

      // Results are rendered together with their call.
      case "toolResult":
        return [];

      case "compaction": {
        // pi's own `[compaction]` block, same component and expand state, plus
        // the token/cost notice it writes underneath (when notices are on).
        this.compaction ??= new CompactionSummaryMessageComponent(
          {
            role: "compactionSummary",
            summary: item.summary,
            tokensBefore: item.tokensBefore,
            timestamp: item.timestamp,
          } as never,
          this.settings.markdownTheme,
        );
        if (this.lastExpanded !== this.expanded) {
          this.lastExpanded = this.expanded;
          this.compaction.setExpanded(this.expanded);
        }
        const out = this.compaction.render(width);
        if (this.settings.showCostNotices && item.usageTokens !== undefined) {
          const cost = item.usageCost !== undefined && item.usageCost >= 0.01 ? ` (~$${item.usageCost.toFixed(2)})` : "";
          out.push("");
          out.push(
            truncateToWidth(
              `${" ".repeat(pad)}${this.theme.fg("warning", `Compaction: ${formatTokens(item.usageTokens)} tokens billed${cost}`)}`,
              width,
            ),
          );
        }
        this.droppedLeadingLine = false;
        return out;
      }

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
  stopped: "Stopped",
  idle: "Idle",
  completed: "Completed",
};

function clip(s: string, n: number): string {
  return s.length <= n ? s : `${s.slice(0, Math.max(1, n - 1))}…`;
}

/**
 * `left` unchanged, `right` pushed to the far edge of `width` with at least
 * two spaces between them — the same layout pi's own footer uses to put the
 * model name on the right of the stats line. `right` is informational, not
 * load-bearing, so when there is no room for it (a narrow terminal) it is
 * dropped whole rather than truncated into something unreadable.
 */
function rightAlign(left: string, right: string, width: number): string {
  const minGap = 2;
  const leftWidth = visibleWidth(left);
  const rightWidth = visibleWidth(right);
  if (leftWidth + minGap + rightWidth > width) return left;
  return left + " ".repeat(width - leftWidth - rightWidth) + right;
}

/** Border characters kept to the right of the editor's view label. */
const LABEL_TAIL = 4;

/**
 * Lines the dock keeps for itself around the picker widget: one line of
 * transcript (pi's layout never gives it less), the editor's three, the footer,
 * the `Spacer(1)` pi puts above widget content, and slack for the pending /
 * status rows.
 *
 * This matters in fullscreen, where a widget is *not* part of the scrolling
 * document but a fixed pane in the dock (`chat-viewport.js`): pi does not clamp
 * factory-built widgets at all, the transcript is squeezed to a single line to
 * make room, and anything that still doesn't fit is cut — from the bottom, with
 * no indicator, and the shrink can eat into the editor and footer as well.
 */
const DOCK_RESERVE = 9;

/** How many lines the picker may draw without pushing pi's own UI around. */
export function pickerBudget(): number {
  return Math.max(6, (process.stdout.rows || 24) - DOCK_RESERVE);
}

/**
 * How many agent rows fit in that budget.
 *
 * Each row costs two lines (name + meta), and the frame around them costs about
 * three (title, rule, one group header). Used for rendering and for scrolling,
 * so the cursor can never sit outside the drawn window.
 */
function viewportRows(): number {
  return Math.max(1, Math.floor((pickerBudget() - 3) / 2));
}

/** Never exceed the budget. */
function fitToBudget(out: string[]): string[] {
  return out.slice(0, pickerBudget());
}

export function renderPicker(view: ViewState, th: Theme, width: number): string[] {
  if (!view.open) return [];
  const out: string[] = [];
  const rule = th.fg("dim", "─".repeat(Math.max(4, Math.min(width - 4, 100))));

  if (view.showHelp) {
    out.push(truncateToWidth(`  ${th.fg("accent", th.bold("Agents — keys"))}`, width));
    out.push(truncateToWidth(`  ${rule}`, width));
    for (const [k, d] of [
      ["↑ ↓", "Select agent"],
      ["Enter / →", "Attach: stream it into the transcript"],
      ["Enter + text", "Create an agent with exactly that task and attach"],
      ["Esc", "Detach (agent keeps running)"],
      ["Ctrl+X", "Press twice to delete (main: abort)"],
      ["/model [name]", "Set that agent's model (Ctrl+L when attached)"],
      ["←", "Close the picker (reopen to refresh the list)"],
      ["@agent:<template> <task>", "Refer to a reusable template when creating an agent"],
      ["@<instance> <task>", "Refer to a live instance"],
      ["/agents", "List agent templates (rescans)"],
    ] as const) {
      out.push(truncateToWidth(`    ${th.fg("accent", k.padEnd(15))}${th.fg("text", d)}`, width));
    }
    return fitToBudget(out);
  }

  const working = view.rows.filter((r) => r.state === "working").length;
  const title = th.fg("accent", th.bold("◆ Agents"));
  const count = th.fg("muted", `${view.rows.length} agent${view.rows.length === 1 ? "" : "s"}`);
  const busy = working > 0 ? th.fg("warning", ` · ${working} working`) : "";
  const left = `  ${title}  ${count}${busy}`;
  const hint = th.fg("dim", "(? help)");
  out.push(truncateToWidth(rightAlign(left, hint, width), width));
  out.push(truncateToWidth(`  ${rule}`, width));

  // The cursor is the *agent* it is on, so it cannot drift onto a neighbour
  // when a state change re-sorts the list between refreshes.
  const cursor = view.rows.findIndex((r) => r.key === view.key);
  const maxRows = viewportRows();
  if (view.scroll > 0) out.push(truncateToWidth(th.fg("dim", `  ↑ ${view.scroll} more`), width));

  const end = Math.min(view.scroll + maxRows, view.rows.length);
  // Seed from the row *above* the window: a group whose header scrolled off
  // must not have a second one drawn at the top of the viewport, which reads as
  // a group boundary that isn't there.
  let lastState: AgentState | undefined = view.rows[view.scroll - 1]?.state;

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
          : row.state === "stopped"
            ? th.fg("muted", "⊘")
            : row.state === "completed"
              ? th.fg("success", "✓")
              : th.fg("dim", "∙");

    const pointer = i === cursor ? th.fg("accent", " ▸ ") : "   ";
    const name = clip(row.name || "(unnamed)", 48);
    const nameStr = i === cursor ? th.fg("accent", name) : th.fg("text", name);
    // The state icon + group header already say everything about the agent's
    // status, so no "(live)" tag and no ticking mtime column.
    // No "[main]" tag: the root session is just the agent called "main".
    const badge = row.template ? th.fg("muted", ` [${row.template}]`) : "";
    const tags = row.isAttached ? th.fg("success", " (attached)") : "";
    out.push(truncateToWidth(`${pointer}${icon} ${nameStr}${badge}${tags}`, width));

    const deleting = deleteConfirmed(view, row.key);
    const meta = deleting
      ? th.fg("error", row.isRoot ? "Press Ctrl+X again to abort" : "Press Ctrl+X again to delete")
      : th.fg("muted", `${row.messageCount} msg${row.messageCount === 1 ? "" : "s"}`);
    const model = !deleting && row.model ? th.fg("dim", ` · ${row.model}`) : "";
    const context = !deleting && row.contextUsage ? th.fg("dim", ` · ${formatContextUsage(row.contextUsage)}`) : "";
    out.push(truncateToWidth(`     ${meta}${model}${context}`, width));
  }

  if (end < view.rows.length) {
    out.push(truncateToWidth(th.fg("dim", `  ↓ ${view.rows.length - end} more`), width));
  }

  return fitToBudget(out);
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
  /** Ctrl+X: confirm, then abort main or delete an agent outright. */
  | { t: "terminate"; key: string }
  | { t: "terminateMain" }
  /** A `BLOCKED_ATTACHED_COMMANDS` command was typed while attached. */
  | { t: "blockedCommand"; name: string };

/**
 * What the editor frame says about the conversation on screen.
 *
 * `working` is the *attached agent's* streaming state, not pi's session state:
 * the two are independent, so an idle agent must not inherit "Working" from a
 * busy main session, and a working agent must show it even when main is idle.
 */
interface ViewStatus {
  /** Plain-text name for the right end of the border. */
  label: string;
  /** True while the conversation on screen is streaming. */
  working: boolean;
  /** False on the main session, where pi owns the working status. */
  ownStatus: boolean;
}

/**
 * pi's embedded working status, driven by an agent instead of pi's session.
 *
 * `CustomEditor` only needs `renderInBorder`/`renderSpinnerInBorder` from an
 * indicator, and `Loader` already animates itself and asks the TUI to repaint,
 * so this is the same spinner pi draws, on our own state.
 */
class AgentWorkingStatus extends Loader {
  constructor(tui: TUI, message: string, colorFn: (text: string) => string) {
    super(tui, colorFn, colorFn, message);
  }

  /** Mirrors pi's `WorkingStatusIndicator`: the loader line, unpadded. */
  renderInBorder(width: number): string {
    const line = super.render(width + 2)[1] ?? "";
    return truncateToWidth(line.startsWith(" ") ? line.slice(1).trimEnd() : line.trimEnd(), width, "");
  }

  renderSpinnerInBorder(width: number): string {
    return truncateToWidth(this.getRenderedIndicator(), width, "");
  }
}

/** Shown on the agent's editor border while it streams. */
const AGENT_WORKING_MESSAGE = "Working";

export class AgentViewEditor extends CustomEditor {
  constructor(
    tui: ConstructorParameters<typeof CustomEditor>[0],
    theme: ConstructorParameters<typeof CustomEditor>[1],
    /** Kept: `CustomEditor.keybindings` is private, and model keys are remappable. */
    private readonly kb: ConstructorParameters<typeof CustomEditor>[2],
    private readonly view: ViewState,
    private readonly act: (a: Action) => void,
    /** What to draw on the frame: the view's name and *its* working state. */
    private readonly status: () => ViewStatus,
  ) {
    super(tui, theme, kb, { embedWorkingStatus: true });
    this.tuiRef = tui as TUI;
  }

  private readonly tuiRef: TUI;
  /** pi's indicator, remembered so the main session keeps its own status. */
  private piStatus?: unknown;
  private agentStatus?: AgentWorkingStatus;
  /**
   * Whether `agentStatus`'s animation timer is currently running.
   *
   * `renderTopBorder` calls `borderStatus()` on every render — including every
   * tick the spinner's own timer causes via `ui.requestRender()` — so calling
   * `start()` unconditionally there would call `Loader.restartAnimation()`
   * (stop + setInterval) that often too, clearing the interval before it ever
   * fires and freezing the icon. Only (re)start on the stopped→working edge.
   */
  private agentStatusRunning = false;

  /** pi hands over its working indicator whenever its own session streams. */
  override setWorkingStatusIndicator(indicator: Parameters<CustomEditor["setWorkingStatusIndicator"]>[0]): void {
    this.piStatus = indicator;
    super.setWorkingStatusIndicator(indicator);
  }

  /** Stop the spinner's timer (pi replaces the editor on every session start). */
  stopStatus(): void {
    this.agentStatus?.stop();
  }

  /**
   * The indicator to embed in the border for the conversation on screen.
   *
   * While attached this is ours, so it tracks that agent and nothing else;
   * on the main session it is pi's, untouched.
   */
  private borderStatus(working: boolean, ownStatus: boolean): unknown {
    if (!ownStatus) {
      this.agentStatus?.stop();
      this.agentStatusRunning = false;
      return this.piStatus;
    }
    if (!working) {
      this.agentStatus?.stop();
      this.agentStatusRunning = false;
      return undefined;
    }
    if (!this.agentStatus) {
      this.agentStatus = new AgentWorkingStatus(this.tuiRef, AGENT_WORKING_MESSAGE, (text) =>
        this.borderColor(text),
      );
      this.agentStatusRunning = true;
    } else if (!this.agentStatusRunning) {
      this.agentStatus.start();
      this.agentStatusRunning = true;
    }
    return this.agentStatus;
  }

  /**
   * Show which conversation the editor is talking to on the editor frame
   * itself, so the transcript can stay exactly as clean as a normal session's.
   *
   * The label is inset from the right end — "──── ◆ main ────" — and is dropped
   * entirely when the frame is too narrow to keep the working status readable.
   */
  protected override renderTopBorder(width: number, hiddenLineCount: number): string {
    const { label, working, ownStatus } = this.status();

    // `CustomEditor` renders whatever indicator it was handed, so swap ours in
    // for the length of the call instead of reimplementing its border layout
    // (working status on the left, "↑ N more" centred, narrow-width fallbacks).
    const self = this as unknown as { workingStatusIndicator?: unknown };
    const saved = self.workingStatusIndicator;
    self.workingStatusIndicator = this.borderStatus(working, ownStatus);
    let border: string;
    try {
      border = super.renderTopBorder(width, hiddenLineCount);
    } finally {
      self.workingStatusIndicator = saved;
    }

    const text = label;
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
      if (empty && matchesKey(data, "ctrl+x") && !view.attached) {
        this.act({ t: "terminateMain" });
        return;
      }
      if (view.attached) {
        if (empty && matchesKey(data, "escape")) {
          this.act({ t: "detach" });
          return;
        }
        if (empty && matchesKey(data, "ctrl+x")) {
          this.act({ t: "terminate", key: view.attached });
          return;
        }
        if (matchesKey(data, "return") || matchesKey(data, "enter")) {
          // `@name` is no longer special here — it's just chat text. Steering
          // a sibling agent, spawning a new one, checking status, or
          // terminating something is now the *attached agent's own LLM*
          // deciding to call `agent_create` / `agent_send` / `agent_inspect` /
          // `agent_remove` from inside its reply, exactly like main would.
          // See README "LLM-callable tools".
          let text = this.getText().trim();
          if (this.isShowingAutocomplete()) {
            // A popup is up (e.g. "/rel" showing "reload"). pi's own `Editor`
            // treats Enter here as "accept the highlighted suggestion", and
            // for a slash command it *also* falls through to submit in the
            // same keystroke — so classifying `this.getText()` directly would
            // act on the unfinished prefix ("/rel") instead of what the user
            // actually picked ("/reload"). Swap `onSubmit` out for the
            // duration so that fallthrough lands on our own capture instead
            // of pi's real dispatcher (which always targets main, not the
            // attached agent), then classify the *completed* text below.
            const realOnSubmit = this.onSubmit;
            let completed: string | undefined;
            this.onSubmit = (submitted) => {
              completed = submitted;
            };
            super.handleInput(data);
            this.onSubmit = realOnSubmit;
            // Accepting a non-slash completion (a file path, an `@mention`, an
            // argument that isn't a whole command by itself) applies it to the
            // text but never reaches `onSubmit` — nothing to classify yet, let
            // the user keep typing.
            if (completed === undefined) return;
            text = completed;
          }
          if (text) {
            const model = parseModelCommand(text);
            if (model) {
              this.setText("");
              this.act({ t: "model", key: view.attached, search: model.search });
              return;
            }
            const cmd = commandName(text);
            // Global commands (`/settings`, `/login`, `/quit`, ...) never touch
            // `this.session`, so pi's real dispatch is correct no matter which
            // agent is on screen. Call it directly with the resolved text
            // rather than replaying `data` through `super.handleInput`: pi's
            // own handler clears the editor itself, and by this point (an
            // accepted completion) the editor may already be empty anyway.
            if (cmd && GLOBAL_ATTACHED_COMMANDS.has(cmd)) {
              this.onSubmit?.(text);
              return;
            }
            // Blacklisted commands are wired to pi's own session/tree — block
            // them instead of either running them against the wrong session
            // or sending the raw command text to the agent as chat.
            if (cmd && BLOCKED_ATTACHED_COMMANDS.has(cmd)) {
              this.setText("");
              this.act({ t: "blockedCommand", name: cmd });
              return;
            }
            this.setText("");
            this.act({ t: "steer", key: view.attached, text });
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
      if (row) this.act({ t: "terminate", key: row.key });
      return;
    }

    // ↑/↓ drive the picker only while the editor is empty, so prompt history
    // still works as soon as you start typing.
    if (empty && (matchesKey(data, "up") || matchesKey(data, "down"))) {
      const next = moveSelection(view.rows, view, matchesKey(data, "up") ? -1 : 1, viewportRows());
      view.selected = next.selected;
      view.scroll = next.scroll;
      view.key = next.key;
      clearDeleteConfirm(view);
      view.refresh?.();
      return;
    }

    if (matchesKey(data, "return") || matchesKey(data, "enter")) {
      const raw = this.getText();
      const text = raw.trim();
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
        // With the picker open, Enter+text always spawns a plain adhoc
        // agent with the typed text as its task — a deterministic UI
        // gesture (like "attach"/"terminate" below), not something for an
        // LLM to interpret. `@name` has no special meaning here any more:
        // if you want to message/query/delete an *existing* agent by name,
        // that now goes through main's `agent_send` / `agent_inspect` /
        // `agent_remove` tools instead (see README "LLM-callable tools").
        this.act({ t: "spawn", prompt: raw });
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

  // Main loads this extension and receives the shared policy per turn.
  // Sub-agents run with noExtensions and receive the same file through their
  // DefaultResourceLoader in agent-runtime.ts.
  pi.on("before_agent_start", (event) => ({
    systemPrompt: `${event.systemPrompt}\n\n${AGENT_POLICY}`,
  }));

  // The `@<slug>` picker used to be a human-only affordance; now every
  // agent (main and every sub-agent — see `setManagedTools` below) gets the
  // same five tools, so delegation/discovery/inspection/messaging/deletion
  // are all just tool calls, decided by whichever LLM is looking at the message.
  registerAgentCreateTool(pi);
  registerAgentListTool(pi);
  registerAgentInspectTool(pi);
  registerAgentControlTools(pi);
  // Sub-agents are built with `noExtensions: true` (see `ensureAgent` in
  // agent-runtime.ts), so they never load this extension and never call
  // `pi.registerTool` themselves. `customTools` is how they get these same
  // five anyway — set once here, read by every `ensureAgent()` call from
  // then on, for any agent at any depth.
  setManagedTools([agentCreateTool, agentListTool, agentInspectTool, agentSendTool, agentRemoveTool]);

  const view = getView();
  /** Captured from the (invisible) tick widget so components can request renders. */
  let tui: TUI | undefined;
  let deleteTimer: ReturnType<typeof setTimeout> | undefined;
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
    view.chat = chat;
    view.unfilter = installChatFilter(chat, (child) => includeChatChild(view, child, OWNED_ENTRIES));
    // The current frame may already have drawn the unfiltered container.
    tui?.requestRender(true);
  }

  /** Toggle between the main transcript and an agent transcript. */
  function redrawTranscript(): void {
    ensureChatFilter();
    // Switching conversations shows the newest message, like opening a session
    // does — and drops any text selection.
    //
    // In fullscreen the transcript is one ScrollView over the whole document,
    // and its scroll offset (and follow-at-end flag) is *shared* by every view:
    // swapping which conversation is drawn keeps the old offset, merely clamped
    // to the new document's very different height. Without this, attaching to a
    // long agent could land in the middle of its history, detaching could drop
    // you at an arbitrary row of main, and a selection made in one view would
    // stay highlighted over unrelated rows of the other (and be what `/copy`
    // copied).
    const t = tui as unknown as { scrollToBottom?: () => void; clearTextSelection?: () => void } | undefined;
    t?.clearTextSelection?.();
    t?.scrollToBottom?.();
    // Force a full repaint: the visible transcript is replaced wholesale, not
    // appended to, so a differential frame would leave the old view behind.
    tui?.requestRender(true);
  }

  /**
   * Build pi's markdown transformers once, on first render.
   *
   * They are not part of `readRenderSettings` because `createMermaidMarkdownTransformer`
   * needs the live theme instance, and the only place an extension is handed it
   * is the entry renderer.
   */
  function ensureMarkdownTransformers(theme: Theme): void {
    if (renderSettings.markdownTransformers.length > 0) return;
    const create = mermaidTransformerFactory();
    if (!create) return;
    renderSettings.markdownTransformers = [create({ getMode: renderSettings.mermaidMode, theme })];
  }

  // Agent output is rendered by pi, through this renderer. `options.expanded`
  // is pi's Ctrl+O state, so agent tool boxes expand with everything else.
  pi.registerEntryRenderer<ItemRef>(ITEM_ENTRY, (entry, options, theme) => {
    if (!entry.data) return undefined;
    ensureMarkdownTransformers(theme);
    return new AgentItemComponent(
      entry.data,
      theme,
      renderSettings,
      options.expanded,
      tui,
      process.cwd(),
      visible,
    );
  });

  /**
   * Best-effort display name for an agent (or the main session).
   *
   * Sources, in order:
   *   1. Freshly-built picker rows, when the list was recently open. These
   *      also carry live-only bits (state, model, def badge), but for the
   *      label all we need is the slug.
   *   2. The manifest under `__agents__/<rootId>/manifest.json`. Written
   *      *synchronously* by `registerAgent` before `runAgent` starts, so
   *      the name is available immediately after spawn — which is what
   *      keeps the editor label from flashing the raw session-file basename
   *      after `spawn + attach`, before the picker has ever been opened.
   *   3. `SessionManager.getSessionName()`. Empty until pi flushes an
   *      assistant message with a `session_info` entry.
   *   4. Bare `path.basename(file)` as a last resort.
   *
   * `resolveRoot(file, "")` recovers the root purely from the file path
   * (agent files live under `__agents__/<rootId>/`), so this stays a pure
   * helper with no `ctx` dependency.
   *
   * Called from `viewStatus()`, i.e. once per frame while attached, so the
   * manifest hit is memoised: an agent's name is assigned at spawn time and
   * never changes, and without the memo every frame re-read (and re-parsed)
   * `manifest.json` — or, if the agent was somehow not listed there, parsed
   * the agent's whole `.jsonl` through `SessionManager.open`.
   */
  const manifestNames = new Map<string, string>();

  function nameOf(file: string): string {
    const row = view.rows.find((r) => r.key === file);
    if (row) return row.name;
    const memo = manifestNames.get(file);
    if (memo !== undefined) return memo;
    try {
      const root = resolveRoot(file, "");
      if (root) {
        // Pass `getAgent` as the live-check so a just-spawned agent — whose
        // session file pi hasn't flushed yet — is not filtered out by
        // `listAgentEntries`. Without it, the toast after a fresh spawn
        // would show the raw session-file basename instead of the slug.
        const entry = listAgentEntries(root, (f) => getAgent(f) !== undefined).find(
          (a) => a.file === file,
        );
        if (entry) {
          manifestNames.set(file, entry.name);
          return entry.name;
        }
      }
    } catch {
      /* manifest is best-effort; fall through */
    }
    // Not memoised: both of these mean "no name yet", and a later call can do
    // better once the manifest or the session file has caught up.
    try {
      return SessionManager.open(file).getSessionName() ?? path.basename(file);
    } catch {
      return path.basename(file);
    }
  }

  /**
   * A toast that is visible in the conversation that raised it.
   *
   * `ctx.ui.notify` works by appending pi's *own* children to the chat
   * container (`showStatus`/`showError`/`showWarning`), and the filter hides
   * pi's children while an agent is attached. Used raw, every notice raised
   * from an agent view was therefore invisible — typing `/copy` while attached
   * just swallowed the input with no explanation, a model switch confirmed
   * nothing — and then the whole backlog appeared in main's transcript on
   * detach. So tag whatever pi just added with the view it was raised from (see
   * `tagRaisedChildren`), and let the filter draw it there and nowhere else.
   */
  function notify(ctx: ExtensionContext, message: string, level?: "info" | "warning" | "error"): void {
    const chat = view.chat;
    const owner = view.attached;
    if (!chat || owner === undefined) {
      ctx.ui.notify(message, level);
      return;
    }
    view.piChildOwner ??= new WeakMap();
    tagRaisedChildren(chat, owner, view.piChildOwner, () => ctx.ui.notify(message, level));
    tui?.requestRender();
  }

  /** Append any agent transcript items that pi has not rendered yet. */
  function mirror(changed?: string): void {
    const appended = syncMirror(view, (ref) => pi.appendEntry<ItemRef>(ITEM_ENTRY, ref));
    // Repaint only when the screen can actually have changed.
    //
    // This runs on *every* streaming delta of *every* live agent, and a repaint
    // is not cheap: fullscreen mode re-renders the whole document (the entire
    // transcript, not just the viewport) on every frame, at up to 60 fps. A
    // background agent's deltas change nothing that is on screen — its entries
    // are filtered out, the picker is a snapshot, and the editor border shows
    // only the current view's own status — so repainting for them just burned a
    // full render per delta and made typing lag while any agent was working.
    // Repaint when: new entries were mirrored, or the agent being *looked at*
    // moved (its streaming message mutates in place, and its state drives the
    // border spinner), or the caller didn't say who changed.
    if (appended > 0 || changed === undefined || changed === view.attached) tui?.requestRender();
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

  function clearDeleteConfirmation(): void {
    if (deleteTimer) clearTimeout(deleteTimer);
    deleteTimer = undefined;
    clearDeleteConfirm(view);
  }

  function closePicker(ctx: ExtensionContext): void {
    clearDeleteConfirmation();
    view.open = false;
    view.showHelp = false;
    ctx.ui.setWidget("agent-view", undefined);
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
      rootContextUsage: ctx.getContextUsage(),
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
      notify(ctx, "Agents need a saved session", "error");
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
    clearDeleteConfirmation();
    view.open = true;

    ctx.ui.setWidget("agent-view", (_tui, theme) => ({
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
      notify(ctx, "That agent's session file is gone", "error");
      return;
    }
    if (view.attached === file) {
      closePicker(ctx);
      return;
    }
    try {
      await ensureAgent(file, ctx.cwd, ctx.model, ctx.thinkingLevel, defForFile(ctx, file));
    } catch (err) {
      notify(ctx, `Could not open agent: ${String(err)}`, "error");
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
   * Ctrl+X always needs confirmation: it aborts main, or irreversibly deletes
   * an agent, only after a second press on the same target within the window.
   */
  function requestTerminate(ctx: ExtensionContext, file: string, main = false): void {
    const isMain = main || file === ctx.sessionManager.getSessionFile();
    if (deleteConfirmed(view, file)) {
      clearDeleteConfirmation();
      if (isMain) ctx.abort();
      else void terminate(ctx, file);
      return;
    }

    clearDeleteConfirmation();
    const deadline = armDeleteConfirm(view, file);
    if (!view.open) {
      notify(ctx, isMain ? "Press Ctrl+X again to abort" : `Press Ctrl+X again to delete ${nameOf(file)}`, "warning");
    }
    view.refresh?.();
    tui?.requestRender();
    deleteTimer = setTimeout(() => {
      if (view.pendingDeleteKey !== file || view.pendingDeleteUntil !== deadline) return;
      clearDeleteConfirmation();
      view.refresh?.();
      tui?.requestRender();
    }, DELETE_CONFIRM_MS);
  }

  /**
   * Ctrl+X. On main this is an abort; on an agent it is a hard delete: the
   * turn is aborted, the session dropped, its manifest entry
   * removed and its `.jsonl` erased from disk. Unlike a stopped agent, there
   * is no record left afterwards — the agent disappears from the list and
   * attaching to it again is not possible; if you were looking at it, you are
   * dropped back to `main`.
   */
  async function terminate(ctx: ExtensionContext, file: string): Promise<void> {
    if (file === ctx.sessionManager.getSessionFile()) {
      ctx.abort();
      return;
    }
    const name = nameOf(file);
    manifestNames.delete(file);
    await forgetAgent(file);
    const root = rootOf(ctx);
    if (root) removeAgentEntry(root, file);
    if (view.attached === file) {
      attachTo(view, undefined);
      redrawTranscript();
    }
    notify(ctx, `Deleted ${name}`, "info");
    refreshRowsIfOpen(ctx);
    tui?.requestRender();
  }

  /**
   * Create a new plain agent from the picker and immediately show it.
   * The user's text is the complete task: this direct UI gesture deliberately
   * does not prepend context from main or from the previously attached agent.
   */
  async function spawn(ctx: ExtensionContext, prompt: string): Promise<string | undefined> {
    const root = rootOf(ctx);
    if (!root) {
      notify(ctx, "Agents need a saved session", "error");
      return undefined;
    }

    const existing = listAgentEntries(root, (f) => getAgent(f) !== undefined);
    const name = agentName(prompt, existing.map((a) => a.name));
    let file: string | undefined;
    try {
      file = registerAgent(root, name, ctx.cwd);
      await runAgent(file, prompt, ctx.cwd, ctx.model, ctx.thinkingLevel);
    } catch (err) {
      // A registered agent may not have a session file yet. Remove its manifest
      // entry as well so a failed one-off start does not consume a slot.
      if (file) removeAgentEntry(root, file);
      notify(ctx, `Could not start agent: ${String(err)}`, "error");
      return undefined;
    }
    await attach(ctx, file);
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
          notify(ctx, `No auth configured for ${model.provider}`, "error");
          return;
        }
      } else if (!(await setAgentModel(file, model))) {
        notify(ctx, "That agent is not live", "warning");
        return;
      }
      notify(ctx, `${nameOf(file)} → ${model.id}`, "info");
      refreshRowsIfOpen(ctx);
    } catch (err) {
      notify(ctx, err instanceof Error ? err.message : String(err), "error");
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
        await ensureAgent(file, ctx.cwd, ctx.model, ctx.thinkingLevel, defForFile(ctx, file));
      } catch (err) {
        notify(ctx, `Could not open agent: ${String(err)}`, "error");
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
        notify(ctx, "No other model available", "warning");
        return;
      }
      notify(ctx, `${nameOf(file)} → ${model.id}`, "info");
      refreshRowsIfOpen(ctx);
    } catch (err) {
      notify(ctx, err instanceof Error ? err.message : String(err), "error");
    }
  }

  // ── Commands ───────────────────────────────────────────────────
  //
  // Extension commands execute immediately even while the agent is streaming,
  // so they never have to interrupt a turn.

  /**
   * Look up the agent template recorded for `file` in the group's manifest.
   *
   * Returns undefined for a plain agent (no def field), the root/main session,
   * or a def whose file has since been removed from `.pi/agents/`. The latter
   * case is intentionally silent: the agent still revives as a plain agent and
   * keeps its recorded model — deleting a def shouldn't break running agents.
   */
  function defForFile(ctx: ExtensionContext, file: string): SubAgentDef | undefined {
    const root = rootOf(ctx);
    if (!root) return undefined;
    if (file === root.rootFile) return undefined;
    const entry = listAgentEntries(root).find((a) => a.file === file);
    const template = entry ? templateId(entry) : undefined;
    return template ? loadCatalog(ctx.cwd).agents.get(template) : undefined;
  }

  pi.registerCommand("agents", {
    description: "List agent templates discovered under .pi/agents/",
    handler: async (_args, ctx) => {
      // Force a rescan every time: users edit files while pi is running and
      // expect the next `/agents` to see the change without a reload flag.
      const catalog = loadCatalog(ctx.cwd);
      if (catalog.agents.size === 0 && catalog.diagnostics.length === 0) {
        notify(
          ctx,
          "No agent templates found under .pi/agents/ or ~/.pi/agent/agents/",
          "info",
        );
        return;
      }
      const lines: string[] = [];
      for (const def of [...catalog.agents.values()].sort((a, b) => a.name.localeCompare(b.name))) {
        lines.push(`@agent:${def.name}  [${def.scope}]  ${def.description}`);
        lines.push(`  ${def.source}`);
      }
      for (const diag of catalog.diagnostics) {
        lines.push(`(skipped) ${diag.path}: ${diag.error}`);
      }
      notify(ctx, lines.join("\n"), "info");
    },
  });

  // ── Wiring ─────────────────────────────────────────────────────

  pi.on("session_start", (event, ctx) => {
    if (ctx.mode !== "tui") return;
    clearDeleteConfirmation();

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
    // Mermaid diagrams: same story, a module pi does not export (see
    // tool-renderers.ts). Without it an agent's ```mermaid block would render as
    // raw source while the identical reply on `main` draws a diagram.
    void initMarkdownTransformers().then((ok) => {
      if (ok) tui?.requestRender();
    });
    ctx.ui.addAutocompleteProvider((current) =>
      // `wrapWithAgentMentions` must be innermost so its
      // `shouldTriggerFileCompletion` override reaches the base provider (the
      // outer filter only touches `/`-suggestions).
      withAttachedCommandFilter(
        wrapWithAgentMentions(current, () => {
          // Just for autocomplete suggestions now — `@` doesn't route or
          // exclude anything at submit time any more (see README "LLM-callable
          // tools"). Still drops the currently attached agent so you aren't
          // offered to `@` yourself from your own view.
          const catalog = loadCatalog(ctx.cwd);
          const liveAgents = computeLiveAgents(ctx).filter((a) => a.file !== view.attached);
          return { catalog, liveAgents };
        }),
        view,
      ),
    );

    view.open = false;
    if (!reloaded) {
      // A different session means a different chat container and a fresh view.
      // Live agents are unaffected: they are not pi sessions.
      view.attached = undefined;
      view.unfilter?.();
      view.unfilter = undefined;
    }
    restoreFromSession(ctx);
    ctx.ui.setWidget("agent-view", undefined);
    // Clear any footer status left behind by an older build of this extension.
    ctx.ui.setStatus("agent-view", undefined);

    // Zero-height widget used only to obtain a TUI handle: transcript content
    // lives in pi's transcript, never in a widget.
    ctx.ui.setWidget("agent-view-tick", (t) => {
      tui = t;
      view.refresh = () => t.requestRender();
      return {
        render: () => {
          // Cheap once installed; the container can only be found after pi has
          // built a child for one of our entries.
          // Install the chat filter as soon as we have entries to filter,
          // whether attached or not. On main it hides our custom entries so
          // they don't contribute pi-Spacer blank lines; on attached views
          // it's what separates the agent's stream from main's. Cheap once
          // installed (single container lookup, cached via `view.unfilter`).
          ensureChatFilter();
          return [];
        },
        invalidate: () => {},
      };
    });

    // Live agents push updates; mirror new items into pi's transcript.
    setOnChange((file) => mirror(file));

    /**
     * What the editor frame says about the conversation on screen.
     *
     * The name is always shown, including the main session (as the agent called
     * "main"), so there is never any doubt about where a prompt is going. The
     * working state is that conversation's own: pi's status indicator tracks
     * pi's session, so while attached it is replaced by the agent's, otherwise
     * an idle agent would show "Working" borrowed from a busy main session (and
     * a working agent would show nothing while main is idle).
     */
    const viewStatus = (): ViewStatus => {
      const file = view.attached;
      if (view.open) {
        return {
          label: ` ◆ ${file ? nameOf(file) : ROOT_AGENT_NAME} `,
          working: false,
          ownStatus: true,
        };
      }
      return {
        label: ` ◆ ${file ? nameOf(file) : ROOT_AGENT_NAME} `,
        working: file ? stateOf(file) === "working" : !ctx.isIdle(),
        ownStatus: file !== undefined,
      };
    };

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
            // Direct picker creation switches straight into the new agent. The
            // prompt is passed through verbatim by spawn(), with no inherited
            // conversation context.
            void spawn(ctx, action.prompt);
            break;
          case "steer":
            void steerAgent(action.key, action.text).then((ok) => {
              if (!ok) notify(ctx, "That agent is not live", "warning");
            });
            break;
          case "model":
            closePicker(ctx);
            void chooseModel(ctx, action.key, action.search);
            break;
          case "cycleModel":
            void cycleModel(ctx, action.key, action.direction);
            break;
          case "terminate":
            requestTerminate(ctx, action.key);
            break;
          case "terminateMain":
            requestTerminate(ctx, ctx.sessionManager.getSessionFile() ?? "", true);
            break;
          case "blockedCommand":
            notify(ctx, `/${action.name} isn't available while attached to an agent — detach (Esc) first`, "warning");
            break;
        }
      };

      // Stop the previous editor's spinner: pi builds a new editor on every
      // session start and never renders the old one again.
      view.stopStatus?.();
      const editor = new AgentViewEditor(t, theme, kb, view, act, viewStatus);
      view.stopStatus = () => editor.stopStatus();

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
    clearDeleteConfirmation();
    view.open = false;
    view.attached = undefined;
    view.mirrored = {};
    view.unfilter?.();
    view.unfilter = undefined;
    setOnChange(undefined);
    ctx.ui.setWidget("agent-view", undefined);
    ctx.ui.setWidget("agent-view-tick", undefined);
    ctx.ui.setStatus("agent-view", undefined);
    // Only release the pool when pi is really going away; a session switch or
    // extension reload must leave background agents running.
    if (event.reason === "quit") void disposeAll();
  });
}
