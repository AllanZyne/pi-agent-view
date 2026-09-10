/**
 * agent-catalog.ts — discover sub-agent definitions from `.pi/agents/`.
 *
 * Mirrors Claude Code's `.claude/agents/` convention, and the built-in
 * `examples/extensions/subagent`'s own layout:
 *
 *   <cwd>/.pi/agents/**\/*.md        (project scope, higher priority)
 *   getAgentDir()/agents/**\/*.md    (user scope; `~/.pi/agent/agents/` by
 *                                     default, or `$PI_CODING_AGENT_DIR/agents/`)
 *
 * User scope lives under `getAgentDir()`, not bare `~/.pi/`, because `~/.pi/`
 * is the shared root for every pi-branded tool (the coding agent, the RPC
 * server, etc. — see `PI_SERVER_DIR` defaulting to `~/.pi/server`), while
 * `~/.pi/agent/` (`PI_CODING_AGENT_DIR`) is this tool's own namespace inside
 * it. A bare `~/.pi/agents/` would sit as a stray sibling of `~/.pi/agent/`
 * instead of inside it, and would silently stop working for anyone who sets
 * `PI_CODING_AGENT_DIR` to relocate or rebrand the coding agent's state.
 *
 * A definition is a Markdown file with YAML frontmatter. The frontmatter
 * declares who the agent is and how it should be spawned; the body is
 * *appended* to pi's base system prompt (via `DefaultResourceLoader.
 * appendSystemPrompt`), so pi's own default prompt, `AGENTS.md`, skills, etc.
 * still load — the def supplements, it doesn't replace.
 *
 * Discovery is on-demand, not watched: callers rescan on every use (spawn,
 * autocomplete, /agents). The tree is tiny in practice, so a fresh scan is
 * cheaper than the invalidation logic a watcher would need.
 *
 * Everything here is pure filesystem work with no TUI or extension-context
 * dependency, so it can be unit tested directly (see tests/).
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { getAgentDir, parseFrontmatter } from "@earendil-works/pi-coding-agent";
import type { ThinkingLevel } from "@earendil-works/pi-ai";

// ── Types ──────────────────────────────────────────────────────────

/**
 * One resolved sub-agent definition.
 *
 * Identity is `name` — the frontmatter field, not the filename or directory.
 * That matches Claude Code and lets users organise files however they like.
 */
export interface SubAgentDef {
  name: string;
  description: string;
  /** Absolute path to the source `.md` file. */
  source: string;
  scope: "project" | "user";
  /** Markdown body, only when non-empty. Appended to the base system prompt. */
  appendSystemPrompt?: string;
  /** `provider/id`. Undefined means "inherit main's model" at spawn time. */
  model?: string;
  thinkingLevel?: ThinkingLevel;
}

export interface CatalogDiagnostic {
  path: string;
  error: string;
}

export interface Catalog {
  agents: Map<string, SubAgentDef>;
  /** Files that were skipped, and why. Surfaced by `/agents`, ignored by resolution. */
  diagnostics: CatalogDiagnostic[];
}

/**
 * Names the loader silently rejects.
 *
 * `agent` is the reserved slug used by `@agent <task>` to mean "spawn a fresh
 * ad-hoc agent inheriting main". If a def could take that name it would
 * shadow the reserved form, so it is skipped and a diagnostic recorded.
 */
export const RESERVED_NAMES = new Set(["agent"]);

/** Slug rule shared with `at-mention.ts` (kept in sync intentionally). */
export const NAME_RE = /^[a-z][a-z0-9-]*$/;

// ── Loading ────────────────────────────────────────────────────────

/** The two roots pi-agent-view scans, project first (higher priority). */
export function agentRoots(cwd: string): Array<{ dir: string; scope: "project" | "user" }> {
  return [
    { dir: path.join(cwd, ".pi", "agents"), scope: "project" },
    { dir: path.join(getAgentDir(), "agents"), scope: "user" },
  ];
}

/**
 * Force-rescan both scopes and return the merged catalog.
 *
 * Project scope wins on `name` collisions — the user scope entry is dropped
 * silently (a diagnostic would be noisy in the common "same name intentionally
 * overridden" case). The user's original file is still discoverable through
 * `/agents`, which lists source paths.
 */
