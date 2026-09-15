/**
 * Unit tests for `withAttachedCommandFilter` (index.ts).
 *
 * Attached-agent command handling is a blacklist, not a whitelist: `/model`
 * is implemented against the attached agent's own session,
 * `GLOBAL_ATTACHED_COMMANDS` (not exported \u2014 covered indirectly here through
 * the filter, which never hides them) fall through to pi's real dispatch
 * unchanged because they never touch `this.session`, and only
 * `BLOCKED_ATTACHED_COMMANDS` (pi's own session/tree commands: `/tree`,
 * `/fork`, `/resume`, `/new`, ...) are hidden from `/` completion \u2014 because
 * `AgentViewEditor.handleInput` blocks them with a notice instead of running
 * them against the wrong session. Everything else (including commands this
 * view has never heard of \u2014 extension commands, skills, prompt templates)
 * stays visible: it gets sent to the agent's own session via `prompt()`,
 * exactly like typing it on main would.
 */

import { assert, assertEqual, load, test } from "./harness.mjs";

const { withAttachedCommandFilter, SUPPORTED_ATTACHED_COMMANDS } = await load("index.ts");

/** A fake `AutocompleteProvider` returning a fixed top-level "/" command list. */
function fakeCommandProvider(names) {
  return {
    async getSuggestions() {
      return {
        items: names.map((name) => ({ value: name, label: name })),
        prefix: "/",
      };
    },
    applyCompletion: (lines, cursorLine, cursorCol) => ({ lines, cursorLine, cursorCol }),
  };
}

/** A view state with just the field the filter reads. */
function viewWith(attached) {
  return { attached };
}

test("SUPPORTED_ATTACHED_COMMANDS includes /model, the one command implemented against the attached agent's session", () => {
  assert(SUPPORTED_ATTACHED_COMMANDS.has("model"));
});

test("detached (main): every command passes through untouched", async () => {
  const provider = withAttachedCommandFilter(fakeCommandProvider(["model", "resume", "fork", "new"]), viewWith(undefined));
  const result = await provider.getSuggestions(["/"], 0, 1, {});
  assertEqual(
    result.items.map((i) => i.value),
    ["model", "resume", "fork", "new"],
    "main has no attached agent, so pi's real command list is untouched",
  );
});

test("attached to an agent: blacklisted commands (pi's own session/tree) are hidden from completion", () => {
  return (async () => {
    const provider = withAttachedCommandFilter(
      fakeCommandProvider(["model", "resume", "fork", "new", "tree", "clone", "export", "import", "share", "scoped-models", "name"]),
      viewWith("/tmp/agent.jsonl"),
    );
    const result = await provider.getSuggestions(["/"], 0, 1, {});
    assertEqual(result.items.map((i) => i.value), ["model"], "every blacklisted command is filtered out");
  })();
});

test("attached: global commands (auth, settings, quit, ...) stay visible \u2014 they run unmodified against pi's own session", async () => {
  const provider = withAttachedCommandFilter(
    fakeCommandProvider(["model", "settings", "login", "logout", "trust", "reload", "quit", "hotkeys", "changelog", "debug"]),
    viewWith("/tmp/agent.jsonl"),
  );
  const result = await provider.getSuggestions(["/"], 0, 1, {});
  assertEqual(
    result.items.map((i) => i.value),
    ["model", "settings", "login", "logout", "trust", "reload", "quit", "hotkeys", "changelog", "debug"],
    "global commands are not blacklisted",
  );
});

test("attached: unrecognised commands (extension/skill/prompt-template) stay visible \u2014 they get sent to the agent's own session", async () => {
  const provider = withAttachedCommandFilter(fakeCommandProvider(["model", "review", "commit-message"]), viewWith("/tmp/agent.jsonl"));
  const result = await provider.getSuggestions(["/"], 0, 1, {});
  assertEqual(
    result.items.map((i) => i.value),
    ["model", "review", "commit-message"],
    "only the explicit blacklist is filtered, not an allowlist",
  );
});

test("attached: no matching command means no suggestions, not an empty list pi treats as file completion", async () => {
  const provider = withAttachedCommandFilter(fakeCommandProvider(["resume", "fork"]), viewWith("/tmp/agent.jsonl"));
  const result = await provider.getSuggestions(["/"], 0, 1, {});
  assertEqual(result, null, "nothing left to suggest");
});

test("attached: argument completions for any command are left alone", async () => {
  // Once past the top-level "/" list, the prefix has a space in it (e.g.
  // "/model sonnet") \u2014 that's a command's own argument completions, already
  // scoped to a command this filter would have let through the list for.
  const provider = withAttachedCommandFilter(
    {
      async getSuggestions() {
        return { items: [{ value: "claude-sonnet", label: "claude-sonnet" }], prefix: "/model son" };
      },
      applyCompletion: (lines, cursorLine, cursorCol) => ({ lines, cursorLine, cursorCol }),
    },
    viewWith("/tmp/agent.jsonl"),
  );
  const result = await provider.getSuggestions(["/model son"], 0, 10, {});
  assertEqual(result.items.map((i) => i.value), ["claude-sonnet"], "argument completions are not command-name-filtered");
});

test("attached: @-file and other non-slash completions pass through untouched", async () => {
  const provider = withAttachedCommandFilter(
    {
      async getSuggestions() {
        return { items: [{ value: "src/index.ts", label: "index.ts" }], prefix: "@src/" };
      },
      applyCompletion: (lines, cursorLine, cursorCol) => ({ lines, cursorLine, cursorCol }),
    },
    viewWith("/tmp/agent.jsonl"),
  );
  const result = await provider.getSuggestions(["@src/"], 0, 5, {});
  assertEqual(result.items.map((i) => i.value), ["src/index.ts"], "only the top-level slash-command list is filtered");
});

test("null suggestions (no match at all) pass through as null", async () => {
  const provider = withAttachedCommandFilter(
    { async getSuggestions() { return null; }, applyCompletion: (lines, cursorLine, cursorCol) => ({ lines, cursorLine, cursorCol }) },
    viewWith("/tmp/agent.jsonl"),
  );
  assertEqual(await provider.getSuggestions(["x"], 0, 1, {}), null, "no crash on no-suggestions");
});
