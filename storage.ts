/**
 * storage.ts — where agent sessions live on disk.
 *
 * Sub-agent sessions live in
 *   <sessionDir>/__agents__/<rootId>/<agentId>.jsonl
 * with a sibling manifest.json. That directory is not scanned by
 * SessionManager.list(), so agents stay out of /resume.
 *
 * Everything here is pure filesystem work with no TUI or extension-context
 * dependency, so it can be unit tested directly (see tests/).
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { SessionManager } from "@earendil-works/pi-coding-agent";

export interface AgentEntry {
  id: string;
  name: string;
  file: string;
  createdAt: string;
  /**
   * Sub-agent def name that spawned this agent, if any.
   *
   * Present when the agent was summoned via `@<def-name>`. Used to badge the
   * row and to re-apply the def's `appendSystemPrompt`/model on revive. A
   * missing field means "plain agent" (forward-compatible with manifests
   * written by earlier builds).
   */
  def?: string;
}

export interface AgentManifest {
  rootId: string;
  rootFile: string;
  agents: AgentEntry[];
}

/** Root context: the top-level pi session that owns a group of agents. */
export interface RootCtx {
  rootId: string;
  rootFile: string;
  sessionDir: string;
}

export const AGENTS_DIR = "__agents__";

/** Hard safety limit shared by every descendant of one root session. */
export const MAX_AGENTS_PER_SESSION = 32;

export const groupDir = (sessionDir: string, rootId: string): string =>
  path.join(sessionDir, AGENTS_DIR, rootId);

export const manifestFile = (sessionDir: string, rootId: string): string =>
  path.join(groupDir(sessionDir, rootId), "manifest.json");

export function loadManifest(sessionDir: string, rootId: string): AgentManifest | null {
  try {
    return JSON.parse(fs.readFileSync(manifestFile(sessionDir, rootId), "utf-8")) as AgentManifest;
  } catch {
    return null;
  }
}

export function saveManifest(sessionDir: string, m: AgentManifest): void {
  fs.mkdirSync(groupDir(sessionDir, m.rootId), { recursive: true });
  fs.writeFileSync(manifestFile(sessionDir, m.rootId), JSON.stringify(m, null, 2));
}

/**
 * Resolve the owning root from a session file path, regardless of whether that
 * file is the root session or one of its agents.
 */
export function resolveRoot(sessionFile: string | undefined, sessionId: string): RootCtx | null {
  if (!sessionFile) return null;

  const marker = `${path.sep}${AGENTS_DIR}${path.sep}`;
  const at = sessionFile.indexOf(marker);
  if (at < 0) {
    return { rootId: sessionId, rootFile: sessionFile, sessionDir: path.dirname(sessionFile) };
  }

  // An agent file was opened directly (e.g. resumed by path).
  const sessionDir = sessionFile.slice(0, at);
  const rootId = sessionFile.slice(at + marker.length).split(path.sep)[0]!;
  const manifest = loadManifest(sessionDir, rootId);
  if (!manifest) return null;
  return { rootId, rootFile: manifest.rootFile, sessionDir };
}

/**
 * Agents recorded for this root.
 *
 * pi does not create a session file until the session has an assistant message
 * (`SessionManager._persist`), so a just-spawned agent has a path but no file
 * yet. Such an agent must still be listed, hence the `isLive` predicate: pass
 * one that reports agents currently in the in-process pool.
 */
export function listAgentEntries(root: RootCtx, isLive: (file: string) => boolean = () => false): AgentEntry[] {
  return (loadManifest(root.sessionDir, root.rootId)?.agents ?? []).filter(
    (a) => fs.existsSync(a.file) || isLive(a.file),
  );
}

/**
 * The root (pi's own) session, listed as an agent like any other.
 *
 * It is always called this, whatever the session name is, so the picker reads
 * as one flat list of slugs and no sub-agent can shadow it.
 */
export const ROOT_AGENT_NAME = "main";

