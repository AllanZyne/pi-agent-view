/**
 * agent-runtime.ts — in-process concurrent agent pool (codex-style)
 *
 * Every agent is its own `AgentSession` created via the SDK. They run
 * concurrently inside the pi process and are never torn down by pi's
 * session switching, so navigating between agents in Agent Views does
 * not abort anything.
 *
 * pi's own session is NOT used to hold agent conversations. This module
 * owns each agent's jsonl exclusively (single writer, no contention).
 */

import {
  createAgentSession,
  DefaultResourceLoader,
  getAgentDir,
  ModelRuntime,
  SessionManager,
} from "@earendil-works/pi-coding-agent";

// ─── Types ──────────────────────────────────────────────────────────

export type RunState = "working" | "idle" | "completed" | "failed";

/** One rendered item in an agent's transcript. */
export type TranscriptItem =
  | { kind: "user"; text: string }
  | { kind: "assistant"; text: string; streaming: boolean }
  | { kind: "thinking"; text: string }
  | { kind: "toolCall"; name: string; args: Record<string, unknown> }
  | { kind: "toolResult"; name: string; text: string; isError: boolean }
  | { kind: "error"; text: string };

export interface RunningAgent {
  file: string;
  /** The SDK session. `any` to avoid depending on non-exported internals. */
  session: any;
  state: RunState;
  /** Rendered transcript, rebuilt from events. */
  transcript: TranscriptItem[];
  /** Last error, if state === "failed". */
  error?: string;
  unsubscribe: () => void;
}

/** Registry lives on globalThis so it survives extension reload. */
interface Registry {
  agents: Map<string, RunningAgent>;
  modelRuntime?: any;
  /** Guard: true while we are constructing a sub-agent session, so the
   *  extension factory can bail out and avoid recursive self-loading. */
  loading: boolean;
  /** Called whenever any agent's state/transcript changes. */
  onChange?: () => void;
}

const KEY = "__piAgentViewsRuntime";

function registry(): Registry {
  const g = globalThis as any;
  if (!g[KEY]) {
    g[KEY] = { agents: new Map(), loading: false } as Registry;
  }
  return g[KEY] as Registry;
}

/** True while a sub-agent session is being constructed. The extension
 *  factory must check this and return early to avoid infinite recursion. */
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

async function getModelRuntime(): Promise<any> {
  const reg = registry();
  if (!reg.modelRuntime) {
    reg.modelRuntime = await ModelRuntime.create();
  }
  return reg.modelRuntime;
}

// ─── Transcript building from events ────────────────────────────────

function textOf(content: any[] | undefined): string {
  if (!Array.isArray(content)) return "";
  return content
    .filter((c) => c?.type === "text" && typeof c.text === "string")
    .map((c) => c.text)
    .join("\n");
}

/** Seed the transcript from an existing session file so attaching to a
 *  previously-created agent shows its history. */
function seedTranscript(sm: SessionManager): TranscriptItem[] {
  const out: TranscriptItem[] = [];
  try {
    for (const entry of sm.getBranch()) {
      const e = entry as any;
      if (e.type !== "message") continue;
      const m = e.message;
      if (!m) continue;
      if (m.role === "user") {
        const t = textOf(m.content);
        if (t) out.push({ kind: "user", text: t });
      } else if (m.role === "assistant") {
        for (const c of m.content ?? []) {
          if (c.type === "text" && c.text) {
            out.push({ kind: "assistant", text: c.text, streaming: false });
          } else if (c.type === "toolCall") {
            out.push({ kind: "toolCall", name: c.name, args: c.arguments ?? {} });
          }
        }
        if (m.errorMessage) out.push({ kind: "error", text: m.errorMessage });
      } else if (m.role === "toolResult") {
        out.push({
          kind: "toolResult",
          name: m.toolName ?? "tool",
          text: textOf(m.content),
          isError: Boolean(m.isError),
        });
      }
    }
  } catch {
    /* ignore */
  }
  return out;
}

function attachEvents(agent: RunningAgent): () => void {
  const { session } = agent;

  const unsub = session.subscribe((event: any) => {
    switch (event.type) {
      case "message_start": {
        const m = event.message;
        if (m?.role === "user") {
          const t = textOf(m.content);
          if (t) agent.transcript.push({ kind: "user", text: t });
        } else if (m?.role === "assistant") {
          // Placeholder that streaming deltas append into
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
        // Finalize the streaming assistant placeholder
        for (let i = agent.transcript.length - 1; i >= 0; i--) {
          const it = agent.transcript[i]!;
          if (it.kind === "assistant" && it.streaming) {
            it.streaming = false;
            // Prefer the authoritative final text
            const finalText = textOf(m?.content);
            if (finalText) it.text = finalText;
            if (!it.text) agent.transcript.splice(i, 1);
            break;
          }
        }
        if (m?.role === "assistant") {
          for (const c of m.content ?? []) {
            if (c.type === "toolCall") {
              agent.transcript.push({ kind: "toolCall", name: c.name, args: c.arguments ?? {} });
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
            name: m.toolName ?? "tool",
            text: textOf(m.content),
            isError: Boolean(m.isError),
          });
        }
        notify();
        break;
      }

      case "tool_execution_end": {
        // Covered by toolResult message_end; kept for state freshness
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

  return unsub;
}

// ─── Public API ─────────────────────────────────────────────────────

/** Get the live agent for a file, if any. */
export function getAgent(file: string): RunningAgent | undefined {
  return registry().agents.get(file);
}

export function listAgentFiles(): string[] {
  return [...registry().agents.keys()];
}

export function stateOf(file: string): RunState | undefined {
  const a = registry().agents.get(file);
  if (!a) return undefined;
  // isStreaming is authoritative for "working"
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
  model?: any,
  thinkingLevel?: any,
): Promise<RunningAgent> {
  const reg = registry();
  const existing = reg.agents.get(file);
  if (existing) return existing;

  const sm = SessionManager.open(file);
  const transcript = seedTranscript(sm);

  const modelRuntime = await getModelRuntime();

  // `noExtensions` is the clean way to avoid recursively loading THIS
  // extension inside every sub-agent. Skills/prompts/context files are
  // still loaded so the sub-agent behaves like a normal pi session.
  // The `loading` flag is kept as a belt-and-braces guard.
  reg.loading = true;
  let session: any;
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

  const agent: RunningAgent = {
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
  model?: any,
  thinkingLevel?: any,
): Promise<void> {
  const agent = await ensureAgent(file, cwd, model, thinkingLevel);
  agent.state = "working";
  agent.error = undefined;
  notify();

  // Fire and forget — concurrency is the point.
  agent.session
    .prompt(prompt)
    .catch((err: unknown) => {
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
