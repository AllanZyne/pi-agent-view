/**
 * Unit tests for agent-runtime.ts's session-event wiring (`attachEvents`):
 * how a sub-agent's state and transcript follow pi's own events.
 */

import { assert, assertEqual, load, test } from "./harness.mjs";

const runtime = await load("agent-runtime.ts");

/** A session stub that only lets the test emit events. */
function fakeAgent() {
  let listener = () => {};
  const session = {
    retryAttempt: 0,
    subscribe(cb) {
      listener = cb;
      return () => {};
    },
  };
  const agent = { file: "/tmp/fake-agent.jsonl", session, state: "working", transcript: [], unsubscribe: () => {} };
  runtime.attachEvents(agent);
  return { agent, emit: (event) => listener(event) };
}

const assistant = (extra = {}) => ({ role: "assistant", content: [{ type: "text", text: "hi" }], stopReason: "stop", ...extra });

test("agent_end alone is not a verdict; agent_settled is", () => {
  const { agent, emit } = fakeAgent();
  emit({ type: "message_end", message: assistant() });
  emit({ type: "agent_end", messages: [], willRetry: false });
  assertEqual(agent.state, "working", "pi may still retry or run queued work after agent_end");
  emit({ type: "agent_settled", aborted: false });
  assertEqual(agent.state, "completed");
});

test("an error that pi retried successfully leaves no Failed mark", () => {
  const { agent, emit } = fakeAgent();
  emit({ type: "message_end", message: assistant({ stopReason: "error", errorMessage: "server_busy" }) });
  emit({ type: "agent_end", messages: [], willRetry: true });
  emit({ type: "message_end", message: assistant() });
  emit({ type: "agent_settled", aborted: false });
  assertEqual(agent.state, "completed");
  assertEqual(agent.error, undefined);
});

test("a run whose last response errored is Failed, with that error", () => {
  const { agent, emit } = fakeAgent();
  emit({ type: "message_end", message: assistant({ stopReason: "error", errorMessage: "boom\ndetails" }) });
  emit({ type: "agent_settled", aborted: false });
  assertEqual(agent.state, "failed");
  assertEqual(agent.error, "boom\ndetails");
});

test("an aborted run is Stopped, not Failed (agent_settled.aborted)", () => {
  const { agent, emit } = fakeAgent();
  emit({ type: "message_end", message: assistant({ stopReason: "aborted" }) });
  emit({ type: "agent_settled", aborted: true });
  assertEqual(agent.state, "stopped");
  assertEqual(agent.error, undefined);
});

test("a failed recovery compaction fails the run", () => {
  const { agent, emit } = fakeAgent();
  emit({ type: "message_end", message: assistant() });
  emit({ type: "compaction_end", reason: "overflow", aborted: false, willRetry: false, errorMessage: "compaction failed" });
  emit({ type: "agent_settled", aborted: false });
  assertEqual(agent.state, "failed");
});

test("tool_execution_end's durationMs reaches the tool box", () => {
  const { agent, emit } = fakeAgent();
  emit({ type: "tool_execution_start", toolCallId: "c1", toolName: "bash", args: { command: "ls" } });
  emit({ type: "tool_execution_end", toolCallId: "c1", toolName: "bash", result: { content: [] }, isError: false, durationMs: 1234 });
  const call = agent.transcript.find((i) => i.kind === "toolCall");
  assertEqual(call?.result?.durationMs, 1234);
});

test("nested tool calls (parentToolCallId) get no box of their own, like on main", () => {
  const { agent, emit } = fakeAgent();
  emit({ type: "tool_execution_start", toolCallId: "parent", toolName: "codemode", args: {} });
  emit({ type: "tool_execution_start", toolCallId: "child", toolName: "read", args: {}, parentToolCallId: "parent" });
  emit({ type: "tool_execution_end", toolCallId: "child", toolName: "read", result: { content: [] }, isError: false, parentToolCallId: "parent" });
  const calls = agent.transcript.filter((i) => i.kind === "toolCall");
  assertEqual(calls.map((c) => c.id), ["parent"]);
  assert(!calls[0].result, "the child's result is not attached to anything");
});
