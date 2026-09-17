/**
 * Shared system-context policy for main and every sub-agent.
 *
 * Keep the actual instructions in agent-policy.md so policy changes are easy
 * to review without digging through runtime code.
 */

import * as fs from "node:fs";
import { fileURLToPath } from "node:url";

export const AGENT_POLICY = fs.readFileSync(fileURLToPath(new URL("./agent-policy.md", import.meta.url)), "utf8").trim();
