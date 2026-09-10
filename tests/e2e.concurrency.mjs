/**
 * End-to-end test for the property that motivated this design:
 *
 *   switching which agent you look at must not disturb any agent's execution.
 *
 * Three real agents run concurrently through the pi SDK while the test flips the
 * "attached" agent every 300ms, exactly as pressing Enter in the picker does.
 * Afterwards every agent must have finished its own multi-step task, and the
 * transcript mirror must be able to replay each agent's output in full.
 *
 * Needs model credentials. Run with: node tests/run.mjs --e2e
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { assert, assertEqual, load, tempDir, test } from "./harness.mjs";

const runtime = await load("agent-runtime.ts");
const storage = await load("storage.ts");
const vm = await load("view-model.ts");

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function makeRoot(dir, id = "root-e2e") {
  const rootFile = path.join(dir, "root.jsonl");
  fs.writeFileSync(rootFile, "");
  return { rootId: id, rootFile, sessionDir: dir };
}

/** Two tool calls plus a final message, so an interrupted turn is detectable. */
function taskFor(marker, file) {
  return (
    `Do exactly this, using the bash tool, one command per call:\n` +
    `1. run: sleep 2\n` +
    `2. run: printf '%s' ${marker} > ${file}\n` +
    `Then reply with exactly ${marker} and nothing else.`
  );
}

async function waitForSettled(files, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  const seenParallel = { max: 0 };
  while (Date.now() < deadline) {
    const states = files.map((f) => runtime.stateOf(f));
    seenParallel.max = Math.max(seenParallel.max, states.filter((s) => s === "working").length);
    if (states.every((s) => s === "completed" || s === "failed")) return seenParallel;
    await sleep(200);
  }
  throw new Error(`agents did not settle in ${timeoutMs}ms: ${files.map((f) => runtime.stateOf(f)).join(",")}`);
}

function transcriptText(file) {
  return runtime
    .readTranscript(file)
    .filter((i) => i.kind === "assistant")
    .map((i) => runtime.assistantText(i.message))
    .join("\n");
}

function renderableCount(file) {
  return runtime.readTranscript(file).filter((i) => vm.renderable(i)).length;
}

test(
  "three agents keep running while the attached view is switched around",
  async () => {
    const dir = tempDir("agent-view-e2e-");
    const root = makeRoot(dir);
    const cwd = dir;

    const agents = [1, 2, 3].map((n) => {
      const marker = `AGENT-DONE-${n}`;
      const outFile = path.join(dir, `agent-${n}.txt`);
      const file = storage.registerAgent(root, storage.agentName(`task ${n}`), cwd);
      return { n, marker, outFile, file };
    });

    // Start them all; runAgent queues the turn and returns immediately.
    for (const a of agents) await runtime.runAgent(a.file, taskFor(a.marker, a.outFile), cwd);

    // Simulate a user hammering the picker: attach/detach while work is running.
    const mirrorState = { attached: undefined, mirrored: {} };
    const appendsByFile = new Map(agents.map((a) => [a.file, []]));
    let switches = 0;

    const switching = (async () => {
      for (let i = 0; ; i++) {
        const states = agents.map((a) => runtime.stateOf(a.file));
        if (states.every((s) => s === "completed" || s === "failed")) break;

        // Cycle: agent1 → agent2 → agent3 → detached (pi's own session) → …
        const target = i % 4 === 3 ? undefined : agents[i % 4].file;
        vm.attachTo(mirrorState, target);
        switches++;
        vm.syncMirror(mirrorState, (ref) => appendsByFile.get(ref.file).push(ref.index));
        await sleep(300);
        // Mid-attachment updates, like the pool's onChange callback firing.
        vm.syncMirror(mirrorState, (ref) => appendsByFile.get(ref.file).push(ref.index));
      }
    })();

    const parallel = await waitForSettled(
      agents.map((a) => a.file),
      240_000,
    );
    await switching;

    assert(switches >= 4, `the view was switched repeatedly (was ${switches})`);
    assert(parallel.max >= 2, `at least two agents were working at the same time (saw ${parallel.max})`);

    for (const a of agents) {
      const state = runtime.stateOf(a.file);
      assertEqual(state, "completed", `agent ${a.n} completed despite the switching`);

      assert(fs.existsSync(a.outFile), `agent ${a.n} finished its bash step (${a.outFile})`);
      assertEqual(fs.readFileSync(a.outFile, "utf-8").trim(), a.marker, `agent ${a.n} wrote its own marker`);

      const text = transcriptText(a.file);
      assert(text.includes(a.marker), `agent ${a.n} reported its own marker: ${JSON.stringify(text)}`);

      const items = runtime.readTranscript(a.file);
      assertEqual(
        items.filter((i) => i.kind === "error").length,
        0,
        `agent ${a.n} recorded no error items`,
      );
      assert(
        items.filter((i) => i.kind === "toolCall").length >= 2,
        `agent ${a.n} ran both bash steps`,
      );

      // Nothing was disposed by the switching: the agent is still live and idle.
      const live = runtime.getAgent(a.file);
      assert(live !== undefined, `agent ${a.n} is still live in the pool`);
      assertEqual(live.session.isStreaming, false, `agent ${a.n} is no longer streaming`);
    }

    // Re-attaching resumes instead of replaying: pi keeps every entry we handed
    // it, so each renderable item must have been appended exactly once even
    // though the view was switched away and back repeatedly.
    for (const a of agents) {
      vm.attachTo(mirrorState, a.file);
      vm.syncMirror(mirrorState, (ref) => appendsByFile.get(ref.file).push(ref.index));
      const indices = appendsByFile.get(a.file);
      assertEqual(
        new Set(indices).size,
        indices.length,
        `agent ${a.n} never had an item appended twice`,
      );
      assertEqual(indices.length, renderableCount(a.file), `agent ${a.n} appended every renderable item`);
    }

    await runtime.disposeAll();
  },
  { e2e: true },
);

