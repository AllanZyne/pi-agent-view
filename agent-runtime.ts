/**
 * agent-runtime.ts — in-process concurrent agent pool (codex-style)
 *
 * Every agent is its own `AgentSession` created via the SDK. They run
 * concurrently inside the pi process and are never torn down by pi's session
 * switching, so navigating between agents in Agent Views does not abort
 * anything.
 *
 * pi's own session is NOT used to hold agent conversations, and this module
 * never calls `ctx.switchSession()` — that path calls `teardownCurrent()`,
 * which aborts and disposes the outgoing session. Each agent jsonl is owned
 * exclusively by its own AgentSession (single writer, no contention).
 */

import {
  AgentSession,
  createAgentSession,
  DefaultResourceLoader,
  getAgentDir,
  ModelRuntime,
  SessionManager,
} from "@earendil-works/pi-coding-agent";
import type { AssistantMessage, Model, ThinkingLevel } from "@earendil-works/pi-ai";
import type { SubAgentDef } from "./agent-catalog.ts";
import { AGENT_POLICY } from "./agent-policy.ts";
import type { ToolDefinition } from "@earendil-works/pi-coding-agent";

// ─── Types ──────────────────────────────────────────────────────────

/**
 * How an agent's last turn ended.
 *
 * | state | meaning |
 * | --- | --- |
 * | `working` | streaming right now |
 * | `failed` | the task ended with an error |
 * | `stopped` | not running and never reached a verdict: terminated, aborted, or died mid-turn |
 * | `idle` | nothing has run yet, waiting for a prompt |
 * | `completed` | the task finished successfully |
 */
export type AgentState = "idle" | "working" | "completed" | "failed" | "stopped";

/**
 * One rendered item in an agent's transcript.
 *
 * Items keep enough provider-level data (`message`, tool ids, raw result
 * content) for the view layer to render them with pi's own transcript
 * components instead of a bespoke widget renderer.
 */
/**
 * A tool result, partial or final, in the shape `ToolExecutionComponent` wants.
 *
 * `isPartial` is pi's own distinction: output streamed so far (the box keeps its
 * "pending" colours) versus the finished result.
 */
export interface ToolCallResult {
  content: Array<{ type: string; text?: string; data?: string; mimeType?: string }>;
  details?: unknown;
  isError: boolean;
  isPartial: boolean;
}

export type TranscriptItem =
  | { kind: "user"; text: string }
  /**
   * A whole assistant message, text and thinking parts in order, exactly as pi
   * keeps it: `AssistantMessageComponent` renders all of it (markdown, thinking
   * blocks, truncation/abort notices), so the view needs no per-part items.
   */
  | { kind: "assistant"; message: AssistantMessage; streaming: boolean }
  /**
   * A tool call and its whole lifecycle, tracked the way pi's interactive mode
   * tracks a `ToolExecutionComponent`: the box exists as soon as the call appears
   * in the streaming message (args may still be arriving), learns that its args
   * are complete when the message ends, that execution started when the tool
   * actually runs, then takes partial output and finally the result.
   *
   * The view replays exactly these transitions onto pi's own component, so an
   * agent's tool box behaves like the main session's — including live output and
   * the synthetic error result pi writes into every still-pending call when a
   * turn is aborted (without which the box sits "pending" forever).
   *
   * `revision` is bumped on every mutation: it is what lets the view apply state
   * when something actually changed instead of on every frame.
   */
  | {
      kind: "toolCall";
      id: string;
      name: string;
      args: Record<string, unknown>;
      argsComplete?: boolean;
      executionStarted?: boolean;
      result?: ToolCallResult;
      revision: number;
    }
  | {
      kind: "toolResult";
      toolCallId: string;
      name: string;
      text: string;
      isError: boolean;
      content: Array<{ type: string; text?: string; data?: string; mimeType?: string }>;
      details?: unknown;
    }
  /**
   * The agent's own session compacted its context.
   *
   * Sub-agent sessions are created with pi's own `SettingsManager`, so they
   * auto-compact on threshold/overflow exactly like the main session does. pi
   * marks that in its transcript with a collapsible `[compaction]` block (plus a
   * token/cost notice) and stops drawing everything before it, because that
   * history is no longer part of the context. An agent view does the same: this
   * item renders the block, and items before it are hidden (see `visibleFrom`).
   *
   * `usageTokens`/`usageCost` are the summarisation call's own billing, kept
   * separately so the notice is only drawn when pi would draw it.
   */
  | {
      kind: "compaction";
      summary: string;
      tokensBefore: number;
      timestamp: number;
      usageTokens?: number;
      usageCost?: number;
    }
  | { kind: "error"; text: string };

