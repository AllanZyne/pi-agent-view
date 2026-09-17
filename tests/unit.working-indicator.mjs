/**
 * Regression test for the editor-border "Working" spinner while attached to a
 * sub-agent.
 *
 * `AgentViewEditor.renderTopBorder` runs on every render frame, and while
 * attached to a working agent it must keep animating the spinner exactly like
 * pi's own indicator does for `main` — a frame that fires far more often than
 * the spinner's own tick (e.g. once per streamed token) must not restart the
 * animation on every call, or the timer resets before it ever ticks and the
 * icon freezes.
 */

import { assert, load, test } from "./harness.mjs";

const { AgentViewEditor } = await load("index.ts");

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** Just enough of pi's TUI/theme/keybindings surface for `renderTopBorder`. */
function makeEditor(status) {
  const fakeTui = { requestRender() {} };
  const fakeTheme = { borderColor: (text) => text };
  const fakeKb = { matches: () => false };
  const view = {};
  const act = () => {};
  return new AgentViewEditor(fakeTui, fakeTheme, fakeKb, view, act, status);
}

test("an attached agent's Working spinner keeps animating under frequent re-renders", async () => {
  const editor = makeEditor(() => ({ label: " \u25c6 agent ", working: true, ownStatus: true }));
  try {
    // Frame zero: creates and starts the agent's own spinner.
    const first = editor.renderTopBorder(80, 0);

    // Simulate renders far more often than the spinner's own 80ms tick —
    // exactly what a streaming agent's transcript updates look like. If any
    // of these calls restarts the spinner's timer, it never gets the chance
    // to fire and the icon in `first` never changes.
    const deadline = Date.now() + 300;
    let last = first;
    while (Date.now() < deadline) {
      last = editor.renderTopBorder(80, 0);
      await sleep(5);
    }

    assert(
      last !== first,
      `the border must animate over 300ms of frequent re-renders (stuck at: ${JSON.stringify(first)})`,
    );
  } finally {
    editor.stopStatus();
  }
});

test("detaching stops the agent spinner, and reattaching resumes it cleanly", async () => {
  let attached = true;
  const editor = makeEditor(() => ({ label: " \u25c6 agent ", working: true, ownStatus: attached }));
  try {
    const whileWorking = editor.renderTopBorder(80, 0);
    assert(whileWorking.includes("Working"), `spinner shown while working: ${JSON.stringify(whileWorking)}`);

    // The background agent remains working; only the displayed conversation
    // changes back to main. Its hidden timer must stop as well.
    attached = false;
    const whileDetached = editor.renderTopBorder(80, 0);
    assert(!whileDetached.includes("Working"), `agent spinner hidden once detached: ${JSON.stringify(whileDetached)}`);

    attached = true;
    const resumedFirst = editor.renderTopBorder(80, 0);
    assert(resumedFirst.includes("Working"), `spinner shown again on resume: ${JSON.stringify(resumedFirst)}`);

    const deadline = Date.now() + 300;
    let last = resumedFirst;
    while (Date.now() < deadline) {
      last = editor.renderTopBorder(80, 0);
      await sleep(5);
    }
    assert(last !== resumedFirst, `resumed spinner animates too: ${JSON.stringify(resumedFirst)}`);
  } finally {
    editor.stopStatus();
  }
});
