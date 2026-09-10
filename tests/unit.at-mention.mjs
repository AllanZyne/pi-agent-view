/**
 * Unit tests for at-mention.ts.
 *
 * Interception rule (see parseAtMention): the `@` must be at the start of
 * the message text, with only whitespace allowed before it. Prose about an
 * agent — anything with content before `@` — falls through as ordinary chat.
 *
 * Resolution priority (see resolveSlug):
 *   1. `agent`                           → adhoc spawn
 *   2. live agent by *own name*          → route (exact instance)
 *   3. live agents by *def*              → route (caller-ordered)
 *   4. catalog def                       → def-backed spawn
 *   5. else                              → not intercepted
 */

import { assert, assertEqual, load, test } from "./harness.mjs";

const mention = await load("at-mention.ts");

function catalogOf(names) {
  const agents = new Map();
  for (const name of names) {
    agents.set(name, { name, description: "test", source: "/tmp/x.md", scope: "user" });
  }
  return { agents, diagnostics: [] };
}

function ctx({ defs = [], live = [], excludeFile } = {}) {
  return { catalog: catalogOf(defs), liveAgents: live, excludeFile };
}

// ── Position rule (message-start only) ─────────────────────────────

test("parseAtMention: @agent at position 0 intercepts, task is verbatim", () => {
  const r = mention.parseAtMention("@agent hello world", ctx());
  assert(r, "matched");
  assertEqual(r.target.kind, "adhoc");
  assertEqual(r.slug, "agent");
  assertEqual(r.task, "@agent hello world", "task is verbatim (not stripped)");
});

test("parseAtMention: leading whitespace before @ is fine — still 'message-start'", () => {
  const r = mention.parseAtMention("   @agent hello", ctx());
  assert(r, "matched despite leading spaces");
  assertEqual(r.slug, "agent");
});

test("parseAtMention: any non-whitespace before @ makes it prose", () => {
  const c = ctx({ defs: ["reviewer"] });
  assertEqual(mention.parseAtMention("hey @reviewer take a look", c), null, "prose lead-in → not a mention");
  assertEqual(mention.parseAtMention("look at @reviewer's config", c), null, "mid-sentence prose");
  assertEqual(mention.parseAtMention("please @reviewer help", c), null, "prose imperative");
  assertEqual(
    mention.parseAtMention("first do X, then @reviewer take over", c),
    null,
    "later-in-the-message mentions don't intercept",
  );
});

test("parseAtMention: escapes for message-start `@` — backslash / backtick / quote", () => {
  const c = ctx({ defs: ["reviewer"] });
  assertEqual(mention.parseAtMention("\\@reviewer has a bug", c), null, "backslash escape (Slack-style)");
  assertEqual(mention.parseAtMention("`@reviewer` is the def name", c), null, "backtick escape");
  assertEqual(mention.parseAtMention('"@reviewer" note', c), null, "quote escape");
});

test("parseAtMention: multi-line messages — only line 0 counts as 'message-start'", () => {
  const c = ctx({ defs: ["reviewer"] });
  const r1 = mention.parseAtMention("@reviewer\nsecond line", c);
  assert(r1, "line 0 starts with @slug → intercept");
  assertEqual(r1.slug, "reviewer");

  const r2 = mention.parseAtMention("first line\n@reviewer second line", c);
  assertEqual(r2, null, "@ on a later line is not the start of the message");
});

test("parseAtMention: unresolved slug at message-start still returns null (falls through as chat)", () => {
  assertEqual(mention.parseAtMention("@yangzhao hi", ctx()), null, "unknown slug isn't intercepted");
  assertEqual(mention.parseAtMention("@Agent hi", ctx()), null, "uppercase A isn't a valid slug");
  assertEqual(mention.parseAtMention("@code_reviewer hi", ctx({ defs: ["code_reviewer"] })), null, "underscore isn't a slug char");
});

test("parseAtMention: message-only-mention returns null (no task) so caller can complain", () => {
  assertEqual(mention.parseAtMention("@agent", ctx()), null, "no task text");
  assertEqual(mention.parseAtMention("   @agent   ", ctx()), null, "whitespace-only task");
  assertEqual(mention.parseAtMention("@reviewer", ctx({ defs: ["reviewer"] })), null, "def mention alone");
});

// ── Resolution priority ────────────────────────────────────────────

test("parseAtMention: catalog def with no live match → def-backed spawn (rule 4)", () => {
  const r = mention.parseAtMention("@reviewer look at storage.ts", ctx({ defs: ["reviewer"] }));
  assert(r, "matched");
  assertEqual(r.target.kind, "def");
  assertEqual(r.target.def.name, "reviewer");
});

