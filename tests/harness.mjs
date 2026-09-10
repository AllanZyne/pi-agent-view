/**
 * Tiny test harness for the agent-view extension.
 *
 * Loads the extension's TypeScript modules with jiti (the same loader pi uses
 * for extensions), so tests exercise the real code with no build step.
 *
 * Usage:
 *   node tests/run.mjs            # unit tests only (offline, fast)
 *   node tests/run.mjs --e2e      # also run tests that call a real model
 */

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
export const EXT_DIR = path.dirname(HERE);

/** Resolve the installed pi package that owns this extension host. */
function findPiPackage() {
  if (process.env.PI_PACKAGE_DIR) return process.env.PI_PACKAGE_DIR;
  const candidates = [];
  const nodeDir = path.dirname(path.dirname(process.execPath)); // .../node-vX
  candidates.push(path.join(nodeDir, "lib", "node_modules", "@earendil-works", "pi-coding-agent"));
  for (const c of candidates) {
    if (fs.existsSync(path.join(c, "dist", "index.js"))) return c;
  }
  throw new Error("Cannot locate @earendil-works/pi-coding-agent; set PI_PACKAGE_DIR");
}

export const PI_DIR = findPiPackage();

const { createJiti } = await import(`${PI_DIR}/node_modules/jiti/lib/jiti.mjs`);

const jiti = createJiti(import.meta.url, {
  alias: {
    "@earendil-works/pi-coding-agent": `${PI_DIR}/dist/index.js`,
    "@earendil-works/pi-ai": `${PI_DIR}/node_modules/@earendil-works/pi-ai`,
    "@earendil-works/pi-tui": `${PI_DIR}/node_modules/@earendil-works/pi-tui`,
    // Real pi resolves bare `typebox` imports (used by `pi.registerTool()`
    // parameter schemas, e.g. subagent-tool.ts) from its own node_modules via
    // normal upward resolution; the test harness has no such path, so alias
    // it explicitly.
    typebox: `${PI_DIR}/node_modules/typebox/build/index.mjs`,
  },
});

/** Import one of the extension's TS modules. */
export const load = (file) => jiti.import(path.join(EXT_DIR, file));
export const pi = await import(`${PI_DIR}/dist/index.js`);

// pi initialises its theme at startup; rendering tests need the same, or every
// component throws "Theme not initialized".
try {
  pi.initTheme("dark");
} catch {
  /* older pi builds initialise on import */
}

// ── assertions ─────────────────────────────────────────────────────

export function assert(cond, message) {
  if (!cond) throw new Error(`assertion failed: ${message}`);
}

export function assertEqual(actual, expected, message) {
  const a = JSON.stringify(actual);
  const e = JSON.stringify(expected);
  if (a !== e) throw new Error(`assertion failed: ${message}\n  expected ${e}\n  actual   ${a}`);
}

// ── temp workspace ─────────────────────────────────────────────────

const tempDirs = [];

export function tempDir(prefix = "agent-view-test-") {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

function cleanup() {
  for (const dir of tempDirs) fs.rmSync(dir, { recursive: true, force: true });
}

// ── runner ─────────────────────────────────────────────────────────

const cases = [];

export function test(name, fn, options = {}) {
  cases.push({ name, fn, e2e: Boolean(options.e2e) });
}

export async function run() {
  const wantE2E = process.argv.includes("--e2e") || process.env.AGENT_VIEWS_E2E === "1";
  let passed = 0;
  let failed = 0;
  let skipped = 0;

  for (const c of cases) {
    if (c.e2e && !wantE2E) {
      console.log(`  ~ ${c.name} (skipped; pass --e2e)`);
      skipped++;
      continue;
    }
    const started = Date.now();
    try {
      await c.fn();
      console.log(`  ✓ ${c.name} (${Date.now() - started}ms)`);
      passed++;
    } catch (err) {
      console.log(`  ✗ ${c.name} (${Date.now() - started}ms)`);
      console.log(`    ${String(err?.stack ?? err).split("\n").join("\n    ")}`);
      failed++;
    }
  }

  cleanup();
  console.log(`\n${passed} passed, ${failed} failed, ${skipped} skipped`);
  process.exit(failed === 0 ? 0 : 1);
}