test(
  "an agent keeps working while you are looking at another one",
  async () => {
    const dir = tempDir("agent-view-e2e-");
    const root = makeRoot(dir, "root-e2e-2");
    const cwd = dir;

    const slow = storage.registerAgent(root, "slow", cwd);
    const other = storage.registerAgent(root, "other", cwd);
    const slowOut = path.join(dir, "slow.txt");

    await runtime.runAgent(slow, taskFor("SLOW-DONE", slowOut), cwd);

    // Look at `slow` first, then walk away to `other` while it is still working.
    const state = { attached: undefined, mirrored: {} };
    vm.attachTo(state, slow);
    vm.syncMirror(state, () => {});
    const seenWhileAttached = vm.mirroredCount(state, slow);

    await runtime.runAgent(other, "Reply with exactly OTHER-DONE and nothing else.", cwd);
    vm.attachTo(state, other);
    vm.syncMirror(state, () => {});
    assert(!vm.isVisible(state, slow), "the agent we walked away from no longer draws");

    await waitForSettled([slow, other], 240_000);

    assertEqual(runtime.stateOf(slow), "completed", "the agent we walked away from completed");
    assert(fs.existsSync(slowOut), "it finished its bash step while unattended");

    // Coming back shows strictly more than we had seen before leaving.
    vm.attachTo(state, slow);
    vm.syncMirror(state, () => {});
    assert(
      vm.mirroredCount(state, slow) > seenWhileAttached,
      `transcript grew while detached (${seenWhileAttached} → ${vm.mirroredCount(state, slow)})`,
    );

    await runtime.disposeAll();
  },
  { e2e: true },
);

test(
  "terminating an agent stops it for good and leaves the others alone",
  async () => {
    const dir = tempDir("agent-view-e2e-");
    const root = makeRoot(dir, "root-e2e-3");
    const cwd = dir;

    const doomed = storage.registerAgent(root, storage.agentName("doomed"), cwd);
    const survivor = storage.registerAgent(root, storage.agentName("survivor"), cwd);
    const doomedOut = path.join(dir, "doomed.txt");
    const survivorOut = path.join(dir, "survivor.txt");

    await runtime.runAgent(doomed, taskFor("DOOMED-DONE", doomedOut), cwd);
    await runtime.runAgent(survivor, taskFor("SURVIVOR-DONE", survivorOut), cwd);

    // Kill one mid-flight.
    while (runtime.stateOf(doomed) !== "working") await sleep(100);
    assertEqual(await runtime.terminateAgent(doomed), true, "it was running when terminated");

    assertEqual(runtime.getAgent(doomed), undefined, "its session is gone from the pool");
    assertEqual(runtime.stateOf(doomed), "stopped", "and it reports Stopped, not Completed");

    await waitForSettled([survivor], 240_000);
    assertEqual(runtime.stateOf(survivor), "completed", "the other agent was untouched");
    assert(fs.existsSync(survivorOut), "and finished its own work");

    // A terminated agent stays in the list and is revivable: its transcript is
    // still on disk, and attaching creates a fresh session for it.
    assert(runtime.readTranscript(doomed).length > 0, "its transcript survives");
    await runtime.ensureAgent(doomed, cwd);
    assert(runtime.getAgent(doomed) !== undefined, "attaching revives it");

    await runtime.disposeAll();
  },
  { e2e: true },
);
