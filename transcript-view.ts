/**
 * transcript-view.ts — keep the two directions of the transcript separate.
 *
 * pi owns one chat container per session and appends *everything* to it: the
 * main session's own messages and the custom entries this extension mirrors
 * for an agent. Custom entries are persisted and cannot be removed, and pi
 * has no API to hide its own messages, so separation has to happen at render
 * time.
 *
 * The filter installed here is **always active** once discovered, and decides
 * per child whether to render. Two rules:
 *
 *   attached (agent view)   →  draw only owned entries whose ref belongs to
 *                              `view.attached`; skip everything else
 *   detached (main session) →  draw pi's own children; skip *all* owned
 *                              entries
 *
 * Nothing is removed or reordered \u2014 pi keeps mutating its container exactly
 * as before, we only decide which children are drawn in the current frame.
 *
 * Why per-child skipping matters (not just "return `[]` from the inner
 * renderer"): pi wraps every custom entry in a `CustomEntryComponent` that
 * unconditionally prepends `Spacer(1)` to whatever the entry renders. An
 * inner `render()` that returns `[]` still leaves that Spacer, so a hidden
 * entry would contribute one blank line to whatever transcript is on screen.
 * With N hidden entries in the current chat, that's N unexplained blank lines.
 * Skipping the *whole child* at the container level is the only way to
 * eliminate them.
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
 * Draw only the children `include(child)` returns `true` for.
 *
 * Returns an uninstall function. Installing twice on the same container is
 * safe: the previous patch is removed first (extensions reload per session).
 *
 * The filter re-implements pi's `Container.render` \u2014 concatenating child
 * renders \u2014 but skips excluded children *entirely* (not calling `.render`),
 * so wrapper components like `CustomEntryComponent` cannot leak their own
 * padding lines for a hidden entry. `mouseLayout` is still populated with
 * height=0 for excluded children so pi's hit testing stays coherent.
 */
export function installChatFilter(
  container: RenderNode,
  include: (child: unknown) => boolean,
): () => void {
  const target = container as Patched;
  target[PATCH]?.();

  const originalRender = container.render.bind(container);
  const originalMouse = container.handleMouse?.bind(container);

  container.render = (width: number): string[] => {
    const lines: string[] = [];
    const mouseChildren: Array<{ component: unknown; height: number }> = [];
    for (const child of container.children ?? []) {
      if (!include(child)) {
        mouseChildren.push({ component: child, height: 0 });
        continue;
      }
      const childLines = (child as RenderNode).render(width);
      mouseChildren.push({ component: child, height: childLines.length });
      for (const line of childLines) lines.push(line);
    }
    // Preserve pi's mouse-layout tracking so hit testing (via the original
    // handleMouse) still resolves the right component under the cursor.
    (container as unknown as { mouseLayout: unknown }).mouseLayout = {
      width,
      children: mouseChildren,
    };
    return lines;
  };

  // Original mouse handling stays: children we hid render at height 0, so hit
  // tests never resolve onto them.
  if (originalMouse) {
    container.handleMouse = (event: unknown) => originalMouse(event);
  }

  const uninstall = () => {
    container.render = originalRender;
    if (originalMouse) container.handleMouse = originalMouse;
    delete target[PATCH];
  };
  target[PATCH] = uninstall;
  return uninstall;
}
