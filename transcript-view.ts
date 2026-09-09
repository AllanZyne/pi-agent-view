/**
 * transcript-view.ts — keep the two directions of the transcript separate.
 *
 * pi owns one chat container per session and appends *everything* to it: the
 * main session's own messages and the custom entries this extension mirrors for
 * an agent. Custom entries are persisted and cannot be removed, and pi has no
 * API to hide its own messages, so separation has to happen at render time:
 *
 *   detached (main session)  →  agent entries render nothing
 *                               (see `isVisible()` in view-model.ts)
 *   attached (agent view)    →  pi's own chat children render nothing,
 *                               only this extension's entries draw
 *
 * The second half is what this module does: it finds pi's chat container
 * through the TUI tree and installs a render filter on it. Nothing is removed
 * or reordered — pi keeps mutating its container exactly as before, we only
 * decide which children are drawn in the current frame. Detaching restores the
 * full main transcript untouched.
 *
 * Headless on purpose: `render`/`children` duck typing only, so it is unit
 * testable with plain objects.
 */

/** Minimal shape of a pi-tui Container, as far as this module cares. */
export interface RenderNode {
  render(width: number): string[];
  children?: unknown[];
  handleMouse?: (event: unknown) => unknown;
}

/** Custom entry types this extension owns. Anything else belongs to pi. */
export type OwnedTypes = ReadonlySet<string>;

/**
 * True when `child` is a pi `CustomEntryComponent` wrapping one of our entries.
 *
 * pi wraps a custom entry in a component that keeps the entry on `.entry`, so
 * duck typing is enough and survives pi internals changing shape.
 */
export function isOwnedChild(child: unknown, owned: OwnedTypes): boolean {
  const entry = (child as { entry?: { customType?: unknown } } | null)?.entry;
  return typeof entry?.customType === "string" && owned.has(entry.customType);
}

/**
 * Find pi's chat container: the node whose children include one of our custom
 * entries. Returns undefined until at least one entry has been appended.
 */
export function findChatContainer(root: RenderNode | undefined, owned: OwnedTypes): RenderNode | undefined {
  if (!root) return undefined;
  const queue: RenderNode[] = [root];
  const seen = new Set<unknown>();

  while (queue.length > 0) {
    const node = queue.shift()!;
    if (seen.has(node)) continue;
    seen.add(node);

    const children = Array.isArray(node.children) ? node.children : [];
    if (children.some((child) => isOwnedChild(child, owned))) return node;

    for (const child of children) {
      const candidate = child as RenderNode;
      if (candidate && typeof candidate.render === "function" && Array.isArray(candidate.children)) {
        queue.push(candidate);
      }
    }
  }
  return undefined;
}

/** Marker so a reloaded extension replaces its own patch instead of nesting. */
const PATCH = Symbol.for("piAgentViews.chatFilter");

type Patched = RenderNode & { [PATCH]?: () => void };

/**
 * Draw only this extension's entries while `filtering()` is true.
 *
 * Returns an uninstall function. Installing twice on the same container is
 * safe: the previous patch is removed first (extensions reload per session).
 */
export function installChatFilter(
  container: RenderNode,
  filtering: () => boolean,
  owned: OwnedTypes,
): () => void {
  const target = container as Patched;
  target[PATCH]?.();

  const originalRender = container.render.bind(container);
  const originalMouse = container.handleMouse?.bind(container);

  container.render = (width: number): string[] => {
    if (!filtering()) return originalRender(width);
    const lines: string[] = [];
    for (const child of container.children ?? []) {
      if (!isOwnedChild(child, owned)) continue;
      for (const line of (child as RenderNode).render(width)) lines.push(line);
    }
    return lines;
  };

  // Hit testing assumes every child is drawn, which is no longer true while
  // filtering; agent views are read-only anyway.
  if (originalMouse) {
    container.handleMouse = (event: unknown) => (filtering() ? undefined : originalMouse(event));
  }

  const uninstall = () => {
    container.render = originalRender;
    if (originalMouse) container.handleMouse = originalMouse;
    delete target[PATCH];
  };
  target[PATCH] = uninstall;
  return uninstall;
}