export interface LiveAgent {
  file: string;
  session: AgentSession;
  state: AgentState;
  transcript: TranscriptItem[];
  error?: string;
  unsubscribe: () => void;
}

interface Registry {
  agents: Map<string, LiveAgent>;
  /** True while a sub-agent session is being constructed. */
  loading: boolean;
  /**
   * Agents stopped in this process. Kept after the session object is gone so a
   * terminated agent stays in the Stopped group instead of reverting to
   * whatever its file happens to say.
   */
  stopped: Set<string>;
  modelRuntime?: ModelRuntime;
  /** Called after any live agent changes; the argument is that agent's file. */
  onChange?: (file?: string) => void;
  /**
   * Tool definitions handed to every sub-agent's `createAgentSession()` as
   * `customTools`, so it has the same `agent_create`/`agent_list`/
   * `agent_inspect`/`agent_send`/`agent_remove` capability main does — recursive
   * delegation to any depth. Set once at extension activation (see
   * `setManagedTools`); a missing value (extension not yet activated, or an
   * older build) just means "no managed tools", not a crash.
   */
  managedTools?: ToolDefinition[];
}

/** Registry lives on globalThis so it survives extension reload. */
const KEY = "__piAgentViewsRuntime";

function registry(): Registry {
  const g = globalThis as Record<string, unknown>;
  if (!g[KEY]) {
    g[KEY] = { agents: new Map<string, LiveAgent>(), loading: false, stopped: new Set<string>() } satisfies Registry;
  }
  const reg = g[KEY] as Registry;
  // Older builds had no stopped set; keep a reload from crashing.
  reg.stopped ??= new Set<string>();
  return reg;
}

/**
 * True while a sub-agent session is being constructed. The extension factory
 * must check this and return early to avoid infinite recursion.
 */
export function isLoadingSubAgent(): boolean {
  return registry().loading;
}

export function setOnChange(cb: ((file?: string) => void) | undefined): void {
  registry().onChange = cb;
}

/** See `Registry.managedTools`. Call once at extension activation. */
export function setManagedTools(tools: ToolDefinition[]): void {
  registry().managedTools = tools;
}

/**
 * Tell the view layer that `file` changed.
 *
 * The file matters: this fires on every streaming delta of every live agent,
 * and a repaint costs a full document render (fullscreen re-renders everything
 * on every frame). The view can only skip work it knows is invisible if it is
 * told *which* agent moved, so always pass the file when it is known.
 */
function notify(file?: string): void {
  try {
    registry().onChange?.(file);
  } catch {
    /* ignore */
  }
}

// ─── Model runtime (cached) ─────────────────────────────────────────

async function getModelRuntime(): Promise<ModelRuntime> {
  const reg = registry();
  if (!reg.modelRuntime) {
    reg.modelRuntime = await ModelRuntime.create();
  }
  return reg.modelRuntime;
}

/**
 * The `ModelRuntime` every agent shares.
 *
 * Exposed so the view layer can drive pi's own model selector (which needs a
 * runtime) against the same catalogue and credentials the agents use.
 */
export async function sharedModelRuntime(): Promise<ModelRuntime> {
  return getModelRuntime();
}

// ─── Transcript building from events ────────────────────────────────

function textOf(content: unknown): string {
  if (!Array.isArray(content)) return "";
  return content
    .filter((c): c is { type: "text"; text: string } => c?.type === "text" && typeof c.text === "string")
    .map((c) => c.text)
    .join("\n");
}

/** Concatenated text parts of an assistant message. */
export function assistantText(message: AssistantMessage): string {
  return textOf(message.content);
}

/**
 * True when pi would draw something for this assistant message.
 *
 * Mirrors `AssistantMessageComponent`: visible text or thinking, or a notice it
 * renders for a stop reason it treats as an error.
 */
export function assistantHasContent(message: AssistantMessage): boolean {
  const content = (message.content ?? []) as Array<Record<string, any>>;
  for (const part of content) {
    if (part.type === "text" && String(part.text ?? "").trim()) return true;
    if (part.type === "thinking" && String(part.thinking ?? "").trim()) return true;
  }
  if (content.some((part) => part.type === "toolCall")) return false;
  const stop = (message as any).stopReason;
  return stop === "length" || stop === "aborted" || stop === "error";
}

/** An empty assistant message to append streaming deltas into. */
function emptyAssistant(message: unknown): AssistantMessage {
  return { ...(message as AssistantMessage), content: [] };
}

