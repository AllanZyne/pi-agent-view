/** Unit tests for view-model.ts (picker rows + transcript mirroring). */

import { assert, assertEqual, load, test } from "./harness.mjs";

const vm = await load("view-model.ts");

const userItem = (text) => ({ kind: "user", text });
const assistantItem = (text, streaming = false) => ({ kind: "assistant", text, streaming });
const toolCall = (id, name = "bash") => ({ kind: "toolCall", id, name, args: { command: "true" } });
const toolResult = (toolCallId, name = "bash") => ({
  kind: "toolResult",
  toolCallId,
  name,
  text: "ok",
  isError: false,
  content: [{ type: "text", text: "ok" }],
});

test("renderable skips tool results and empty streaming text", () => {
  assert(vm.renderable(userItem("hi")), "user text renders");
  assert(!vm.renderable(assistantItem("", true)), "empty streaming assistant does not render yet");
  assert(vm.renderable(assistantItem("partial", true)), "assistant with a first delta renders");
  assert(vm.renderable(toolCall("t1")), "tool call renders");
  assert(!vm.renderable(toolResult("t1")), "tool result is drawn inside its call");
});

test("syncMirror hands pi each new renderable item exactly once", () => {
  const items = [userItem("do it"), toolCall("t1"), toolResult("t1"), assistantItem("done")];
  const state = { attached: "A", mirrored: {} };
  const appended = [];

  const n = vm.syncMirror(state, (ref) => appended.push(ref), () => items);

  assertEqual(n, 3, "user + toolCall + assistant were appended");
  assertEqual(
    appended.map((r) => r.index),
    [0, 1, 3],
    "the tool result index is consumed but not appended",
  );
  assertEqual(vm.mirroredCount(state, "A"), 4, "all items are accounted for");

  // A second sync with no new items must be a no-op (no duplicate rendering).
  assertEqual(vm.syncMirror(state, (r) => appended.push(r), () => items), 0, "no duplicates");
  assertEqual(appended.length, 3, "nothing appended twice");
});

test("syncMirror waits for the streaming tail to produce text", () => {
  const items = [userItem("go"), assistantItem("", true)];
  const state = { attached: "A", mirrored: {} };
  const appended = [];

  assertEqual(vm.syncMirror(state, (r) => appended.push(r), () => items), 1, "only the user item so far");
  assertEqual(vm.mirroredCount(state, "A"), 1, "the empty assistant tail is not consumed");

  // First delta arrives.
  items[1].text = "wor";
  assertEqual(vm.syncMirror(state, (r) => appended.push(r), () => items), 1, "assistant appears once");
  assertEqual(
    appended.map((r) => r.index),
    [0, 1],
    "each item appended once, in order",
  );

  // Further deltas do not append: pi re-renders the same entry.
  items[1].text = "working";
  assertEqual(vm.syncMirror(state, (r) => appended.push(r), () => items), 0, "deltas do not append entries");
});

test("attachTo switches the mirrored agent without replaying it", () => {
  const state = { attached: "A", mirrored: { A: 7 } };
  vm.attachTo(state, "B");
  assertEqual(state, { attached: "B", mirrored: { A: 7 } }, "per-agent progress is kept");
  vm.attachTo(state, undefined);
  assertEqual(state.attached, undefined, "detached");
  assertEqual(vm.syncMirror(state, () => assert(false, "must not append when detached")), 0, "detached is inert");
});

test("only the attached agent is visible", () => {
  const state = { attached: "A", mirrored: {} };
  assert(vm.isVisible(state, "A"), "the attached agent draws");
  assert(!vm.isVisible(state, "B"), "another agent's entries draw nothing");
  vm.attachTo(state, undefined);
  assert(!vm.isVisible(state, "A"), "back on the main session nothing agent-ish draws");
});

test("switching between two agents never mixes or duplicates their items", () => {
  const a = [userItem("a1"), assistantItem("a2")];
  const b = [userItem("b1")];
  const read = (file) => (file === "A" ? a : b);
  const state = { attached: undefined, mirrored: {} };
  const appended = [];
  const sync = () => vm.syncMirror(state, (ref) => appended.push(`${ref.file}:${ref.index}`), read);

  vm.attachTo(state, "A");
  sync();
  // While we look at B, A keeps working: its new items must not be appended.
  vm.attachTo(state, "B");
  a.push(assistantItem("a3 while detached"));
  sync();
  assertEqual(appended, ["A:0", "A:1", "B:0"], "B did not pull in A's later output");

  // Coming back to A appends only what is new.
  vm.attachTo(state, "A");
  assertEqual(sync(), 1, "just the item produced while we were away");
  assertEqual(appended, ["A:0", "A:1", "B:0", "A:2"], "no item appended twice");
});

