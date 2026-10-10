/**
 * Sub-agents load what main loads — user, project and built-in extensions —
 * except agent-view itself. See `ensureAgent` and builtin-extensions.ts.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { assert, assertEqual, EXT_DIR, load, PI_DIR, tempDir, test } from "./harness.mjs";

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

const toolExtension = (tool) => `export default function (pi) {
  pi.registerTool({
    name: ${JSON.stringify(tool)},
    label: ${JSON.stringify(tool)},
    description: "test tool",
    parameters: { type: "object", properties: {} },
    execute: async () => ({ content: [{ type: "text", text: "ok" }] }),
  });
}
`;

/**
 * A scratch agent dir like the user's: agent-view installed (symlinked, like
 * a dev checkout), one other user extension, and `-builtin:mcp` in settings.
 * Plus a project with its own `.pi/extensions`.
 */
function scratch() {
  const dir = tempDir();
  const agentDir = path.join(dir, "agent");
  const extDir = path.join(agentDir, "extensions");
  fs.mkdirSync(extDir, { recursive: true });
  fs.symlinkSync(EXT_DIR, path.join(extDir, "agent-view"));
  fs.writeFileSync(path.join(extDir, "hello.ts"), toolExtension("hello_tool"));
  fs.writeFileSync(path.join(agentDir, "settings.json"), JSON.stringify({ extensions: ["-builtin:mcp"] }));
  const cwd = path.join(dir, "project");
  fs.mkdirSync(path.join(cwd, ".pi", "extensions"), { recursive: true });
  fs.writeFileSync(path.join(cwd, ".pi", "extensions", "proj.ts"), toolExtension("proj_tool"));
  return { agentDir, cwd };
}

async function withAgent(agentDir, cwd, fn) {
  const prev = process.env.PI_CODING_AGENT_DIR;
  process.env.PI_CODING_AGENT_DIR = agentDir;
  const file = path.join(cwd, `agent-${Math.random().toString(36).slice(2)}.jsonl`);
  try {
    const agent = await runtime.ensureAgent(file, cwd);
    await fn(agent);
  } finally {
    await runtime.forgetAgent(file);
    if (prev === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = prev;
  }
}

test("a sub-agent loads main's extensions and built-ins, but not agent-view itself", async () => {
  const { agentDir, cwd } = scratch();
  runtime.setProjectTrust(cwd, () => true);
  await withAgent(agentDir, cwd, async (agent) => {
    const paths = agent.session.extensionRunner.getExtensionPaths();
    assert(!paths.some((p) => runtime.isOwnExtension({ path: p })), `agent-view is not loaded: ${JSON.stringify(paths)}`);
    assert(agent.session.getToolDefinition("hello_tool"), "a user extension's tool is there");
    assert(agent.session.getToolDefinition("proj_tool"), "a trusted project's extension is there");
    for (const name of ["llama.cpp", "codemode", "tool-search"]) {
      assert(paths.includes(`builtin:${name}`), `builtin:${name} loaded: ${JSON.stringify(paths)}`);
    }
    assert(!paths.includes("builtin:mcp"), "`-builtin:mcp` in settings keeps MCP off, like on main");
    assert(agent.session.getToolDefinition("codemode"), "codemode tool is registered");

    // Tool boxes in an agent view resolve renderers through that agent's
    // session, like main does; the session-less lookup knows only pi's core
    // tool renderers.
    await renderers.initToolRenderers();
    const codemode = renderers.agentToolRenderers(agent.session, "codemode");
    assert(codemode?.renderCall || codemode?.renderResult, "codemode renders with its own renderers in an agent view");
    assert(!renderers.toolRenderersFor("codemode")?.renderCall, "which the session-less lookup could not provide");
  });
});

test("a sub-agent does not trust a project main does not trust", async () => {
  const { agentDir, cwd } = scratch();
  runtime.setProjectTrust(cwd, () => false);
  await withAgent(agentDir, cwd, async (agent) => {
    assert(agent.session.getToolDefinition("hello_tool"), "user extensions still load");
    assert(!agent.session.getToolDefinition("proj_tool"), "the untrusted project's extension does not");
  });
  runtime.setProjectTrust("/nonexistent-other-cwd", () => true);
  await withAgent(agentDir, cwd, async (agent) => {
    assert(!agent.session.getToolDefinition("proj_tool"), "main's trust only covers main's own cwd");
  });
});

test("isOwnExtension matches agent-view's files by real path, and nothing else", () => {
  assert(runtime.isOwnExtension({ path: path.join(EXT_DIR, "index.ts") }), "its index.ts");
  assert(!runtime.isOwnExtension({ path: path.join(path.dirname(EXT_DIR), "other", "index.ts") }), "a sibling extension");
  assert(!runtime.isOwnExtension({ path: "builtin:codemode" }), "a built-in");
  assert(!runtime.isOwnExtension({ path: "<inline:x>" }), "an inline factory");
});