/** Append a streaming delta to the last part of `kind`, or start a new one. */
function appendDelta(message: AssistantMessage, kind: "text" | "thinking", delta: string): void {
  if (!delta) return;
  const content = message.content as Array<Record<string, any>>;
  const last = content[content.length - 1];
  if (last?.type === kind) {
    last[kind === "text" ? "text" : "thinking"] += delta;
    return;
  }
  content.push(kind === "text" ? { type: "text", text: delta } : { type: "thinking", thinking: delta });
}

/**
 * Seed the transcript from an existing session file so attaching to a
 * previously-created agent shows its history.
 */
export function seedTranscript(sm: SessionManager): TranscriptItem[] {
  const out: TranscriptItem[] = [];
  try {
    for (const entry of sm.getBranch()) {
      // A compaction the agent's session performed earlier: same marker pi
      // replays, and everything before it stops being drawn (`visibleFrom`).
      if (entry.type === "compaction") {
        out.push(compactionItem(entry as unknown as Parameters<typeof compactionItem>[0]));
        continue;
      }
      if (entry.type !== "message") continue;
      const m = entry.message as any;
      if (!m) continue;
      if (m.role === "user") {
        const t = textOf(m.content);
        if (t) out.push({ kind: "user", text: t });
      } else if (m.role === "assistant") {
        // The whole message goes in, so history renders like a live turn:
        // thinking blocks, markdown and error notices all come from pi.
        if (assistantHasContent(m as AssistantMessage)) {
          out.push({ kind: "assistant", message: m as AssistantMessage, streaming: false });
        }
        for (const c of m.content ?? []) {
          if (c.type === "toolCall") {
            out.push({
              kind: "toolCall",
              id: c.id,
              name: c.name,
              args: c.arguments ?? {},
              // A persisted call is finished by definition: its args are whole
              // and it ran. The result is attached below, from the toolResult
              // message that follows, so a revived transcript drives pi's tool
              // box through exactly the same state a live one does.
              argsComplete: true,
              executionStarted: true,
              revision: 1,
            });
          }
        }
      } else if (m.role === "toolResult") {
        out.push({
          kind: "toolResult",
          toolCallId: m.toolCallId,
          name: m.toolName ?? "tool",
          text: textOf(m.content),
          isError: Boolean(m.isError),
          content: m.content ?? [],
          details: m.details,
        });
        for (let i = out.length - 1; i >= 0; i--) {
          const call = out[i]!;
          if (call.kind !== "toolCall" || call.id !== m.toolCallId) continue;
          call.result = {
            content: m.content ?? [],
            details: m.details,
            isError: Boolean(m.isError),
            isPartial: false,
          };
          break;
        }
      }
    }
  } catch {
    /* ignore */
  }
  return out;
}

const CONTEXT_MAX_TURNS = 6;
const CONTEXT_MAX_CHARS = 3000;
const CONTEXT_TURN_MAX_CHARS = 800;

/**
 * A short, plain-text excerpt of the tail of a transcript, meant to be
 * prepended to a freshly-spawned sub-agent's task so it isn't dropped into
 * the middle of someone else's conversation with zero background.
 *
 * Only `user`/`assistant` turns are kept (tool calls/results/errors are
 * noise for this purpose and can be huge); each turn is truncated to
 * `CONTEXT_TURN_MAX_CHARS`, and the whole excerpt is capped at
 * `CONTEXT_MAX_TURNS` turns *and* `CONTEXT_MAX_CHARS` — whichever is hit
 * first, walking backwards from the most recent turn so the freshest
 * context always wins over older turns. Returns `""` when there is nothing
 * worth including (empty transcript, or only tool activity).
 */
export function summarizeContext(items: readonly TranscriptItem[]): string {
  const turns: string[] = [];
  let chars = 0;
  for (let i = items.length - 1; i >= 0 && turns.length < CONTEXT_MAX_TURNS; i--) {
    const item = items[i]!;
    let line: string | undefined;
    if (item.kind === "user") line = `User: ${truncate(item.text, CONTEXT_TURN_MAX_CHARS)}`;
    else if (item.kind === "assistant") {
      const text = assistantText(item.message).trim();
      if (text) line = `Assistant: ${truncate(text, CONTEXT_TURN_MAX_CHARS)}`;
    }
    if (!line) continue;
    if (chars + line.length > CONTEXT_MAX_CHARS && turns.length > 0) break;
    turns.push(line);
    chars += line.length;
  }
  return turns.reverse().join("\n\n");
}

function truncate(text: string, max: number): string {
  const trimmed = text.trim();
  return trimmed.length > max ? `${trimmed.slice(0, max)}…` : trimmed;
}

/** Transcript of an agent that is not live in this process, read from its jsonl. */
export function readTranscript(file: string): TranscriptItem[] {
  const live = registry().agents.get(file);
  if (live) return live.transcript;
  try {
    return seedTranscript(SessionManager.open(file));
  } catch {
    return [];
  }
}

