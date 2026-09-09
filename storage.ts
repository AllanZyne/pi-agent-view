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

/**
 * Create an agent session file and record it in the manifest.
 *
 * The returned path may not exist on disk yet: pi flushes a session file only
 * once it holds an assistant message.
 */
export function registerAgent(root: RootCtx, name: string, cwd: string): string {
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

  // Name it up front so the picker shows something useful immediately.
  sm.appendSessionInfo(name);
  return file;
}
