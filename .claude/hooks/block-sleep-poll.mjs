#!/usr/bin/env node
// PreToolUse hook: refuse a Bash wait that can run forever, and a Bash call that
// is nothing but a long `sleep`, the shape a session takes when it polls for a
// background run to finish.
//
// Why this exists: a poll is not cheap. Every one is a fresh tool round trip
// that re-bills the polling session's whole context, and the waiting session
// learns nothing it would not have been told -- a background run notifies on
// exit, and a foreground command is waited on by the tool itself. A wait inside
// one call does not re-bill, so a loop is fine; what is refused is a wait with
// no upper bound, since it keeps running after the session that started it has
// returned. Bounding is judged on the loop's shape, not on what it waits for:
// an unbounded wait on `ps aux | grep "[e]slint"` matched an editor extension's
// command line for hours after the lint it watched had finished.
//
// Three shapes are refused:
//
// - A naked sleep: a command that is exactly `sleep <duration>` with nothing
//   else on the line, when that duration is at least five seconds. A shorter
//   sleep is a settle, not a poll, and a sleep that is part of a larger command
//   line is judged by the two rules below.
// - An unbounded wait loop: an `until` or `while` loop that sleeps, in its
//   condition or its body, whatever its condition tests. It counts as bounded
//   when a `timeout ... sh -c` wrapper encloses it, or when its condition or body
//   does shell arithmetic (`$((n+=1))`, `((...))`, `let`, `expr`), reads
//   `SECONDS`, or reads the clock with `date +%s` -- an iteration counter or a
//   deadline. A `for` loop over a finite list is bounded by its list and is not
//   read.
// - An unbounded background command: a `run_in_background` call must open with
//   `timeout <N>` (or `gtimeout <N>`, the name Homebrew's coreutils installs it
//   under), N not zero -- GNU `timeout 0` disables the limit, measured against
//   coreutils 9.1 -- and hold no later `;`, `&&`, `||`, lone `&`, or newline
//   outside quotes, since a command after one of those runs outside the
//   bound. The Bash tool's own timeout does not apply to a background run, so
//   the wrapper is its only bound. Any non-zero N is accepted: the rule is that the run
//   ends, and a background run is used precisely for work longer than the
//   foreground ceiling, so a hook-enforced cap would be a number with nothing
//   behind it. A host with no `timeout` on PATH (macOS without coreutils) can
//   run the command in the foreground instead.
//
// What the background rule rests on: a subagent the Agent tool spawned that
// starts a background command and ends its turn is resumed by the harness when
// the command finishes. Its caller is notified twice: first with the turn-end
// message, flagged "This agent stopped with background work of its own still
// running ... the result below may be interim", then with the resumed result
// under the same task id. First observed 2026-09-24; re-run 2026-09-25 on Claude
// Code 2.1.282 on a macOS host, where the probe's command ran unwrapped because
// no `timeout` was on PATH. The prompt is block-sleep-poll.probe.md beside this
// file; re-run it after a harness upgrade. A `Workflow` `agent()` call was not
// probed.
//
// None of this is a shell parser (see lib/shell.mjs): a loop hidden in a
// variable, a function, or an `eval` string is not seen.
//
// Exit 0 allows the call; exit 2 blocks it and feeds stderr back to Claude. Any
// unexpected failure here falls through to exit 0 (fail open) so a bug in this
// hook can never wedge every Bash command.

import { commandOf, eventForTools } from "./lib/event.mjs";
import { tokenizeRaw } from "./lib/shell.mjs";

const MINIMUM_BLOCKED_SECONDS = 5;

// The duration forms `sleep` itself accepts: a decimal number with an optional
// unit suffix. A bare number is seconds.
const SLEEP_ONLY = /^sleep\s+(\d+(?:\.\d+)?)([smhd]?)$/;

const UNIT_SECONDS = { "": 1, s: 1, m: 60, h: 3600, d: 86400 };

// The duration in seconds of a command that is a naked `sleep` and nothing else,
// or null when the command is anything more than that.
function nakedSleepSeconds(command) {
  const match = SLEEP_ONLY.exec(command.trim());
  return match === null ? null : Number(match[1]) * UNIT_SECONDS[match[2]];
}

// A loop's condition and body, split on the first `do` and the first `done`
// after it; a nested loop ends its enclosing match early, which only narrows
// what is refused.
const WAIT_LOOP =
  /\b(?:until|while)\s([\s\S]*?)(?:;|\n)\s*do\s([\s\S]*?)(?:;|\n)?\s*\bdone\b/g;
