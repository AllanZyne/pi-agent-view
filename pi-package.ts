/**
 * pi-package.ts — locate pi's own modules on disk, by absolute path.
 *
 * Some of pi's modules that this extension needs (built-in tool renderers,
 * the mermaid transformer, the llama.cpp built-in extension) are not in the
 * package's `exports` map, and pi's standalone Node distribution loads
 * extensions with jiti `virtualModules`, so a bare deep import throws. This
 * finds the package's real install directory and returns a `file://` URL,
 * which Node imports without consulting `exports`. See the header of
 * `tool-renderers.ts` for the full story.
 *
 * Stateless on purpose: modules with state (`tool-renderers.ts`) and modules
 * that only need a path (`builtin-extensions.ts`) both import it.
 */

import { existsSync, realpathSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join, sep } from "node:path";
import { pathToFileURL } from "node:url";

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

/** Locate one of pi's own modules on disk, by absolute path (see file header). */
export function piModuleUrl(subpath: string[]): { url: string; reason: string } | undefined {
  for (const candidate of CANDIDATES) {
    const root = candidate.packageRoot();
    if (!root) continue;
    const file = join(root, ...subpath);
    if (existsSync(file)) return { url: pathToFileURL(file).href, reason: candidate.reason };
  }
  return undefined;
}
