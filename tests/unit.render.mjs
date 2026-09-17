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
const { visibleWidth } = await import(`${(await import("./harness.mjs")).PI_DIR}/node_modules/@earendil-works/pi-tui/dist/index.js`);

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

/**
 * A finished tool call, in the shape the runtime produces: the call item owns
 * its whole lifecycle (args complete, execution started, result), exactly like
 * pi's own `ToolExecutionComponent` is driven.
 */
const toolCall = (id, name, args, options = {}) => ({
  kind: "toolCall",
  id,
  name,
  args,
  argsComplete: options.argsComplete ?? true,
  executionStarted: options.executionStarted ?? true,
  revision: options.revision ?? 1,
  ...(options.result === undefined ? {} : { result: options.result }),
});

/** A final (non-partial) text result. */
const textResult = (text, isError = false) => ({
  content: [{ type: "text", text }],
  isError,
  isPartial: false,
});

/**
 * pi hands the entry renderer its live `Theme` instance; the package does not
 * export the singleton, so stub the methods this renderer uses itself. pi's own
 * components colour themselves from the theme `initTheme()` set up in the
 * harness, so their output is still the real thing.
 */
const appTheme = { fg: (_color, text) => text, bold: (text) => text, bg: (_color, text) => text };

/** Render one item of a fake agent transcript. */
function renderItem(items, index, options = {}) {
  const component = new AgentItemComponent(
    { file: "/tmp/agent.jsonl", index },
    options.theme ?? appTheme,
    options.settings ?? settings,
    options.expanded ?? false,
    fakeTui,
    process.cwd(),
    () => true,
    () => items,
  );
  return component.render(WIDTH);
}

test("a user message renders like pi's UserMessageComponent (padding preserved, no extra leading blank)", () => {
  const items = [{ kind: "user", text: "**hello** agent" }];
  const expected = new pi.UserMessageComponent("**hello** agent", settings.markdownTheme, settings.outputPad).render(
    WIDTH,
  );
  // pi's `CustomEntryComponent` (the wrapper around every custom entry pi
  // holds) already prepends `Spacer(1)` to whatever we return — that Spacer
  // is what plays pi native's "Spacer(1) before user" role in chatContainer.
  // Our render must NOT emit its own leading blank, or the two would stack
  // and every user message would grow an extra blank line.
  assertEqual(renderItem(items, 0), expected, "raw component output, no leading blank added by us");
});

test("user renders identically whether or not there is preceding content — CustomEntry's Spacer handles the gap", () => {
  const items = [
    { kind: "assistant", message: assistantMessage([{ type: "text", text: "done" }]), streaming: false },
    { kind: "user", text: "and now this" },
  ];
  const alone = renderItem([items[1]], 0);
  const after = renderItem(items, 1);
  assertEqual(after, alone, "our AgentItemComponent output is position-independent (pi's wrapper adds the separator)");
});

test("an assistant message renders pi's output MINUS its leading Spacer (which CustomEntry provides)", () => {
  const message = assistantMessage([
    { type: "thinking", thinking: "let me think" },
    { type: "text", text: "the answer is `42`" },
  ]);
  const piNative = new pi.AssistantMessageComponent(
    message,
    settings.hideThinkingBlock,
    settings.markdownTheme,
    undefined,
    settings.outputPad,
  ).render(WIDTH);

  const actual = renderItem([{ kind: "assistant", message, streaming: false }], 0);

  // `AssistantMessageComponent.updateContent` unconditionally adds a leading
  // `Spacer(1)` (`contentContainer.addChild(new Spacer(1))` when the message
  // has visible content), and then its own `render` wraps the first line in
  // an OSC133 shell-integration prefix (`\x1b]133;A\x07`) — so the first line
  // has visibleWidth 0 but is not the empty string. CustomEntry adds another
  // Spacer above the whole thing, so one leading zero-width line is dropped —
  // but its OSC133 marker is carried onto the next line, because fullscreen's
  // prompt navigation (`Ctrl+↑`/`Ctrl+↓`) finds turns by looking for it.
  const OSC133 = "\x1b]133;A\x07";
  assert(visibleWidth(piNative[0]) === 0, `pi's native render starts with a zero-width line: ${JSON.stringify(piNative.slice(0, 2))}`);
  assert(piNative[0].includes(OSC133), "pi puts its prompt-zone marker on that line");
  assertEqual(actual.length, piNative.length - 1, "one fewer leading blank");
  assert(actual[0].startsWith(piNative[0]), `the marker moves onto the first content line: ${JSON.stringify(actual[0])}`);
  assertEqual(
    [actual[0].slice(piNative[0].length), ...actual.slice(1)],
    piNative.slice(1),
    "and the content itself is byte-identical to the main session's",
  );
  assert(
    actual.join("\n").includes("42"),
    `the answer is rendered: ${JSON.stringify(actual)}`,
  );
});

