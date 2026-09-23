/**
 * autocomplete.ts — merge agent suggestions into pi's own `@` file/path
 * completion, instead of one clobbering the other.
 *
 * The old design split `@` in two by cursor position: agent suggestions at
 * the very start of the message, pi's own file completion everywhere else.
 * That produced the bug this file now exists to avoid: which popup you got
 * depended on *where* the cursor was, and `applyCompletion` decided which
 * logic owned a selected item by checking `prefix.startsWith("@")` — but
 * pi's own file items *also* have an `@`-prefixed `prefix` (that's pi's own
 * file-completion trigger character), so a file selection could be
 * misidentified as ours and spliced in through our own `replaceAtToken`
 * instead of pi's own `applyCompletion`, corrupting the line (an extra `@`,
 * or the wrong text entirely).
 *
 * Investigating how the Codex CLI's TUI avoids this same class of bug
 * (`.agents/research/codex-at-mention.md`) turned up the actual fix: it
 * never re-derives a mention's *kind* from surrounding text or from a prefix
 * string after the fact — every candidate carries an explicit kind from the
 * moment it's constructed (`Candidate.mention_type`), and insertion dispatch
 * `match`es on that, not on some string shape two different kinds could both
 * produce. `wrapWithAgentMentions` does the same here: every item in the
 * merged list gets tagged with an explicit `kind` (`"agent"` or `"file"`,
 * `MentionItem` below) at construction time, and `applyCompletion` dispatches
 * on that tag — an agent item is spliced in with `replaceAtToken`, a file
 * item is forwarded verbatim to pi's own `applyCompletion` (the original
 * item pi gave us, not a reconstruction), so pi's own path/quoting logic
 * still runs exactly as it would have without this wrapper at all.
 *
 * `atTokenAtCursor` (`at-mention.ts`) now agrees with pi's own file
 * completion about *where* an `@` token is (same delimiter rule, no
 * position restriction), so both sides are always looking at the same span
 * — which is what makes merging their results into one list correct instead
 * of coincidental.
 *
 * The wrapper composes with `withAttachedCommandFilter`: this one must be the
 * *innermost* wrap so its `shouldTriggerFileCompletion` override actually
 * reaches the base provider (the outer filter only touches `/`-suggestions).
 *
 * Headless: depends only on the `AutocompleteProvider` shape from pi-tui and
 * on `at-mention.ts` / `agent-catalog.ts`. Testable without a terminal.
 */

import type { AutocompleteItem, AutocompleteProvider, AutocompleteSuggestions } from "@earendil-works/pi-tui";
import { atTokenAtCursor, type LiveAgentInfo } from "./at-mention.ts";
import type { Catalog } from "./agent-catalog.ts";

/**
 * Snapshot of everything `@`-completion needs: the on-disk catalog plus the
 * live agent pool (already filtered by the caller — e.g. `view.attached` is
 * excluded so you never see "yourself" in the picker).
 *
 * `liveAgents` is ordered most-recently-active first so the top of the list
 * instances of the same template surface the freshest one first.
 */
export interface MentionScan {
  catalog: Catalog;
  liveAgents: readonly LiveAgentInfo[];
}

/**
 * An `AutocompleteItem` tagged with which logic produced it and, for a
 * forwarded file item, the exact original item pi's own provider returned
 * (so `applyCompletion` can hand it straight back without reconstructing
 * it). The tag is what `applyCompletion` dispatches on — never the `prefix`
 * string, which both kinds can share (see module doc).
 */
interface MentionItem extends AutocompleteItem {
  kind: "agent" | "file";
  original?: AutocompleteItem;
}

/**
 * Wrap `current` so that `@` offers agent suggestions merged with pi's own
 * file completion in one list, instead of one replacing the other by cursor
 * position.
 *
 * `rescan` is called on every completion request that lands inside an `@`
 * token, so newly-added def files and freshly-spawned live agents show up
 * without an explicit refresh. Its cost is one directory walk plus a live
 * agent enumeration; the extension coalesces successive calls at the caller
 * layer (autocomplete + submit typically share one scan per keystroke).
 */