/** A `compaction` transcript item from a persisted or live compaction. */
function compactionItem(source: {
  summary?: string;
  tokensBefore?: number;
  timestamp?: string | number;
  usage?: { input?: number; output?: number; cacheRead?: number; cacheWrite?: number; cost?: { total?: number } };
}): Extract<TranscriptItem, { kind: "compaction" }> {
  const usage = source.usage;
  const tokens = usage
    ? (usage.input ?? 0) + (usage.output ?? 0) + (usage.cacheRead ?? 0) + (usage.cacheWrite ?? 0)
    : undefined;
  return {
    kind: "compaction",
    summary: source.summary ?? "",
    tokensBefore: source.tokensBefore ?? 0,
    timestamp: new Date(source.timestamp ?? Date.now()).getTime(),
    ...(tokens === undefined ? {} : { usageTokens: tokens }),
    ...(usage?.cost?.total === undefined ? {} : { usageCost: usage.cost.total }),
  };
}

/**
 * The transcript's record of a tool call, searched from the end (a call is
 * always near the tail when its events arrive).
 */
function findCall(agent: LiveAgent, id: string): Extract<TranscriptItem, { kind: "toolCall" }> | undefined {
  for (let i = agent.transcript.length - 1; i >= 0; i--) {
    const it = agent.transcript[i]!;
    if (it.kind === "toolCall" && it.id === id) return it;
  }
  return undefined;
}

/**
 * Add or update the tool calls of a (possibly still streaming) assistant
 * message, like pi's `message_update` handler does: a call gets its box as soon
 * as it appears, and its args are refreshed while they stream.
 */
function syncToolCalls(agent: LiveAgent, message: Record<string, any>): boolean {
  let changed = false;
  for (const part of (message.content ?? []) as Array<Record<string, any>>) {
    if (part.type !== "toolCall") continue;
    const args = (part.arguments ?? {}) as Record<string, unknown>;
    const existing = findCall(agent, part.id);
    if (!existing) {
      agent.transcript.push({ kind: "toolCall", id: part.id, name: part.name, args, revision: 1 });
      changed = true;
    } else if (existing.args !== args) {
      existing.args = args;
      existing.revision++;
      changed = true;
    }
  }
  return changed;
}

/** Attach a result to a call, if the call is known. */
function applyResult(agent: LiveAgent, id: string, result: ToolCallResult): boolean {
  const call = findCall(agent, id);
  if (!call) return false;
  call.result = result;
  call.revision++;
  return true;
}