test("a tool call renders with pi's built-in renderers, not a bare name", async () => {
  await toolRenderers.initToolRenderers();
  const output = "total 0\nfoo\nbar";
  const items = [toolCall("t1", "bash", { command: "ls -la" }, { result: textResult(output) })];

  // Driven exactly like pi's interactive mode drives its own box, in pi's order:
  // create + expand state (message_update), args complete (message_end),
  // execution started (tool_execution_start), result (tool_execution_end).
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
    component.setExpanded(false);
    component.updateArgs({ command: "ls -la" });
    component.setArgsComplete();
    component.markExecutionStarted();
    component.updateResult({ content: [{ type: "text", text: output }], details: undefined, isError: false }, false);
    return component.render(WIDTH);
  })();

  const actual = renderItem(items, 0);
  // ToolExecutionComponent also unconditionally prepends `Spacer(1)` to
  // itself (see `tool-execution.js`), same double-Spacer problem as
  // AssistantMessageComponent — we drop one and let CustomEntry's Spacer
  // fill that role.
  assert(expected[0] === "", `pi's native tool render starts with a Spacer: ${JSON.stringify(expected.slice(0, 2))}`);
  assertEqual(actual, expected.slice(1), "same box as the main session's bash call, minus the leading Spacer");
  assert(actual.join("\n").includes("ls -la"), `the command itself is shown: ${JSON.stringify(actual)}`);
});

test("tool output follows pi's expand state", async () => {
  await toolRenderers.initToolRenderers();
  const long = Array.from({ length: 400 }, (_, i) => `line ${i}`).join("\n");
  const items = [toolCall("t1", "bash", { command: "seq 400" }, { result: textResult(long) })];

  const collapsed = renderItem(items, 0, { expanded: false });
  const expanded = renderItem(items, 0, { expanded: true });
  assert(expanded.length > collapsed.length, `ctrl+o expands agent tool output (${collapsed.length} → ${expanded.length})`);
});

