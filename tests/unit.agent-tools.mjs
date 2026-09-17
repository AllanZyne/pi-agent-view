/** Unit tests for the split agent_list / agent_inspect contracts. */

import * as fs from "node:fs";
import * as path from "node:path";
import { assert, load, pi, tempDir, test } from "./harness.mjs";

const { agentListTool } = await load("agent-list-tool.ts");
const { agentInspectTool, parseRegexQuery } = await load("agent-inspect-tool.ts");
const storage = await load("storage.ts");
const { AGENT_POLICY } = await load("agent-policy.ts");

test("agent_inspect requires one agent name, has bounded modes, and has no full-history switch", () => {
  assert(agentInspectTool.parameters.required?.includes("name"), "agent_inspect requires name");
  assert(!("full" in (agentInspectTool.parameters.properties ?? {})), "agent_inspect has no full parameter");
  assert("mode" in (agentInspectTool.parameters.properties ?? {}), "agent_inspect exposes bounded modes");
  assert(Object.keys(agentListTool.parameters.properties ?? {}).length === 0, "agent_list takes no arguments");
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

test("agent_list reports root slot usage and compact agent states", async () => {
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
    sessionManager: {
      getSessionFile: () => rootFile,
      getSessionId: () => "root-list",
    },
  });
  const text = result.content[0].text;
  assert(text.includes(`Session agents: 1/${storage.MAX_AGENTS_PER_SESSION}`), "slot usage is included");
  assert(text.includes("review-auth — idle"), "name and state are included");
});

test("delegation behavior lives in the reviewable policy file", () => {
  assert(AGENT_POLICY.includes("agent_list"), "policy directs discovery through agent_list");
  assert(AGENT_POLICY.includes("agent_remove"), "policy covers one-off cleanup");
  assert(AGENT_POLICY.includes("fast, inexpensive model"), "policy covers task-appropriate model choice");
});
