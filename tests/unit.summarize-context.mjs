/**
 * Unit tests for agent-runtime.ts's `summarizeContext` — the excerpt of the
 * conversation a freshly-spawned `@<slug>` agent gets prepended to its task
 * so it isn't dropped into work with zero background.
 */

import { assert, assertEqual, load, test } from "./harness.mjs";

const runtime = await load("agent-runtime.ts");

function assistant(text) {
  return { kind: "assistant", streaming: false, message: { role: "assistant", content: [{ type: "text", text }] } };
}
function user(text) {
  return { kind: "user", text };
}

test("summarizeContext: empty transcript yields empty string", () => {
  assertEqual(runtime.summarizeContext([]), "");
});

test("summarizeContext: only tool activity yields empty string", () => {
  const items = [
    { kind: "toolCall", id: "1", name: "read", args: {} },
    { kind: "toolResult", toolCallId: "1", name: "read", text: "contents", isError: false, content: [] },
  ];
  assertEqual(runtime.summarizeContext(items), "");
});

test("summarizeContext: keeps user/assistant turns in chronological order", () => {
  const items = [user("hi"), assistant("hello"), user("do X")];
  const out = runtime.summarizeContext(items);
  assertEqual(out, "User: hi\n\nAssistant: hello\n\nUser: do X");
});

test("summarizeContext: skips tool noise between turns", () => {
  const items = [
    user("hi"),
    { kind: "toolCall", id: "1", name: "read", args: {} },
    { kind: "toolResult", toolCallId: "1", name: "read", text: "x", isError: false, content: [] },
    assistant("done"),
  ];
  assertEqual(runtime.summarizeContext(items), "User: hi\n\nAssistant: done");
});

test("summarizeContext: caps to the most recent turns", () => {
  const items = [];
  for (let i = 0; i < 20; i++) {
    items.push(user(`u${i}`));
    items.push(assistant(`a${i}`));
  }
  const out = runtime.summarizeContext(items);
  const lines = out.split("\n\n");
  assert(lines.length <= 6, `expected at most 6 turns, got ${lines.length}`);
  assert(out.includes("a19"), "keeps the freshest turn");
  assert(!out.includes("u0"), "drops the oldest turns once the cap is hit");
});

test("summarizeContext: truncates a single very long turn", () => {
  const long = "x".repeat(5000);
  const out = runtime.summarizeContext([user(long)]);
  assert(out.length < 5000, "long turn text is truncated");
  assert(out.endsWith("\u2026"), "truncated turn ends with an ellipsis marker");
});
