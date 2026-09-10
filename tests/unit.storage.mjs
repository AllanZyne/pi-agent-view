/** Unit tests for storage.ts (manifest + root resolution). */

import * as fs from "node:fs";
import * as path from "node:path";
import { assert, assertEqual, load, tempDir, test } from "./harness.mjs";

const storage = await load("storage.ts");

test("registerAgent records an agent under __agents__/<rootId>", () => {
  const dir = tempDir();
  const rootFile = path.join(dir, "root.jsonl");
  fs.writeFileSync(rootFile, "");
  const root = { rootId: "root-1", rootFile, sessionDir: dir };

  const file = storage.registerAgent(root, "first task", dir);

  assert(file.includes(path.join("__agents__", "root-1")), `agent file is grouped by root: ${file}`);
  assert(fs.existsSync(storage.manifestFile(dir, "root-1")), "manifest was written");
  // pi flushes a session file only once it holds an assistant message, so the
  // path exists in the manifest before it exists on disk.
  assert(!fs.existsSync(file), "the session file is not flushed yet");

  const manifest = storage.loadManifest(dir, "root-1");
  assertEqual(manifest.agents.length, 1, "manifest has one agent");
  assertEqual(manifest.agents[0].name, "first task", "manifest records the name");
  assertEqual(manifest.agents[0].file, file, "manifest records the file");
  assertEqual(manifest.rootFile, rootFile, "manifest records the root file");
});

test("registerAgent appends to an existing manifest", () => {
  const dir = tempDir();
  const rootFile = path.join(dir, "root.jsonl");
  fs.writeFileSync(rootFile, "");
  const root = { rootId: "root-2", rootFile, sessionDir: dir };

  storage.registerAgent(root, "a", dir);
  storage.registerAgent(root, "b", dir);

  const names = storage.loadManifest(dir, "root-2").agents.map((a) => a.name);
  assertEqual(names, ["a", "b"], "both agents are recorded in order");
});

test("registerAgent records the sub-agent def name when given one", () => {
  const dir = tempDir();
  const rootFile = path.join(dir, "root.jsonl");
  fs.writeFileSync(rootFile, "");
  const root = { rootId: "root-def", rootFile, sessionDir: dir };

  storage.registerAgent(root, "plain", dir);
  storage.registerAgent(root, "backed", dir, "code-reviewer");

  const agents = storage.loadManifest(dir, "root-def").agents;
  assertEqual(agents[0].def, undefined, "plain agent has no def field on disk");
  assertEqual(agents[1].def, "code-reviewer", "def-backed agent records its def name");
});

test("listAgentEntries returns def fields through unchanged (forward-compat)", () => {
  const dir = tempDir();
  const rootFile = path.join(dir, "root.jsonl");
  fs.writeFileSync(rootFile, "");
  const root = { rootId: "root-def2", rootFile, sessionDir: dir };

  const flushed = storage.registerAgent(root, "one", dir, "reviewer");
  fs.writeFileSync(flushed, "");

  const entries = storage.listAgentEntries(root);
  assertEqual(entries.length, 1);
  assertEqual(entries[0].def, "reviewer", "def is preserved through the read path");
});

test("resolveRoot treats a normal session file as its own root", () => {
  const dir = tempDir();
  const file = path.join(dir, "session.jsonl");
  const root = storage.resolveRoot(file, "sid-1");
  assertEqual(root, { rootId: "sid-1", rootFile: file, sessionDir: dir }, "root is the session itself");
});

test("resolveRoot recovers the root from an agent file path", () => {
  const dir = tempDir();
  const rootFile = path.join(dir, "root.jsonl");
  fs.writeFileSync(rootFile, "");
  const root = { rootId: "root-3", rootFile, sessionDir: dir };
  const agentFile = storage.registerAgent(root, "task", dir);

  // Pretend pi opened the agent file directly: the root must still resolve.
  const resolved = storage.resolveRoot(agentFile, "some-other-id");
  assertEqual(resolved.rootId, "root-3", "root id comes from the path");
  assertEqual(resolved.rootFile, rootFile, "root file comes from the manifest");
  assertEqual(resolved.sessionDir, dir, "session dir is the parent of __agents__");
});

test("resolveRoot returns null without a session file", () => {
  assertEqual(storage.resolveRoot(undefined, "sid"), null, "no file, no root");
});

test("listAgentEntries hides deleted agents but keeps live ones", () => {
  const dir = tempDir();
  const rootFile = path.join(dir, "root.jsonl");
  fs.writeFileSync(rootFile, "");
  const root = { rootId: "root-4", rootFile, sessionDir: dir };
  const flushed = storage.registerAgent(root, "flushed", dir);
  const pending = storage.registerAgent(root, "pending", dir);
  // Simulate pi having flushed only the first agent's file.
  fs.writeFileSync(flushed, "");

  assertEqual(
    storage.listAgentEntries(root).map((a) => a.file),
    [flushed],
    "without a liveness hint only on-disk agents are listed",
  );
  assertEqual(
    storage.listAgentEntries(root, (f) => f === pending).map((a) => a.file),
    [flushed, pending],
    "a live agent is listed even before its file is flushed",
  );

  fs.rmSync(flushed);
  assertEqual(
    storage.listAgentEntries(root).map((a) => a.file),
    [],
    "a deleted, non-live agent disappears",
  );
});

// ── Naming ─────────────────────────────────────────────────────────

test("agentName slugifies the first prompt to letters and hyphens", () => {
  assertEqual(storage.agentName("Run ls in the current directory"), "run-ls-in-the-current-directory");
  assertEqual(storage.agentName("Fix bug #42 in foo_bar.ts!"), "fix-bug-in-foo-bar-ts");
  assertEqual(storage.agentName("   leading and trailing   "), "leading-and-trailing");
  const name = storage.agentName("a".repeat(80));
  assert(name.length <= 40, `long words are bounded (${name.length})`);
});

test("agentName never emits spaces, underscores or digits", () => {
  for (const prompt of [
    "Add 2 tests for v3 API",
    "snake_case_and SPACES",
    "tabs\tand\nnewlines",
    "emoji 🎉 and ünïcödé",
  ]) {
    const name = storage.agentName(prompt);
    assert(/^[a-z]+(-[a-z]+)*$/.test(name), `${JSON.stringify(prompt)} -> ${JSON.stringify(name)}`);
  }
});

test("agentName falls back to a name when the prompt has no latin letters", () => {
  assertEqual(storage.agentName("给我跑一下测试"), "agent");
  assertEqual(storage.agentName("!!! ???"), "agent");
});

test("agentName keeps names unique with letter suffixes, never numbers", () => {
  const taken = [];
  for (let i = 0; i < 4; i++) taken.push(storage.agentName("run tests", taken));
  assertEqual(taken, ["run-tests", "run-tests-b", "run-tests-c", "run-tests-d"], "collisions get letters");
  for (const name of taken) assert(/^[a-z-]+$/.test(name), `${name} is still a slug`);
});

test("agentName never shadows the root session's name", () => {
  assertEqual(storage.ROOT_AGENT_NAME, "main", "the root session is the agent called main");
  assertEqual(storage.agentName("main"), "main-b", "a prompt that slugs to main is suffixed");
  assertEqual(storage.agentName("Main!"), "main-b", "case does not matter");
  assertEqual(storage.agentName("main thing"), "main-thing", "only an exact collision is renamed");
});