test("parseAtMention: rule 2 — exact live-agent name → route to that instance", () => {
  const r = mention.parseAtMention(
    "@review-storage-ts also check view-model.ts",
    ctx({
      live: [
        { file: "/tmp/a.jsonl", name: "review-storage-ts", def: "reviewer" },
        { file: "/tmp/b.jsonl", name: "other-work" },
      ],
      defs: ["reviewer"],
    }),
  );
  assertEqual(r.target.kind, "route");
  assertEqual(r.target.file, "/tmp/a.jsonl", "exact-name match beats def match");
  assertEqual(r.target.name, "review-storage-ts");
});

test("parseAtMention: rule 3 — live agent by def → route (not spawn)", () => {
  const r = mention.parseAtMention(
    "@reviewer next diff please",
    ctx({
      live: [{ file: "/tmp/a.jsonl", name: "review-storage-ts", def: "reviewer" }],
      defs: ["reviewer"],
    }),
  );
  assertEqual(r.target.kind, "route", "route to the live def-backed agent");
  assertEqual(r.target.file, "/tmp/a.jsonl");
});

test("parseAtMention: rule 3 with multiple def-matches → caller's order wins (most-recent first)", () => {
  const live = [
    { file: "/tmp/newer.jsonl", name: "reviewer-newer", def: "reviewer" },
    { file: "/tmp/older.jsonl", name: "reviewer-older", def: "reviewer" },
  ];
  const r = mention.parseAtMention("@reviewer another one", ctx({ live, defs: ["reviewer"] }));
  assertEqual(r.target.file, "/tmp/newer.jsonl", "first live match in caller's order");
});

test("parseAtMention: excludeFile skips self so `@slug` targets *another* agent", () => {
  const live = [
    { file: "/tmp/self.jsonl", name: "self-agent", def: "reviewer" },
    { file: "/tmp/sib.jsonl", name: "sibling", def: "reviewer" },
  ];
  const r = mention.parseAtMention("@reviewer sibling task", ctx({ live, defs: ["reviewer"], excludeFile: "/tmp/self.jsonl" }));
  assertEqual(r.target.kind, "route");
  assertEqual(r.target.file, "/tmp/sib.jsonl");
});

test("parseAtMention: excludeFile with no siblings but a catalog def → falls through to fresh spawn", () => {
  const live = [{ file: "/tmp/self.jsonl", name: "reviewer", def: "reviewer" }];
  const r = mention.parseAtMention(
    "@reviewer another task",
    ctx({ live, defs: ["reviewer"], excludeFile: "/tmp/self.jsonl" }),
  );
  assertEqual(r.target.kind, "def", "self excluded → def-backed spawn instead");
});

test("parseAtMention: excludeFile with nothing else reachable → null (chat, not spawn)", () => {
  const live = [{ file: "/tmp/self.jsonl", name: "solo", def: "solo-def" }];
  const r = mention.parseAtMention("@solo-def more work", ctx({ live, excludeFile: "/tmp/self.jsonl" }));
  assertEqual(r, null, "only reachable target is self → not intercepted");
});

test("parseAtMention: rule 2 works even for adhoc live agents (no def field)", () => {
  const live = [{ file: "/tmp/a.jsonl", name: "adhoc-slug" }];
  const r = mention.parseAtMention("@adhoc-slug more work", ctx({ live }));
  assertEqual(r.target.kind, "route");
  assertEqual(r.target.file, "/tmp/a.jsonl");
});

// ── atTokenAtCursor (aligned to parseAtMention's position rule) ────

test("atTokenAtCursor: cursor right after '@' at message-start returns empty slug", () => {
  assertEqual(mention.atTokenAtCursor(["@"], 0, 1), { prefix: "@", slug: "" });
});

test("atTokenAtCursor: cursor inside a slug at message-start returns the fragment", () => {
  assertEqual(mention.atTokenAtCursor(["@co"], 0, 3), { prefix: "@co", slug: "co" });
});

test("atTokenAtCursor: leading whitespace before @ is OK (matches parse rule)", () => {
  assertEqual(mention.atTokenAtCursor(["   @co"], 0, 6), { prefix: "@co", slug: "co" });
});

test("atTokenAtCursor: mid-line @ after prose is NOT a token — file picker owns it now", () => {
  assertEqual(
    mention.atTokenAtCursor(["hello @rev"], 0, 10),
    null,
    "prose lead-in means this @ falls through to pi's file completion",
  );
});

test("atTokenAtCursor: @ on line > 0 is not message-start", () => {
  assertEqual(mention.atTokenAtCursor(["first line", "@rev"], 1, 4), null);
});

test("atTokenAtCursor: @ inside a word (email) is not a token", () => {
  assertEqual(mention.atTokenAtCursor(["foo@bar"], 0, 7), null);
});

test("atTokenAtCursor: cursor past the slug (on a space) is not in the token", () => {
  assertEqual(mention.atTokenAtCursor(["@agent "], 0, 7), null);
});

test("atTokenAtCursor: uppercase after @ is not a slug character", () => {
  assertEqual(mention.atTokenAtCursor(["@A"], 0, 2), null);
});
