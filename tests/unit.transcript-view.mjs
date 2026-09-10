/** Unit tests for transcript-view.ts (main transcript vs agent transcript). */

import { assert, assertEqual, load, test } from "./harness.mjs";

const tv = await load("transcript-view.ts");

const OWNED = new Set(["agent-view-item", "agent-view-marker"]);

/** Minimal stand-in for a pi-tui Container. */
function container(children = []) {
  const node = {
    children,
    render(width) {
      const lines = [];
      for (const child of node.children) lines.push(...child.render(width));
      return lines;
    },
    handleMouse: () => "mouse",
  };
  return node;
}

/** A pi message component: not ours, no `.entry`. */
const piChild = (text) => ({ render: () => [text] });

/** A pi CustomEntryComponent wrapping one of our entries. */
const ourChild = (text, customType = "agent-view-item", file = "/tmp/agent.jsonl") => ({
  entry: { customType, data: { file, index: 0 } },
  render: () => [text],
});

/** A custom entry from some other extension. */
const otherExtensionChild = (text) => ({ entry: { customType: "todo-list" }, render: () => [text] });

// ── isOwnedChild / findChatContainer (unchanged shape) ────────────

test("isOwnedChild only claims this extension's entries", () => {
  assert(tv.isOwnedChild(ourChild("a"), OWNED), "our item entry");
  assert(tv.isOwnedChild(ourChild("h", "agent-view-marker"), OWNED), "our header entry");
  assert(!tv.isOwnedChild(piChild("main message"), OWNED), "pi's own message");
  assert(!tv.isOwnedChild(otherExtensionChild("todo"), OWNED), "another extension's entry");
  assert(!tv.isOwnedChild(undefined, OWNED), "missing child");
});

test("findChatContainer locates the container holding our entries", () => {
  const chat = container([piChild("you: hi"), ourChild("agent line")]);
  const root = container([container([piChild("header")]), container([chat])]);
  assertEqual(tv.findChatContainer(root, OWNED), chat, "found through the tree");
  assertEqual(tv.findChatContainer(container([piChild("only pi")]), OWNED), undefined, "nothing of ours yet");
  assertEqual(tv.findChatContainer(undefined, OWNED), undefined, "no tui yet");
});

// ── installChatFilter (per-child include predicate) ──────────────

test("filter hides ALL our entries on main (detached) and pi's own content when attached", () => {
  const chat = container([
    piChild("main line 1"),
    ourChild("agent A line", "agent-view-item", "/tmp/a.jsonl"),
    piChild("main line 2"),
    ourChild("agent B line", "agent-view-item", "/tmp/b.jsonl"),
  ]);
  let attached; // undefined | file

  const include = (child) => {
    if (tv.isOwnedChild(child, OWNED)) {
      if (!attached) return false;
      return child.entry.data.file === attached;
    }
    return !attached;
  };

  tv.installChatFilter(chat, include);

  // Detached: only pi's own children draw.
  attached = undefined;
  assertEqual(chat.render(80), ["main line 1", "main line 2"], "on main: hidden agent entries do not contribute a single blank line");

  // Attached to A: only A's entries.
  attached = "/tmp/a.jsonl";
  assertEqual(chat.render(80), ["agent A line"], "only the current agent's entries draw");

  // Attached to B: only B's entries.
  attached = "/tmp/b.jsonl";
  assertEqual(chat.render(80), ["agent B line"], "switching agents changes the visible set");
});

test("filter tracks child height=0 for skipped children so mouseLayout stays coherent", () => {
  const chat = container([piChild("visible"), ourChild("hidden")]);
  tv.installChatFilter(chat, (c) => !tv.isOwnedChild(c, OWNED));
  chat.render(80);
  const layout = chat.mouseLayout;
  assert(layout, "mouseLayout was populated");
  assertEqual(layout.children.length, 2, "one entry per child, hidden ones included");
  const heights = layout.children.map((c) => c.height);
  assertEqual(heights, [1, 0], "visible child has its height, hidden child has height 0");
});

test("main-session output arriving while attached stays hidden; detaching restores it", () => {
  const chat = container([piChild("you: hi"), ourChild("agent answer", "agent-view-item", "/tmp/a.jsonl")]);
  let attached = "/tmp/a.jsonl";
  const include = (child) =>
    tv.isOwnedChild(child, OWNED) ? attached && child.entry.data.file === attached : !attached;

  tv.installChatFilter(chat, include);
  assertEqual(chat.render(80), ["agent answer"], "attached: only agent draws");

  chat.children.push(piChild("main streaming delta"));
  assertEqual(chat.render(80), ["agent answer"], "main output does not leak into the agent view");

  attached = undefined;
  assertEqual(
    chat.render(80),
    ["you: hi", "main streaming delta"],
    "detaching shows main's children, still hides the agent's",
  );
});

test("installing twice replaces the previous patch instead of nesting", () => {
  const chat = container([piChild("main"), ourChild("agent")]);
  const keepAll = () => true;
  const hideOurs = (c) => !tv.isOwnedChild(c, OWNED);

  const first = tv.installChatFilter(chat, hideOurs);
  const second = tv.installChatFilter(chat, keepAll);
  assertEqual(chat.render(80), ["main", "agent"], "the second predicate is in effect");

  second();
  assertEqual(chat.render(80), ["main", "agent"], "uninstalled: pi's container behaves exactly as before");
  first(); // stale
  assertEqual(chat.render(80), ["main", "agent"], "stale uninstall is harmless");
});

test("another extension's entries always pass through as pi content (never treated as ours)", () => {
  const chat = container([otherExtensionChild("todo"), ourChild("agent")]);
  let attached = "/tmp/agent.jsonl";
  const include = (child) =>
    tv.isOwnedChild(child, OWNED) ? attached && child.entry.data.file === attached : !attached;

  tv.installChatFilter(chat, include);
  assertEqual(chat.render(80), ["agent"], "attached: agent-view entries, no other extensions");
  attached = undefined;
  assertEqual(chat.render(80), ["todo"], "detached: the other extension is there, ours is hidden");
});