export function loadCatalog(cwd: string): Catalog {
  const agents = new Map<string, SubAgentDef>();
  const diagnostics: CatalogDiagnostic[] = [];

  for (const { dir, scope } of agentRoots(cwd)) {
    for (const file of walkMarkdown(dir)) {
      const parsed = parseDefFile(file, scope);
      if ("error" in parsed) {
        diagnostics.push({ path: file, error: parsed.error });
        continue;
      }
      // Project wins over user: only the first-seen (project) entry keeps its slot.
      if (agents.has(parsed.def.name)) continue;
      agents.set(parsed.def.name, parsed.def);
    }
  }

  return { agents, diagnostics };
}

/**
 * Parse one `.md` file into a `SubAgentDef`, or explain why it was skipped.
 *
 * Exported so tests can hit the parser directly without setting up a
 * filesystem.
 */
export function parseDefFile(
  file: string,
  scope: "project" | "user",
): { def: SubAgentDef } | { error: string } {
  let raw: string;
  try {
    raw = fs.readFileSync(file, "utf-8");
  } catch (err) {
    return { error: `read failed: ${(err as Error).message}` };
  }
  return parseDefContent(raw, file, scope);
}

/** Text-only variant of `parseDefFile` for unit tests. */
export function parseDefContent(
  raw: string,
  file: string,
  scope: "project" | "user",
): { def: SubAgentDef } | { error: string } {
  let parsed: { frontmatter: Record<string, unknown>; body: string };
  try {
    parsed = parseFrontmatter(raw);
  } catch (err) {
    return { error: `frontmatter parse: ${(err as Error).message}` };
  }
  const { frontmatter, body } = parsed;

  const name = frontmatter.name;
  if (typeof name !== "string" || name.length === 0) {
    // Claude Code silently ignores files with no `name` (they are used as
    // documentation kept beside agents). Match that: no diagnostic.
    return { error: "no name" };
  }
  if (!NAME_RE.test(name)) return { error: `invalid name "${name}"` };
  if (RESERVED_NAMES.has(name)) return { error: `reserved name "${name}"` };

  const description = frontmatter.description;
  if (typeof description !== "string" || description.trim().length === 0) {
    return { error: "no description" };
  }

  const modelValue = frontmatter.model;
  let model: string | undefined;
  if (modelValue !== undefined && modelValue !== null) {
    if (typeof modelValue !== "string") return { error: "model must be a string" };
    if (modelValue === "inherit") model = undefined;
    else if (!/^[^/\s]+\/[^/\s]+$/.test(modelValue)) return { error: `invalid model "${modelValue}" (expected provider/id)` };
    else model = modelValue;
  }

  const thinkingValue = frontmatter.thinkingLevel;
  let thinkingLevel: ThinkingLevel | undefined;
  if (thinkingValue !== undefined && thinkingValue !== null) {
    if (typeof thinkingValue !== "string") return { error: "thinkingLevel must be a string" };
    if (!THINKING_LEVELS.has(thinkingValue)) return { error: `invalid thinkingLevel "${thinkingValue}"` };
    thinkingLevel = thinkingValue as ThinkingLevel;
  }

  const bodyTrimmed = body.trim();
  const def: SubAgentDef = {
    name,
    description: description.trim(),
    source: file,
    scope,
    ...(bodyTrimmed ? { appendSystemPrompt: bodyTrimmed } : {}),
    ...(model !== undefined ? { model } : {}),
    ...(thinkingLevel !== undefined ? { thinkingLevel } : {}),
  };
  return { def };
}

const THINKING_LEVELS = new Set(["off", "low", "medium", "high"]);

// ── Filesystem walk ────────────────────────────────────────────────

/**
 * Yield every `*.md` under `dir`, recursively. Missing directory → yields
 * nothing (users may have set up only one scope).
 */
function* walkMarkdown(dir: string): IterableIterator<string> {
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return;
  }
  // Sort so scan order is deterministic — matters for the diagnostic list and
  // for tests, not for resolution (name collisions inside one scope pick
  // filesystem order, matching Claude Code).
  entries.sort((a, b) => a.name.localeCompare(b.name));
  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      yield* walkMarkdown(full);
    } else if (entry.isFile() && entry.name.endsWith(".md")) {
      yield full;
    }
  }
}
