/**
 * Sub-agents get pi's built-in extensions (codemode, tool search, MCP,
 * llama.cpp) like main does — see builtin-extensions.ts.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { assert, assertEqual, load, PI_DIR, tempDir, test } from "./harness.mjs";

const builtins = await load("builtin-extensions.ts");
const runtime = await load("agent-runtime.ts");
const renderers = await load("tool-renderers.ts");

test("the built-in set matches pi's own builtInExtensions (fails on a pi upgrade that changes it)", async () => {
  const { builtInExtensions } = await import(`${PI_DIR}/dist/extensions/index.js`);
  assertEqual([...builtins.BUILTIN_EXTENSION_NAMES], builtInExtensions.map((e) => e.name), "same names, same order");
  const entries = await builtins.builtinExtensionEntries();
  assertEqual(entries.map((e) => e.name), builtInExtensions.map((e) => e.name), "every one is loadable");
  for (const e of entries) {
    const theirs = builtInExtensions.find((b) => b.name === e.name);
    assert(e.builtin === true && typeof e.factory === "function", `${e.name} is a builtin entry`);
    assertEqual(Boolean(e.replaceable), Boolean(theirs.replaceable), `${e.name} replaceable like pi's`);
  }
});

test("enabledBuiltinPaths honours `-builtin:<name>` in the extensions setting", async () => {
  const dir = tempDir();
  const agentDir = path.join(dir, "agent");
  fs.mkdirSync(agentDir, { recursive: true });
  const names = [...builtins.BUILTIN_EXTENSION_NAMES];
  assertEqual(
    await builtins.enabledBuiltinPaths(dir, agentDir, names),
    names.map((n) => `builtin:${n}`),
    "all enabled by default",
  );
  fs.writeFileSync(path.join(agentDir, "settings.json"), JSON.stringify({ extensions: ["-builtin:mcp"] }));
  assertEqual(
    await builtins.enabledBuiltinPaths(dir, agentDir, names),
    names.filter((n) => n !== "mcp").map((n) => `builtin:${n}`),
    "mcp disabled",
  );
});

test("a sub-agent session loads the built-in extensions (codemode, tool_search registered)", async () => {
  const dir = tempDir();
  const file = path.join(dir, "agent.jsonl");
  const agent = await runtime.ensureAgent(file, dir);
  try {
    const paths = agent.session.extensionRunner.getExtensionPaths();
    for (const name of builtins.BUILTIN_EXTENSION_NAMES) {
      assert(paths.includes(`builtin:${name}`), `builtin:${name} loaded: ${JSON.stringify(paths)}`);
    }
    assert(agent.session.getToolDefinition("codemode"), "codemode tool is registered");
    assert(agent.session.getToolDefinition("tool_search"), "tool_search tool is registered");
    // The renderers an agent view uses for these come from the agent's own
    // session (its tool definitions / extension resolvers), like main's do;
    // the session-less lookup knows only pi's core tool renderers.
    await renderers.initToolRenderers();
    const codemode = renderers.agentToolRenderers(agent.session, "codemode");
    assert(codemode?.renderCall || codemode?.renderResult, "codemode renders with its own renderers in an agent view");
    assert(!renderers.toolRenderersFor("codemode")?.renderCall, "which the session-less lookup could not provide");
  } finally {
    await runtime.forgetAgent(file);
  }
});

test("agentToolRenderers resolves through the session like main does, with a fallback", async () => {
  await renderers.initToolRenderers();
  const mine = { renderCall: () => null };
  const session = {
    extensionRunner: { resolveToolRenderers: (name, next) => (name === "mcp__x__y" ? mine : next()) },
    getToolDefinition: () => undefined,
  };
  assertEqual(renderers.agentToolRenderers(session, "mcp__x__y"), mine, "an extension's registerToolRenderer wins");
  assert(renderers.agentToolRenderers(session, "bash")?.renderCall, "built-ins still reached through next()");
  assert(renderers.agentToolRenderers(undefined, "bash")?.renderCall, "no session: plain built-in lookup");
  const broken = { extensionRunner: { resolveToolRenderers: () => { throw new Error("x"); } } };
  assert(renderers.agentToolRenderers(broken, "bash")?.renderCall, "a throwing resolver falls back");
});

test("shutdownExtensionsWithTimeout emits session_shutdown, and never hangs", async () => {
  const seen = [];
  await runtime.shutdownExtensionsWithTimeout({
    extensionRunner: { hasHandlers: () => true, emit: async (e) => void seen.push(e.type) },
  });
  assertEqual(seen, ["session_shutdown"]);
  const started = Date.now();
  await runtime.shutdownExtensionsWithTimeout(
    { extensionRunner: { hasHandlers: () => true, emit: () => new Promise(() => {}) } },
    50,
  );
  assert(Date.now() - started < 1000, "a hung handler is cut off");
});
