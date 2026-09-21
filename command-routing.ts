/**
 * command-routing.ts — which `/` slash commands run, get blocked, or fall
 * through unchanged while an agent view is attached.
 *
 * pi's own `/model` is intercepted by interactive mode before extensions see
 * it and always targets pi's session, so an attached view has to recognise it
 * itself — otherwise the command text would be sent to the agent as a plain
 * prompt. Everything else is a blacklist, not a whitelist: only commands that
 * are actually wrong for the conversation on screen are blocked; anything this
 * view has never heard of (extension commands, skills, prompt templates) is
 * sent to the agent's own session exactly like typing it on `main` would.
 *
 * Headless: no TUI, no extension context, no `ViewState` import — the one
 * function that needs to know whether something is attached takes just
 * `{ attached }`, so this module has no dependency on index.ts.
 */

import type { AutocompleteItem, AutocompleteProvider } from "@earendil-works/pi-tui";

/**
 * pi built-in commands (keyed by the name autocomplete lists them under, no
 * leading slash) that don't touch a session's transcript/state at all:
 * auth (`/login`, `/logout`), folder trust, provider settings, extension
 * reload, quitting the app, static info screens, easter eggs. Running pi's
 * real dispatch for these is correct and safe no matter which agent is on
 * screen, since they never read or write `this.session` — so `handleInput`
 * lets them fall through to it unchanged instead of steering them as chat
 * text to the attached agent.
 */
export const GLOBAL_ATTACHED_COMMANDS = new Set<string>([
  "settings",
  "login",
  "logout",
  "trust",
  "reload",
  "debug",
  "hotkeys",
  "changelog",
  "quit",
  "arminsayshi",
  "dementedelves",
]);

/**
 * Slash commands actually implemented against the attached agent's own
 * session, keyed by the name pi's autocomplete lists them under. `handleInput`
 * in index.ts has a dedicated case for each of these.
 */
export const SUPPORTED_ATTACHED_COMMANDS = new Set<string>(["model"]);

/**
 * Blacklist: pi built-ins that either operate on *pi's own* session/tree in
 * ways that don't translate to "the agent you're looking at" (`/tree`,
 * `/fork`, `/resume`, `/new` branch, switch, or clear pi's session file;
 * `/clone`, `/export`, `/import`, `/share`, `/scoped-models`, `/name` are
 * similarly wired to `this.session`), or are per-session but not yet
 * implemented against the attached agent's own session the way `/model` is
 * (`/thinking`, `/compact`, `/copy`, `/session` all have a direct
 * `AgentSession` equivalent — `setThinkingLevel`/`cycleThinkingLevel`,
 * `compact`, `getLastAssistantText`, `getSessionStats` — but nothing calls
 * them yet). Confirmed in a real tmux run (see
 * `.agents/skills/pi-agent-view-debug`): letting any of these fall through to
 * pi's real dispatch while attached either silently mutates main instead of
 * the agent on screen (`/tree` opened pi's *own* session tree), or — for the
 * unimplemented per-session ones — just gets sent to the agent as chat text
 * verbatim (`/thinking` produced a literal "/thinking" chat message the LLM
 * then had to explain away). Both are worse than a clear "not available"
 * notice, so `handleInput` blocks all of them instead. Move a command out of
 * this set into `SUPPORTED_ATTACHED_COMMANDS` once it has a real
 * attached-agent implementation; move a global one to
 * `GLOBAL_ATTACHED_COMMANDS` if it turns out not to touch a session at all.
 */
export const BLOCKED_ATTACHED_COMMANDS = new Set<string>([
  "tree",
  "fork",
  "clone",
  "resume",
  "new",
  "scoped-models",
  "export",
  "import",
  "share",
  "name",
  "thinking",
  "compact",
  "copy",
  "session",
]);

/**
 * `/model` typed while an agent is attached.
 *
 * pi's own `/model` is handled by interactive mode before extensions see it
 * and always targets pi's session, so an attached view has to recognise it
 * itself — otherwise the command text would be sent to the agent as a prompt.
 */
export function parseModelCommand(text: string): { search?: string } | undefined {
  if (text !== "/model" && !text.startsWith("/model ")) return undefined;
  const search = text.slice("/model".length).trim();
  return { search: search || undefined };
}

/**
 * The bare command name of a `/foo` or `/foo args` line, or `undefined` for
 * anything else (plain chat text, `!bash`, `@mention`, ...).
 */
export function commandName(text: string): string | undefined {
  if (!text.startsWith("/")) return undefined;
  const spaceIndex = text.indexOf(" ");
  const name = spaceIndex === -1 ? text.slice(1) : text.slice(1, spaceIndex);
  return name || undefined;
}

/**
 * Hide slash commands the attached view would reject outright from `/`
 * completion — the blacklist above, since typing one gets blocked with a
 * notice instead of doing anything useful. Global commands and the ones this
 * view implements itself both stay visible: both actually run. Detached (on
 * `main`), this passes every call straight through: `attached` is unset only
 * there.
 */
export function withAttachedCommandFilter(
  current: AutocompleteProvider,
  view: { attached?: string },
): AutocompleteProvider {
  return {
    triggerCharacters: current.triggerCharacters,
    async getSuggestions(lines, cursorLine, cursorCol, options) {
      const result = await current.getSuggestions(lines, cursorLine, cursorCol, options);
      if (!result || !view.attached) return result;
      // Only the top-level "/" command list needs filtering: a command that
      // made it past that list either runs directly or is one we implement
      // ourselves, so its own argument completions (prefix has a space in it)
      // are left untouched.
      if (!result.prefix.startsWith("/") || result.prefix.includes(" ")) return result;
      const items = result.items.filter((item: AutocompleteItem) => !BLOCKED_ATTACHED_COMMANDS.has(item.value));
      if (items.length === 0) return null;
      return { ...result, items };
    },
    applyCompletion: (lines, cursorLine, cursorCol, item, prefix) =>
      current.applyCompletion(lines, cursorLine, cursorCol, item, prefix),
    shouldTriggerFileCompletion: current.shouldTriggerFileCompletion
      ? (lines, cursorLine, cursorCol) => current.shouldTriggerFileCompletion!(lines, cursorLine, cursorCol)
      : undefined,
  };
}
