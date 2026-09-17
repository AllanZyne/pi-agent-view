/** Instance lookup must never turn a template ID into an instance alias. */

import { assertEqual, load, test } from "./harness.mjs";

const { resolveEntry } = await load("agent-lookup.ts");

const entries = [
  { id: "1", name: "review-auth", file: "/tmp/a.jsonl", createdAt: "", template: "reviewer" },
  // A legacy manifest still exposes its template through storage, but lookup
  // must remain instance-only regardless of which manifest format produced it.
  { id: "2", name: "review-db", file: "/tmp/b.jsonl", createdAt: "", def: "reviewer" },
];

test("resolveEntry resolves only exact instance names, never template IDs", () => {
  assertEqual(resolveEntry(entries, "review-auth")?.id, "1", "exact instance name resolves");
  assertEqual(resolveEntry(entries, "reviewer"), undefined, "template ID is not an instance alias");
  assertEqual(resolveEntry(entries, "review"), undefined, "partial names do not resolve");
});
