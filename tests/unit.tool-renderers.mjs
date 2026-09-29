/**
 * Unit tests for tool-renderers.ts.
 *
 * These assert the renderers module is reached by resolving the package's
 * real install directory and importing an absolute file URL — not by a bare
 * deep-import specifier, which throws under pi's standalone Node distribution
 * (see the header comment in tool-renderers.ts). Without the renderers, an
 * agent's tool calls degrade to a bold tool name plus raw JSON args, which is
 * exactly the "commands look different" bug.
 */

import { assert, assertEqual, load, test } from "./harness.mjs";

const tr = await load("tool-renderers.ts");

test("pi's built-in tool renderers load", async () => {
  tr.resetToolRenderers();
  assertEqual(await tr.initToolRenderers(), true, "the renderers module was found");
  assertEqual(await tr.initToolRenderers(), true, "loading is cached and idempotent");
});

test("every built-in tool that pi draws specially has renderers", async () => {
  await tr.initToolRenderers();
  for (const name of ["bash", "read", "edit", "write", "ls", "grep", "find"]) {
    const renderers = tr.toolRenderersFor(name);
    assert(renderers, `${name} has renderers`);
    assert(
      typeof renderers.renderCall === "function" || typeof renderers.renderResult === "function",
      `${name} renders its call or its result`,
    );
  }
});

test("unknown tools fall back to pi's generic rendering", async () => {
  await tr.initToolRenderers();
  assertEqual(tr.toolRenderersFor("definitely-not-a-tool"), undefined, "no renderers, no crash");
});

test("registerOwnToolRenderers makes this extension's own tools render like pi's built-ins", async () => {
  // Regression test: an agent view's replayed toolCall items only ever go
  // through `toolRenderersFor` (see TranscriptItemComponent in index.ts), so
  // a sub-agent nesting its own agent_create/agent_send/... call used to fall
  // back to raw JSON in that agent's view even though the exact same call
  // from `main` drew the tool's real box (main's own rendering uses the
  // registered tool definition directly, not this lookup).
  assertEqual(tr.toolRenderersFor("not-yet-registered-own-tool"), undefined, "nothing registered yet");
  tr.registerOwnToolRenderers([
    { name: "not-yet-registered-own-tool", renderCall: () => "call", renderResult: () => "result" },
  ]);
  const renderers = tr.toolRenderersFor("not-yet-registered-own-tool");
  assert(renderers, "the tool has renderers once registered");
  assertEqual(typeof renderers.renderCall, "function", "renderCall carried through");
  assertEqual(typeof renderers.renderResult, "function", "renderResult carried through");
});

test("lookups before loading are inert", async () => {
  tr.resetToolRenderers();
  assertEqual(tr.toolRenderersFor("bash"), undefined, "no renderers until initialised");
  // Renderers are process-global: restore them for the other suites.
  await tr.initToolRenderers();
});

test("renderers resolve by absolute path, not by a bare deep import", async () => {
  // Regression test for the real-world failure this file was rewritten to fix:
  // pi's standalone Node distribution loads extensions with jiti's
  // `virtualModules`, not an `alias` map, so a bare specifier like
  // "@earendil-works/pi-coding-agent/../core/tools/renderers/index.js" throws
  // ("Cannot find module") instead of resolving — every agent tool call fell
  // back to raw JSON forever, with no way to recover. The fix locates the
  // package's real install directory on disk and imports the renderers module
  // by an absolute `file://` URL, which never touches the package's `exports`
  // map. Assert that path was actually used: if this regresses to a bare
  // specifier import, `toolRenderersResolution()` has nothing to report.
  tr.resetToolRenderers();
  assertEqual(await tr.initToolRenderers(), true, "renderers still load");
  const resolution = tr.toolRenderersResolution();
  assert(resolution, "records how the renderers module was found");
  assert(resolution.path.startsWith("file://"), `resolved by absolute file URL: ${resolution.path}`);
  assert(
    resolution.path.endsWith("/dist/core/tools/renderers/index.js"),
    `resolved straight to the renderers module: ${resolution.path}`,
  );
});
