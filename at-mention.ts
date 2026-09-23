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
 * support so typing `@` offers templates as `@agent:<id>` and live instances
 * as `@<instance-name>` (see `autocomplete.ts`).
 *
 * Token detection used to be restricted to the very start of the message
 * (cursor on line 0, only whitespace before `@`) specifically to keep it out
 * of pi's own file-completion's way — but that position rule was itself the
 * source of a worse bug: whether `@` meant "agent" or "file" depended on
 * *where* the cursor happened to be, and a completion applied through the
 * wrong path could corrupt the line (see `autocomplete.ts`'s `kind` tag for
 * the actual fix). Investigating how the Codex CLI's TUI handles the same
 * problem (`.agents/research/codex-at-mention.md`) turned up a simpler,
 * position-independent rule its own popup and its file/path completion both
 * already use: scan left from the cursor to the nearest delimiter (matching
 * pi's own `CombinedAutocompleteProvider.extractAtPrefix`/`findLastDelimiter`
 * — whitespace, quotes, or `=`) and check whether that run starts with `@`.
 * `atTokenAtCursor` now does the same, so it agrees with pi's own file
 * completion about *where* a token is; `autocomplete.ts` is what makes the
 * two coexist inside one token instead of one clobbering the other.
 *
 * Headless: no FS, no TUI, no extension context.
 */

/** Enough about a live agent for the completion list. */
export interface LiveAgentInfo {
  file: string;
  name: string;
  template?: string;
}

/**
 * Delimiters that end a token when scanning left from the cursor. Mirrors
 * pi's own `PATH_DELIMITERS` (`" \t\"'="`) plus Unicode whitespace — kept in
 * sync deliberately so our token boundary and pi's file-completion token
 * boundary never disagree about where `@word` starts (see module doc).
 */
function isDelimiter(ch: string): boolean {
  return ch === " " || ch === "\t" || ch === '"' || ch === "'" || ch === "=" || /\s/u.test(ch);
}

/**
 * The `@`-token the cursor is currently editing, or `null` if it isn't in
 * one — anywhere in the message, not just at its start (see module doc for
 * why the old start-of-message restriction was removed). Never crosses a
 * newline: only the cursor's own line is scanned, so a token on one line
 * can't absorb text from another.
 *
 * `foo@bar` is correctly *not* a token: scanning left from the cursor only
 * stops at a delimiter, and `@` has to be the very first character of that
 * run, so an `@` stuck mid-word (an email-like string, prose) is prose, not
 * a mention — exactly like pi's own file completion treats it.
 *
 * `prefix` is what a completion would replace: `@` + the slug fragment typed
 * so far. `slug` is that fragment alone.
 */
export function atTokenAtCursor(
  lines: string[],
  cursorLine: number,
  cursorCol: number,
): { prefix: string; slug: string } | null {
  const line = lines[cursorLine] ?? "";
  const before = line.slice(0, cursorCol);
  let start = before.length;
  while (start > 0 && !isDelimiter(before[start - 1]!)) start--;
  if (before[start] !== "@") return null;
  const prefix = before.slice(start);
  return { prefix, slug: prefix.slice(1) };
}
