/**
 * Unit tests for at-mention.ts.
 *
 * All that's left of this module is `atTokenAtCursor`, the cosmetic
 * autocomplete-only cursor helper — the routing/priority/escaping logic it
 * used to also contain is gone (every agent now decides what `@name` means
 * via LLM tool calls; see agent-status-tool.ts / agent-control-tool.ts /
 * agent-create-tool.ts and README "LLM-callable tools").
 */

import { assertEqual, load, test } from "./harness.mjs";

const mention = await load("at-mention.ts");

// ── atTokenAtCursor (message-start only) ────────────────────────────

test("atTokenAtCursor: cursor right after '@' at message-start returns empty slug", () => {
  assertEqual(mention.atTokenAtCursor(["@"], 0, 1), { prefix: "@", slug: "" });
});

test("atTokenAtCursor: cursor inside a slug at message-start returns the fragment", () => {
  assertEqual(mention.atTokenAtCursor(["@co"], 0, 3), { prefix: "@co", slug: "co" });
});

test("atTokenAtCursor: leading whitespace before @ is OK", () => {
  assertEqual(mention.atTokenAtCursor(["   @co"], 0, 6), { prefix: "@co", slug: "co" });
});

test("atTokenAtCursor: mid-line @ after prose is NOT a token — file picker owns it", () => {
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

test("ADHOC_SLUG is 'agent'", () => {
  assertEqual(mention.ADHOC_SLUG, "agent");
});
