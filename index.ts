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
 *   Enter + text   picker open: spawn a background agent with that prompt
 *                  attached:    `@<slug>` from another agent stays background,
 *                               anything else steers the attached agent
 *   Esc            detach (agent keeps running)
 *   Ctrl+X         terminate that agent (main session: interrupt its turn)
 *   Ctrl+L         model selector for the conversation on screen
 *   Ctrl+P         cycle the attached agent's model
 *   ?              help
 *
 * Commands
 *   /agents         list sub-agent definitions discovered under .pi/agents/
 *                   (rescans on every call — no explicit reload flag needed).
 *   /model [name]   while attached (or with the picker open): set that agent's
 *                   model. pi's own /model is intercepted by interactive mode
 *                   and always targets pi's session, so an agent view has to
 *                   recognise it itself.
 *
 * Summoning agents (replaces the old `/agent <task>` command)
 *   `@<slug>` at the **start of a message** (leading whitespace allowed) is
 *   a routing operator. Anywhere else in the message it's prose — the
 *   tight position rule is what keeps "the @pinger def has a bug" from
 *   accidentally spawning an agent. Resolution (see `at-mention.ts`):
 *     1. `agent`                       — spawn a new adhoc agent (inherits main)
 *     2. live agent whose name = slug   — route to that instance
 *     3. live agent(s) whose def = slug — route to the most-recent one
 *     4. catalog def named slug         — spawn a def-backed agent whose
 *                                         Markdown body is appended to pi's
 *                                         base system prompt
 *     5. otherwise                      — not intercepted, chat as usual
 *
 *   Works from anywhere — detached main, picker open, and attached views.
 *   In an attached view, the currently attached agent is excluded from
 *   name/def matching so `@slug` addresses *another* agent; if the only
 *   reachable target is self, the message falls through to `steer` and
 *   goes to the current agent as chat.
 *
 *   Escape a leading `@` with backslash (`\@pinger`) if you want to write
 *   it as literal text at the start of a message; the `\` is stripped
 *   before send. Backticks and quotes also work as escapes.
 *
 *   Typing `@` at the start of the message opens an agent picker instead
 *   of pi's file picker; mid-message `@` still opens pi's file picker
 *   (see `autocomplete.ts`).
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
  Loader,
  matchesKey,
  truncateToWidth,
  visibleWidth,
  wrapTextWithAnsi,
  type AutocompleteItem,
  type AutocompleteProvider,
  type Component,
  type MarkdownTheme,
  type TUI,
} from "@earendil-works/pi-tui";
import {
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
  stateOf,
  steerAgent,
  terminateAgent,
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
import { loadCatalog, type Catalog, type SubAgentDef } from "./agent-catalog.ts";
import { parseAtMention, type LiveAgentInfo } from "./at-mention.ts";
import { wrapWithAgentMentions } from "./autocomplete.ts";
import { findChatContainer, installChatFilter, isOwnedChild, type RenderNode } from "./transcript-view.ts";
import { initToolRenderers, toolRenderersFor } from "./tool-renderers.ts";
import { registerSubagentTool } from "./subagent-tool.ts";
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
 * Strip a leading backslash from `@<slug>` escape sequences, Slack-style.
 *
 * Users who want to write `@pinger` as literal chat (e.g. discussing a bug
 * in that def) type `\@pinger` to suppress interception. The backslash isn't
 * whitespace, so `parseAtMention` sees it as prose and doesn't fire; this
 * helper then removes the `\` before the message is sent so the escape is
 * cosmetic and never leaks into main's transcript or a sub-agent's task.
 *
 * Only `\@<slug>` sequences are touched; other backslashes are left alone.
 */
function stripAtEscape(text: string): string {
  return text.replace(/\\@([a-z][a-z0-9-]*)/g, "@$1");
}

/**
 * Snapshot the live-agent pool for `@`-mention routing and completion.
 *
 * Ordered most-recently-active first (see `statMtime`) so both
 * `parseAtMention` rule 3 and the `@` completion list surface the freshest
 * instance when a def has several running siblings. Callers may further
 * filter by `excludeFile` (typically `view.attached`) to drop "self".
 */
function computeLiveAgents(ctx: ExtensionContext): LiveAgentInfo[] {
  const root = rootOf(ctx);
  if (!root) return [];
  return listAgentEntries(root, (f) => getAgent(f) !== undefined)
    .filter((a) => getAgent(a.file) !== undefined)
    .sort((a, b) => statMtime(b.file) - statMtime(a.file))
    .map((a) => ({ file: a.file, name: a.name, ...(a.def ? { def: a.def } : {}) }));
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
  /** Stops the current editor's agent working spinner. */
  stopStatus?: () => void;
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
  private toolHasRenderers = false;
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
    const dropLeadingSpacer = (lines: string[]): string[] =>
      lines.length > 0 && visibleWidth(lines[0]!) === 0 ? lines.slice(1) : lines;

    switch (item.kind) {
      case "user": {
        this.user ??= new UserMessageComponent(item.text, this.settings.markdownTheme, pad);
        return this.user.render(width);
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
          this.tool.setArgsComplete();
          this.tool.markExecutionStarted();
          this.tool.setExpanded(this.expanded);
          this.lastExpanded = this.expanded;
        } else if (this.lastExpanded !== this.expanded) {
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
        return dropLeadingSpacer(this.tool.render(width));
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
  stopped: "Stopped",
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
      ["Enter + text", "Background spawn (picker) · steer / @-route (attached)"],
      ["Esc", "Detach (agent keeps running)"],
      ["Ctrl+X", "Terminate that agent (main: interrupt the turn)"],
      ["/model [name]", "Set that agent's model (Ctrl+L when attached)"],
      ["←", "Close the picker (reopen to refresh the list)"],
      ["@agent <task>", "Spawn a background agent (inherits main)"],
      ["@<name> <task>", "Route to a live agent, else spawn from .pi/agents/<name>.md"],
      ["/agents", "List sub-agent definitions (rescans)"],
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
    const badge = row.def ? th.fg("muted", ` [${row.def}]`) : "";
    const tags = row.isAttached ? th.fg("success", " (attached)") : "";
    out.push(truncateToWidth(`${pointer}${icon} ${nameStr}${badge}${tags}`, width));

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
  /** `def` is set when a `@<def-name>` mention resolved into a catalog entry. */
  | { t: "spawn"; prompt: string; def?: SubAgentDef; fromAttached?: string }
  | { t: "steer"; key: string; text: string }
  /**
   * Route a message to an existing live agent addressed by `@<slug>`.
   *
   * Distinct from `steer` so the handler can show a "sent to …" toast when
   * the current view isn't that agent, and so the semantics stay readable at
   * the call site: `steer` is the attached view's normal Enter path, `route`
   * is a mention-driven summon of a sibling agent.
   */
  | { t: "route"; key: string; name: string; text: string; fromAttached?: string }
  | { t: "model"; key: string; search?: string }
  | { t: "cycleModel"; key: string; direction: "forward" | "backward" }
  /** Ctrl+X: interrupt the main session's turn, terminate an agent outright. */
  | { t: "terminate"; key: string };

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

/**
 * Slash commands actually implemented for an attached agent, keyed by the
 * name pi's autocomplete lists them under (no leading slash).
 *
 * Every pi built-in command past this set is meaningless for an agent — it
 * operates on pi's own session/tree (`/resume`, `/fork`, `/new`, `/tree`, …),
 * which is not what an attached view is showing — and `handleInput` below
 * never lets pi's real command dispatch run while attached, so typing one
 * used to just get sent to the agent as a chat message with the autocomplete
 * suggesting it as if it would work. Add a command here (and teach
 * `handleInput` to actually run it) as attached-agent support for it lands.
 */
export const SUPPORTED_ATTACHED_COMMANDS = new Set<string>(["model"]);

/**
 * Hide slash commands the attached view does not support from `/` completion,
 * so the suggestion list matches what actually works when you press Enter
 * (see `SUPPORTED_ATTACHED_COMMANDS`). Detached (on `main`), this passes
 * every call straight through: `view.attached` is unset only there.
 */
export function withAttachedCommandFilter(current: AutocompleteProvider, view: ViewState): AutocompleteProvider {
  return {
    triggerCharacters: current.triggerCharacters,
    async getSuggestions(lines, cursorLine, cursorCol, options) {
      const result = await current.getSuggestions(lines, cursorLine, cursorCol, options);
      if (!result || !view.attached) return result;
      // Only the top-level "/" command list needs filtering: a command that
      // made it past that list is one we support, so its own argument
      // completions (prefix has a space in it) are left untouched.
      if (!result.prefix.startsWith("/") || result.prefix.includes(" ")) return result;
      const items = result.items.filter((item: AutocompleteItem) => SUPPORTED_ATTACHED_COMMANDS.has(item.value));
      if (items.length === 0) return null;
      return { ...result, items };
    },
    applyCompletion: (lines, cursorLine, cursorCol, item, prefix) =>
      current.applyCompletion(lines, cursorLine, cursorCol, item, prefix),
    shouldTriggerFileCompletion: current.shouldTriggerFileCompletion
      ? (lines, cursorLine, cursorCol) => current.shouldTriggerFileCompletion!(lines, cursorLine, cursorCol)
      : undefined,
  };
}

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

class AgentViewEditor extends CustomEditor {
  constructor(
    tui: ConstructorParameters<typeof CustomEditor>[0],
    theme: ConstructorParameters<typeof CustomEditor>[1],
    /** Kept: `CustomEditor.keybindings` is private, and model keys are remappable. */
    private readonly kb: ConstructorParameters<typeof CustomEditor>[2],
    private readonly view: ViewState,
    private readonly act: (a: Action) => void,
    /** What to draw on the frame: the view's name and *its* working state. */
    private readonly status: () => ViewStatus,
    /**
     * Scan a submitted prompt for a `@<slug>` mention. Returns a mention that
     * routes to an existing live agent, spawns a new one from a def, spawns
     * an adhoc agent, or null if nothing matches — exactly per
     * `parseAtMention`'s priority order.
     *
     * The editor tells the resolver whether it should exclude a specific
     * file from live-agent matching (the currently attached agent, so a
     * mention there addresses *another* agent, not itself). Injected as a
     * function so the editor stays UI-only and knows nothing about
     * `agent-catalog.ts` or the live agent pool.
     */
    private readonly resolveMention: (text: string, opts?: { excludeFile?: string }) => ReturnType<typeof parseAtMention>,
  ) {
    super(tui, theme, kb, { embedWorkingStatus: true });
    this.tuiRef = tui as TUI;
  }

  private readonly tuiRef: TUI;
  /** pi's indicator, remembered so the main session keeps its own status. */
  private piStatus?: unknown;
  private agentStatus?: AgentWorkingStatus;

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
    if (!ownStatus) return this.piStatus;
    if (!working) {
      this.agentStatus?.stop();
      return undefined;
    }
    if (!this.agentStatus) {
      this.agentStatus = new AgentWorkingStatus(this.tuiRef, AGENT_WORKING_MESSAGE, (text) =>
        this.borderColor(text),
      );
    } else {
      this.agentStatus.start();
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
          // Users escape a literal `@name` in an attached-view message the
          // same way they'd escape one in a main-session message: with a
          // backslash (Slack-style). Strip that `\` before doing anything
          // with the text — mention parsing, /model, or steer — so the
          // escape is cosmetic and never leaks into the sent message.
          const raw = this.getText();
          const text = stripAtEscape(raw).trim();
          if (text) {
            const model = parseModelCommand(text);
            this.setText("");
            if (model) {
              this.act({ t: "model", key: view.attached, search: model.search });
              return;
            }
            // `@<slug>` from within an attached view addresses *another*
            // agent — either an existing live sibling (route) or a fresh
            // spawn. The currently attached agent is passed as excludeFile
            // so it doesn't match itself; if the slug's only reachable
            // target is self, `resolveMention` returns null and we fall
            // through to `steer` (i.e. the mention is treated as chat, and
            // the current agent gets the message as before).
            const mention = this.resolveMention(text, { excludeFile: view.attached });
            if (mention) {
              this.act(
                mention.target.kind === "route"
                  ? {
                      t: "route",
                      key: mention.target.file,
                      name: mention.target.name,
                      text: mention.task,
                      fromAttached: view.attached,
                    }
                  : {
                      t: "spawn",
                      prompt: mention.task,
                      def: mention.target.kind === "def" ? mention.target.def : undefined,
                      fromAttached: view.attached,
                    },
              );
              return;
            }
            this.act({ t: "steer", key: view.attached, text });
            return;
          }
        }
      } else if (matchesKey(data, "return") || matchesKey(data, "enter")) {
        // Detached (main), list closed. `@<slug>` at the *start* of the
        // message routes to a sibling agent or spawns a new one;
        // everything else falls through to pi so ordinary chat works. If
        // the user escaped a leading `@` with a backslash (`\@pinger has a
        // bug`), strip the backslash before pi sees the text — so `main`
        // gets clean prose and the escape stays cosmetic.
        const raw = this.getText();
        if (raw.trim().length > 0) {
          const text = stripAtEscape(raw);
          const mention = this.resolveMention(text);
          if (mention) {
            this.setText("");
            this.act(
              mention.target.kind === "route"
                ? {
                    t: "route",
                    key: mention.target.file,
                    name: mention.target.name,
                    text: mention.task,
                  }
                : {
                    t: "spawn",
                    prompt: mention.task,
                    def: mention.target.kind === "def" ? mention.target.def : undefined,
                  },
            );
            return;
          }
          // Fall through to pi: it reads from the editor buffer on Enter,
          // so overwrite the buffer with the stripped version so pi (main)
          // never sees the escape character.
          if (text !== raw) this.setText(text);
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
      view.refresh?.();
      return;
    }

    if (matchesKey(data, "return") || matchesKey(data, "enter")) {
      const raw = this.getText();
      const text = stripAtEscape(raw).trim();
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
        // With the picker open, Enter+text spawns or routes. A `@<slug>`
        // mention picks the target: an existing live agent gets routed to,
        // a catalog def is spawned, `@agent` spawns adhoc. No mention
        // = adhoc spawn with the typed text (historical picker behaviour).
        const mention = this.resolveMention(text);
        if (mention?.target.kind === "route") {
          this.act({
            t: "route",
            key: mention.target.file,
            name: mention.target.name,
            text: mention.task,
          });
          return;
        }
        this.act({
          t: "spawn",
          prompt: mention ? mention.task : text,
          def: mention && mention.target.kind === "def" ? mention.target.def : undefined,
        });
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

  // The `@<slug>` picker is a human affordance (it intercepts typed prompts);
  // this tool is the model-callable equivalent, sharing the same pool so a
  // tool-spawned agent shows up live in the picker too.
  registerSubagentTool(pi);

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
    view.unfilter = installChatFilter(chat, (child) => {
      if (isOwnedChild(child, OWNED_ENTRIES)) {
        // Our custom entry. Draw only when attached and it belongs to that
        // agent. Any other case (not-attached, or attached to someone else)
        // must skip the whole child so pi's `CustomEntryComponent` wrapper
        // doesn't leak its own `Spacer(1)` padding as a mystery blank line.
        if (view.attached === undefined) return false;
        const ref = (child as { entry?: { data?: ItemRef } } | null)?.entry?.data;
        return ref?.file === view.attached;
      }
      // pi's own child (main-session content). Show only when detached; hide
      // when attached so the agent view is exclusively that agent's stream.
      return view.attached === undefined;
    });
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
   */
  function nameOf(file: string): string {
    const row = view.rows.find((r) => r.key === file);
    if (row) return row.name;
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
        if (entry) return entry.name;
      }
    } catch {
      /* manifest is best-effort; fall through */
    }
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
      ctx.ui.notify("That agent's session file is gone", "error");
      return;
    }
    if (view.attached === file) {
      closePicker(ctx);
      return;
    }
    try {
      await ensureAgent(file, ctx.cwd, ctx.model, ctx.thinkingLevel, defForFile(ctx, file));
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
   * Ctrl+X. On the main session this is pi's interrupt; on an agent it is a
   * hard stop: the turn is aborted and the session dropped, so nothing of that
   * agent is left running. Its transcript stays on disk, so the agent remains
   * in the list and attaching to it revives it.
   */
  async function terminate(ctx: ExtensionContext, file: string): Promise<void> {
    if (file === ctx.sessionManager.getSessionFile()) {
      ctx.abort();
      return;
    }
    const name = nameOf(file);
    const wasLive = await terminateAgent(file);
    ctx.ui.notify(wasLive ? `Terminated ${name}` : `${name} was not running`, wasLive ? "info" : "warning");
    refreshRowsIfOpen(ctx);
    tui?.requestRender();
  }

  /**
   * Create a new agent and hand it the prompt. Returns as soon as the turn is
   * queued: the session you are in is never blocked or interrupted.
   */
  /**
   * Create a new agent and hand it the prompt. Returns as soon as the turn is
   * queued: the session you are in is never blocked or interrupted.
   *
   * `def` (if set) applies a `.pi/agents/<name>.md` sub-agent definition:
   * the Markdown body is appended to the base system prompt, and the def's
   * model / thinking level are used as inheritance defaults. Undefined means
   * a plain adhoc agent (the old `/agent <task>` behaviour).
   */
  async function spawn(
    ctx: ExtensionContext,
    prompt: string,
    options: { attach: boolean; def?: SubAgentDef },
  ): Promise<string | undefined> {
    const root = rootOf(ctx);
    if (!root) {
      ctx.ui.notify("Agents need a saved session", "error");
      return undefined;
    }

    const existing = listAgentEntries(root, (f) => getAgent(f) !== undefined);
    const name = agentName(prompt, existing.map((a) => a.name));
    const file = registerAgent(root, name, ctx.cwd, options.def?.name);
    try {
      await runAgent(file, prompt, ctx.cwd, ctx.model, ctx.thinkingLevel, options.def);
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
        await ensureAgent(file, ctx.cwd, ctx.model, ctx.thinkingLevel, defForFile(ctx, file));
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

  /**
   * Look up the sub-agent def recorded for `file` in the group's manifest.
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
    if (!entry?.def) return undefined;
    return loadCatalog(ctx.cwd).agents.get(entry.def);
  }

  pi.registerCommand("agents", {
    description: "List sub-agent definitions discovered under .pi/agents/",
    handler: async (_args, ctx) => {
      // Force a rescan every time: users edit files while pi is running and
      // expect the next `/agents` to see the change without a reload flag.
      const catalog = loadCatalog(ctx.cwd);
      if (catalog.agents.size === 0 && catalog.diagnostics.length === 0) {
        ctx.ui.notify(
          "No sub-agent definitions found under .pi/agents/ or ~/.pi/agent/agents/",
          "info",
        );
        return;
      }
      const lines: string[] = [];
      for (const def of [...catalog.agents.values()].sort((a, b) => a.name.localeCompare(b.name))) {
        lines.push(`@${def.name}  [${def.scope}]  ${def.description}`);
        lines.push(`  ${def.source}`);
      }
      for (const diag of catalog.diagnostics) {
        lines.push(`(skipped) ${diag.path}: ${diag.error}`);
      }
      ctx.ui.notify(lines.join("\n"), "info");
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
    ctx.ui.addAutocompleteProvider((current) =>
      // `wrapWithAgentMentions` must be innermost so its
      // `shouldTriggerFileCompletion` override reaches the base provider (the
      // outer filter only touches `/`-suggestions).
      withAttachedCommandFilter(
        wrapWithAgentMentions(current, () => {
          // Same snapshot logic as `resolveMention`, but also drop the
          // currently attached agent — you don't `@` yourself from your own
          // view, and rule 2 in at-mention.ts would exclude it at submit
          // time anyway.
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
    setOnChange(() => mirror());

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
            // Every `@<slug> <task>` runs in the background — no auto-attach,
            // no matter which view dispatched the spawn. The user's current
            // conversation stays put (main, or an attached agent); the new
            // sibling appears in the picker on next `←`. A toast confirms
            // where the message went, so it's obvious nothing got hijacked.
            //
            // Rationale: attaching-on-spawn was surprising for the common
            // "fire-and-forget" case (typing `@agent do X` while chatting
            // with main). It also broke symmetry with `route`, which
            // already stays background and just toasts.
            void spawn(ctx, action.prompt, { attach: false, def: action.def }).then((file) => {
              if (!file) return;
              // Prefer the agent's real slug (from the manifest, written
              // synchronously by registerAgent) over the def's name in the
              // toast — that's what the picker will show for the new row,
              // so the user can look for it later without translation.
              const target = `@${nameOf(file)}`;
              if (action.fromAttached && action.fromAttached !== file) {
                const current = `@${nameOf(action.fromAttached)}`;
                ctx.ui.notify(`Started ${target} in the background · ${current} keeps working`, "info");
              } else {
                ctx.ui.notify(`Started ${target} in the background`, "info");
              }
            });
            break;
          case "steer":
            void steerAgent(action.key, action.text).then((ok) => {
              if (!ok) ctx.ui.notify("That agent is not live", "warning");
            });
            break;
          case "route":
            // Sibling agent addressed by `@<slug>`. Same routing primitive
            // as `steer` (steerAgent handles both streaming and idle live
            // agents), but from any view, and with a toast when the current
            // view is somebody else so the user knows their message did
            // not go there.
            void steerAgent(action.key, action.text).then((ok) => {
              if (!ok) {
                ctx.ui.notify(`@${action.name} is not live — attach to revive it`, "warning");
                return;
              }
              if (action.fromAttached && action.fromAttached !== action.key) {
                const current = `@${nameOf(action.fromAttached)}`;
                ctx.ui.notify(`Sent to @${action.name} · ${current} keeps working`, "info");
              } else if (!action.fromAttached) {
                ctx.ui.notify(`Sent to @${action.name} in the background`, "info");
              }
              refreshRowsIfOpen(ctx);
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
            void terminate(ctx, action.key);
            break;
        }
      };

      // Stop the previous editor's spinner: pi builds a new editor on every
      // session start and never renders the old one again.
      view.stopStatus?.();
      // Every submitted prompt is scanned against a freshly-loaded catalog
      // and the current live-agent pool, so users don't need to reload after
      // adding a new .pi/agents/*.md or after spawning a sibling agent.
      //
      // Live agents are ordered most-recently-active first: when several
      // share a def (rule 3 in at-mention.ts), the freshest wins — that's
      // usually "the one I was just working with".
      const resolveMention = (text: string, opts?: { excludeFile?: string }) => {
        const catalog = loadCatalog(ctx.cwd);
        const liveAgents = computeLiveAgents(ctx);
        return parseAtMention(text, { catalog, liveAgents, excludeFile: opts?.excludeFile });
      };
      const editor = new AgentViewEditor(t, theme, kb, view, act, viewStatus, resolveMention);
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