/**
 * Name a new agent from its first prompt.
 *
 * Agent names double as session names and show up in the picker, so they are
 * slugs: lowercase letters and single hyphens, nothing else. A numeric suffix
 * would break that rule, so collisions get a letter suffix instead.
 */
export function agentName(prompt: string, taken: Iterable<string> = []): string {
  const words = prompt
    .toLowerCase()
    .split(/[^a-z]+/)
    .filter(Boolean);

  let base = "";
  for (const word of words.slice(0, MAX_NAME_WORDS)) {
    const next = base ? `${base}-${word}` : word;
    if (next.length > MAX_NAME_LENGTH) break;
    base = next;
  }
  // Prompts with no latin letters at all (e.g. pure CJK) still need a name.
  if (!base) base = "agent";

  const used = new Set(taken);
  used.add(ROOT_AGENT_NAME);
  if (!used.has(base)) return base;
  for (let i = 1; ; i++) {
    const candidate = `${base}-${letterSuffix(i)}`;
    if (!used.has(candidate)) return candidate;
  }
}

const MAX_NAME_WORDS = 6;
const MAX_NAME_LENGTH = 40;

/** 1 → "b", 2 → "c", … 25 → "z", 26 → "bb", … (letters only, never digits). */
function letterSuffix(n: number): string {
  const letter = String.fromCharCode("a".charCodeAt(0) + (n % 26));
  return letter.repeat(1 + Math.floor(n / 26));
}

/** Number of occupied agent slots for this root, including completed/stopped agents. */
export function agentCount(root: RootCtx): number {
  return loadManifest(root.sessionDir, root.rootId)?.agents.length ?? 0;
}

/**
 * Reject a create request that would exceed the root session's shared limit.
 * Check the whole batch before registering any member so creation is all-or-none.
 */
export function assertAgentCapacity(root: RootCtx, requested = 1): void {
  const current = agentCount(root);
  if (current + requested <= MAX_AGENTS_PER_SESSION) return;
  const available = Math.max(0, MAX_AGENTS_PER_SESSION - current);
  throw new Error(
    `Agent limit reached: this session has ${current}/${MAX_AGENTS_PER_SESSION} agents, ` +
      `but ${requested} were requested (${available} slot${available === 1 ? "" : "s"} available). ` +
      "Reuse an existing agent with agent_send, or delete completed one-off agents with agent_remove.",
  );
}

/**
 * Create an agent session file and record it in the manifest.
 *
 * The returned path may not exist on disk yet: pi flushes a session file only
 * once it holds an assistant message.
 */
export function registerAgent(root: RootCtx, name: string, cwd: string, def?: string): string {
  // Every creation path (LLM tool and direct picker gesture) passes here. The
  // tool also checks its whole batch up front to avoid partial creation.
  assertAgentCapacity(root);
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
  m.agents.push({
    id: sm.getSessionId(),
    name,
    file,
    createdAt: new Date().toISOString(),
    ...(def ? { def } : {}),
  });
  saveManifest(root.sessionDir, m);

  // Name it up front so the picker shows something useful immediately.
  sm.appendSessionInfo(name);
  return file;
}

/**
 * Remove an agent's manifest entry and delete its session file from disk.
 *
 * Used for an outright delete (Ctrl+X in `index.ts`), as opposed to merely
 * stopping it (`terminateAgent` in `agent-runtime.ts`): after this call
 * `listAgentEntries()` no longer reports the agent at all, so there is
 * nothing left on the picker to attach to and revive. A missing file (or no
 * matching manifest entry) is not an error.
 */
export function removeAgentEntry(root: RootCtx, file: string): void {
  const m = loadManifest(root.sessionDir, root.rootId);
  if (m) {
    const next = m.agents.filter((a) => a.file !== file);
    if (next.length !== m.agents.length) {
      m.agents = next;
      saveManifest(root.sessionDir, m);
    }
  }
  try {
    fs.rmSync(file, { force: true });
  } catch {
    /* ignore */
  }
}
