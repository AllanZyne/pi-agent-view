/**
 * Unit tests for `withAttachedCommandFilter` (index.ts).
 *
 * pi's own slash-command dispatch never runs while an agent is attached (see
 * `AgentViewEditor.handleInput`): every command but `/model` is instead sent
 * to the agent as a plain chat message. Without this filter, `/` completion
 * still suggested every pi built-in command as if it would work — this is
 * the mismatch these tests guard against.
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

test("SUPPORTED_ATTACHED_COMMANDS includes /model, pi's built-ins otherwise", () => {
  assert(SUPPORTED_ATTACHED_COMMANDS.has("model"), "the one command actually implemented while attached");
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

test("attached to an agent: unsupported commands are hidden from completion", async () => {
  const provider = withAttachedCommandFilter(fakeCommandProvider(["model", "resume", "fork", "new"]), viewWith("/tmp/agent.jsonl"));
  const result = await provider.getSuggestions(["/"], 0, 1, {});
  assertEqual(result.items.map((i) => i.value), ["model"], "only the command handleInput actually runs is suggested");
});

test("attached: no matching supported command means no suggestions, not an empty list pi treats as file completion", async () => {
  const provider = withAttachedCommandFilter(fakeCommandProvider(["resume", "fork"]), viewWith("/tmp/agent.jsonl"));
  const result = await provider.getSuggestions(["/"], 0, 1, {});
  assertEqual(result, null, "nothing left to suggest");
});

test("attached: argument completions for a supported command are left alone", async () => {
  // Once past the top-level "/" list, the prefix has a space in it (e.g.
  // "/model sonnet") — that's a command's own argument completions, already
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
