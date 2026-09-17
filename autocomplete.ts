/**
 * autocomplete.ts — swap pi's `@` file completion for agent completion.
 *
 * pi's built-in `CombinedAutocompleteProvider` reserves `@` for a file picker.
 * While pi-agent-view is loaded, `@` picks an agent instead: typing `@` opens
 * a list of reusable templates as `agent:<id>` and live instances by name.
 * Selecting one inserts the corresponding `@... ` token.
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
 * Wrap `current` so that `@` triggers agent suggestions.
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
      if (token) {
        return agentSuggestions(token, rescan());
      }
      return current.getSuggestions(lines, cursorLine, cursorCol, options);
    },

    applyCompletion(lines, cursorLine, cursorCol, item, prefix) {
      // Our items are recognisable by `prefix` starting with `@` — the base
      // provider's file items also start with `@` but its own applyCompletion
      // is what handled them before; here we own `@` completely.
      if (prefix.startsWith("@")) {
        return replaceAtToken(lines, cursorLine, cursorCol, prefix, `@${item.value} `);
      }
      return current.applyCompletion(lines, cursorLine, cursorCol, item, prefix);
    },

    // Suppress pi's file listing whenever the cursor is inside an `@` token —
    // otherwise the editor would race a file scan against our agent list.
    shouldTriggerFileCompletion(lines, cursorLine, cursorCol) {
      if (atTokenAtCursor(lines, cursorLine, cursorCol)) return false;
      return current.shouldTriggerFileCompletion
        ? current.shouldTriggerFileCompletion(lines, cursorLine, cursorCol)
        : false;
    },
  };
}

// ── Helpers ────────────────────────────────────────────────────────

function agentSuggestions(
  token: { prefix: string; slug: string },
  scan: MentionScan,
): AutocompleteSuggestions {
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

  return { items: filtered, prefix: token.prefix };
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
