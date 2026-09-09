/**
 * Unit tests for transcript rendering fidelity.
 *
 * The point of this extension is that an agent's transcript is drawn by pi, so
 * these tests render an agent item and assert it is byte-identical to what pi's
 * own interactive mode produces for the same message — same components, same
 * settings, same spacing.
 */

import { assert, assertEqual, load, pi, test } from "./harness.mjs";

const { AgentItemComponent, defaultRenderSettings } = await load("index.ts");
const toolRenderers = await load("tool-renderers.ts");

const WIDTH = 80;
const settings = defaultRenderSettings();
const theme = pi.Theme ? pi.getMarkdownTheme() : undefined; // markdown theme, not the app theme

/** Minimal TUI: tool components only ever ask it to re-render. */
const fakeTui = { requestRender() {}, terminal: { columns: WIDTH, rows: 24 } };

const assistantMessage = (content, extra = {}) => ({
  role: "assistant",
  content,
  api: "messages",
  provider: "test",
  model: "test-model",
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
  ...extra,
});

/** Render one item of a fake agent transcript. */
function renderItem(items, index, options = {}) {
  const component = new AgentItemComponent(
    { file: "/tmp/agent.jsonl", index },
    pi.theme ?? {},
    options.settings ?? settings,
    options.expanded ?? false,
    fakeTui,
    process.cwd(),
    () => true,
    () => items,
  );
  return component.render(WIDTH);
}

test("a user message renders exactly like pi's", () => {
  const items = [{ kind: "user", text: "**hello** agent" }];
  const expected = new pi.UserMessageComponent("**hello** agent", settings.markdownTheme, settings.outputPad).render(
    WIDTH,
  );
  assertEqual(renderItem(items, 0), expected, "same lines as pi's own user message");
});

test("a user message after other output gets pi's separating blank line", () => {
  const items = [
    { kind: "assistant", message: assistantMessage([{ type: "text", text: "done" }]), streaming: false },
    { kind: "user", text: "and now this" },
  ];
  const alone = renderItem([items[1]], 0);
  const after = renderItem(items, 1);
  assertEqual(after, ["", ...alone], "pi adds a Spacer(1) when the chat is not empty");
});

test("an assistant message with thinking renders exactly like pi's", () => {
  const message = assistantMessage([
    { type: "thinking", thinking: "let me think" },
    { type: "text", text: "the answer is `42`" },
  ]);
  const expected = new pi.AssistantMessageComponent(
    message,
    settings.hideThinkingBlock,
    settings.markdownTheme,
    undefined,
    settings.outputPad,
  ).render(WIDTH);

  const actual = renderItem([{ kind: "assistant", message, streaming: false }], 0);
  assertEqual(actual, expected, "thinking block and markdown both come from pi");
  assert(
    actual.join("\n").includes("42"),
    `the answer is rendered: ${JSON.stringify(actual)}`,
  );
});

test("a tool call renders with pi's built-in renderers, not a bare name", async () => {
  await toolRenderers.initToolRenderers();
  const items = [
    { kind: "toolCall", id: "t1", name: "bash", args: { command: "ls -la" } },
    {
      kind: "toolResult",
      toolCallId: "t1",
      name: "bash",
      text: "total 0\nfoo\nbar",
      isError: false,
      content: [{ type: "text", text: "total 0\nfoo\nbar" }],
    },
  ];

  const expected = (() => {
    const component = new pi.ToolExecutionComponent(
      "bash",
      "t1",
      { command: "ls -la" },
      settings.tool,
      toolRenderers.toolRenderersFor("bash"),
      fakeTui,
      process.cwd(),
    );
    component.setArgsComplete();
    component.markExecutionStarted();
    component.setExpanded(false);
    component.updateResult({ content: items[1].content, details: undefined, isError: false }, false);
    return component.render(WIDTH);
  })();

  const actual = renderItem(items, 0);
  assertEqual(actual, expected, "same box as the main session's bash call");
  assert(actual.join("\n").includes("ls -la"), `the command itself is shown: ${JSON.stringify(actual)}`);
  assertEqual(renderItem(items, 1), [], "the result is drawn inside the call, never on its own");
});

test("tool output follows pi's expand state", async () => {
  await toolRenderers.initToolRenderers();
  const long = Array.from({ length: 400 }, (_, i) => `line ${i}`).join("\n");
  const items = [
    { kind: "toolCall", id: "t1", name: "bash", args: { command: "seq 400" } },
    {
      kind: "toolResult",
      toolCallId: "t1",
      name: "bash",
      text: long,
      isError: false,
      content: [{ type: "text", text: long }],
    },
  ];

  const collapsed = renderItem(items, 0, { expanded: false });
  const expanded = renderItem(items, 0, { expanded: true });
  assert(expanded.length > collapsed.length, `ctrl+o expands agent tool output (${collapsed.length} → ${expanded.length})`);
});

test("without pi's renderers a command is not even shown — the bug this fixes", async () => {
  const items = [
    { kind: "toolCall", id: "t1", name: "bash", args: { command: "ls -la" } },
    {
      kind: "toolResult",
      toolCallId: "t1",
      name: "bash",
      text: "foo",
      isError: false,
      content: [{ type: "text", text: "foo" }],
    },
  ];

  toolRenderers.resetToolRenderers();
  const bare = renderItem(items, 0).join("\n");
  await toolRenderers.initToolRenderers();
  const real = renderItem(items, 0).join("\n");

  // The fallback dumps the tool name and its raw JSON arguments; pi's shell
  // renderer shows the command the way the main session does.
  assert(bare.includes('"command"'), `the fallback dumps raw args: ${JSON.stringify(bare)}`);
  assert(!bare.includes("$ ls -la"), "the fallback has no shell rendering");
  assert(real.includes("$ ls -la"), `pi's shell rendering is used: ${JSON.stringify(real)}`);
});

test("nothing is drawn for an agent that is not attached", () => {
  const items = [{ kind: "user", text: "hidden" }];
  const component = new AgentItemComponent(
    { file: "/tmp/agent.jsonl", index: 0 },
    pi.theme ?? {},
    settings,
    false,
    fakeTui,
    process.cwd(),
    () => false,
    () => items,
  );
  assertEqual(component.render(WIDTH), [], "detached agents render no lines at all");
});

test("default render settings match pi's defaults", () => {
  assertEqual(settings.outputPad, 1, "pi's outputPad default");
  assertEqual(settings.hideThinkingBlock, false, "thinking blocks shown");
  assertEqual(settings.tool, { showImages: true, imageWidthCells: 60 }, "pi's image defaults");
  assert(theme === undefined || typeof theme === "object", "markdown theme is available");
});