function attachEvents(agent: LiveAgent): () => void {
  const { session } = agent;

  return session.subscribe((event: any) => {
    switch (event.type) {
      case "message_start": {
        const m = event.message;
        if (m?.role === "user") {
          const t = textOf(m.content);
          if (t) agent.transcript.push({ kind: "user", text: t });
        } else if (m?.role === "assistant") {
          // Placeholder that streaming deltas append into.
          agent.transcript.push({ kind: "assistant", message: emptyAssistant(m), streaming: true });
        }
        agent.state = "working";
        notify(agent.file);
        break;
      }

      case "message_update": {
        const ev = event.assistantMessageEvent;
        // Tool calls show up inside the streaming message: pi draws the box
        // right away (args still arriving) rather than waiting for the turn.
        if (event.message?.role === "assistant" && syncToolCalls(agent, event.message)) notify(agent.file);
        if (!ev) break;
        const last = agent.transcript[agent.transcript.length - 1];
        if (last?.kind !== "assistant" || !last.streaming) break;
        if (ev.type === "text_delta") {
          appendDelta(last.message, "text", ev.delta ?? "");
          notify(agent.file);
        } else if (ev.type === "thinking_delta") {
          appendDelta(last.message, "thinking", ev.delta ?? "");
          notify(agent.file);
        }
        break;
      }

      case "message_end": {
        const m = event.message;
        // Finalize the streaming assistant placeholder with the authoritative
        // message: it carries usage, stop reason and any error notice.
        for (let i = agent.transcript.length - 1; i >= 0; i--) {
          const it = agent.transcript[i]!;
          if (it.kind === "assistant" && it.streaming) {
            it.streaming = false;
            if (m?.role === "assistant") it.message = m as AssistantMessage;
            break;
          }
        }
        if (m?.role === "assistant") {
          // Same wording pi puts on an aborted turn, so the notice on the
          // message and in every pending tool box reads identically.
          let errorMessage: string | undefined;
          if (m.stopReason === "aborted") {
            const retries = agent.session.retryAttempt ?? 0;
            errorMessage =
              retries > 0 ? `Aborted after ${retries} retry attempt${retries > 1 ? "s" : ""}` : "Operation aborted";
            m.errorMessage = errorMessage;
          }
          syncToolCalls(agent, m);
          const aborted = m.stopReason === "aborted" || m.stopReason === "error";
          for (const it of agent.transcript) {
            if (it.kind !== "toolCall" || it.result) continue;
            if (aborted) {
              // pi writes a synthetic error result into every still-pending
              // call; without it the box stays "pending" for good and an
              // aborted turn looks like a tool that is still running.
              it.result = {
                content: [{ type: "text", text: errorMessage || m.errorMessage || "Error" }],
                isError: true,
                isPartial: false,
              };
            } else {
              // Args are complete now: this is what makes `edit` compute its diff.
              it.argsComplete = true;
            }
            it.revision++;
          }
          if (m.errorMessage) {
            agent.state = "failed";
            agent.error = m.errorMessage;
          }
        } else if (m?.role === "toolResult") {
          agent.transcript.push({
            kind: "toolResult",
            toolCallId: m.toolCallId,
            name: m.toolName ?? "tool",
            text: textOf(m.content),
            isError: Boolean(m.isError),
            content: m.content ?? [],
            details: m.details,
          });
          // Normally `tool_execution_end` already delivered this; attach it
          // again only if that event never arrived, so a revived or
          // event-starved transcript still shows the result.
          const call = findCall(agent, m.toolCallId);
          if (call && (!call.result || call.result.isPartial)) {
            call.result = {
              content: m.content ?? [],
              details: m.details,
              isError: Boolean(m.isError),
              isPartial: false,
            };
            call.revision++;
          }
        }
        notify(agent.file);
        break;
      }

      case "tool_execution_start": {
        const e = event as { toolCallId: string; toolName?: string; args?: Record<string, unknown> };
        let call = findCall(agent, e.toolCallId);
        if (!call) {
          // The call never showed up in a streaming message (a provider that
          // does not stream tool args): pi creates the box here too.
          call = {
            kind: "toolCall",
            id: e.toolCallId,
            name: e.toolName ?? "tool",
            args: e.args ?? {},
            argsComplete: true,
            revision: 1,
          };
          agent.transcript.push(call);
        }
        call.executionStarted = true;
        call.revision++;
        notify(agent.file);
        break;
      }

      case "tool_execution_update": {
        const e = event as { toolCallId: string; partialResult?: { content?: unknown[]; details?: unknown } };
        const partial = e.partialResult ?? {};
        if (
          applyResult(agent, e.toolCallId, {
            content: (partial.content ?? []) as ToolCallResult["content"],
            details: partial.details,
            isError: false,
            isPartial: true,
          })
        ) {
          notify(agent.file);
        }
        break;
      }

      case "tool_execution_end": {
        const e = event as {
          toolCallId: string;
          result?: { content?: unknown[]; details?: unknown };
          isError?: boolean;
        };
        const result = e.result ?? {};
        if (
          applyResult(agent, e.toolCallId, {
            content: (result.content ?? []) as ToolCallResult["content"],
            details: result.details,
            isError: Boolean(e.isError),
            isPartial: false,
          })
        ) {
          notify(agent.file);
        }
        break;
      }

      case "agent_end": {
        if (agent.state !== "failed" && agent.state !== "stopped") agent.state = "completed";
        notify(agent.file);
        break;
      }

      case "compaction_end": {
        // The agent's own session compacted (threshold/overflow — sub-agents use
        // pi's settings, so this happens to them just like to main). Record it
        // the way pi does: a `[compaction]` block at its chronological position,
        // after which everything older stops being drawn.
        const e = event as {
          aborted?: boolean;
          result?: { summary?: string; tokensBefore?: number; usage?: Record<string, any> };
          errorMessage?: string;
        };
        if (e.aborted) {
          agent.transcript.push({ kind: "error", text: "Auto-compaction cancelled" });
        } else if (e.result) {
          agent.transcript.push(compactionItem({ ...e.result, timestamp: Date.now() }));
        } else if (e.errorMessage) {
          agent.transcript.push({ kind: "error", text: e.errorMessage });
        }
        notify(agent.file);
        break;
      }
    }
  });
}

// ─── Public API ─────────────────────────────────────────────────────

/** Get the live agent for a file, if any. */
export function getAgent(file: string): LiveAgent | undefined {
  return registry().agents.get(file);
}

/** Model a live agent is currently using. */
export function modelOf(file: string): Model<any> | undefined {
  try {
    return registry().agents.get(file)?.session.model;
  } catch {
    return undefined;
  }
}