const SLEEPS = /\bsleep\b/;
const COUNTS_OR_DEADLINE =
  /\$\(\(|\(\(|\blet\s|\bexpr\s|\bSECONDS\b|\bdate\s+['"]?\+%s\b/;
const TIMEOUT_SHELL =
  /\bg?timeout\s[^;&|\n]*\b(?:bash|sh|zsh|dash)\s+(?:-\w+\s+)*-\w*c\b/;

// True when the loop starting at loopIndex sits inside the quoted script
// of a timeout-wrapped shell: the quote opening that shell's -c argument
// is still open where the loop starts.
function insideTimeoutShell(command, loopIndex) {
  const prefix = command.slice(0, loopIndex);
  let wrapper = null;
  for (const found of prefix.matchAll(new RegExp(TIMEOUT_SHELL.source, "g"))) {
    wrapper = found;
  }
  if (wrapper === null) return false;
  const script = prefix.slice(wrapper.index + wrapper[0].length);
  const opener = /^\s*(['"])/.exec(script);
  if (opener === null) return false;
  const quote = opener[1];
  const rest = script.slice(opener[0].length);
  const closers = rest
    .split(quote)
    .filter((_, i, all) => i < all.length - 1)
    .filter((piece) => !piece.endsWith("\\")).length;
  return closers % 2 === 0;
}

// True when the command holds a sleeping loop with no timeout wrapper enclosing
// it and no counter or deadline inside it.
function hasUnboundedWaitLoop(command) {
  for (const match of command.matchAll(WAIT_LOOP)) {
    const [, condition, body] = match;
    if (!SLEEPS.test(condition) && !SLEEPS.test(body)) continue;
    if (COUNTS_OR_DEADLINE.test(condition) || COUNTS_OR_DEADLINE.test(body)) {
      continue;
    }
    if (insideTimeoutShell(command, match.index)) continue;
    return true;
  }
  return false;
}

// `timeout` options that take the next word as their value when not joined to
// it (`-s KILL`, `--kill-after 5`).
const TIMEOUT_VALUE_OPTIONS = new Set(["-s", "-k", "--signal", "--kill-after"]);
const DURATION = /^(\d+(?:\.\d*)?|\.\d+)[smhd]?$/;

// True when the command opens with `timeout <N>` (or `gtimeout <N>`), N a
// non-zero duration, followed by a command for it to bound.
function opensWithTimeout(command) {
  const words = tokenizeRaw(command);
  if (words[0] !== "timeout" && words[0] !== "gtimeout") return false;
  let i = 1;
  while (i < words.length && words[i].startsWith("-")) {
    i += TIMEOUT_VALUE_OPTIONS.has(words[i]) ? 2 : 1;
  }
  const duration = words[i];
  if (duration === undefined || !DURATION.test(duration)) return false;
  if (Number.parseFloat(duration) === 0) return false;
  return i + 1 < words.length;
}

// True when a `;`, `&&`, `||`, lone `&`, or newline stands outside quotes,
// where the command after it runs as a separate list element. An `&` inside a
// redirection (`2>&1`, `&>`, `>&`) or a `|&` pipe is not a separator.
function hasTopLevelListSeparator(command) {
  let quote = null;
  for (let i = 0; i < command.length; i += 1) {
    const char = command[i];
    if (quote === "'") {
      if (char === "'") quote = null;
      continue;
    }
    if (char === "\\") {
      i += 1;
      continue;
    }
    if (quote === '"') {
      if (char === '"') quote = null;
      continue;
    }
    if (char === "'" || char === '"') {
      quote = char;
      continue;
    }
    if (char === ";" || char === "\n") return true;
    const pair = command.slice(i, i + 2);
    if (pair === "&&" || pair === "||") return true;
    if (char === "&") {
      const before = command[i - 1];
      const after = command[i + 1];
      const inRedirection =
        before === ">" || before === "<" || before === "|" || after === ">";
      if (!inRedirection) return true;
    }
  }
  return false;
}

function isUnboundedBackground(command) {
  const trimmed = command.trim();
  return !opensWithTimeout(trimmed) || hasTopLevelListSeparator(trimmed);
}

function blockUnboundedLoop() {
  process.stderr.write(
    "Blocked by block-sleep-poll hook: this loop sleeps with no upper bound, so if " +
      "what it waits for never happens it keeps running after this session has " +
      "returned.\n" +
      "Bound the wait with a timeout wrapper -- " +
      "`timeout 600 sh -c 'until <test>; do sleep 2; done'` -- " +
      "or an iteration counter -- " +
      "`n=0; until <test> || [ $((n+=1)) -gt 300 ]; do sleep 2; done`.\n",
  );
  process.exit(2);
}

function blockUnboundedBackground() {
  process.stderr.write(
    "Blocked by block-sleep-poll hook: a run_in_background command has no timeout " +
      "of its own, so it must open with `timeout <N>` (N not zero) and hold no " +
      "later `;`, `&&`, `||`, lone `&`, or newline outside quotes.\n" +
      "Wrap the whole command -- `timeout 900 npm run lint`, or " +
      "`timeout 900 sh -c 'cd apps/web && npm test'` -- or, where no `timeout` " +
      "is on PATH, run it in the foreground with a raised timeout.\n",
  );
  process.exit(2);
}

function blockNakedSleep(seconds) {
  process.stderr.write(
    `Blocked by block-sleep-poll hook: this call is a bare ${seconds}-second sleep, ` +
      "which polls rather than waits -- every poll re-bills this session's whole context.\n" +
      "Wait one of the three ways that cost nothing while they wait: run the command in " +
      "the foreground and let the tool wait for it; start it with run_in_background, " +
      "opening with `timeout <N>` (N not zero), and wait for the completion notification; " +
      "or loop on the condition itself inside one " +
      "bounded call (`timeout 600 sh -c 'until <test>; do sleep 2; done'`).\n",
  );
  process.exit(2);
}

function main() {
  const event = eventForTools("Bash");
  if (event === null) process.exit(0); // unreadable, or another tool
  const command = commandOf(event);
  if (command === null) process.exit(0);
  const seconds = nakedSleepSeconds(command);
  if (seconds !== null && seconds >= MINIMUM_BLOCKED_SECONDS) {
    blockNakedSleep(seconds);
  }
  if (hasUnboundedWaitLoop(command)) blockUnboundedLoop();
  if (event.tool_input.run_in_background === true) {
    if (isUnboundedBackground(command)) blockUnboundedBackground();
  }
  process.exit(0);
}

try {
  main();
} catch {
  process.exit(0); // fail open: never wedge Bash on an unexpected hook error
}