test("without pi's renderers a command is not even shown — the bug this fixes", async () => {
  const items = [toolCall("t1", "bash", { command: "ls -la" }, { result: textResult("foo") })];

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

test("a tool call built before renderers loaded upgrades once they arrive", async () => {
  // initToolRenderers() is awaited asynchronously from session_start, while
  // the first render pass can happen synchronously right after — the exact
  // race that used to leave every tool call in an agent view stuck showing
  // raw JSON args forever, because `ToolExecutionComponent` only takes
  // renderers in its constructor.
  const items = [toolCall("t1", "bash", { command: "ls -la" }, { result: textResult("foo") })];

  toolRenderers.resetToolRenderers();
  const component = new AgentItemComponent(
    { file: "/tmp/agent.jsonl", index: 0 },
    appTheme,
    settings,
    false,
    fakeTui,
    process.cwd(),
    () => true,
    () => items,
  );

  const beforeLoad = component.render(WIDTH).join("\n");
  assert(beforeLoad.includes('"command"'), `renders raw args before load: ${JSON.stringify(beforeLoad)}`);

  await toolRenderers.initToolRenderers();
  const afterLoad = component.render(WIDTH).join("\n");
  assert(
    afterLoad.includes("$ ls -la"),
    `the same component upgrades to pi's shell rendering once renderers load: ${JSON.stringify(afterLoad)}`,
  );
});

test("a settled tool box is handed its state once, not rebuilt on every frame", async () => {
  // Every one of pi's tool-box setters (`updateArgs`, `setArgsComplete`,
  // `markExecutionStarted`, `updateResult`) runs `updateDisplay()`, which clears
  // the box and re-invokes the tool's renderers, discarding the line caches pi's
  // Text/Markdown components keep. Applying them per frame made every frame
  // re-wrap and re-highlight every tool box in an attached agent's view; in
  // fullscreen (a full document render per keystroke and per scroll tick) that
  // is exactly the lag that made an agent view feel slow while `main` did not.
  // Frames after the first must not touch the box at all.
  await toolRenderers.initToolRenderers();
  const long = Array.from({ length: 60 }, (_, i) => `line ${i}`).join("\n");
  const items = [toolCall("t1", "bash", { command: "seq 60" }, { result: textResult(long) })];

  const spied = ["updateArgs", "setArgsComplete", "markExecutionStarted", "updateResult"];
  const originals = {};
  let calls = 0;
  for (const name of spied) {
    originals[name] = pi.ToolExecutionComponent.prototype[name];
    pi.ToolExecutionComponent.prototype[name] = function (...args) {
      calls++;
      return originals[name].apply(this, args);
    };
  }
  try {
    const component = new AgentItemComponent(
      { file: "/tmp/agent.jsonl", index: 0 },
      appTheme,
      settings,
      false,
      fakeTui,
      process.cwd(),
      () => true,
      () => items,
    );
    const first = component.render(WIDTH);
    const afterFirstFrame = calls;
    for (let i = 0; i < 5; i++) component.render(WIDTH);
    assertEqual(calls, afterFirstFrame, "five more frames touch the box zero times");
    assert(afterFirstFrame > 0, "the first frame did apply the call's state");
    // Collapsed `bash` output shows the tail of the output plus an
    // "N earlier lines" hint, exactly like the main session's.
    assert(first.join("\n").includes("line 59"), "and the output is still drawn");
    assertEqual(component.render(WIDTH), first, "repeat frames are byte-identical");
  } finally {
    for (const name of spied) pi.ToolExecutionComponent.prototype[name] = originals[name];
  }
});

test("live tool output and the final result both land, like the main session's", async () => {
  // pi shows a tool box as soon as the call appears, streams partial output into
  // it (`isPartial`), and replaces it with the finished result. The runtime bumps
  // `revision` on each of those transitions; the view has to follow them.
  await toolRenderers.initToolRenderers();
  const call = toolCall("t1", "bash", { command: "echo hi" }, { argsComplete: false, executionStarted: false });
  const items = [call];
  const component = new AgentItemComponent(
    { file: "/tmp/agent.jsonl", index: 0 },
    appTheme,
    settings,
    false,
    fakeTui,
    process.cwd(),
    () => true,
    () => items,
  );

  const pending = component.render(WIDTH).join("\n");
  assert(pending.includes("echo hi"), `the call is drawn while it is still running: ${JSON.stringify(pending)}`);
  assert(!pending.includes("hi there"), "with no result yet");

  // Streaming output (tool_execution_update).
  call.executionStarted = true;
  call.result = { content: [{ type: "text", text: "hi the" }], isError: false, isPartial: true };
  call.revision++;
  assert(component.render(WIDTH).join("\n").includes("hi the"), "partial output shows up live");

  // Final result (tool_execution_end).
  call.result = textResult("hi there");
  call.revision++;
  const done = component.render(WIDTH).join("\n");
  assert(done.includes("hi there"), `the final result replaces it: ${JSON.stringify(done)}`);
});

test("an aborted turn's pending tool call shows pi's error result, not a stuck pending box", async () => {
  // pi writes a synthetic error result into every still-pending call when a turn
  // is aborted (interactive-mode's message_end). Without it the box sits in its
  // pending colours forever and an aborted agent looks like a running one.
  await toolRenderers.initToolRenderers();
  const items = [toolCall("t1", "bash", { command: "sleep 100" }, { result: textResult("Operation aborted", true) })];
  const out = renderItem(items, 0).join("\n");
  assert(out.includes("Operation aborted"), `the abort reason is shown: ${JSON.stringify(out)}`);
});

test("a tool box rebuilt when renderers arrive replays the call's whole state", async () => {
  // State is applied per component instance, and the box is rebuilt from scratch
  // when pi's renderers finish loading — the rebuilt box must not come up empty.
  const items = [toolCall("t1", "bash", { command: "echo hi" }, { result: textResult("hi there") })];

  toolRenderers.resetToolRenderers();
  const component = new AgentItemComponent(
    { file: "/tmp/agent.jsonl", index: 0 },
    appTheme,
    settings,
    false,
    fakeTui,
    process.cwd(),
    () => true,
    () => items,
  );
  component.render(WIDTH);
  await toolRenderers.initToolRenderers();
  const afterLoad = component.render(WIDTH).join("\n");
  assert(afterLoad.includes("$ echo hi"), "upgraded to pi's shell rendering");
  assert(afterLoad.includes("hi there"), `and kept its result: ${JSON.stringify(afterLoad)}`);
});

test("nothing is drawn for an agent that is not attached", () => {
  const items = [{ kind: "user", text: "hidden" }];
  const component = new AgentItemComponent(
    { file: "/tmp/agent.jsonl", index: 0 },
    appTheme,
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

test("pi's markdown transformers are used, so a mermaid block renders as a diagram", async () => {
  // pi always hands its message components `createMermaidMarkdownTransformer`.
  // Passing an empty list (the old behaviour) left an agent's ```mermaid block
  // as raw source while the identical reply on `main` drew a diagram.
  assertEqual(await toolRenderers.initMarkdownTransformers(), true, "pi's mermaid module loads");
  const create = toolRenderers.mermaidTransformerFactory();
  assert(create, "the factory is available");

  const mermaid = "```mermaid\ngraph TD;\n  A-->B;\n```";
  const withTransformers = {
    ...settings,
    markdownTransformers: [create({ getMode: () => "always", theme: pi.theme })],
  };

  const items = [{ kind: "user", text: mermaid }];
  const raw = renderItem(items, 0).join("\n");
  const drawn = renderItem(items, 0, { settings: withTransformers }).join("\n");

  assert(raw.includes("graph TD"), `without transformers the source is shown: ${JSON.stringify(raw)}`);
  assert(!drawn.includes("graph TD"), "with pi's transformer the source is replaced");
  assert(/[│┌└─▼]/.test(drawn), `and a diagram is drawn instead: ${JSON.stringify(drawn)}`);
});

test("a click on a tool box reaches pi's expand region, like it does on main", async () => {
  await toolRenderers.initToolRenderers();
  const long = Array.from({ length: 60 }, (_, i) => `line ${i}`).join("\n");
  const items = [toolCall("t1", "bash", { command: "seq 60" }, { result: textResult(long) })];
  const component = new AgentItemComponent(
    { file: "/tmp/agent.jsonl", index: 0 },
    appTheme,
    settings,
    false,
    fakeTui,
    process.cwd(),
    () => true,
    () => items,
  );
  const lines = component.render(WIDTH);

  // pi's own box has one leading line that this renderer strips (CustomEntry
  // provides that gap), so a click at row N here is row N+1 inside the box.
  let handled = false;
  for (let y = 0; y < lines.length; y++) {
    const result = component.handleMouse({ type: "click", button: "left", x: 4, y, width: WIDTH, height: lines.length });
    if (result?.handled) handled = true;
  }
  assert(handled, "some row of the box accepts the click (pi's MouseRegion)");
});

test("a skill invocation renders pi's [skill] block, not its raw wire format", () => {
  // Steering an attached agent with `/skill:foo` sends the same `<skill ...>`
  // block pi's own session gets. pi renders it as a collapsible `[skill]` block
  // plus the user's own message; drawing it as plain user text (the old
  // behaviour) dumped the whole skill file into the transcript.
  const text = '<skill name="code-review" location="/tmp/SKILL.md">\nDo a review.\n</skill>\n\nplease review my diff';
  const block = pi.parseSkillBlock(text);
  assert(block, "pi parses the block");

  const collapsed = renderItem([{ kind: "user", text }], 0).join("\n");
  assert(collapsed.includes("[skill]"), `pi's skill label is used: ${JSON.stringify(collapsed)}`);
  assert(collapsed.includes("code-review"), "the skill name is shown");
  assert(!collapsed.includes("Do a review."), "the body stays collapsed, like main");
  assert(collapsed.includes("please review my diff"), "and the user's own message is drawn after it");

  const expanded = renderItem([{ kind: "user", text }], 0, { expanded: true }).join("\n");
  assert(expanded.includes("Do a review."), "ctrl+o expands the block, like main");
});

test("a compaction the agent's own session did renders pi's [compaction] block", () => {
  // Sub-agent sessions are created with pi's own SettingsManager, so they
  // auto-compact on threshold/overflow exactly like main. pi marks that with a
  // collapsible `[compaction]` block plus a token/cost notice; an agent view
  // showed nothing at all, so the transcript silently disagreed with the
  // context the agent was actually working from.
  const item = {
    kind: "compaction",
    summary: "We refactored the parser and fixed two tests.",
    tokensBefore: 42_000,
    timestamp: Date.now(),
    usageTokens: 12_345,
    usageCost: 0.0234,
  };

  const collapsed = renderItem([item], 0).join("\n");
  assert(collapsed.includes("[compaction]"), `pi's compaction label: ${JSON.stringify(collapsed)}`);
  assert(collapsed.includes("42,000"), "tokens before compaction are shown, like pi");
  assert(!collapsed.includes("refactored the parser"), "the summary stays collapsed, like main");
  assert(collapsed.includes("Compaction: 12k tokens billed (~$0.02)"), `pi's cost notice: ${JSON.stringify(collapsed)}`);

  const expanded = renderItem([item], 0, { expanded: true }).join("\n");
  assert(expanded.includes("refactored the parser"), "ctrl+o expands the summary, like main");

  const quiet = renderItem([item], 0, { settings: { ...settings, showCostNotices: false } }).join("\n");
  assert(!quiet.includes("tokens billed"), "and the notice honours pi's showCacheMissNotices setting");
});

test("an error item renders like pi's own error line", () => {
  // Never covered before, because the harness had no app theme to hand this
  // renderer — the `error` path throws without one.
  const out = renderItem([{ kind: "error", text: "Operation aborted" }], 0);
  assertEqual(out.length, 1, "one line");
  assert(out[0].includes("Operation aborted"), `the message is drawn: ${JSON.stringify(out)}`);
  assert(out[0].startsWith(" ".repeat(settings.outputPad)), "padded like pi's own error text");
});
