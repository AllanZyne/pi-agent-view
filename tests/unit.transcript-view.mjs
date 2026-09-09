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
const ourChild = (text, customType = "agent-view-item") => ({
  entry: { customType, data: {} },
  render: () => [text],
});

/** A custom entry from some other extension. */
const otherExtensionChild = (text) => ({ entry: { customType: "todo-list" }, render: () => [text] });

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

test("the filter hides pi's own children only while an agent is attached", () => {
  const chat = container([piChild("you: main question"), piChild("main answer"), ourChild("agent answer")]);
  let attached = false;

  const uninstall = tv.installChatFilter(chat, () => attached, OWNED);

  assertEqual(chat.render(80), ["you: main question", "main answer", "agent answer"], "detached: pi renders everything");

  attached = true;
  assertEqual(chat.render(80), ["agent answer"], "attached: only the agent's entries draw");
  assertEqual(chat.handleMouse({}), undefined, "hit testing is off while filtered");

  // Main session output arriving while we look at an agent must stay invisible.
  chat.children.push(piChild("main streaming delta"));
  assertEqual(chat.render(80), ["agent answer"], "main output does not leak into the agent view");

  attached = false;
  assertEqual(
    chat.render(80),
    ["you: main question", "main answer", "agent answer", "main streaming delta"],
    "detaching restores the main transcript, including what arrived meanwhile",
  );
  assertEqual(chat.handleMouse({}), "mouse", "hit testing is back");

  uninstall();
  attached = true;
  assertEqual(chat.render(80).length, 4, "uninstalled: pi's container behaves exactly as before");
  assertEqual(chat.handleMouse({}), "mouse", "mouse handler restored");
});

test("installing twice replaces the previous patch instead of nesting", () => {
  const chat = container([piChild("main"), ourChild("agent")]);
  const filtering = () => true;

  const first = tv.installChatFilter(chat, filtering, OWNED);
  const second = tv.installChatFilter(chat, filtering, OWNED);
  assertEqual(chat.render(80), ["agent"], "still filtered once");

  second();
  assertEqual(chat.render(80), ["main", "agent"], "one uninstall is enough to fully restore");
  first(); // must not resurrect the filter
  assertEqual(chat.render(80), ["main", "agent"], "stale uninstall is harmless");
});

test("another extension's entries stay with the main transcript", () => {
  const chat = container([otherExtensionChild("todo"), ourChild("agent")]);
  let attached = true;
  tv.installChatFilter(chat, () => attached, OWNED);
  assertEqual(chat.render(80), ["agent"], "only ours in the agent view");
  attached = false;
  assertEqual(chat.render(80), ["todo", "agent"], "untouched in the main view");
});