test("noteMirrored restores progress from a reloaded session", () => {
  const items = [userItem("u"), assistantItem("a"), userItem("u2")];
  const state = { attached: undefined, mirrored: {} };
  // Entries persisted by an earlier run: indices 0 and 1 are already in pi.
  vm.noteMirrored(state, "A", 2);
  vm.noteMirrored(state, "A", 1); // monotonic: must not move backwards
  vm.attachTo(state, "A");
  const appended = [];
  assertEqual(vm.syncMirror(state, (r) => appended.push(r.index), () => items), 1, "only the unseen item");
  assertEqual(appended, [2], "the reloaded entries are not duplicated");
});

test("buildRows puts working agents first and marks the attached one", () => {
  const rows = vm.buildRows({
    rootFile: "/tmp/root.jsonl",
    rootName: "main",
    rootBusy: false,
    agents: [
      { id: "1", name: "agent one", file: "/tmp/missing-one.jsonl", createdAt: "" },
      { id: "2", name: "agent two", file: "/tmp/missing-two.jsonl", createdAt: "" },
    ],
    attached: "/tmp/missing-two.jsonl",
  });

  assertEqual(rows.length, 3, "root plus two agents");
  assertEqual(rows[0].isRoot, true, "root is first while everything is idle");
  assertEqual(rows[0].isAttached, false, "root is not attached when an agent is");
  const two = rows.find((r) => r.key === "/tmp/missing-two.jsonl");
  assertEqual(two.isAttached, true, "the attached agent is marked");
});

test("buildRows reports pi's own session as working while it streams", () => {
  const rows = vm.buildRows({
    rootFile: "/tmp/root.jsonl",
    rootName: "main",
    rootBusy: true,
    agents: [],
  });
  assertEqual(rows[0].state, "working", "root is working");
  assertEqual(rows[0].isAttached, true, "with no agent attached, the root row is the attached one");
});

// ── Selection stability ────────────────────────────────────────────

const row = (key, state = "idle") => ({
  key,
  name: key,
  isRoot: false,
  isAttached: false,
  state,
  messageCount: 1,
  lastModified: new Date(0),
});

test("the cursor follows its agent when a state change re-sorts the list", () => {
  // What the user sees: main, then two working agents.
  let rows = [row("main"), row("a", "working"), row("b", "working")];
  let sel = vm.reconcileSelection(rows, { selected: 0, scroll: 0 }, 10);
  sel = vm.moveSelection(rows, sel, 1, 10); // cursor on "a"
  sel = vm.moveSelection(rows, sel, 1, 10); // cursor on "b"
  assertEqual(sel.key, "b", "the cursor is on b");
  assertEqual(sel.selected, 2, "which is row 2 right now");

  // "a" finishes: rows are rebuilt and re-sorted, so b moves up.
  rows = [row("b", "working"), row("main"), row("a", "completed")];
  sel = vm.reconcileSelection(rows, sel, 10);
  assertEqual(sel.key, "b", "still the same agent");
  assertEqual(sel.selected, 0, "index followed it to the top");
  assertEqual(vm.selectedRow(rows, sel).key, "b", "acting on the selection hits the agent the user saw");
});

test("selectedRow prefers the key over a stale index", () => {
  const rows = [row("b"), row("main"), row("a")];
  // Index captured before a re-sort: it now points at a different agent.
  assertEqual(vm.selectedRow(rows, { selected: 2, scroll: 0, key: "b" }).key, "b", "key wins");
  assertEqual(vm.selectedRow(rows, { selected: 1, scroll: 0, key: undefined }).key, "main", "index is the fallback");
});

test("a removed agent leaves the cursor in place instead of jumping", () => {
  const rows = [row("main"), row("b")];
  const sel = vm.reconcileSelection(rows, { selected: 1, scroll: 0, key: "gone" }, 10);
  assertEqual(sel.selected, 1, "kept its position in the list");
  assertEqual(sel.key, "b", "re-anchored to whatever is there now");

  const empty = vm.reconcileSelection([], { selected: 3, scroll: 2, key: "gone" }, 10);
  assertEqual(empty, { selected: 0, scroll: 0, key: undefined }, "no rows, no selection");
});

test("scrolling keeps the selection inside the viewport", () => {
  const rows = Array.from({ length: 10 }, (_, i) => row(`r${i}`));
  assertEqual(vm.clampScroll(0, 4, 3, 10), 0, "scrolled back up to the cursor");
  assertEqual(vm.clampScroll(5, 0, 3, 10), 3, "scrolled down to reveal the cursor");
  assertEqual(vm.clampScroll(2, 9, 3, 10), 2, "never scrolls past the end");

  let sel = { selected: 0, scroll: 0, key: "r0" };
  for (let i = 0; i < 9; i++) sel = vm.moveSelection(rows, sel, 1, 3);
  assertEqual(sel.key, "r9", "walked to the last row");
  assert(sel.selected >= sel.scroll && sel.selected < sel.scroll + 3, "last row is visible");
  sel = vm.moveSelection(rows, sel, 1, 3);
  assertEqual(sel.selected, 9, "cannot move past the end");
});