/**
 * Switch a live agent's model, exactly like `/model` does for pi's own session:
 * session-scoped (never persisted as the global default) and recorded in the
 * agent's own transcript, so the choice is remembered when that agent is
 * revived later and never leaks to the main session or to another agent.
 *
 * The thinking level is left to `setModel()`, which applies the per-model
 * override for the new model just as pi does.
 *
 * @throws Error if no auth is configured for the model.
 */
export async function setAgentModel(file: string, model: Model<any>): Promise<boolean> {
  const agent = registry().agents.get(file);
  if (!agent) return false;
  await agent.session.setModel(model, { persist: false });
  notify(file);
  return true;
}

/** Cycle a live agent's model, like Ctrl+P does for pi's own session. */
export async function cycleAgentModel(
  file: string,
  direction: "forward" | "backward",
): Promise<Model<any> | undefined> {
  const agent = registry().agents.get(file);
  if (!agent) return undefined;
  const result = await agent.session.cycleModel(direction, { persist: false });
  notify(file);
  return result?.model;
}

export function listAgentFiles(): string[] {
  return [...registry().agents.keys()];
}

export function stateOf(file: string): AgentState | undefined {
  const reg = registry();
  const a = reg.agents.get(file);
  // A terminated agent has no session left, but it is still stopped.
  if (!a) return reg.stopped.has(file) ? "stopped" : undefined;
  // isStreaming is authoritative for "working".
  try {
    if (a.session.isStreaming) return "working";
  } catch {
    /* ignore */
  }
  return a.state;
}

/**
 * What an agent's own session file already says about its model/thinking level.
 *
 * Each agent owns its model: `createAgentSession()` restores it from the
 * session only when no `model` option is passed, so an agent that has already
 * chosen one must NOT be handed the caller's (main session's) model again —
 * that would silently reset it on every re-attach.
 */
function ownSettings(sm: SessionManager): { model: boolean; thinkingLevel: boolean } {
  try {
    return {
      model: sm.buildSessionContext().model !== null,
      thinkingLevel: sm.getBranch().some((entry) => entry.type === "thinking_level_change"),
    };
  } catch {
    return { model: false, thinkingLevel: false };
  }
}

/**
 * Ensure the agent is live (create or revive its `AgentSession`).
 *
 * Does not send any prompt.
 *
 * `model`/`thinkingLevel` are only an *inheritance* default, used for a brand
 * new agent. An agent that already recorded its own model keeps it.
 *
 * `def` supplies a catalog-backed sub-agent's `appendSystemPrompt`, model, and
 * thinking level. It's an inheritance default too: the def's values apply
 * only to a fresh agent; on revive, the session file wins for model/thinking
 * (existing `ownSettings()` logic). The `appendSystemPrompt` is applied every
 * time because it goes through the resource loader, not the session file —
 * the caller re-supplies the def on revive so a def-backed agent keeps its
 * system-prompt supplement across restarts.
 */
export async function ensureAgent(
  file: string,
  cwd: string,
  model?: Model<any>,
  thinkingLevel?: ThinkingLevel,
  def?: SubAgentDef,
  forcedModel?: Model<any>,
): Promise<LiveAgent> {
  const reg = registry();
  const existing = reg.agents.get(file);
  if (existing) return existing;

  const sm = SessionManager.open(file);
  const transcript = seedTranscript(sm);
  const own = ownSettings(sm);

  const modelRuntime = await getModelRuntime();

  // Resolve the def's model to a concrete `Model<any>` if one is declared. A
  // missing / unresolvable model falls through to the caller-supplied
  // inheritance default — same rule as when there's no def.
  const defModel = def?.model ? tryResolveModel(modelRuntime, def.model) : undefined;
  // `forcedModel` is a caller's explicit choice (e.g. the `agent_create` tool's
  // `model` parameter) rather than an inheritance default, so it outranks
  // both the def's model and the plain inherited one.
  const inheritModel = forcedModel ?? defModel ?? model;
  const inheritThinking = def?.thinkingLevel ?? thinkingLevel;

  // `noExtensions` is the clean way to avoid recursively loading THIS
  // extension inside every sub-agent. Skills/prompts/context files are still
  // loaded so the sub-agent behaves like a normal pi session. The `loading`
  // flag is kept as a belt-and-braces guard.
  reg.loading = true;
  let session: AgentSession;
  try {
    const loader = new DefaultResourceLoader({
      cwd,
      agentDir: getAgentDir(),
      noExtensions: true,
      // The shared delegation policy applies to every sub-agent. A def's body
      // follows it as a specialization; both supplement (rather than replace)
      // pi's base system prompt, AGENTS.md, skills, and other context.
      appendSystemPrompt: [AGENT_POLICY, ...(def?.appendSystemPrompt ? [def.appendSystemPrompt] : [])],
    });
    await loader.reload();

    const created = await createAgentSession({
      cwd,
      // Undefined lets the SDK restore the agent's own recorded model/level.
      model: own.model ? undefined : inheritModel,
      thinkingLevel: own.thinkingLevel ? undefined : inheritThinking,
      modelRuntime,
      sessionManager: sm,
      resourceLoader: loader,
      // `noExtensions: true` above keeps this sub-agent from recursively
      // loading the whole agent-view extension, but it should still get the
      // same management tools main has — `customTools` is the SDK's
      // extension-independent way to hand a session tools directly, and
      // `AgentSession` gives them a real per-session `ExtensionContext`
      // (via `runner.createContext()`) exactly like an extension-registered
      // tool would. This is what makes delegation recursive: any agent can
      // spawn/message/inspect/terminate any other, to any depth.
      customTools: reg.managedTools,
    });
    session = created.session;
  } finally {
    reg.loading = false;
  }

  // Pin the inherited model into the agent's own session so it stays put even
  // if the main session switches model before this agent says anything.
  if (!own.model && session.model) {
    try {
      sm.appendModelChange(session.model.provider, session.model.id);
    } catch {
      /* best effort: the model is still correct for this process */
    }
  }

  const agent: LiveAgent = {
    file,
    session,
    state: transcript.length > 0 ? "completed" : "idle",
    transcript,
    unsubscribe: () => {},
  };
  agent.unsubscribe = attachEvents(agent);

  reg.agents.set(file, agent);
  notify(file);
  return agent;
}

