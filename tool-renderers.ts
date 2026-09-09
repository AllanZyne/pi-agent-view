/**
 * tool-renderers.ts — pi's built-in tool renderers, for agent tool calls.
 *
 * `ToolExecutionComponent` does not know how to draw a tool: pi passes it
 * renderers, obtained from `withBuiltInRenderers(name, definition)`. Without
 * them a tool call falls back to a bold tool name plus raw JSON args, which is
 * why agent tool calls used to look nothing like the main session's
 * `bash` / `edit` / `read` boxes — e.g. a `bash` call rendering as
 *
 *   bash
 *   { "command": "ls" }
 *
 * instead of pi's own `$ ls` box.
 *
 * Those renderers live in `<pi>/dist/core/tools/renderers/index.js`, which the
 * package's `exports` map does not expose, so it cannot be imported by its bare
 * specifier ("@earendil-works/pi-coding-agent/core/tools/..." is simply not a
 * key in `exports`, and Node rejects deep subpaths once a package declares an
 * `exports` map at all).
 *
 * A previous version of this file tried to route around that by importing
 * "@earendil-works/pi-coding-agent/../core/tools/renderers/index.js" on the
 * theory that pi's extension loader aliases the package specifier to
 * `<pi>/dist/index.js` and jiti resolves the ".." against that real path. That
 * only holds when the loader actually uses an `alias` map. pi's own standalone
 * Node distribution (what installs under `~/.local/share/pi-node/.../lib/
 * node_modules/@earendil-works/pi-coding-agent`, i.e. exactly how this
 * extension's host is normally installed) is `isBundledNode`, and for that case
 * pi's loader configures jiti with `virtualModules` instead of `alias` — no
 * alias means the deep import falls through to Node's own resolver, which
 * rejects the out-of-package subpath outright. The renderers module was never
 * reachable this way in that install; every agent tool call silently fell back
 * to raw JSON forever, and `resetToolRenderers()`/retries could not fix it
 * because the failure is not transient.
 *
 * The fix: never ask Node's specifier resolver to reach outside the package.
 * Find the package's real install directory on disk instead (multiple ways,
 * host layout permitting) and import the renderers module by an absolute
 * `file://` URL, which bypasses `exports` entirely — Node only consults
 * `exports` for bare specifiers, never for direct paths.
 *
 * Everything here stays best-effort: if every strategy fails (restructured
 * package, exotic host), tool calls keep the generic rendering rather than
 * throwing.
 */

import { existsSync, realpathSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join, sep } from "node:path";
import { pathToFileURL } from "node:url";

/** The subset of a pi tool definition that `ToolExecutionComponent` needs. */
export interface ToolRenderers {
  renderCall?: unknown;
  renderResult?: unknown;
}

const RENDERERS_SUBPATH = ["dist", "core", "tools", "renderers", "index.js"];
const PACKAGE_NAME = "@earendil-works/pi-coding-agent";

/** One guess at the package's install root, paired with why it might be right. */
interface Candidate {
  reason: string;
  packageRoot: () => string | undefined;
}

/**
 * `process.argv[1]` is the script Node was actually launched with. For pi that
 * is always something under the installed package (bundled `dist/bundle/
 * cli.js` or, unbundled, `dist/cli.js`), however pi itself was installed —
 * standalone Node distribution, global npm install, or a symlinked bin like
 * `~/.local/share/pi-node/.../bin/pi`. Resolving symlinks and walking up to the
 * `dist` directory's parent finds the package root regardless of which of
 * those it is, with no assumption about directory names above `dist`.
 */
function packageRootFromArgv(): string | undefined {
  const argv1 = process.argv[1];
  if (!argv1) return undefined;
  try {
    const real = realpathSync(argv1);
    const marker = `${sep}dist${sep}`;
    const idx = real.lastIndexOf(marker);
    if (idx === -1) return undefined;
    return real.slice(0, idx);
  } catch {
    return undefined;
  }
}

