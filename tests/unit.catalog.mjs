/**
 * Unit tests for agent-catalog.ts (frontmatter parsing + discovery).
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { assert, assertEqual, load, tempDir, test } from "./harness.mjs";

const catalog = await load("agent-catalog.ts");

// ── parseDefContent (no filesystem) ────────────────────────────────

test("parseDefContent: full valid def yields all fields", () => {
  const text = [
    "---",
    "name: code-reviewer",
    "description: Reviews diffs for correctness",
    "model: anthropic/claude-sonnet-4-5",
    "thinkingLevel: medium",
    "---",
    "",
    "You are a strict reviewer.",
  ].join("\n");
  const r = catalog.parseDefContent(text, "/tmp/x.md", "project");
  assert("def" in r, `expected def, got ${JSON.stringify(r)}`);
  assertEqual(r.def.name, "code-reviewer");
  assertEqual(r.def.description, "Reviews diffs for correctness");
  assertEqual(r.def.model, "anthropic/claude-sonnet-4-5");
  assertEqual(r.def.thinkingLevel, "medium");
  assertEqual(r.def.scope, "project");
  assertEqual(r.def.appendSystemPrompt, "You are a strict reviewer.");
});

test("parseDefContent: empty body → no appendSystemPrompt (undefined, not empty string)", () => {
  const text = "---\nname: bare\ndescription: hi\n---\n";
  const r = catalog.parseDefContent(text, "/tmp/x.md", "user");
  assert("def" in r, "parses");
  assertEqual(r.def.appendSystemPrompt, undefined, "no body → no appendSystemPrompt at all");
});

test("parseDefContent: missing name is skipped silently (no diagnostic-worthy error)", () => {
  const r = catalog.parseDefContent("---\ndescription: hi\n---\n", "/tmp/x.md", "user");
  assert("error" in r && r.error === "no name", `expected no-name skip: ${JSON.stringify(r)}`);
});

test("parseDefContent: missing description is skipped", () => {
  const r = catalog.parseDefContent("---\nname: x\n---\n", "/tmp/x.md", "user");
  assert("error" in r && r.error === "no description");
});

test("parseDefContent: reserved name 'agent' is rejected", () => {
  const r = catalog.parseDefContent("---\nname: agent\ndescription: x\n---\n", "/tmp/x.md", "user");
  assert("error" in r && /reserved/.test(r.error), `expected reserved-name error: ${JSON.stringify(r)}`);
});

test("parseDefContent: bad slug is rejected", () => {
  for (const bad of ["Foo", "-leading", "with_underscore", "with space", "1digitfirst"]) {
    const r = catalog.parseDefContent(`---\nname: ${bad}\ndescription: x\n---\n`, "/tmp/x.md", "user");
    assert("error" in r, `expected error for ${bad}: ${JSON.stringify(r)}`);
  }
});

test("parseDefContent: bad model / thinkingLevel are rejected", () => {
  const badModel = catalog.parseDefContent(
    "---\nname: x\ndescription: y\nmodel: not-a-model-id\n---\n",
    "/tmp/x.md",
    "user",
  );
  assert("error" in badModel, "invalid model rejected");

  const badThinking = catalog.parseDefContent(
    "---\nname: x\ndescription: y\nthinkingLevel: extreme\n---\n",
    "/tmp/x.md",
    "user",
  );
  assert("error" in badThinking, "invalid thinkingLevel rejected");
});

test("parseDefContent: model: inherit is accepted and normalises to undefined", () => {
  const r = catalog.parseDefContent(
    "---\nname: x\ndescription: y\nmodel: inherit\n---\n",
    "/tmp/x.md",
    "user",
  );
  assert("def" in r, "parses");
  assertEqual(r.def.model, undefined, "'inherit' is normalised to undefined at the def level");
});

test("parseDefContent: unparseable frontmatter is reported, not thrown", () => {
  const r = catalog.parseDefContent("---\nname: [unterminated\n---\n", "/tmp/x.md", "user");
  assert("error" in r, "bad YAML is a diagnostic, not a crash");
});

// ── loadCatalog (filesystem) ───────────────────────────────────────

function writeDef(dir, filename, body) {
  const full = path.join(dir, filename);
  fs.mkdirSync(path.dirname(full), { recursive: true });
  fs.writeFileSync(full, body);
  return full;
}

test("loadCatalog: reads project scope and yields SubAgentDef", () => {
  const cwd = tempDir();
  writeDef(
    path.join(cwd, ".pi", "agents"),
    "reviewer.md",
    "---\nname: reviewer\ndescription: strict\n---\nsystem prompt body\n",
  );
  // agentRoots also looks at ~/.pi/agents; the test tmp home isolates that in the next test.
  const c = catalog.loadCatalog(cwd);
  const def = c.agents.get("reviewer");
  assert(def, `expected 'reviewer' to be loaded: ${JSON.stringify([...c.agents.keys()])}`);
  assertEqual(def.scope, "project");
  assertEqual(def.appendSystemPrompt, "system prompt body");
});

test("loadCatalog: project scope wins over user scope on name collision", () => {
  const cwd = tempDir();
  // Fake home directory so the user scope is deterministic in the test.
  const fakeHome = tempDir();
  const savedHome = process.env.HOME;
  process.env.HOME = fakeHome;
  try {
    writeDef(
      path.join(cwd, ".pi", "agents"),
      "shared.md",
      "---\nname: shared\ndescription: project version\n---\nproject body\n",
    );
    writeDef(
      path.join(fakeHome, ".pi", "agents"),
      "shared.md",
      "---\nname: shared\ndescription: user version\n---\nuser body\n",
    );
    const c = catalog.loadCatalog(cwd);
    const def = c.agents.get("shared");
    assertEqual(def.scope, "project", "project scope wins");
    assertEqual(def.appendSystemPrompt, "project body", "project body kept");
  } finally {
    if (savedHome === undefined) delete process.env.HOME;
    else process.env.HOME = savedHome;
  }
});

test("loadCatalog: subdirectories are walked; identity is `name`, not path", () => {
  const cwd = tempDir();
  writeDef(
    path.join(cwd, ".pi", "agents", "review"),
    "security.md",
    "---\nname: security-review\ndescription: hunt security bugs\n---\nbody\n",
  );
  const c = catalog.loadCatalog(cwd);
  assert(c.agents.get("security-review"), "nested file discovered");
});

test("loadCatalog: bad files become diagnostics, not exceptions", () => {
  const cwd = tempDir();
  writeDef(
    path.join(cwd, ".pi", "agents"),
    "bad.md",
    "---\nname: agent\ndescription: attempts to shadow the reserved name\n---\n",
  );
  writeDef(
    path.join(cwd, ".pi", "agents"),
    "ok.md",
    "---\nname: ok\ndescription: fine\n---\n",
  );
  const c = catalog.loadCatalog(cwd);
  assert(c.agents.get("ok"), "the good file still loads");
  assert(c.diagnostics.some((d) => /reserved/.test(d.error)), `diagnostics: ${JSON.stringify(c.diagnostics)}`);
});

test("loadCatalog: missing directories are simply empty (no crash)", () => {
  const cwd = tempDir(); // no .pi/agents inside
  const savedHome = process.env.HOME;
  process.env.HOME = tempDir(); // no ~/.pi/agents inside either
  try {
    const c = catalog.loadCatalog(cwd);
    assertEqual(c.agents.size, 0, "no agents");
    assertEqual(c.diagnostics.length, 0, "no diagnostics");
  } finally {
    if (savedHome === undefined) delete process.env.HOME;
    else process.env.HOME = savedHome;
  }
});