/**
 * Resolve a `provider/id` string against the model runtime.
 *
 * Returns undefined when the model isn't known (no auth, wrong id, etc.),
 * matching how a missing def field would behave: the caller falls back to the
 * inherited model rather than crashing. The agent still spawns, and the user
 * can `/model` later.
 */
function tryResolveModel(runtime: ModelRuntime, id: string): Model<any> | undefined {
  const slash = id.indexOf("/");
  if (slash <= 0) return undefined;
  const provider = id.slice(0, slash);
  const modelId = id.slice(slash + 1);
  return runtime.getAvailableSnapshot().find((m) => m.provider === provider && m.id === modelId);
}

/**
 * Public, string-based variant of `tryResolveModel` for callers outside this
 * module (e.g. the `agent_create` tool's `model: "provider/id"` parameter) that
 * don't otherwise need a `ModelRuntime` handle.
 */
export async function resolveModelId(id: string): Promise<Model<any> | undefined> {
  const runtime = await getModelRuntime();
  return tryResolveModel(runtime, id);
}

export type ModelSearchResult =
  | { ok: true; model: Model<any> }
  | { ok: false; reason: "unknown" }
  | { ok: false; reason: "ambiguous"; candidates: string[] };

/**
 * Resolve a short, human-typed model token — e.g. from `@agent:opus` or a
 * tool's free-form `model` argument — against every currently available
 * model.
 *
 * Tries an exact `provider/id` or bare `id` match first (case-insensitive),
 * exactly like `tryResolveModel`. Failing that, falls back to a
 * case-insensitive substring match against every `id`, so a short alias
 * like `opus` or `haiku` finds `anthropic/claude-opus-4-...` without the
 * caller typing the whole thing. A substring that matches more than one
 * model is reported as ambiguous instead of guessing.
 */
export async function resolveModelSearch(token: string): Promise<ModelSearchResult> {
  const runtime = await getModelRuntime();
  const available = runtime.getAvailableSnapshot();
  const wanted = token.trim().toLowerCase();
  const exact = available.find(
    (m) => `${m.provider}/${m.id}`.toLowerCase() === wanted || m.id.toLowerCase() === wanted,
  );
  if (exact) return { ok: true, model: exact };

  const matches = available.filter((m) => m.id.toLowerCase().includes(wanted));
  if (matches.length === 1) return { ok: true, model: matches[0]! };
  if (matches.length > 1) {
    return { ok: false, reason: "ambiguous", candidates: matches.map((m) => `${m.provider}/${m.id}`) };
  }
  return { ok: false, reason: "unknown" };
}

/** Every `provider/id` currently available (has auth configured), for error messages. */
export async function availableModelIds(): Promise<string[]> {
  const runtime = await getModelRuntime();
  return runtime.getAvailableSnapshot().map((m) => `${m.provider}/${m.id}`);
}

/**
 * Start (or continue) an agent with a prompt. Runs concurrently; does not await
 * completion. Safe to call while other agents are running.
 */
