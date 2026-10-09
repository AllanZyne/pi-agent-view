/**
 * pi's built-in extensions (`builtin:<name>`: codemode, tool search, MCP,
 * llama.cpp), loaded into every sub-agent the same way the CLI loads them into
 * main.
 *
 * Sub-agents are created with `noExtensions: true` so this extension is never
 * loaded recursively into them, but `noExtensions` also turns off the built-in
 * extensions (pi's `--no-extensions` does the same). The CLI keeps its list
 * in `dist/extensions/index.js` (`builtInExtensions`); the SDK says to supply
 * them yourself (see pi's docs/sdk.md, "Codemode and MCP"). This module does
 * that:
 *
 * - The factories come from pi's public exports (`createCodemodeExtension`,
 *   `createToolSearchExtension`, `createMcpExtension`). In a bundled pi those
 *   resolve to the running bundle, so they share its module instances. The
 *   CLI's own entries are these same factories (`export default createX()`).
 * - llama.cpp has no public export, so it is loaded from its file on disk,
 *   best effort, the same way `tool-renderers.ts` loads pi's renderers.
 * - Each one is passed as a `builtin: true` entry, so it loads like it does on
 *   main: hidden, replaceable, and named `builtin:<name>` in diagnostics.
 * - Which ones are enabled comes from the user's own `extensions` setting
 *   (`-builtin:mcp` disables MCP globally or per project), resolved by pi's
 *   `DefaultPackageManager` exactly the way main's resource loader resolves
 *   it. `noExtensions` drops those settings-enabled paths, so the enabled ones
 *   go in as `additionalExtensionPaths` (`builtin:<name>`), which is pi's
 *   documented way to load one explicitly.
 */

import {
  createCodemodeExtension,
  createMcpExtension,
  createToolSearchExtension,
  DefaultPackageManager,
  type InlineExtension,
  SettingsManager,
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

/**
 * `builtin:<name>` paths the user's settings enable for `cwd`. A failure to
 * resolve settings counts as "all enabled", which is pi's default.
 */
export async function enabledBuiltinPaths(cwd: string, agentDir: string, names: readonly string[]): Promise<string[]> {
  const all = names.map((name) => `builtin:${name}`);
  try {
    const pm = new DefaultPackageManager({
      cwd,
      agentDir,
      settingsManager: SettingsManager.create(cwd, agentDir),
      builtinExtensions: [...names],
    });
    const resolved = await pm.resolve();
    const enabled = new Set(resolved.extensions.filter((r) => r.enabled).map((r) => r.path));
    return all.filter((path) => enabled.has(path));
  } catch {
    return all;
  }
}

/** Test seam: forget the loaded entries. */
export function resetBuiltinExtensions(): void {
  entries = undefined;
}
