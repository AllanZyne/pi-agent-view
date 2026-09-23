/**
 * Unit tests for the agent picker widget (renderPicker).
 *
 * In fullscreen mode a widget is a fixed pane in pi's dock, not part of the
 * scrolling document: pi does not clamp factory-built widgets, squeezes the
 * transcript to a single line to make room for them, and cuts whatever still
 * doesn't fit off the bottom without any indication. So the picker has to fit
 * itself.
 */

import { assert, assertEqual, load, test } from "./harness.mjs";

const { renderPicker, pickerBudget } = await load("index.ts");
const { DELETE_CONFIRM_MS } = await load("view-model.ts");

/** Theme stand-in: styling is irrelevant here, layout is not. */
const th = { fg: (_c, text) => text, bold: (text) => text };

const row = (name, state, key = name) => ({
  key,
  name,
  isRoot: false,
  isAttached: false,
  state,
  messageCount: 3,
  lastModified: new Date(0),
  model: "some-model",
  summary: "did a thing",
});

const view = (rows, extra = {}) => ({
  open: true,
  showHelp: false,
  rows,
  selected: 0,
  scroll: 0,
  key: rows[0]?.key,
  mirrored: {},
  ...extra,
});

test("the picker never draws more lines than pi's dock can give it", () => {
  const many = Array.from({ length: 60 }, (_, i) => row(`agent-${i}`, i % 2 ? "working" : "idle"));
  const lines = renderPicker(view(many), th, 100);
  assert(
    lines.length <= pickerBudget(),
    `stays within the budget: ${lines.length} lines vs budget ${pickerBudget()}`,
  );
});

test("the picker has no footer", () => {
  const lines = renderPicker(view([row("agent", "idle")]), th, 100);
  assert(!lines.some((line) => line.includes("attach") || line.includes("ctrl+x")), JSON.stringify(lines));
  assert(!lines.at(-1).includes("────"), `no closing footer rule: ${JSON.stringify(lines.at(-1))}`);
});

test("an armed deletion is shown on the target row", () => {
  const rows = [row("doomed", "idle"), row("safe", "idle")];
  const lines = renderPicker(
    view(rows, { pendingDeleteKey: "doomed", pendingDeleteUntil: Date.now() + DELETE_CONFIRM_MS }),
    th,
    100,
  );
  assert(lines.some((line) => line.includes("Ctrl+X again to delete")), JSON.stringify(lines));
  assertEqual(lines.filter((line) => line.includes("Ctrl+X again to delete")).length, 1, "only target is armed");
});

test("an armed main abort is distinguished from agent deletion", () => {
  const main = { ...row("main", "working"), isRoot: true };
  const lines = renderPicker(
    view([main], { pendingDeleteKey: main.key, pendingDeleteUntil: Date.now() + DELETE_CONFIRM_MS }),
    th,
    100,
  );
  assert(lines.some((line) => line.includes("Ctrl+X again to abort")), JSON.stringify(lines));
  assert(!lines.some((line) => line.includes("again to delete")), "main is never described as deleted");
});

test("help fits the budget too", () => {
  const lines = renderPicker(view([row("a", "idle")], { showHelp: true }), th, 100);
  assert(lines.length <= pickerBudget(), `help stays within the budget: ${lines.length}`);
});

test("a group header is drawn once, not again when the window starts mid-group", () => {
  // Six working agents, scrolled two rows in: the "Working" header belongs above
  // row 0 and already scrolled off — drawing it again above row 2 invents a
  // group boundary that does not exist.
  const rows = Array.from({ length: 6 }, (_, i) => row(`w-${i}`, "working"));
  const lines = renderPicker(view(rows, { scroll: 2, selected: 2, key: "w-2" }), th, 100);
  const headers = lines.filter((l) => l.includes("Working ("));
  assertEqual(headers.length, 0, "no header for a group whose header is scrolled off");

  const fromTop = renderPicker(view(rows), th, 100).filter((l) => l.includes("Working ("));
  assertEqual(fromTop.length, 1, "and exactly one when the group really starts here");
});

test("a group boundary inside the window still gets its header", () => {
  const rows = [row("w-0", "working"), row("i-0", "idle"), row("i-1", "idle")];
  const lines = renderPicker(view(rows), th, 100);
  assertEqual(lines.filter((l) => l.includes("Working (")).length, 1, "Working header");
  assertEqual(lines.filter((l) => l.includes("Idle (")).length, 1, "Idle header");
});

test("a row shows its full model id and no last-message summary", () => {
  const longModel = "anthropic/claude-opus-4-1-20250805-with-a-very-long-suffix";
  const withSummary = { ...row("agent", "idle"), model: longModel, summary: "did a thing worth mentioning" };
  const lines = renderPicker(view([withSummary]), th, 200);
  assert(lines.some((l) => l.includes(longModel)), `full model id is shown, not clipped: ${JSON.stringify(lines)}`);
  assert(!lines.some((l) => l.includes("did a thing")), `no last-message summary: ${JSON.stringify(lines)}`);
});

test("a row with context usage shows percent/window, like pi's own footer", () => {
  const withUsage = { ...row("agent", "idle"), contextUsage: { tokens: 12345, contextWindow: 128000, percent: 42.5 } };
  const lines = renderPicker(view([withUsage]), th, 200);
  assert(lines.some((l) => l.includes("42.5%/128k")), `context usage is shown: ${JSON.stringify(lines)}`);
});

test("unknown context usage (right after compaction) shows a question mark, not a crash", () => {
  const unknown = { ...row("agent", "idle"), contextUsage: { tokens: null, contextWindow: 128000, percent: null } };
  const lines = renderPicker(view([unknown]), th, 200);
  assert(lines.some((l) => l.includes("?%/128k")), `unknown usage renders as ?: ${JSON.stringify(lines)}`);
});
