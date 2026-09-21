/** Unit tests for view-model.ts (picker rows + transcript mirroring). */

import * as fs from "node:fs";
import * as path from "node:path";
import { assert, assertEqual, load, pi, tempDir, test } from "./harness.mjs";

const vm = await load("view-model.ts");

/** A minimal assistant message, as a session file would hold it. */
const assistantEntry = (stopReason, text, extra = {}) => ({
  role: "assistant",
  content: text ? [{ type: "text", text }] : [],
  api: "messages",
  provider: "test",
  model: "test-model",
  usage: {
    input: 0,
    output: 0,
    cacheRead: 0,
    cacheWrite: 0,
    totalTokens: 0,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
  },
  stopReason,
  timestamp: 0,
  ...extra,
});

/** Write a real session file, so state detection runs against pi's own reader. */
function writeSession(dir, name, messages) {
  const sm = pi.SessionManager.create(dir, dir);
  sm.appendSessionInfo(name);
  for (const message of messages) sm.appendMessage(message);
  return sm.getSessionFile();
}

const userItem = (text) => ({ kind: "user", text });
const assistantMessage = (text, extra = {}) => ({
  role: "assistant",
  content: text ? [{ type: "text", text }] : [],
  stopReason: "stop",
  ...extra,
});
const assistantItem = (text, streaming = false) => ({
  kind: "assistant",
  message: assistantMessage(text, streaming ? { stopReason: "pending" } : {}),
  streaming,
});
const setText = (item, text) => {
  item.message.content = text ? [{ type: "text", text }] : [];
};
const thinkingItem = (thinking) => ({
  kind: "assistant",
  message: { role: "assistant", content: [{ type: "thinking", thinking }], stopReason: "stop" },
  streaming: false,
});
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
  assert(vm.renderable(thinkingItem("hmm")), "a thinking-only message renders");
  assert(
    vm.renderable({ kind: "assistant", message: { role: "assistant", content: [], stopReason: "error" }, streaming: false }),
    "an errored turn renders its notice",
  );
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

test("syncMirror mirrors an assistant reply before it has any text, and only once", () => {
  // pi adds its streaming component to the chat immediately and lets it fill in
  // place; mirroring does the same, because pi's chat is append-only and holding
  // an item back would either reorder the ones after it or lose it. An item with
  // nothing to draw yet is skipped at *render* time (see `renderable`).
  const items = [userItem("go"), assistantItem("", true)];
  const state = { attached: "A", mirrored: {} };
  const appended = [];
  const sync = () => vm.syncMirror(state, (r) => appended.push(r.index), () => items);

  assertEqual(sync(), 2, "both items are mirrored right away");
  assertEqual(vm.renderable(items[1]), false, "but the empty reply draws nothing yet");

  // First delta arrives: same entry, now with content.
  setText(items[1], "wor");
  assertEqual(sync(), 0, "no second entry for the same item");
  assertEqual(vm.renderable(items[1]), true, "it draws now");

  // Further deltas do not append: pi re-renders the same entry.
  setText(items[1], "working");
  assertEqual(sync(), 0, "deltas do not append entries");
  assertEqual(appended, [0, 1], "each item appended once, in order");
});

