/** Unit tests for the split agent_list / agent_inspect contracts. */

import * as fs from "node:fs";
import * as path from "node:path";
import { assert, assertEqual, load, pi, tempDir, test } from "./harness.mjs";

const { agentCreateTool } = await load("agent-create-tool.ts");
const { agentListTool } = await load("agent-list-tool.ts");
const { agentInspectTool, parseRegexQuery } = await load("agent-inspect-tool.ts");
const { agentRemoveTool } = await load("agent-control-tool.ts");
const { abortSessionWithTimeout, waitForAgentSettled, runAgentAndWait } = await load("agent-runtime.ts");
const storage = await load("storage.ts");
const { AGENT_POLICY } = await load("agent-policy.ts");

test("agent_create exposes template and not the old agent parameter", () => {
  const properties = agentCreateTool.parameters.properties ?? {};
  assert("template" in properties && !("agent" in properties), "public single-task schema exposes only template");
  const taskProperties = properties.tasks?.items?.properties ?? {};
  assert("template" in taskProperties && !("agent" in taskProperties), "public batch schema exposes only template");
  assertEqual(agentCreateTool.parameters.additionalProperties, false, "old top-level agent arguments are rejected");
  assertEqual(properties.tasks.items.additionalProperties, false, "old per-task agent arguments are rejected");
  assert(!agentCreateTool.prepareArguments, "old agent arguments are not normalized");
});

test("agent_inspect requires one agent name, has bounded modes, and has no full-history switch", () => {
  assert(agentInspectTool.parameters.required?.includes("name"), "agent_inspect requires name");
  assert(!("full" in (agentInspectTool.parameters.properties ?? {})), "agent_inspect has no full parameter");
  assert("mode" in (agentInspectTool.parameters.properties ?? {}), "agent_inspect exposes bounded modes");
  assert("wait" in (agentInspectTool.parameters.properties ?? {}), "agent_inspect exposes one-shot waiting");
  assert(Object.keys(agentListTool.parameters.properties ?? {}).length === 0, "agent_list takes no arguments");
});

test("agent_remove rejects self-removal instead of deadlocking its own tool call", async () => {
  const dir = tempDir();
  const ownFile = path.join(dir, "self.jsonl");
  fs.writeFileSync(ownFile, "");
  storage.saveManifest(dir, {
    rootId: "self-root",
    rootFile: ownFile,
    agents: [{ id: "self-id", name: "self-worker", file: ownFile, createdAt: new Date().toISOString() }],
  });
  const ctx = {
    cwd: dir,
    sessionManager: { getSessionFile: () => ownFile, getSessionId: () => "self-root" },
  };

  const result = await agentRemoveTool.execute("remove-self", { name: "self-worker" }, undefined, undefined, ctx);
  assert(result.isError, "self-removal is rejected");
  assert(result.content[0].text.includes("cannot remove itself"), "the error explains the invalid operation");
  assertEqual(storage.loadManifest(dir, "self-root").agents.length, 1, "the instance remains recorded");
});

test("graceful agent abort has a hard timeout", async () => {
  assertEqual(await abortSessionWithTimeout({ abort: async () => {} }, 10), "settled", "normal abort settles");
  const started = Date.now();
  const result = await abortSessionWithTimeout({ abort: () => new Promise(() => {}) }, 20);
  assertEqual(result, "timed-out", "an uncooperative run cannot block disposal forever");
  assert(Date.now() - started < 500, "timeout is bounded in practice");
});

test("waiting for an existing agent joins its current run without polling", async () => {
  const key = "__piAgentViewsRuntime";
  const saved = globalThis[key];
  let resolveIdle;
  const idle = new Promise((resolve) => {
    resolveIdle = resolve;
  });
  const live = {
    file: "/tmp/waiting-agent.jsonl",
    state: "working",
    session: { isStreaming: true, waitForIdle: () => idle },
  };
  globalThis[key] = {
    agents: new Map([[live.file, live]]),
    loading: false,
    stopped: new Set(),
    changeListeners: new Set(),
  };
  try {
    const waiting = waitForAgentSettled(live.file);
    live.state = "completed";
    live.session.isStreaming = false;
    resolveIdle();
    assertEqual(await waiting, "completed", "wait resolves with the final state after the run settles");
  } finally {
    if (saved === undefined) delete globalThis[key];
    else globalThis[key] = saved;
  }
});

