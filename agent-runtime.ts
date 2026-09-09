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

export type AgentState = "idle" | "working" | "completed" | "failed";

/**
 * One rendered item in an agent's transcript.
 *
 * Items keep enough provider-level data (`message`, tool ids, raw result
 * content) for the view layer to render them with pi's own transcript
 * components instead of a bespoke widget renderer.
 */
export type TranscriptItem =
  | { kind: "user"; text: string }
  | { kind: "assistant"; text: string; streaming: boolean; message?: AssistantMessage }
  | { kind: "thinking"; text: string }
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
  modelRuntime?: ModelRuntime;
  onChange?: () => void;
}

/** Registry lives on globalThis so it survives extension reload. */
const KEY = "__piAgentViewsRuntime";

function registry(): Registry {
  const g = globalThis as Record<string, unknown>;
  if (!g[KEY]) {
    g[KEY] = { agents: new Map<string, LiveAgent>(), loading: false } satisfies Registry;
  }
  return g[KEY] as Registry;
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

// ─── Transcript building from events ────────────────────────────────

function textOf(content: unknown): string {
  if (!Array.isArray(content)) return "";
  return content
    .filter((c): c is { type: "text"; text: string } => c?.type === "text" && typeof c.text === "string")
    .map((c) => c.text)
    .join("\n");
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
        const texts = (m.content ?? []).filter((c: any) => c.type === "text" && c.text);
        if (texts.length > 0) {
          out.push({
            kind: "assistant",
            text: texts.map((c: any) => c.text).join("\n"),
            streaming: false,
            message: m as AssistantMessage,
          });
        }
        for (const c of m.content ?? []) {
          if (c.type === "toolCall") {
            out.push({ kind: "toolCall", id: c.id, name: c.name, args: c.arguments ?? {} });
          }
        }
        if (m.errorMessage) out.push({ kind: "error", text: m.errorMessage });
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
          agent.transcript.push({ kind: "assistant", text: "", streaming: true });
        }
        agent.state = "working";
        notify();
        break;
      }

      case "message_update": {
        const ev = event.assistantMessageEvent;
        if (!ev) break;
        const last = agent.transcript[agent.transcript.length - 1];
        if (ev.type === "text_delta" && last?.kind === "assistant" && last.streaming) {
          last.text += ev.delta ?? "";
          notify();
        } else if (ev.type === "thinking_delta") {
          const prev = agent.transcript[agent.transcript.length - 1];
          if (prev?.kind === "thinking") prev.text += ev.delta ?? "";
          else agent.transcript.push({ kind: "thinking", text: ev.delta ?? "" });
          notify();
        }
        break;
      }

      case "message_end": {
        const m = event.message;
        // Finalize the streaming assistant placeholder.
        for (let i = agent.transcript.length - 1; i >= 0; i--) {
          const it = agent.transcript[i]!;
          if (it.kind === "assistant" && it.streaming) {
            it.streaming = false;
            // Prefer the authoritative final message.
            const finalText = textOf(m?.content);
            if (finalText) it.text = finalText;
            if (m?.role === "assistant") it.message = m as AssistantMessage;
            if (!it.text) agent.transcript.splice(i, 1);
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
            agent.transcript.push({ kind: "error", text: m.errorMessage });
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
        if (agent.state !== "failed") agent.state = "completed";
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

export function listAgentFiles(): string[] {
  return [...registry().agents.keys()];
}

export function stateOf(file: string): AgentState | undefined {
  const a = registry().agents.get(file);
  if (!a) return undefined;
  // isStreaming is authoritative for "working".
  try {
    if (a.session.isStreaming) return "working";
  } catch {
    /* ignore */
  }
  return a.state;
}

/**
 * Ensure an in-process AgentSession exists for `file`, creating it if needed.
 * Does not send any prompt.
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
      model,
      thinkingLevel,
      modelRuntime,
      sessionManager: sm,
      resourceLoader: loader,
    });
    session = created.session;
  } finally {
    reg.loading = false;
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
    agent.state = "failed";
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

/** Abort an agent's current turn (does not dispose it). */
export async function abortAgent(file: string): Promise<void> {
  const agent = registry().agents.get(file);
  if (!agent) return;
  try {
    await agent.session.abort();
  } catch {
    /* ignore */
  }
  agent.state = "idle";
  notify();
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
