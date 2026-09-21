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

import { readTranscript } from "./agent-runtime.ts";
import type { TranscriptItem } from "./agent-runtime.ts";
import { renderable, visibleFrom } from "./view-model.ts";

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

// ── Who a chat child belongs to ─────────────────────────────────────
//
// Two more kinds of "does this child belong to the view on screen" besides
// the owned-entry rule above: our own custom entries (read side: does *this*
// entry's ref belong to the attached agent) and pi's own children raised as a
// notice while an agent was attached (write side: tag them; read side: check
// the tag). Kept together because they are the two ends of the same seam —
// `tagRaisedChildren` writes the ownership `includeChatChild` later reads.

/**
 * True when `child` should draw in the current frame — the actual rule this
 * extension installs via `installChatFilter`, combining the owned-entry rule
 * above with notice ownership (see `tagRaisedChildren`).
 *
 * Three kinds of child, three rules:
 *   - **our custom entries** — drawn only while their own agent is attached.
 *     Skipping the whole child matters: pi's `CustomEntryComponent` wrapper
 *     always prepends a `Spacer(1)`, so a merely-empty render would still leave
 *     one mystery blank line per hidden entry.
 *   - **notices we raised from inside an agent view** — pi's own children, but
 *     they belong to that agent's conversation (see `tagRaisedChildren`).
 *   - **everything else pi appends** — main's own transcript: drawn only when
 *     nothing is attached.
 */
export function includeChatChild(
  view: {
    attached?: string;
    piChildOwner?: WeakMap<object, string>;
  },
  child: unknown,
  owned: OwnedTypes,
  /** Test seam; defaults to the live agent pool. */
  read: (file: string) => TranscriptItem[] = readTranscript,
): boolean {
  if (isOwnedChild(child, owned)) {
    if (view.attached === undefined) return false;
    const ref = (child as { entry?: { data?: { file: string; index: number } } } | null)?.entry?.data;
    if (ref?.file !== view.attached) return false;
    const items = read(ref.file);
    // Compacted away: pi clears its transcript on compaction and redraws only
    // what is still in context, so entries older than the newest compaction
    // stop being drawn here too.
    if (ref.index < visibleFrom(items)) return false;
    // An item with nothing to draw *yet* (an assistant message that has not
    // streamed its first token) must be skipped as a whole child: its entry
    // exists so that later items keep their order, and pi's wrapper would
    // otherwise contribute its `Spacer(1)` as a stray blank line.
    const item = items[ref.index];
    return item !== undefined && renderable(item);
  }
  const owner = view.piChildOwner?.get(child as object);
  if (owner !== undefined) return view.attached === owner;
  return view.attached === undefined;
}

/**
 * Tag whichever of `chat`'s children `raise()` just added as belonging to
 * `owner`, so `includeChatChild` draws them only in that view.
 *
 * `ctx.ui.notify` works by appending pi's *own* children to the chat
 * container (`showStatus`/`showError`/`showWarning`), and the filter installed
 * by `installChatFilter` hides pi's children while an agent is attached. Used
 * raw, every notice raised from an agent view would therefore be invisible —
 * typing `/copy` while attached would just swallow the input with no
 * explanation, a model switch would confirm nothing — and then the whole
 * backlog would appear in main's transcript on detach. So this tags whatever
 * pi just added with the view it was raised from, and the filter draws it
 * there and nowhere else.
 */
export function tagRaisedChildren(
  chat: RenderNode,
  owner: string,
  piChildOwner: WeakMap<object, string>,
  raise: () => void,
): void {
  const children = (chat.children ?? []) as unknown[];
  const before = children.length;
  raise();
  const own = (child: unknown) => {
    if (child && typeof child === "object") piChildOwner.set(child, owner);
  };
  if (children.length > before) {
    for (let i = before; i < children.length; i++) own(children[i]);
  } else {
    // Back-to-back status messages: pi rewrites the previous status line's
    // text in place instead of appending (`showStatus`). That line now shows
    // *our* message, so it belongs to this view too.
    own(children[children.length - 1]);
    own(children[children.length - 2]);
  }
}