test("waiting for an agent is cancellable without stopping that agent", async () => {
  const key = "__piAgentViewsRuntime";
  const saved = globalThis[key];
  const live = {
    file: "/tmp/cancellable-agent.jsonl",
    state: "working",
    session: { isStreaming: true, waitForIdle: () => new Promise(() => {}) },
  };
  globalThis[key] = {
    agents: new Map([[live.file, live]]),
    loading: false,
    stopped: new Set(),
    changeListeners: new Set(),
  };
  try {
    const controller = new AbortController();
    const waiting = waitForAgentSettled(live.file, controller.signal);
    controller.abort();
    let error;
    try {
      await waiting;
    } catch (err) {
      error = err;
    }
    assert(String(error).includes("cancelled"), "caller cancellation ends only the wait");
    assert(globalThis[key].agents.has(live.file), "the agent remains live");
  } finally {
    if (saved === undefined) delete globalThis[key];
    else globalThis[key] = saved;
  }
});

test("agent_create's wait:true path is cancellable without stopping the sub-agent (the bug this fixes)", async () => {
  const key = "__piAgentViewsRuntime";
  const saved = globalThis[key];
  let promptStarted;
  const started = new Promise((resolve) => {
    promptStarted = resolve;
  });
  const live = {
    file: "/tmp/create-cancellable-agent.jsonl",
    state: "idle",
    transcript: [],
    session: {
      isStreaming: false,
      prompt: (text) => {
        promptStarted(text);
        // Never resolves on its own — like a real long-running turn. This
        // stands in for the sub-agent's own in-flight LLM call, which must
        // keep running in the background even after the wait is cancelled.
        return new Promise(() => {});
      },
    },
  };
  globalThis[key] = {
    agents: new Map([[live.file, live]]),
    loading: false,
    stopped: new Set(),
    changeListeners: new Set(),
  };
  try {
    const controller = new AbortController();
    const waiting = runAgentAndWait(
      live.file,
      "do the task",
      "/tmp",
      undefined,
      undefined,
      undefined,
      undefined,
      controller.signal,
    );
    await started;
    controller.abort();
    let error;
    try {
      await waiting;
    } catch (err) {
      error = err;
    }
    assert(error !== undefined, "the wait itself rejects instead of hanging until the turn finishes");
    assert(String(error).includes("cancelled"), "the rejection explains this is a cancelled wait, not a failed turn");
    assert(globalThis[key].agents.has(live.file), "the sub-agent stays registered and kept running in the background");
  } finally {
    if (saved === undefined) delete globalThis[key];
    else globalThis[key] = saved;
  }
});

test("agent_inspect search accepts raw and slash-delimited regular expressions", () => {
  const raw = parseRegexQuery("refresh\\s+token");
  assert(raw.source === "refresh\\s+token" && raw.flags === "i", "raw patterns default to case-insensitive");
  const literal = parseRegexQuery("/refresh\\s+token/im");
  assert(literal.source === "refresh\\s+token" && literal.flags.includes("i") && literal.flags.includes("m"), "literal flags are preserved");
  let rejected = false;
  try {
    parseRegexQuery("/[unterminated/");
  } catch {
    rejected = true;
  }
  assert(rejected, "invalid regular expressions are rejected");
});

test("agent_inspect history is paged and regex search returns bounded matches", async () => {
  const dir = tempDir();
  const rootFile = path.join(dir, "root.jsonl");
  fs.writeFileSync(rootFile, "");
  const sm = pi.SessionManager.create(dir, dir);
  sm.appendMessage({ role: "user", content: [{ type: "text", text: "Check refresh token rotation" }], timestamp: 1 });
  sm.appendMessage({
    role: "assistant",
    content: [{ type: "text", text: "The refresh token is reused after rotation." }],
    api: "messages",
    provider: "test",
    model: "test-model",
    usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
    stopReason: "stop",
    timestamp: 2,
  });
  const agentFile = sm.getSessionFile();
  storage.saveManifest(dir, {
    rootId: "root-inspect",
    rootFile,
    agents: [{ id: sm.getSessionId(), name: "review-auth", file: agentFile, createdAt: new Date().toISOString() }],
  });
  const ctx = { sessionManager: { getSessionFile: () => rootFile, getSessionId: () => "root-inspect" } };

  const history = await agentInspectTool.execute("history", { name: "review-auth", mode: "history", limit: 1 }, undefined, undefined, ctx);
  assert(history.content[0].text.includes("History: 1 turn"), "history respects the requested page size");
  assert(history.content[0].text.includes("Older history available"), "history returns a cursor instead of the whole transcript");

  const search = await agentInspectTool.execute("search", { name: "review-auth", mode: "search", query: "/refresh\\s+token/i" }, undefined, undefined, ctx);
  assert(search.content[0].text.includes("match"), "regex search returns matches");
  assert(search.content[0].text.includes("refresh token"), "matching chat snippets are returned");
});