/**
 * pi's standalone Node distribution installs the package at a fixed offset
 * from the `node` binary itself: `<node-root>/lib/node_modules/@earendil-
 * works/pi-coding-agent`. This is the layout this extension's host normally
 * uses, and the one under which the old alias-based import silently broke.
 */
function packageRootFromExecPath(): string | undefined {
  try {
    const nodeRoot = dirname(dirname(process.execPath));
    return join(nodeRoot, "lib", "node_modules", "@earendil-works", "pi-coding-agent");
  } catch {
    return undefined;
  }
}

/**
 * A plain node_modules install (npm/pnpm) makes the package resolvable by
 * name from this file's own location — this is the fallback for hosts where
 * neither of the above heuristics applies (e.g. running the extension's own
 * test suite, or a dev checkout where pi is a workspace dependency).
 */
function packageRootFromRequireResolve(): string | undefined {
  try {
    const req = createRequire(import.meta.url);
    const entry = req.resolve(PACKAGE_NAME); // resolves the "." export only
    // entry is ".../pi-coding-agent/dist/index.js" (or an equivalent bundle
    // entry); walk up to the package root the same way, from a known-good
    // absolute path instead of a specifier.
    const marker = `${sep}dist${sep}`;
    const idx = entry.lastIndexOf(marker);
    if (idx === -1) return undefined;
    return entry.slice(0, idx);
  } catch {
    return undefined;
  }
}

const CANDIDATES: Candidate[] = [
  { reason: "argv[1] (the running pi script)", packageRoot: packageRootFromArgv },
  { reason: "process.execPath (pi's standalone Node distribution layout)", packageRoot: packageRootFromExecPath },
  { reason: "require.resolve of the package's public entry", packageRoot: packageRootFromRequireResolve },
];

type Lookup = (name: string) => ToolRenderers | undefined;

let lookup: Lookup | undefined;
let attempted = false;
/** Test/diagnostic seam: which strategy worked, if any. */
let lastResolution: { reason: string; path: string } | undefined;

function renderersFileUrl(): { url: string; reason: string } | undefined {
  for (const candidate of CANDIDATES) {
    const root = candidate.packageRoot();
    if (!root) continue;
    const file = join(root, ...RENDERERS_SUBPATH);
    if (existsSync(file)) return { url: pathToFileURL(file).href, reason: candidate.reason };
  }
  return undefined;
}

/**
 * Load pi's built-in tool renderers once. Returns true when tool calls will be
 * drawn exactly like the main session's.
 */
export async function initToolRenderers(): Promise<boolean> {
  if (attempted) return lookup !== undefined;
  attempted = true;
  const found = renderersFileUrl();
  if (!found) {
    lookup = undefined;
    return false;
  }
  try {
    const mod = (await import(found.url)) as {
      withBuiltInRenderers?: (name: string, definition: undefined) => ToolRenderers | undefined;
    };
    const withBuiltInRenderers = mod.withBuiltInRenderers;
    if (typeof withBuiltInRenderers === "function") {
      lookup = (name) => withBuiltInRenderers(name, undefined);
      lastResolution = { reason: found.reason, path: found.url };
    }
  } catch {
    lookup = undefined;
  }
  return lookup !== undefined;
}

/**
 * Renderers for a tool, or undefined for tools pi has no built-in renderer for
 * (agents run with `noExtensions`, so extension tools cannot appear).
 */
export function toolRenderersFor(name: string): ToolRenderers | undefined {
  try {
    return lookup?.(name);
  } catch {
    return undefined;
  }
}

/** Test/diagnostic seam: which strategy found the renderers module, if any. */
export function toolRenderersResolution(): { reason: string; path: string } | undefined {
  return lastResolution;
}

/** Test seam: forget what was loaded. */
export function resetToolRenderers(): void {
  lookup = undefined;
  attempted = false;
  lastResolution = undefined;
}
