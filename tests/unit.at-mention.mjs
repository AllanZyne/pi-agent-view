/**
 * Unit tests for at-mention.ts.
 *
 * All that's left of this module is `atTokenAtCursor`, the cosmetic
 * autocomplete-only cursor helper — the routing/priority/escaping logic it
 * used to also contain is gone (every agent now decides what `@name` means
 * via LLM tool calls; see agent-status-tool.ts / agent-control-tool.ts /
 * agent-create-tool.ts and README "LLM-callable tools").
 *
 * Token detection is now position-independent and delimiter-based (see the
 * module doc in at-mention.ts and `.agents/research/codex-at-mention.md`):
 * scan left from the cursor to the nearest delimiter and check whether that
 * run starts with `@`, the same rule pi's own file completion uses. It used
 * to be restricted to the very start of the message and to a strict
 * lowercase-slug shape; both restrictions are gone — *detection* no longer
 * decides *classification* (whether a token is a real agent/template name is
 * up to whoever matches against it, e.g. `autocomplete.ts`'s fuzzy filter).
 */

import { assertEqual, load, test } from "./harness.mjs";

const mention = await load("at-mention.ts");

test("atTokenAtCursor: cursor right after '@' returns empty slug", () => {
  assertEqual(mention.atTokenAtCursor(["@"], 0, 1), { prefix: "@", slug: "" });
});

test("atTokenAtCursor: cursor inside a slug returns the fragment", () => {
  assertEqual(mention.atTokenAtCursor(["@co"], 0, 3), { prefix: "@co", slug: "co" });
});

test("atTokenAtCursor: leading whitespace before @ is OK", () => {
  assertEqual(mention.atTokenAtCursor(["   @co"], 0, 6), { prefix: "@co", slug: "co" });
});

test("atTokenAtCursor: mid-sentence @ IS a token now — no longer message-start only", () => {
  assertEqual(
    mention.atTokenAtCursor(["hello @rev"], 0, 10),
    { prefix: "@rev", slug: "rev" },
    "the space before @ is a delimiter, exactly like pi's own file completion treats it",
  );
});

test("atTokenAtCursor: @ on a line other than 0 is a token too — no longer message-start only", () => {
  assertEqual(mention.atTokenAtCursor(["first line", "@rev"], 1, 4), { prefix: "@rev", slug: "rev" });
});

test("atTokenAtCursor: @ inside a word (email) is not a token", () => {
  assertEqual(
    mention.atTokenAtCursor(["foo@bar"], 0, 7),
    null,
    "@ must be the first character of the delimiter-bounded run, not stuck mid-word",
  );
});

test("atTokenAtCursor: cursor past the slug (on a space) is not in the token", () => {
  assertEqual(mention.atTokenAtCursor(["@agent "], 0, 7), null);
});

test("atTokenAtCursor: never crosses a newline — only the cursor's own line is scanned", () => {
  assertEqual(
    mention.atTokenAtCursor(["@rev", "more text"], 1, 4),
    null,
    "line 1 has no @ of its own; line 0's token must not leak across the line boundary",
  );
});

test("atTokenAtCursor: quotes and '=' are delimiters too, matching pi's own PATH_DELIMITERS", () => {
  assertEqual(mention.atTokenAtCursor(['say "@rev'], 0, 9), { prefix: "@rev", slug: "rev" });
  assertEqual(mention.atTokenAtCursor(["x=@rev"], 0, 6), { prefix: "@rev", slug: "rev" });
});

test("atTokenAtCursor: no charset restriction on the slug — classification is not detection's job", () => {
  // Uppercase, and an arbitrary "name:fragment" shape, both used to be
  // rejected right here by a strict grammar. Now any run starting with `@`
  // is a token; whether it matches anything real is for the matcher
  // (autocomplete.ts's fuzzy filter) to decide, exactly like Codex never
  // lets its token-boundary scan double as a resource-kind check.
  assertEqual(mention.atTokenAtCursor(["@A"], 0, 2), { prefix: "@A", slug: "A" });
  assertEqual(mention.atTokenAtCursor(["@reviewer:rev"], 0, 13), { prefix: "@reviewer:rev", slug: "reviewer:rev" });
});

test("atTokenAtCursor: @agent: template marker and fragments are tokens", () => {
  assertEqual(mention.atTokenAtCursor(["@agent:"], 0, 7), { prefix: "@agent:", slug: "agent:" });
  assertEqual(mention.atTokenAtCursor(["@agent:rev"], 0, 10), { prefix: "@agent:rev", slug: "agent:rev" });
});