test("agent_list reports instances, templates, root slot usage, and compact agent states", async () => {
  const dir = tempDir();
  const rootFile = path.join(dir, "root.jsonl");
  const agentFile = path.join(dir, "agent.jsonl");
  fs.writeFileSync(rootFile, "");
  fs.writeFileSync(agentFile, "");
  storage.saveManifest(dir, {
    rootId: "root-list",
    rootFile,
    agents: [{ id: "agent-id", name: "review-auth", file: agentFile, createdAt: new Date().toISOString() }],
  });

  const result = await agentListTool.execute("call", {}, undefined, undefined, {
    cwd: dir,
    sessionManager: {
      getSessionFile: () => rootFile,
      getSessionId: () => "root-list",
    },
  });
  const text = result.content[0].text;
  assert(text.includes(`Existing instances: 1/${storage.MAX_AGENTS_PER_SESSION}`), "instance slot usage is included");
  assert(text.includes("Available templates"), "templates are listed separately");
  assert(text.includes("review-auth — idle"), "name and state are included");
});

test("agent_list lists templates before the root is saved", async () => {
  const dir = tempDir();
  fs.mkdirSync(path.join(dir, ".pi", "agents"), { recursive: true });
  fs.writeFileSync(path.join(dir, ".pi", "agents", "reviewer.md"), "---\nname: reviewer\ndescription: Reviews changes\nmodel: anthropic/claude-sonnet-4-5\n---\n");
  const result = await agentListTool.execute("call", {}, undefined, undefined, {
    cwd: dir,
    sessionManager: { getSessionFile: () => undefined, getSessionId: () => "unsaved" },
  });
  const text = result.content[0].text;
  assert(!result.isError, "an unsaved root can still discover templates");
  assert(text.includes("Existing instances") && text.includes("Available templates"), "both sections are present");
  assert(
    text.includes("reviewer") &&
      text.includes("Reviews changes") &&
      text.includes("project") &&
      text.includes("claude-sonnet-4-5"),
    "template details include ID, routing description, scope, and default model",
  );
});

test("agent_list omits the calling sub-agent from reusable instances", async () => {
  const dir = tempDir();
  const ownFile = path.join(dir, "self.jsonl");
  const peerFile = path.join(dir, "peer.jsonl");
  fs.writeFileSync(ownFile, "");
  fs.writeFileSync(peerFile, "");
  storage.saveManifest(dir, {
    rootId: "nested-root",
    rootFile: path.join(dir, "outer.jsonl"),
    agents: [
      { id: "self-id", name: "self-worker", file: ownFile, createdAt: new Date().toISOString() },
      { id: "peer-id", name: "peer-worker", file: peerFile, createdAt: new Date().toISOString() },
    ],
  });
  // resolveRoot recognizes an agent session only when it lives under the
  // normal __agents__ layout, so exercise the output rule with that layout.
  const nestedDir = storage.groupDir(dir, "nested-root");
  fs.mkdirSync(nestedDir, { recursive: true });
  const nestedOwn = path.join(nestedDir, "self.jsonl");
  const nestedPeer = path.join(nestedDir, "peer.jsonl");
  fs.renameSync(ownFile, nestedOwn);
  fs.renameSync(peerFile, nestedPeer);
  const manifest = storage.loadManifest(dir, "nested-root");
  manifest.agents[0].file = nestedOwn;
  manifest.agents[1].file = nestedPeer;
  storage.saveManifest(dir, manifest);

  const result = await agentListTool.execute("list-from-self", {}, undefined, undefined, {
    cwd: dir,
    sessionManager: { getSessionFile: () => nestedOwn, getSessionId: () => "self-id" },
  });
  const text = result.content[0].text;
  assert(!text.includes("- self-worker"), "the caller is not offered as a reusable peer");
  assert(text.includes("peer-worker"), "other instances remain discoverable");
  assert(text.includes("current calling instance omitted"), "the omitted root slot is explained");
});

test("delegation behavior lives in the reviewable policy file", () => {
  assert(AGENT_POLICY.includes("agent_list"), "policy directs discovery through agent_list");
  assert(AGENT_POLICY.includes("agent_remove"), "policy covers one-off cleanup");
  assert(AGENT_POLICY.includes("fast, inexpensive model"), "policy covers task-appropriate model choice");
});
