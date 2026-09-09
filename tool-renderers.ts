/**
 * tool-renderers.ts — pi's built-in tool renderers, for agent tool calls.
 *
 * `ToolExecutionComponent` does not know how to draw a tool: pi passes it
 * renderers, obtained from `withBuiltInRenderers(name, definition)`. Without
 * them a tool call falls back to a bold tool name plus truncated raw output,
 * which is why agent tool calls used to look nothing like the main session's
 * `bash` / `edit` / `read` boxes.
 *
 * Those renderers live in `<pi>/dist/core/tools/renderers/index.js`, which the
 * package's `exports` map does not expose. Rather than guess an install path,
 * this walks out of the alias the host already set up for the package entry:
 * pi's extension loader (and this project's test harness) alias
 * `@earendil-works/pi-coding-agent` to `<pi>/dist/index.js`, and jiti resolves
 * a subpath by appending it, so `".../pi-coding-agent/../core/tools/..."`
 * normalises to `<pi>/dist/core/tools/...`.
 *
 * Everything here is best-effort: if the module cannot be loaded (unaliased
 * host, restructured package), tool calls keep the generic rendering.
 */

/** The subset of a pi tool definition that `ToolExecutionComponent` needs. */
export interface ToolRenderers {
  renderCall?: unknown;
  renderResult?: unknown;
}

const RENDERERS_MODULE = "@earendil-works/pi-coding-agent/../core/tools/renderers/index.js";

type Lookup = (name: string) => ToolRenderers | undefined;

let lookup: Lookup | undefined;
let attempted = false;

/**
 * Load pi's built-in tool renderers once. Returns true when tool calls will be
 * drawn exactly like the main session's.
 */
export async function initToolRenderers(): Promise<boolean> {
  if (attempted) return lookup !== undefined;
  attempted = true;
  try {
    const mod = (await import(RENDERERS_MODULE)) as {
      withBuiltInRenderers?: (name: string, definition: undefined) => ToolRenderers | undefined;
    };
    const withBuiltInRenderers = mod.withBuiltInRenderers;
    if (typeof withBuiltInRenderers === "function") {
      lookup = (name) => withBuiltInRenderers(name, undefined);
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

/** Test seam: forget what was loaded. */
export function resetToolRenderers(): void {
  lookup = undefined;
  attempted = false;
}
