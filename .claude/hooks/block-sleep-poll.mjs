#!/usr/bin/env node
// PreToolUse hook: refuse a Bash call that is nothing but a long `sleep`, the
// shape a session takes when it polls for a background run to finish, and a
// loop that waits on a process with no upper bound.
//
// Why this exists: a poll is not cheap. Every one is a fresh tool round trip
// that re-bills the polling session's whole context, and the waiting session
// learns nothing it would not have been told -- a background run notifies on
// exit, and a foreground command is waited on by the tool itself.
//
// The sleep match is narrow, so a false positive costs a rephrase
// rather than a capability: ONLY a command that is exactly `sleep <duration>`
// with nothing else on the line, and only when that duration is at least five
// seconds. A shorter sleep is a settle, not a poll. A sleep that is part of a
// real command line -- a condition wait (`until curl -sf localhost:3000; do
// sleep 2; done`), a retry, a pipeline -- is left alone, because those wait on
// the condition rather than on the clock, which is the thing to do instead.
//
// The exits, which the block message names: run the command in the foreground
// and let the tool wait for it; start it with run_in_background and wait for the
// completion notification; or loop on the condition itself.
//
// One condition wait is refused: an `until` or `while` loop whose condition
// watches a process (`kill -0` or `pgrep`) and whose body sleeps, with no upper
// bound. If the process never exits the loop never ends, and it keeps running
// after the session that started it has returned. The loop counts as bounded
// when a `timeout ... sh -c` wrapper precedes it, or when its condition or body
// does shell arithmetic (`$((n+=1))`, `((...))`, `let`, `expr`) or reads
// `SECONDS` -- an iteration counter or a deadline. A condition wait on anything
// else, such as `until curl -sf ...`, stays allowed: it ends when a service
// comes up, not when a process the session may have lost track of exits.
//
// Exit 0 allows the call; exit 2 blocks it and feeds stderr back to Claude. Any
// unexpected failure here falls through to exit 0 (fail open) so a bug in this
// hook can never wedge every Bash command.

import { commandOf, eventForTools } from "./lib/event.mjs";

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
const WATCHES_PROCESS = /\bkill\s+-0\b|\bpgrep\b/;
const SLEEPS = /\bsleep\b/;
const COUNTS = /\$\(\(|\(\(|\blet\s|\bexpr\s|\bSECONDS\b/;
const TIMEOUT_SHELL =
  /\btimeout\s[^;&|\n]*\b(?:bash|sh|zsh|dash)\s+(?:-\w+\s+)*-\w*c\b/;

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

// True when the command holds a loop that waits on a process with no timeout
// wrapper enclosing it and no counter or deadline inside it.
function hasUnboundedProcessWait(command) {
  for (const match of command.matchAll(WAIT_LOOP)) {
    const [, condition, body] = match;
    if (!WATCHES_PROCESS.test(condition) || !SLEEPS.test(body)) continue;
    if (COUNTS.test(condition) || COUNTS.test(body)) continue;
    if (insideTimeoutShell(command, match.index)) continue;
    return true;
  }
  return false;
}

function blockUnboundedLoop() {
  process.stderr.write(
    "Blocked by block-sleep-poll hook: this loop waits on a process (`kill -0` or " +
      "`pgrep`) with no upper bound, so if the process never exits the loop keeps " +
      "running after this session has returned.\n" +
      "Bound the wait with a timeout wrapper -- " +
      "`timeout 600 bash -c 'while kill -0 1234 2>/dev/null; do sleep 2; done'` -- " +
      "or an iteration counter -- " +
      '`n=0; while kill -0 "$pid" 2>/dev/null && [ $((n+=1)) -le 300 ]; do sleep 2; done`.\n',
  );
  process.exit(2);
}

function block(seconds) {
  process.stderr.write(
    `Blocked by block-sleep-poll hook: this call is a bare ${seconds}-second sleep, ` +
      "which polls rather than waits -- every poll re-bills this session's whole context.\n" +
      "Wait one of the three ways that cost nothing while they wait: run the command in " +
      "the foreground and let the tool wait for it; start it with run_in_background and " +
      "wait for the completion notification; or loop on the condition itself " +
      "(`until <test>; do sleep 2; done`), which this hook does not touch.\n",
  );
  process.exit(2);
}

function main() {
  const event = eventForTools("Bash");
  if (event === null) process.exit(0); // unreadable, or another tool
  const command = commandOf(event);
  if (command === null) process.exit(0);
  const seconds = nakedSleepSeconds(command);
  if (seconds !== null && seconds >= MINIMUM_BLOCKED_SECONDS) block(seconds);
  if (hasUnboundedProcessWait(command)) blockUnboundedLoop();
  process.exit(0);
}

try {
  main();
} catch {
  process.exit(0); // fail open: never wedge Bash on an unexpected hook error
}
