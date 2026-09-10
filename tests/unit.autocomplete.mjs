/**
 * Unit tests for autocomplete.ts (wrapWithAgentMentions).
 *
 * pi's `@` normally opens a file picker. pi-agent-view repurposes it as an
 * agent picker: typing `@` lists `agent` (adhoc) plus every discovered def,
 * suppresses pi's file listing, and completes with `@<name> ` at the cursor.
 */

import { assert, assertEqual, load, test } from "./harness.mjs";

const { wrapWithAgentMentions, replaceAtToken } = await load("autocomplete.ts");

function fakeCatalog(names) {
  const agents = new Map();
  for (const name of names) {
    agents.set(name, { name, description: `about ${name}`, source: "/tmp/x.md", scope: "project" });
  }
  return { agents, diagnostics: [] };
}

/** Build the `MentionScan` shape `wrapWithAgentMentions` now consumes. */
function fakeScan(defNames, liveAgents = []) {
  return { catalog: fakeCatalog(defNames), liveAgents };
}

/** A base provider that returns a fixed slash-command list, so we can prove pass-through works. */
function slashBase() {
  return {
    triggerCharacters: ["/", "@"],
    async getSuggestions(lines, cursorLine, cursorCol) {
      const line = lines[cursorLine] ?? "";
      if (line.slice(0, cursorCol).startsWith("/")) {
        return { items: [{ value: "model", label: "model" }], prefix: "/" };
      }
      return null;
    },
    applyCompletion(lines, cursorLine, cursorCol) {
      return { lines, cursorLine, cursorCol };
    },
    shouldTriggerFileCompletion() {
      return true; // pi's base returns true for any `@` — we're proving we suppress that.
    },
  };
}

test("wrap: typing '@' returns adhoc first, then catalog defs alphabetically", async () => {
  const provider = wrapWithAgentMentions(slashBase(), () => fakeScan(["reviewer", "debugger"]));
  const result = await provider.getSuggestions(["@"], 0, 1, { signal: new AbortController().signal });
  assertEqual(result.prefix, "@", "prefix is the token so far");
  assertEqual(
    result.items.map((i) => i.value),
    ["agent", "debugger", "reviewer"],
    "adhoc first, catalog sorted alphabetically",
  );
});

test("wrap: live agents appear between adhoc and catalog defs, most-recent order preserved", async () => {
  const live = [
    { file: "/a/pearl.jsonl", name: "pearl", def: "reviewer" },
    { file: "/a/coral.jsonl", name: "coral" },
  ];
  const provider = wrapWithAgentMentions(slashBase(), () => fakeScan(["debugger"], live));
  const result = await provider.getSuggestions(["@"], 0, 1, { signal: new AbortController().signal });
  assertEqual(
    result.items.map((i) => i.value),
    ["agent", "pearl", "coral", "debugger"],
    "order: adhoc, then live (caller order kept), then catalog defs",
  );
  const pearl = result.items.find((i) => i.value === "pearl");
  assert(pearl.description.includes("reviewer"), "a live agent's description mentions its def");
});

test("wrap: a live agent shadows a same-named catalog def (rule 2 beats rule 4)", async () => {
  const live = [{ file: "/a/reviewer.jsonl", name: "reviewer", def: "reviewer" }];
  const provider = wrapWithAgentMentions(slashBase(), () => fakeScan(["reviewer", "debugger"], live));
  const result = await provider.getSuggestions(["@"], 0, 1, { signal: new AbortController().signal });
  assertEqual(
    result.items.map((i) => i.value),
    ["agent", "reviewer", "debugger"],
    "the live 'reviewer' is listed once (as live), the catalog entry is suppressed",
  );
  const reviewer = result.items.find((i) => i.value === "reviewer");
  assert(reviewer.description.startsWith("live"), "the surviving entry is the live one, not the catalog def");
});

test("wrap: fragment '@re' fuzzy-filters the list", async () => {
  const provider = wrapWithAgentMentions(slashBase(), () => fakeScan(["reviewer", "debugger"]));
  const result = await provider.getSuggestions(["@re"], 0, 3, { signal: new AbortController().signal });
  assertEqual(
    result.items.map((i) => i.value),
    ["reviewer"],
    "'re' matches only 'reviewer' (not 'agent' or 'debugger')",
  );
  assertEqual(result.prefix, "@re", "prefix keeps the fragment for replaceAtToken");
});

test("wrap: mid-sentence '@' does NOT trigger the agent picker — delegates to base", async () => {
  // Since the mention rule tightened to message-start only, a mid-message
  // `@` is prose or a file reference. `atTokenAtCursor` returns null there,
  // so the wrapper delegates and pi's file picker takes over.
  const provider = wrapWithAgentMentions(slashBase(), () => fakeScan(["reviewer"]));
  const line = "hey @re";
  const result = await provider.getSuggestions([line], 0, line.length, { signal: new AbortController().signal });
  assertEqual(result, null, "mid-message @ delegates to base (which returns null for non-slash prefixes here)");
});

test("wrap: '@' inside a word (e.g. email) delegates to base (which returns null here)", async () => {
  const provider = wrapWithAgentMentions(slashBase(), () => fakeScan(["reviewer"]));
  const line = "foo@bar";
  const result = await provider.getSuggestions([line], 0, line.length, { signal: new AbortController().signal });
  assertEqual(result, null, "not in an @-token → delegated → base returned null");
});

test("wrap: '/mo' still triggers pi's slash-command completion (pass-through)", async () => {
  const provider = wrapWithAgentMentions(slashBase(), () => fakeScan(["reviewer"]));
  const result = await provider.getSuggestions(["/mo"], 0, 3, { signal: new AbortController().signal });
  assertEqual(result.items.map((i) => i.value), ["model"], "slash commands are not touched");
});

test("wrap: shouldTriggerFileCompletion — false at message-start `@`, delegates otherwise", () => {
  const provider = wrapWithAgentMentions(slashBase(), () => fakeScan([]));
  assertEqual(
    provider.shouldTriggerFileCompletion(["@co"], 0, 3),
    false,
    "message-start @-token: pi's file listing is suppressed (agent picker owns it)",
  );
  assertEqual(
    provider.shouldTriggerFileCompletion(["hey @co"], 0, 7),
    true,
    "mid-message @: delegates — pi's file picker takes over",
  );
  assertEqual(
    provider.shouldTriggerFileCompletion(["src/"], 0, 4),
    true,
    "outside any @-token: delegates (base returns true here)",
  );
});

test("wrap: applyCompletion replaces the @-token with '@<name> '", () => {
  const provider = wrapWithAgentMentions(slashBase(), () => fakeScan(["reviewer"]));
  const result = provider.applyCompletion(
    ["@re"],
    0,
    "@re".length,
    { value: "reviewer", label: "reviewer" },
    "@re",
  );
  assertEqual(result.lines, ["@reviewer "], "the fragment is replaced with the full slug + space");
  assertEqual(result.cursorCol, "@reviewer ".length, "cursor is at the end of the replacement");
});

test("replaceAtToken: preserves the tail after the cursor", () => {
  const result = replaceAtToken(["@re please"], 0, 3, "@re", "@reviewer ");
  assertEqual(result.lines, ["@reviewer  please"], "text after the cursor is preserved verbatim");
  assertEqual(result.cursorCol, "@reviewer ".length, "cursor lands after the space");
});
