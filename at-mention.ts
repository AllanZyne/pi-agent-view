/**
 * at-mention.ts — `@` token detection for editor autocomplete.
 *
 * `@name` used to be a client-side routing operator with its own priority
 * order, position rule, and backslash/backtick/quote escaping (see git
 * history / README for the old design). That's gone: every agent now gets
 * the same LLM-callable tools (`agent_create`, `agent_list`, `agent_inspect`,
 * `agent_send`, `agent_remove`), so whichever conversation you're talking to
 * decides from the message's *content* what `@name` means and calls the matching
 * tool itself — no client-side parsing, no escaping needed.
 *
 * All that's left here is `atTokenAtCursor`: purely cosmetic autocomplete
 * support so typing `@` still offers a list of known agent names/defs and
 * inserts `@<name> ` at the cursor (see `autocomplete.ts`). It has no
 * bearing on what happens when the message is actually sent.
 *
 * Headless: no FS, no TUI, no extension context.
 */

/** The conventional slug suggested for "spawn a fresh background agent" in the `@` completion list. Not reserved or special to any parsing — just a suggestion. */
export const ADHOC_SLUG = "agent";

/** Enough about a live agent for the completion list. */
export interface LiveAgentInfo {
  file: string;
  name: string;
  def?: string;
}

/**
 * The `@`-token the cursor is currently editing, or `null` if it isn't in one.
 *
 * Only recognised at the very start of the message (only whitespace allowed
 * before `@`), matching the one place typing `@` used to intercept — kept so
 * the completion list doesn't pop up mid-sentence (e.g. `foo@bar`), where
 * `@` is either prose or a file reference and pi's own file picker should
 * still own it.
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
