/** Unit tests for agent-summary.ts (status text shared by the agent tools). */

import { assert, assertEqual, load, pi, tempDir, test } from "./harness.mjs";

const summary = await load("agent-summary.ts");

// ── lastAssistantText ──────────────────────────────────────────────

const userItem = (text) => ({ kind: "user", text });
const assistantItem = (text) => ({
  kind: "assistant",
  message: { role: "assistant", content: text ? [{ type: "text", text }] : [] },
  streaming: false,
});
const toolCallItem = (name) => ({ kind: "toolCall", id: "1", name, args: {} });

test("lastAssistantText finds the most recent assistant message, ignoring what follows on other kinds", () => {
  const items = [userItem("hi"), assistantItem("first reply"), userItem("more"), assistantItem("second reply")];
  assertEqual(summary.lastAssistantText(items), "second reply", "the latest one wins");
});

test("lastAssistantText looks past trailing tool calls with no assistant text after them", () => {
  const items = [assistantItem("here's my answer"), toolCallItem("bash")];
  assertEqual(summary.lastAssistantText(items), "here's my answer", "still finds the last assistant text");
});

test("lastAssistantText is empty when there is no assistant message yet", () => {
  assertEqual(summary.lastAssistantText([userItem("hi")]), "", "nothing to report");
  assertEqual(summary.lastAssistantText([]), "", "empty transcript");
});

test("lastAssistantText trims whitespace", () => {
  assertEqual(summary.lastAssistantText([assistantItem("  padded  ")]), "padded", "trimmed");
});

// ── describeAgentLabel ─────────────────────────────────────────────

test("describeAgentLabel is just the name with no template and no resolvable model", () => {
  const entry = { id: "1", name: "run-tests", file: "/tmp/does-not-exist.jsonl", createdAt: "" };
  assertEqual(summary.describeAgentLabel(entry), "run-tests", "no tags to show");
});

test("describeAgentLabel tags the template even with no live or on-disk model", () => {
  const entry = {
    id: "1",
    name: "run-tests",
    file: "/tmp/does-not-exist.jsonl",
    createdAt: "",
    template: "reviewer",
  };
  assertEqual(summary.describeAgentLabel(entry), "run-tests [reviewer]", "just the template tag");
});

test("describeAgentLabel accepts the legacy `def` field as the template, like storage.ts's templateId", () => {
  const entry = { id: "1", name: "run-tests", file: "/tmp/does-not-exist.jsonl", createdAt: "", def: "reviewer" };
  assertEqual(summary.describeAgentLabel(entry), "run-tests [reviewer]", "legacy manifests still tag correctly");
});

test("describeAgentLabel falls back to the on-disk model when the agent is not live", () => {
  const dir = tempDir("agent-summary-model-");
  const sm = pi.SessionManager.create(dir, dir);
  sm.appendSessionInfo("run-tests");
  sm.appendMessage({
    role: "assistant",
    content: [{ type: "text", text: "done" }],
    api: "messages",
    provider: "anthropic",
    model: "claude-haiku-4-5",
    usage: {
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 0,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    },
    stopReason: "stop",
    timestamp: 0,
  });
  const file = sm.getSessionFile();

  const entry = { id: "1", name: "run-tests", file, createdAt: "", template: "reviewer" };
  assertEqual(
    summary.describeAgentLabel(entry),
    "run-tests [reviewer · claude-haiku-4-5]",
    "template and the last-known model, read from disk since nothing is live",
  );
});

// ── isTerminalFailure ──────────────────────────────────────────────

test("isTerminalFailure is true for failed and stopped, false for everything else", () => {
  assert(summary.isTerminalFailure("failed"), "failed");
  assert(summary.isTerminalFailure("stopped"), "stopped (aborted or died mid-turn)");
  assert(!summary.isTerminalFailure("completed"), "completed");
  assert(!summary.isTerminalFailure("working"), "working");
  assert(!summary.isTerminalFailure("idle"), "idle");
});