test("an agent's items keep their transcript order even when one fills in late", () => {
  // Steering a busy agent pushes a user message onto the transcript while the
  // assistant reply above it may still be empty. Order is what matters: pi's
  // chat is append-only, so the reply's entry must already be in place before
  // the steer's, or the two would appear swapped once the reply streams.
  const items = [userItem("go"), assistantItem("", true)];
  const state = { attached: "A", mirrored: {} };
  const appended = [];
  const sync = () => vm.syncMirror(state, (r) => appended.push(r.index), () => items);

  assertEqual(sync(), 2, "the user item and the (still empty) reply");

  // The steer lands before the reply has produced a single token.
  items.push(userItem("also check the tests"));
  assertEqual(sync(), 1, "the steer is mirrored after the reply, not before");

  // The reply finally streams.
  setText(items[1], "sure, one sec");
  assertEqual(sync(), 0, "and needs no new entry to become visible");
  assertEqual(appended, [0, 1, 2], "nothing lost, nothing duplicated, nothing reordered");
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

test("buildRows carries the template ID through from the manifest entry to the row", () => {
  vm.resetGroupOrder();
  const rows = vm.buildRows({
    rootFile: "/tmp/root.jsonl",
    rootName: "main",
    rootBusy: false,
    agents: [
      { id: "1", name: "plain-agent", file: "/tmp/plain.jsonl", createdAt: "" },
      { id: "2", name: "backed-agent", file: "/tmp/backed.jsonl", createdAt: "", template: "reviewer" },
    ],
  });

  const plain = rows.find((r) => r.key === "/tmp/plain.jsonl");
  const backed = rows.find((r) => r.key === "/tmp/backed.jsonl");
  assertEqual(plain.template, undefined, "plain agent has no template badge");
  assertEqual(backed.template, "reviewer", "template-backed agent surfaces its template ID for the badge");
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

test("buildRows keeps a group in join order across refreshes", () => {
  vm.resetGroupOrder();
  const agents = [
    { id: "1", name: "one", file: "/tmp/missing-one.jsonl", createdAt: "" },
    { id: "2", name: "two", file: "/tmp/missing-two.jsonl", createdAt: "" },
  ];
  const build = (list) =>
    vm.buildRows({ rootFile: "/tmp/root.jsonl", rootName: "main", rootBusy: false, agents: list })
      .map((r) => r.key);

  const first = build(agents);
  assertEqual(first, ["/tmp/root.jsonl", "/tmp/missing-one.jsonl", "/tmp/missing-two.jsonl"], "join order");
  assertEqual(build([...agents].reverse()), first, "order does not follow the input or mtimes");

  // A newcomer joins at the bottom of its group.
  const third = { id: "3", name: "three", file: "/tmp/missing-three.jsonl", createdAt: "" };
  assertEqual(build([agents[1], third, agents[0]]), [...first, "/tmp/missing-three.jsonl"], "appended last");
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

test("each agent's own model is what the picker reports", () => {
  const dir = tempDir();
  // Two agents that picked different models: the model is recorded in each
  // agent's own session (a model_change entry), never shared.
  const write = (name, provider, modelId) => {
    const file = path.join(dir, `${name}.jsonl`);
    fs.writeFileSync(
      file,
      [
        JSON.stringify({ type: "session", version: 3, id: name, timestamp: new Date().toISOString(), cwd: dir }),
        JSON.stringify({ type: "model_change", id: "m1", parentId: null, timestamp: new Date().toISOString(), provider, modelId }),
      ].join("\n") + "\n",
    );
    return file;
  };

  const fast = write("fast", "anthropic", "claude-haiku-4-5");
  const smart = write("smart", "anthropic", "claude-opus-4-1");

  assertEqual(vm.readAgentFile(fast).model, "claude-haiku-4-5", "the agent's own model, not the main session's");
  assertEqual(vm.readAgentFile(smart).model, "claude-opus-4-1", "models do not bleed between agents");

  const rows = vm.buildRows({
    rootFile: path.join(dir, "root.jsonl"),
    rootName: "main",
    rootBusy: false,
    agents: [
      { id: "1", name: "fast", file: fast, createdAt: "" },
      { id: "2", name: "smart", file: smart, createdAt: "" },
    ],
  });
  assertEqual(rows.find((r) => r.key === fast).model, "claude-haiku-4-5", "picker row shows it");
  assertEqual(rows.find((r) => r.key === smart).model, "claude-opus-4-1", "picker row shows it");
});

// ── States ─────────────────────────────────────────────────────────

const rt = await load("agent-runtime.ts");

test("an agent that died mid-turn is Stopped, not Completed", () => {
  const dir = tempDir("agent-view-state-");
  // What a killed agent looks like on disk: a turn that ends on a tool call
  // nothing ever answered (this is the shape of the hung agent that started it).
  const cutOff = writeSession(dir, "cut-off", [
    { role: "user", content: [{ type: "text", text: "go" }] },
    { ...assistantEntry("toolUse", ""), content: [{ type: "toolCall", id: "t1", name: "bash", arguments: {} }] },
  ]);
  assertEqual(vm.readAgentFile(cutOff).fileState, "stopped", "cut off mid tool call");

  const aborted = writeSession(dir, "aborted", [assistantEntry("aborted", "partial")]);
  assertEqual(vm.readAgentFile(aborted).fileState, "stopped", "aborted turn");

  const errored = writeSession(dir, "errored", [assistantEntry("error", "boom", { errorMessage: "boom" })]);
  assertEqual(vm.readAgentFile(errored).fileState, "failed", "a task that ended with an error still Failed");

  const done = writeSession(dir, "done", [assistantEntry("stop", "all good")]);
  assertEqual(vm.readAgentFile(done).fileState, "completed", "a task that finished successfully");
});

test("terminating an agent keeps it Stopped after its session is gone", async () => {
  const file = "/tmp/agent-view-not-live.jsonl";
  assertEqual(rt.stateOf(file), undefined, "not live, nothing recorded");
  assertEqual(await rt.terminateAgent(file), false, "nothing was running");
  assertEqual(rt.stateOf(file), "stopped", "still reported as stopped without a session");
});

test("rows are grouped Working, Failed, Stopped, Idle, Completed", () => {
  const dir = tempDir("agent-view-groups-");
  const files = {
    main: writeSession(dir, "main", [assistantEntry("stop", "main done")]),
    broken: writeSession(dir, "broken", [assistantEntry("error", "boom", { errorMessage: "boom" })]),
    killed: writeSession(dir, "killed", [assistantEntry("aborted", "half")]),
    done: writeSession(dir, "done", [assistantEntry("stop", "finished")]),
  };

  const rows = vm.buildRows({
    rootFile: files.main,
    rootName: "main",
    rootBusy: true, // the main session is streaming, so it heads the list
    agents: [
      { id: "1", name: "done", file: files.done, createdAt: "" },
      { id: "2", name: "killed", file: files.killed, createdAt: "" },
      { id: "3", name: "broken", file: files.broken, createdAt: "" },
    ],
  });

  assertEqual(
    rows.map((r) => r.state),
    ["working", "failed", "stopped", "completed"],
    "groups come in attention order",
  );
});

test("compaction hides everything the agent no longer has in context", () => {
  // pi clears its transcript on compaction and redraws only what survived. Agent
  // entries are persisted and cannot be removed, so `visibleFrom` is where the
  // visible transcript starts and the chat filter skips everything before it.
  const items = [
    userItem("do a big refactor"),
    assistantItem("working on it", false),
    { kind: "compaction", summary: "s", tokensBefore: 1000, timestamp: 0 },
    userItem("what did you change?"),
  ];
  assertEqual(vm.visibleFrom(items), 2, "the visible transcript starts at the compaction block");
  assertEqual(vm.visibleFrom(items.slice(0, 2)), 0, "no compaction: everything is visible");

  // A second compaction wins, and the memo notices the array grew.
  items.push({ kind: "compaction", summary: "s2", tokensBefore: 2000, timestamp: 1 });
  assertEqual(vm.visibleFrom(items), 4, "the newest compaction is the boundary");

  // The block itself draws (it is the summary of what was dropped).
  assertEqual(vm.renderable(items[2]), true, "the compaction block itself is drawn");
});

// ── Delete confirmation ──────────────────────────────────────────

test("armDeleteConfirm arms a target, deleteConfirmed is true until the window elapses", () => {
  const state = {};
  const now = 1_000_000;
  const deadline = vm.armDeleteConfirm(state, "doomed", now);
  assertEqual(deadline, now + vm.DELETE_CONFIRM_MS, "deadline is now + the window");
  assert(vm.deleteConfirmed(state, "doomed", now), "confirmed right after arming");
  assert(vm.deleteConfirmed(state, "doomed", deadline), "confirmed exactly at the deadline");
  assert(!vm.deleteConfirmed(state, "doomed", deadline + 1), "not confirmed once the window has passed");
});

test("deleteConfirmed only agrees for the armed key", () => {
  const state = {};
  const now = 1_000_000;
  vm.armDeleteConfirm(state, "doomed", now);
  assert(!vm.deleteConfirmed(state, "someone-else", now), "a different key was never armed");
});

test("deleteConfirmed is false before anything is armed", () => {
  assert(!vm.deleteConfirmed({}, "anything", Date.now()), "nothing armed yet");
});

test("armDeleteConfirm re-arming replaces whatever was armed before", () => {
  const state = {};
  const now = 1_000_000;
  vm.armDeleteConfirm(state, "first", now);
  vm.armDeleteConfirm(state, "second", now);
  assert(!vm.deleteConfirmed(state, "first", now), "the first target is no longer armed");
  assert(vm.deleteConfirmed(state, "second", now), "the second target is armed instead");
});

test("clearDeleteConfirm resets both fields", () => {
  const state = {};
  vm.armDeleteConfirm(state, "doomed");
  vm.clearDeleteConfirm(state);
  assertEqual(state.pendingDeleteKey, undefined, "key cleared");
  assertEqual(state.pendingDeleteUntil, undefined, "deadline cleared");
  assert(!vm.deleteConfirmed(state, "doomed"), "no longer confirmed once cleared");
});
