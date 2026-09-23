/**
 * Unit tests for autocomplete.ts (wrapWithAgentMentions).
 *
 * pi's `@` normally opens a file picker. pi-agent-view merges agent
 * suggestions into that same `@`, instead of one replacing the other by
 * cursor position (see the module doc in autocomplete.ts and
 * `.agents/research/codex-at-mention.md` for why: two kinds of completion
 * sharing one trigger character, disambiguated only by an inferred string
 * shape, is exactly the bug class this used to have — a file selection
 * could be misidentified as an agent selection through `applyCompletion`'s
 * `prefix.startsWith("@")` check, corrupting the line). Every item now
 * carries an explicit `kind` tag at construction time instead.
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

/**
 * A base provider standing in for pi's own file+slash completion. Its `@`
 * suggestions are deliberately a *different* shape from ours (an `id` field
 * instead of `description`, and its own `applyCompletion` that does
 * something our `replaceAtToken` would not: uppercase the value) — so a test
 * that finds this exact transform in the result proves the base's own logic
 * actually ran, not a reimplementation of it.
 */
function slashAndFileBase() {
  return {
    triggerCharacters: ["/", "@"],
    async getSuggestions(lines, cursorLine, cursorCol) {
      const line = lines[cursorLine] ?? "";
      const before = line.slice(0, cursorCol);
      if (before.startsWith("/")) {
        return { items: [{ value: "model", label: "model" }], prefix: "/" };
      }
      if (before.includes("@")) {
        const at = before.lastIndexOf("@");
        // Mimic pi's own delimiter rule enough for these tests: an `@` stuck
        // mid-word (e.g. an email-like string) is not a token for the base
        // provider either.
        const boundaryOk = at === 0 || /[\s"'=]/.test(before[at - 1] ?? "");
        if (boundaryOk) {
          const prefix = before.slice(at);
          if (prefix === "@zzz-no-match") return null; // base has nothing for this one
          return { items: [{ value: `${prefix.slice(1)}.txt`, label: `${prefix.slice(1)}.txt`, id: "file-item" }], prefix };
        }
      }
      return null;
    },
    applyCompletion(lines, cursorLine, cursorCol, item, prefix) {
      // A transform our own replaceAtToken does not do, so a test can tell
      // whether *this* ran versus our own logic. Slash-command completions
      // (prefix starts with "/") insert plainly, with no "@" at all --
      // exactly like pi's real slash-command completion does, and exactly
      // what our own replaceAtToken must never be allowed to overwrite with
      // a stray "@".
      const line = lines[cursorLine] ?? "";
      const before = line.slice(0, cursorCol);
      const cut = before.endsWith(prefix) ? before.slice(0, -prefix.length) : before;
      const replacement = prefix.startsWith("/") ? `/${item.value} ` : `@${item.value.toUpperCase()} `;
      const newLine = cut + replacement + line.slice(cursorCol);
      return { lines: [newLine], cursorLine, cursorCol: (cut + replacement).length };
    },
    shouldTriggerFileCompletion() {
      return true; // pi's base returns true for any `@` — we suppress that ourselves.
    },
  };
}

test("wrap: typing '@' returns templates as agent:<id>", async () => {
  const provider = wrapWithAgentMentions(slashAndFileBase(), () => fakeScan(["reviewer", "debugger"]));
  const result = await provider.getSuggestions(["@"], 0, 1, { signal: new AbortController().signal });
  assertEqual(result.prefix, "@", "prefix is the token so far");
  const agentValues = result.items.filter((i) => i.kind === "agent").map((i) => i.value);
  assertEqual(
    agentValues,
    ["agent:debugger", "agent:reviewer"],
    "templates are sorted alphabetically and there is no ad-hoc @agent item",
  );
});

test("wrap: live agents appear before templates, most-recent order preserved", async () => {
  const live = [
    { file: "/a/pearl.jsonl", name: "pearl", template: "reviewer" },
    { file: "/a/coral.jsonl", name: "coral" },
  ];
  const provider = wrapWithAgentMentions(slashAndFileBase(), () => fakeScan(["debugger"], live));
  const result = await provider.getSuggestions(["@"], 0, 1, { signal: new AbortController().signal });
  const agentItems = result.items.filter((i) => i.kind === "agent");
  assertEqual(
    agentItems.map((i) => i.value),
    ["pearl", "coral", "agent:debugger"],
    "order: live instances first (caller order kept), then templates",
  );
  const pearl = agentItems.find((i) => i.value === "pearl");
  assert(pearl.description.includes("reviewer"), "a live instance description mentions its template");
});

test("wrap: templates remain available even when a same-template instance is live", async () => {
  const live = [{ file: "/a/reviewer.jsonl", name: "reviewer", template: "reviewer" }];
  const provider = wrapWithAgentMentions(slashAndFileBase(), () => fakeScan(["reviewer", "debugger"], live));
  const result = await provider.getSuggestions(["@"], 0, 1, { signal: new AbortController().signal });
  const agentItems = result.items.filter((i) => i.kind === "agent");
  assertEqual(
    agentItems.map((i) => i.value),
    ["reviewer", "agent:debugger", "agent:reviewer"],
    "the live instance and reusable template are distinct, non-duplicate entries",
  );
  const reviewer = agentItems.find((i) => i.value === "agent:reviewer");
  assert(reviewer.description.startsWith("template"), "the template remains createable");
});

test("wrap: @agent: template fragments filter and complete", async () => {
  const provider = wrapWithAgentMentions(slashAndFileBase(), () => fakeScan(["reviewer", "debugger"]));
  const result = await provider.getSuggestions(["@agent:re"], 0, 9, { signal: new AbortController().signal });
  const agentItems = result.items.filter((i) => i.kind === "agent");
  assertEqual(agentItems.map((i) => i.value), ["agent:reviewer"], "template fragment selects a template");
  assertEqual(result.prefix, "@agent:re", "prefix includes the template marker");
});

test("wrap: fragment '@re' fuzzy-filters live instances", async () => {
  const provider = wrapWithAgentMentions(slashAndFileBase(), () =>
    fakeScan(["reviewer", "debugger"], [{ file: "/a/review.jsonl", name: "review" }]),
  );
  const result = await provider.getSuggestions(["@re"], 0, 3, { signal: new AbortController().signal });
  const agentItems = result.items.filter((i) => i.kind === "agent");
  assertEqual(
    agentItems.map((i) => i.value),
    ["review", "agent:reviewer"],
    "plain fragments find live instances while templates remain discoverable; @agent: narrows to templates",
  );
  assertEqual(result.prefix, "@re", "prefix keeps the fragment for replaceAtToken");
});

test("wrap: '@' merges agent items with the base provider's own file items, tagged apart", async () => {
  const provider = wrapWithAgentMentions(slashAndFileBase(), () => fakeScan(["reviewer"]));
  const result = await provider.getSuggestions(["@re"], 0, 3, { signal: new AbortController().signal });
  assertEqual(
    result.items.map((i) => `${i.kind}:${i.value}`),
    ["agent:agent:reviewer", "file:re.txt"],
    "one merged list: our agent match first, then the base's own file match, each tagged with its kind",
  );
  const fileItem = result.items.find((i) => i.kind === "file");
  assertEqual(fileItem.original, { value: "re.txt", label: "re.txt", id: "file-item" }, "the base's exact item is kept, not rebuilt");
});

test("wrap: mid-sentence '@' now ALSO merges — no longer delegates entirely to the base", async () => {
  const provider = wrapWithAgentMentions(slashAndFileBase(), () => fakeScan(["reviewer"]));
  const line = "hey @re";
  const result = await provider.getSuggestions([line], 0, line.length, { signal: new AbortController().signal });
  assertEqual(
    result.items.map((i) => `${i.kind}:${i.value}`),
    ["agent:agent:reviewer", "file:re.txt"],
    "position no longer decides which side owns @ — both sides are always asked and merged",
  );
});

test("wrap: '@' inside a word (e.g. email) is not a token — delegates entirely to the base", async () => {
  const provider = wrapWithAgentMentions(slashAndFileBase(), () => fakeScan(["reviewer"]));
  const line = "foo@bar";
  const result = await provider.getSuggestions([line], 0, line.length, { signal: new AbortController().signal });
  assertEqual(result, null, "not in an @-token → delegated whole → base returned null for this non-slash, non-@ text");
});

test("wrap: typing a space right after a finished mention closes the popup instead of opening an unrelated file listing", async () => {
  // The actual bug: pi's editor re-queries the *active* provider (ours, since
  // our merged popup was still open for "@agent") on the very next keystroke,
  // even though that keystroke (a space) isn't one of pi's own trigger
  // characters. Without justClosedMentionToken, falling through to the base
  // here would hit its own unrelated "browse the current directory" fallback
  // for an empty path prefix right after a word+delimiter.
  const provider = wrapWithAgentMentions(slashAndFileBase(), () => fakeScan(["reviewer"]));
  const result = await provider.getSuggestions(["@agent "], 0, "@agent ".length, {
    signal: new AbortController().signal,
  });
  assertEqual(result, null, "nothing to suggest right after a mention closes — not the base's directory listing");
});

test("wrap: prose with no @ anywhere still delegates to the base normally (not over-suppressed)", async () => {
  // A trailing space after ordinary prose (no @ before it at all) must not
  // be mistaken for "just closed a mention" -- justClosedMentionToken is
  // false here, so this still reaches the base, which for this input (no
  // leading "/", no "@") legitimately has nothing to offer either.
  const provider = wrapWithAgentMentions(slashAndFileBase(), () => fakeScan(["reviewer"]));
  const result = await provider.getSuggestions(["just some words "], 0, "just some words ".length, {
    signal: new AbortController().signal,
  });
  assertEqual(result, null);
});

test("wrap: an @ token with no agent matches and no base matches still returns an (empty) merged list", async () => {
  const provider = wrapWithAgentMentions(slashAndFileBase(), () => fakeScan([]));
  const result = await provider.getSuggestions(["@zzz-no-match"], 0, "@zzz-no-match".length, {
    signal: new AbortController().signal,
  });
  assertEqual(result.items, [], "empty, not null — still inside a real @ token");
  assertEqual(result.prefix, "@zzz-no-match");
});

test("wrap: '/mo' still triggers pi's slash-command completion (pass-through)", async () => {
  const provider = wrapWithAgentMentions(slashAndFileBase(), () => fakeScan(["reviewer"]));
  const result = await provider.getSuggestions(["/mo"], 0, 3, { signal: new AbortController().signal });
  assertEqual(result.items.map((i) => i.value), ["model"], "slash commands are not touched");
});

test("wrap: shouldTriggerFileCompletion is always false inside an @ token now (merged already), delegates outside one", () => {
  const provider = wrapWithAgentMentions(slashAndFileBase(), () => fakeScan([]));
  assertEqual(
    provider.shouldTriggerFileCompletion(["@co"], 0, 3),
    false,
    "@-token anywhere: base's own file listing is suppressed (already merged into our getSuggestions)",
  );
  assertEqual(
    provider.shouldTriggerFileCompletion(["hey @co"], 0, 7),
    false,
    "no longer message-start-only: this is an @-token too, so still suppressed, not delegated",
  );
  assertEqual(
    provider.shouldTriggerFileCompletion(["src/"], 0, 4),
    true,
    "outside any @-token: delegates (base returns true here)",
  );
});

test("wrap: applyCompletion on an UNTAGGED item (e.g. a pi slash-command completion, no @ anywhere) forwards to the base — the actual bug this fixes", () => {
  // The bug: an untagged item (anything that reached applyCompletion
  // without going through our own agent-tagging step -- pi's own
  // slash-command completions are the real-world case) used to fall through
  // to our own replaceAtToken by default, splicing in "@<value> " and
  // replacing the leading "/" with a stray "@". Only an explicit
  // kind: "agent" tag may go through our own logic now; everything else,
  // tagged "file" or not tagged at all, forwards to the base.
  const provider = wrapWithAgentMentions(slashAndFileBase(), () => fakeScan(["reviewer"]));
  const result = provider.applyCompletion(["/mo"], 0, "/mo".length, { value: "model", label: "model" }, "/mo");
  assertEqual(result.lines, ["/model "], "the base's own slash-command completion ran — '/' was never replaced with '@'");
  assertEqual(result.cursorCol, "/model ".length);
});

test("wrap: applyCompletion on an agent-kind item replaces the @-token with '@<name> ' — our own logic", () => {
  const provider = wrapWithAgentMentions(slashAndFileBase(), () => fakeScan(["reviewer"]));
  const result = provider.applyCompletion(
    ["@re"],
    0,
    "@re".length,
    { value: "reviewer", label: "reviewer", kind: "agent" },
    "@re",
  );
  assertEqual(result.lines, ["@reviewer "], "the fragment is replaced with the full slug + space");
  assertEqual(result.cursorCol, "@reviewer ".length, "cursor is at the end of the replacement");
});

test("wrap: applyCompletion on a file-kind item forwards to the base's OWN applyCompletion — the actual bug fix", () => {
  // This is the bug this rewrite exists to fix: a file selection must run
  // through the base provider's own apply logic (here: uppercasing, as a
  // stand-in for pi's real path/quoting logic), never our own
  // `replaceAtToken` guess just because its prefix also starts with `@`.
  const provider = wrapWithAgentMentions(slashAndFileBase(), () => fakeScan(["reviewer"]));
  const original = { value: "re.txt", label: "re.txt", id: "file-item" };
  const result = provider.applyCompletion(
    ["@re"],
    0,
    "@re".length,
    { value: "re.txt", label: "re.txt", kind: "file", original },
    "@re",
  );
  assertEqual(result.lines, ["@RE.TXT "], "the base's own applyCompletion ran (uppercased) — not a stray extra '@'");
  assertEqual(result.cursorCol, "@RE.TXT ".length);
});

test("replaceAtToken: preserves the tail after the cursor", () => {
  const result = replaceAtToken(["@re please"], 0, 3, "@re", "@reviewer ");
  assertEqual(result.lines, ["@reviewer  please"], "text after the cursor is preserved verbatim");
  assertEqual(result.cursorCol, "@reviewer ".length, "cursor lands after the space");
});
