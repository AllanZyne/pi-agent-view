/**
 * pi's built-in extensions (`builtin:<name>`: codemode, tool search, MCP,
 * llama.cpp), supplied to every sub-agent's resource loader the way the CLI
 * supplies them to main's.
 *
 * The CLI keeps its list in `dist/extensions/index.js` (`builtInExtensions`)
 * and passes it as `extensionFactories`; an SDK session gets none unless its
 * host does the same (see pi's docs/sdk.md, "Codemode and MCP"). This module
 * builds that same list:
 *
 * - The factories come from pi's public exports (`createCodemodeExtension`,
 *   `createToolSearchExtension`, `createMcpExtension`). In a bundled pi those
 *   resolve to the running bundle, so they share its module instances. The
 *   CLI's own entries are these same factories (`export default createX()`).
 * - llama.cpp has no public export, so it is loaded from its file on disk,
 *   best effort, the same way `tool-renderers.ts` loads pi's renderers.
 * - Each one is a `builtin: true` entry, so pi resolves whether it is enabled
 *   from the `extensions` setting (`-builtin:mcp`) exactly as for main, and
 *   loads it hidden, replaceable, and named `builtin:<name>`.
 */

import {
  createCodemodeExtension,
  createMcpExtension,
  createToolSearchExtension,
  type InlineExtension,
} from "@earendil-works/pi-coding-agent";
import { piModuleUrl } from "./pi-package.ts";

type BuiltinEntry = Extract<InlineExtension, { name: string }>;

/**
 * Names of pi's built-in extensions, in pi's own load order (as in its
 * `builtInExtensions`). `tests/unit.builtin-extensions.mjs` compares this with
 * pi's list, so a pi upgrade that adds or renames one fails a test instead of
 * silently leaving sub-agents without it.
 */
export const BUILTIN_EXTENSION_NAMES = ["llama.cpp", "codemode", "tool-search", "mcp"] as const;

const LLAMA_SUBPATH = ["dist", "extensions", "llama", "index.js"];

let entries: Promise<BuiltinEntry[]> | undefined;

/** Load llama.cpp's factory from disk, or undefined when it can't be found. */
async function loadLlamaFactory(): Promise<BuiltinEntry["factory"] | undefined> {
  const found = piModuleUrl(LLAMA_SUBPATH);
  if (!found) return undefined;
  try {
    const mod = (await import(found.url)) as { default?: unknown };
    return typeof mod.default === "function" ? (mod.default as BuiltinEntry["factory"]) : undefined;
  } catch {
    return undefined;
  }
}

/** The built-in extension entries for a sub-agent's `extensionFactories` (loaded once). */
export function builtinExtensionEntries(): Promise<BuiltinEntry[]> {
  entries ??= (async () => {
    const list: BuiltinEntry[] = [];
    const llama = await loadLlamaFactory();
    if (llama) list.push({ name: "llama.cpp", factory: llama, builtin: true });
    // Replaceable, like on main: an extension that registers `codemode`,
    // `tool_search`, or `/mcp` takes over instead of running alongside.
    list.push({ name: "codemode", factory: createCodemodeExtension(), replaceable: true, builtin: true });
    list.push({ name: "tool-search", factory: createToolSearchExtension(), replaceable: true, builtin: true });
    list.push({ name: "mcp", factory: createMcpExtension(), replaceable: true, builtin: true });
    return list;
  })();
  return entries;
}

/** Test seam: forget the loaded entries. */
export function resetBuiltinExtensions(): void {
  entries = undefined;
}
