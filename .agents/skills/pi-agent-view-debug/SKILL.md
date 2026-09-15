---
name: pi-agent-view-debug
description: Use when a bug report is about how a TUI/interactive-CLI extension renders or behaves at runtime (rendering glitches, "looks different from the main session", module-loading failures that unit tests don't catch) and you need to reproduce it against the real program instead of guessing from source. Also use when a try/catch is silently swallowing an error that only happens in the real runtime.
---

# pi-agent-view-debug: reproduce TUI bugs for real, in tmux

## When unit tests are not enough

Unit tests for a TUI extension usually run its code through a hand-built harness:
a test-only module loader, a fake alias table, a mocked terminal. That harness
encodes assumptions about how the real host loads and runs the extension. If
those assumptions are wrong — a different module resolution strategy, a
different install layout, a feature flag that changes behavior — the unit
tests can pass while the real program is still broken. This is especially true
for anything involving dynamic `import()`, deep/relative module paths,
environment feature-detection, or async initialization races.

**Rule: once you have a plausible fix, prove it against the actual running
program, not just the test suite.** A green test suite that exercises the bug
via the same hand-built harness that hid it proves nothing.

## Reproduce with tmux

tmux lets you drive an interactive full-screen program non-interactively and
inspect its rendered output as text, which makes it scriptable exactly like
any other command-line tool:

```bash
# Isolated scratch directory so you don't touch real project state
mkdir -p /tmp/repro && cd /tmp/repro

# Start the pane running your actual interactive shell first, THEN launch the
# program with send-keys — don't hand the program to `new-session` as the pane
# command. `new-session "<cmd>"` runs `<cmd>` under a bare non-login shell,
# which may not have the PATH/aliases/functions/rc-file setup your normal
# terminal has (a program installed or wired up via your shell's rc file can
# be genuinely "not found" in that bare shell even though it works everywhere
# you actually type). Starting the real shell first, the same one you'd
# normally use, avoids debugging a PATH problem that has nothing to do with
# the bug you're actually chasing.
tmux new-session -d -s repro -x 220 -y 50 <your-actual-shell>   # e.g. fish, zsh, bash -l
tmux send-keys -t repro "cd /tmp/repro && <your interactive program>" Enter
sleep <enough time for it to finish starting up>
tmux capture-pane -t repro -p   # confirm it's actually up before driving it

# Drive it like a user would
tmux send-keys -t repro "<input>" Enter
sleep <enough time for the program to react>

# Inspect what's actually on screen
tmux capture-pane -t repro -p          # visible pane only
tmux capture-pane -t repro -p -S -100  # include scrollback (bump -100 for long agentic traces)

# Clean up
tmux kill-session -t repro
```

Notes that matter in practice:

- Give the program real time to react (`sleep`) before capturing; capturing
  too early just shows you the loading state. For a step whose duration is
  unpredictable (an agentic tool call, a network request), don't guess one
  long `sleep` — poll: sleep a short interval, `capture-pane`, check whether
  the program's own "still working" indicator (a spinner, a "Working"/"Busy"
  label, a progress line) is still present, and only move on once it's gone.
  A blind sleep is either wastefully long or truncates a still-running step.
- If the program needs a real backend/service to exercise the code path (e.g.
  it needs to actually do work, not just sit idle), use whatever the project's
  normal setup provides for that — don't invent a fake credential path that
  the real users don't use.
- Reproduce the *specific* user-reported symptom, one input at a time, and
  capture-pane after each step. Don't try to script the whole scenario blind;
  look at the screen after every `send-keys`.
- Compare the buggy path against a known-good path side by side (e.g. the
  same operation done directly vs. through the feature under test) so you have
  a concrete "should look like this" reference, not just a vague expectation.
- Most interactive programs have *some* interrupt key (`Escape`, `Ctrl+C`, …)
  that cuts a running step short. Learn it and use it once you've seen enough
  to answer your question — don't sit through a long operation to the end
  just because you started it; that's how a 5-second check turns into a
  5-minute one.

## Gotcha: live suggestion/autocomplete popups eat the next keystroke

Many interactive editors open a live suggestion popup while you're mid-token
after a trigger character (an `@`-mention list, a `/`-command list, a path
completer after typing part of a filename, …). If a popup like that is open
when you send `Enter`, the program very plausibly reads that `Enter` as
"accept the highlighted suggestion", not "submit the line" — and now your
scripted input never actually got submitted, or got silently replaced by
whatever the popup was suggesting. This is easy to miss because the pane
doesn't necessarily show an error; it just quietly doesn't do what you sent.

Two ways to stay out of that state before you send `Enter`:

- Make sure the text you sent doesn't end mid-token — trailing whitespace or
  more words after the trigger closes most popups on its own.
- When in doubt, `send-keys -t repro Escape` right before the `Enter` that's
  supposed to submit. An extra `Escape` is a no-op if nothing was open;
  skipping it when something *was* open silently eats your input.

Also: clearing the input line (e.g. `Ctrl+U`) does not reliably close an
already-open popup by itself — the popup can keep rendering even once the
text behind it is gone. `capture-pane` right after clearing to check, and
send an explicit `Escape` if the popup is still on screen, before typing the
next input.

## When a try/catch is hiding the real error

If the suspect code swallows exceptions (`catch { return undefined }` /
`catch { /* best effort */ }`), don't reason about *why* it might be failing —
find out. Temporarily make the catch block loud (write the error to stderr or
a file), reproduce again in tmux, read the real error, then revert the
temporary logging once you understand the failure. Guessing at the cause of a
silenced error wastes far more time than a two-line temporary log statement.

## Confirm root cause before fixing

A real stack trace or error message tells you the true failure mode (e.g.
"module not found" vs. "wrong value at runtime" vs. "timing/race"), which are
different bugs with different fixes. Don't patch symptoms you haven't traced
to a concrete cause — a fix that "should" work based on a plausible theory can
leave the actual bug untouched while looking like a fix in the test suite.

## Prove the fix both ways

For both the runtime reproduction and any unit test you add:

1. Reproduce the bug first (before the fix), so you know what "broken" looks
   like concretely.
2. Apply the fix, reproduce again the same way, and confirm the output now
   matches the known-good reference.
3. For an added regression test, briefly revert the fix and confirm the new
   test actually fails — a test that passes both before and after the fix
   isn't testing the bug.
