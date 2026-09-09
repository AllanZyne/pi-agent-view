/**
 * Unit tests for tool-renderers.ts.
 *
 * These assert the deep-import trick still reaches pi's built-in tool
 * renderers: without them an agent's tool calls degrade to a bold tool name
 * plus raw output, which is exactly the "commands look different" bug.
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

test("lookups before loading are inert", async () => {
  tr.resetToolRenderers();
  assertEqual(tr.toolRenderersFor("bash"), undefined, "no renderers until initialised");
  // Renderers are process-global: restore them for the other suites.
  await tr.initToolRenderers();
});
