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
export type TranscriptItem =
  | { kind: "user"; text: string }
  /**
   * A whole assistant message, text and thinking parts in order, exactly as pi
   * keeps it: `AssistantMessageComponent` renders all of it (markdown, thinking
   * blocks, truncation/abort notices), so the view needs no per-part items.
   */
  | { kind: "assistant"; message: AssistantMessage; streaming: boolean }
  | { kind: "toolCall"; id: string; name: string; args: Record<string, unknown> }
  | {
      kind: "toolResult";
      toolCallId: string;
      name: string;
      text: string;
      isError: boolean;
      content: Array<{ type: string; text?: string; data?: string; mimeType?: string }>;
      details?: unknown;
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
  onChange?: () => void;
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

export function setOnChange(cb: (() => void) | undefined): void {
  registry().onChange = cb;
}

function notify(): void {
  try {
    registry().onChange?.();
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
            out.push({ kind: "toolCall", id: c.id, name: c.name, args: c.arguments ?? {} });
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
      }
    }
  } catch {
    /* ignore */
  }
  return out;
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
        notify();
        break;
      }

      case "message_update": {
        const ev = event.assistantMessageEvent;
        if (!ev) break;
        const last = agent.transcript[agent.transcript.length - 1];
        if (last?.kind !== "assistant" || !last.streaming) break;
        if (ev.type === "text_delta") {
          appendDelta(last.message, "text", ev.delta ?? "");
          notify();
        } else if (ev.type === "thinking_delta") {
          appendDelta(last.message, "thinking", ev.delta ?? "");
          notify();
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
            if (!assistantHasContent(it.message)) agent.transcript.splice(i, 1);
            break;
          }
        }
        if (m?.role === "assistant") {
          for (const c of m.content ?? []) {
            if (c.type === "toolCall") {
              agent.transcript.push({ kind: "toolCall", id: c.id, name: c.name, args: c.arguments ?? {} });
            }
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
        }
        notify();
        break;
      }

      case "tool_execution_end": {
        // Covered by toolResult message_end; kept for state freshness.
        notify();
        break;
      }

      case "agent_end": {
        if (agent.state !== "failed" && agent.state !== "stopped") agent.state = "completed";
        notify();
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
  notify();
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
  notify();
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
 * Ensure an in-process AgentSession exists for `file`, creating it if needed.
 * Does not send any prompt.
 *
 * `model`/`thinkingLevel` are only an *inheritance* default, used for a brand
 * new agent. An agent that already recorded its own model keeps it.
 */
export async function ensureAgent(
  file: string,
  cwd: string,
  model?: Model<any>,
  thinkingLevel?: ThinkingLevel,
): Promise<LiveAgent> {
  const reg = registry();
  const existing = reg.agents.get(file);
  if (existing) return existing;

  const sm = SessionManager.open(file);
  const transcript = seedTranscript(sm);
  const own = ownSettings(sm);

  const modelRuntime = await getModelRuntime();

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
    });
    await loader.reload();

    const created = await createAgentSession({
      cwd,
      // Undefined lets the SDK restore the agent's own recorded model/level.
      model: own.model ? undefined : model,
      thinkingLevel: own.thinkingLevel ? undefined : thinkingLevel,
      modelRuntime,
      sessionManager: sm,
      resourceLoader: loader,
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
  notify();
  return agent;
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
): Promise<void> {
  const agent = await ensureAgent(file, cwd, model, thinkingLevel);
  agent.state = "working";
  agent.error = undefined;
  notify();

  // Fire and forget — concurrency is the point.
  agent.session.prompt(prompt).catch((err: unknown) => {
    // The turn never reached a verdict: the session itself blew up.
    agent.state = "stopped";
    agent.error = String(err);
    agent.transcript.push({ kind: "error", text: String(err) });
    notify();
  });
}

/** Send a steering message to a running agent. */
export async function steerAgent(file: string, text: string): Promise<boolean> {
  const agent = registry().agents.get(file);
  if (!agent) return false;
  try {
    if (agent.session.isStreaming) await agent.session.steer(text);
    else await agent.session.prompt(text);
    notify();
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
  notify();
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
  notify();
}

/** Dispose every agent (call on quit). */
export async function disposeAll(): Promise<void> {
  for (const file of listAgentFiles()) {
    await disposeAgent(file);
  }
}