export function wrapWithAgentMentions(
  current: AutocompleteProvider,
  rescan: () => MentionScan,
): AutocompleteProvider {
  return {
    // `@` was already a trigger character for pi's file completion; keep it so
    // the editor debounces the same way, but now our `getSuggestions` fires.
    triggerCharacters: current.triggerCharacters,

    async getSuggestions(lines, cursorLine, cursorCol, options) {
      const token = atTokenAtCursor(lines, cursorLine, cursorCol);
      if (!token) return current.getSuggestions(lines, cursorLine, cursorCol, options);

      const agentItems = agentMentionItems(token, rescan());
      // Ask pi's own file completion too, using the *same* token — its own
      // `extractAtPrefix` uses the same delimiter rule (see `at-mention.ts`),
      // so it independently finds the same span and returns the same
      // `prefix` we already have. Each item it hands back is wrapped, never
      // rebuilt, so `applyCompletion` can forward it unchanged later.
      const fileSuggestions = await current.getSuggestions(lines, cursorLine, cursorCol, options);
      const fileItems: MentionItem[] = (fileSuggestions?.items ?? []).map((item) => ({
        ...item,
        kind: "file",
        original: item,
      }));

      return { items: [...agentItems, ...fileItems], prefix: token.prefix };
    },

    applyCompletion(lines, cursorLine, cursorCol, item, prefix) {
      const mention = item as MentionItem;
      if (mention.kind === "file") {
        // pi's own item, pi's own logic — never our `replaceAtToken` guess.
        return current.applyCompletion(lines, cursorLine, cursorCol, mention.original ?? item, prefix);
      }
      // `kind === "agent"`, or untagged as a safety net for anything that
      // somehow reaches here without a tag: ours.
      return replaceAtToken(lines, cursorLine, cursorCol, prefix, `@${item.value} `);
    },

    // Suppress pi's *independent* file trigger whenever the cursor is inside
    // an `@` token — its suggestions are already merged into ours above, so
    // letting it also fire on its own would just race the same file scan
    // twice for one keystroke.
    shouldTriggerFileCompletion(lines, cursorLine, cursorCol) {
      if (atTokenAtCursor(lines, cursorLine, cursorCol)) return false;
      return current.shouldTriggerFileCompletion
        ? current.shouldTriggerFileCompletion(lines, cursorLine, cursorCol)
        : false;
    },
  };
}

// ── Helpers ────────────────────────────────────────────────────────

function agentMentionItems(token: { prefix: string; slug: string }, scan: MentionScan): MentionItem[] {
  const { catalog, liveAgents } = scan;

  // Live instances are targets for follow-up wording; templates always remain
  // present so they can create additional instances, even when one made from
  // that template is live.
  const items: AutocompleteItem[] = [
    ...liveAgents.map((a) => ({
      value: a.name,
      label: a.name,
      description: a.template ? `live instance · template: ${a.template}` : "live instance · no template",
    })),
    ...[...catalog.agents.values()]
      .sort((a, b) => a.name.localeCompare(b.name))
      .map((template) => ({
        value: `agent:${template.name}`,
        label: `agent:${template.name}`,
        description: `template · ${template.description} [${template.scope}; default: ${template.model ?? "inherit"}]`,
      })),
  ];

  const query = token.slug.toLowerCase();
  const filtered = query ? items.filter((i) => i.value.toLowerCase().includes(query)) : items;
  return filtered.map((item) => ({ ...item, kind: "agent" as const }));
}

/**
 * Replace the `@`-token ending at the cursor with `replacement`, and put the
 * cursor at the end of the replacement.
 *
 * Only the current line's text before the cursor changes: the tail after the
 * cursor (if any) and other lines are untouched. Matches the shape returned
 * by `AutocompleteProvider.applyCompletion`.
 */
export function replaceAtToken(
  lines: string[],
  cursorLine: number,
  cursorCol: number,
  prefix: string,
  replacement: string,
): { lines: string[]; cursorLine: number; cursorCol: number } {
  const line = lines[cursorLine] ?? "";
  const before = line.slice(0, cursorCol);
  const after = line.slice(cursorCol);
  // The prefix is always at the tail of `before` (the wrapper only invents
  // completions when `atTokenAtCursor` matched, so this is guaranteed). Guard
  // anyway, so a caller misusing this cannot corrupt the line.
  const cut = before.endsWith(prefix) ? before.slice(0, -prefix.length) : before;
  const newBefore = cut + replacement;
  const newLine = newBefore + after;
  const newLines = lines.slice();
  newLines[cursorLine] = newLine;
  return { lines: newLines, cursorLine, cursorCol: newBefore.length };
}
