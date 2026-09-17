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

// ── the real include rule (index.ts) ──────────────────────────────

const { includeChatChild } = await load("index.ts");

test("the real filter rule: our entries, main's content, and notices raised inside an agent view", () => {
  const items = { "/tmp/a.jsonl": [{ kind: "user", text: "hi" }], "/tmp/b.jsonl": [{ kind: "user", text: "yo" }] };
  const read = (file) => items[file] ?? [];
  const ourA = ourChild("agent A line", "agent-view-item", "/tmp/a.jsonl");
  const ourB = ourChild("agent B line", "agent-view-item", "/tmp/b.jsonl");
  const mainLine = piChild("main line");
  const noticeInA = piChild("Warning: /copy isn't available…");
  const view = { attached: undefined, piChildOwner: new WeakMap([[noticeInA, "/tmp/a.jsonl"]]) };
  const include = (child) => includeChatChild(view, child, read);

  view.attached = undefined;
  assert(include(mainLine), "detached: main's own content draws");
  assert(!include(ourA), "detached: no agent entries draw");
  assert(!include(ourB), "detached: no agent entries draw");
  assert(
    !include(noticeInA),
    "detached: a notice raised inside an agent view does NOT reappear in main's transcript",
  );

  view.attached = "/tmp/a.jsonl";
  assert(!include(mainLine), "attached: main's content is hidden");
  assert(include(ourA), "attached: that agent's entries draw");
  assert(!include(ourB), "attached: another agent's entries stay hidden");
  assert(include(noticeInA), "attached: its own notices are visible — this is the whole point");

  view.attached = "/tmp/b.jsonl";
  assert(!include(noticeInA), "a notice belongs to one view only");
});

test("an entry whose item has nothing to draw yet is skipped whole, not left as a blank line", () => {
  // Every item is mirrored as soon as it exists so that order is preserved, so an
  // assistant reply is in the chat before its first token. pi's CustomEntry
  // wrapper always prepends a Spacer(1), so such an entry has to be skipped as a
  // child — otherwise it shows up as an unexplained blank line, and there is one
  // per empty item.
  const items = [{ kind: "assistant", message: { role: "assistant", content: [] }, streaming: true }];
  const read = () => items;
  const child = ourChild("(nothing yet)", "agent-view-item", "/tmp/a.jsonl");
  const view = { attached: "/tmp/a.jsonl" };

  assert(!includeChatChild(view, child, read), "empty streaming reply: skipped");

  items[0].message.content = [{ type: "text", text: "here we go" }];
  assert(includeChatChild(view, child, read), "same entry draws as soon as it has content");

  // A ref that points past the end (its item never made it to disk) draws nothing
  // instead of throwing.
  const dangling = { entry: { customType: "agent-view-item", data: { file: "/tmp/a.jsonl", index: 99 } }, render: () => ["x"] };
  assert(!includeChatChild(view, dangling, read), "a dangling ref is skipped, not rendered");
});
