/**
 * at-mention.ts — parse `@name` mentions in submitted prompts.
 *
 * `@<slug>` is a **routing operator**, not a highlight operator: it addresses
 * an agent by priority, with a new spawn as a fallback. Because that
 * redirects the message away from main, the interception rule is narrow to
 * avoid capturing prose-about-an-agent (the "mention" vs "mention-of" ambiguity):
 *
 *   The `@` must be at the **start of the message text** (leading whitespace
 *   is allowed). Any non-whitespace character before `@` — a word, a
 *   backslash, a backtick, a quote — makes it prose, not a mention.
 *
 * Examples:
 *
 *   `@pinger ping 3`               → intercept (message-start)
 *   `   @pinger ping 3`            → intercept (leading spaces are fine)
 *   `let me look at @pinger's cfg` → prose, not intercepted
 *   `\@pinger has a bug`           → prose (backslash escape, Slack-style)
 *   `` `@pinger` is broken ``      → prose (backtick escape)
 *   `first do X, then @pinger …`   → prose
 *
 * Resolution for the slug (once the position check passes):
 *
 *   1. `agent`                                  → adhoc spawn (reserved slug)
 *   2. live agent whose *own name* equals slug  → route (exact instance)
 *   3. live agents whose *def* equals slug      → route (caller-ordered
 *                                                  most-recent-first)
 *   4. catalog def named slug                   → def-backed spawn
 *   5. else                                     → not intercepted
 *
 * The caller passes `excludeFile` set to the currently attached agent's file
 * so rules 2 and 3 don't match "self" — the point of `@name` is to address
 * *another* agent, and if the only live match is the agent you're already
 * talking to, the message falls through as normal chat (steer).
 *
 * If interception fails, the whole message goes to main / the attached agent
 * as normal chat. When it succeeds, the full original message is passed
 * verbatim to the target — the mention is not stripped. The `\@` cleanup
 * (removing leading backslashes from `@`-escape sequences) is done by the
 * editor before this module runs, so `parseAtMention` sees the same text
 * both when it decides to intercept and when it lets the message through.
 *
 * Everything here is pure: no FS, no TUI, no extension context, no mtime.
 */

import type { Catalog, SubAgentDef } from "./agent-catalog.ts";

/** The reserved slug meaning "spawn a fresh ad-hoc agent, inherit main". */
export const ADHOC_SLUG = "agent";

/** Enough about a live agent for name/def matching; no session or transcript. */
export interface LiveAgentInfo {
  file: string;
  name: string;
  def?: string;
}

export interface MentionContext {
  catalog: Catalog;
  /**
   * Live agents in **most-recently-active-first** order. Rules 2 and 3 take
   * the first match, so this ordering is what disambiguates when multiple
   * live agents share a def. Kept as the caller's responsibility so this
   * module has no time/FS dependency.
   */
  liveAgents: readonly LiveAgentInfo[];
  /**
   * The currently attached agent's file, if any. Skipped from live-agent
   * matching so `@slug` from within an attached view addresses "another"
   * agent, not itself.
   */
  excludeFile?: string;
}

export type AtMentionTarget =
  | { kind: "adhoc" }
  | { kind: "route"; file: string; name: string }
  | { kind: "def"; def: SubAgentDef };

export interface AtMention {
  target: AtMentionTarget;
  /** The slug that was matched (`"agent"` for adhoc). */
  slug: string;
  /** Verbatim original prompt text (mention NOT stripped). */
  task: string;
}

/**
 * Recognise `@<slug>` at the start of `text` and return the routing decision,
 * or `null` when the message is prose (mention doesn't start the message,
 * doesn't resolve to any target, or resolves but leaves an empty task).
 */
export function parseAtMention(text: string, ctx: MentionContext): AtMention | null {
  // Anchored at start-of-text with only whitespace allowed before `@`. This
  // is what makes prose about an agent (`"look at @pinger's config"`) fall
  // through to normal chat: prose doesn't start with `@`.
  const match = /^\s*@([a-z][a-z0-9-]*)\b/.exec(text);
  if (!match) return null;

  const slug = match[1]!;
  const target = resolveSlug(slug, ctx);
  if (!target) return null;

  // The task is everything after the mention token. If the user pressed
  // Enter on just `@slug` (or whitespace + `@slug`), there's no task —
  // return null so the caller can complain about an empty prompt exactly
  // the way it complains about an empty submit.
  if (text.slice(match[0].length).trim().length === 0) return null;

  return { target, slug, task: text };
}

/** Look up a slug against the 5-step priority order. */
function resolveSlug(slug: string, ctx: MentionContext): AtMentionTarget | null {
  // 1. Reserved adhoc slug always wins.
  if (slug === ADHOC_SLUG) return { kind: "adhoc" };

  // 2. Exact live-agent name match (excluding self). This is how a user
  //    addresses a specific instance by its picker slug.
  const byName = ctx.liveAgents.find((a) => a.file !== ctx.excludeFile && a.name === slug);
  if (byName) return { kind: "route", file: byName.file, name: byName.name };

  // 3. Live agent whose *def* is this slug (excluding self). Caller's
  //    ordering picks the winner when multiple share a def.
  const byDef = ctx.liveAgents.find((a) => a.file !== ctx.excludeFile && a.def === slug);
  if (byDef) return { kind: "route", file: byDef.file, name: byDef.name };

  // 4. Catalog def with this name — spawn a new def-backed agent.
  const def = ctx.catalog.agents.get(slug);
  if (def) return { kind: "def", def };

  // 5. Nothing matched: treat as ordinary text.
  return null;
}

// ── Cursor-token helper for autocomplete ───────────────────────────

/**
 * The `@`-token the cursor is currently editing, or `null` if it isn't in one.
 *
 * Matches `parseAtMention`'s position rule exactly: the cursor must be inside
 * an `@`-token at the very start of the message, with only whitespace
 * allowed before `@`. This is what lets the autocomplete wrapper offer agent
 * suggestions where `@` will actually intercept on submit — and cede to pi's
 * file picker mid-message, where `@` is prose or a file reference and would
 * fall through to main anyway.
 *
 * `prefix` is what a completion would replace: `@` + the slug fragment typed
 * so far. `slug` is that fragment alone.
 */
export function atTokenAtCursor(
  lines: string[],
  cursorLine: number,
  cursorCol: number,
): { prefix: string; slug: string } | null {
  // Multi-line messages: only line 0 is "message start".
  if (cursorLine !== 0) return null;
  const line = lines[0] ?? "";
  const before = line.slice(0, cursorCol);
  // Only whitespace allowed between the start of the message and `@`.
  const match = /^\s*(@([a-z][a-z0-9-]*)?)$/.exec(before);
  if (!match) return null;
  return { prefix: match[1]!, slug: match[2] ?? "" };
}