export async function runAgent(
  file: string,
  prompt: string,
  cwd: string,
  model?: Model<any>,
  thinkingLevel?: ThinkingLevel,
  def?: SubAgentDef,
  forcedModel?: Model<any>,
): Promise<void> {
  const agent = await ensureAgent(file, cwd, model, thinkingLevel, def, forcedModel);
  agent.state = "working";
  agent.error = undefined;
  notify(file);

  // Fire and forget — concurrency is the point.
  agent.session.prompt(prompt).catch((err: unknown) => {
    // The turn never reached a verdict: the session itself blew up.
    agent.state = "stopped";
    agent.error = String(err);
    agent.transcript.push({ kind: "error", text: String(err) });
    notify(file);
  });
}

/**
 * Start (or continue) an agent with a prompt and wait for the turn to end.
 *
 * Same bookkeeping as `runAgent`, but awaits completion instead of firing and
 * forgetting, so a caller that needs the result (e.g. the `agent_create` tool)
 * can read the final transcript as soon as this resolves. Because the agent
 * is registered in the same pool as `runAgent` uses, it is a live entry in
 * the picker for the whole time this promise is pending — a human can attach
 * to it, watch it stream, or steer it, exactly like any other agent.
 *
 * `forcedModel`, if given, is an explicit caller choice (not merely an
 * inheritance default) and outranks both the def's model and the plain
 * inherited one — see `ensureAgent()`.
 */
export async function runAgentAndWait(
  file: string,
  prompt: string,
  cwd: string,
  model?: Model<any>,
  thinkingLevel?: ThinkingLevel,
  def?: SubAgentDef,
  forcedModel?: Model<any>,
): Promise<LiveAgent> {
  const agent = await ensureAgent(file, cwd, model, thinkingLevel, def, forcedModel);
  agent.state = "working";
  agent.error = undefined;
  notify(file);

  try {
    await agent.session.prompt(prompt);
  } catch (err) {
    // The turn never reached a verdict: the session itself blew up.
    agent.state = "stopped";
    agent.error = String(err);
    agent.transcript.push({ kind: "error", text: String(err) });
  }
  notify(file);
  return agent;
}

/** Send a steering message to a running agent. */
export async function steerAgent(file: string, text: string): Promise<boolean> {
  const agent = registry().agents.get(file);
  if (!agent) return false;
  try {
    // Always go through `prompt()`, exactly like pi's own session does for
    // both the idle and streaming cases (interactive-mode.js calls `prompt()`
    // with `streamingBehavior: "steer"` while streaming, never `steer()`
    // directly). `prompt()` is what dispatches extension commands
    // (`pi.registerCommand`), skill commands, and prompt templates against
    // *this* agent's own session -- `steer()` skips all of that and throws on
    // extension commands, which made those work only while the agent was
    // idle.
    await agent.session.prompt(text, agent.session.isStreaming ? { streamingBehavior: "steer" } : undefined);
    notify(file);
    return true;
  } catch {
    return false;
  }
}

/**
 * Terminate an agent: abort its turn and drop its session.
 *
 * The transcript stays on disk, so the agent remains in the list and can be
 * attached to (and revived) later — this kills the running thing, it does not
 * delete the record. Returns false when there was nothing running.
 */
export async function terminateAgent(file: string): Promise<boolean> {
  const reg = registry();
  const wasLive = reg.agents.has(file);
  reg.stopped.add(file);
  await disposeAgent(file);
  notify(file);
  return wasLive;
}

/**
 * Fully remove an agent from the in-process pool: abort/dispose its live
 * session (if any) and drop any stale `stopped` bookkeeping for it.
 *
 * Unlike `terminateAgent`, this is the runtime half of an outright delete —
 * the caller (Ctrl+X in `index.ts`) also erases the on-disk record via
 * `removeAgentEntry()` in `storage.ts`, so there is nothing left to revive.
 * Returns whether the agent was live at the time.
 */
export async function forgetAgent(file: string): Promise<boolean> {
  const reg = registry();
  const wasLive = reg.agents.has(file);
  await disposeAgent(file);
  reg.stopped.delete(file);
  notify(file);
  return wasLive;
}

/** Dispose an agent, releasing its session file. */
export async function disposeAgent(file: string): Promise<void> {
  const reg = registry();
  const agent = reg.agents.get(file);
  if (!agent) return;
  try {
    if (agent.session.isStreaming) await agent.session.abort();
  } catch {
    /* ignore */
  }
  try {
    agent.unsubscribe();
  } catch {
    /* ignore */
  }
  try {
    agent.session.dispose();
  } catch {
    /* ignore */
  }
  reg.agents.delete(file);
  notify(file);
}

/** Dispose every agent (call on quit). */
export async function disposeAll(): Promise<void> {
  for (const file of listAgentFiles()) {
    await disposeAgent(file);
  }
}
