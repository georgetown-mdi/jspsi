#!/usr/bin/env node
// PreToolUse hook: refuse a Bash call that is nothing but a long `sleep`, the
// shape a session takes when it polls for a background run to finish.
//
// Why this exists: a poll is not cheap. Every one is a fresh tool round trip
// that re-bills the polling session's whole context, and the waiting session
// learns nothing it would not have been told -- a background run notifies on
// exit, and a foreground command is waited on by the tool itself.
//
// What it matches is narrow, so a false positive costs a rephrase
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
  process.exit(0);
}

try {
  main();
} catch {
  process.exit(0); // fail open: never wedge Bash on an unexpected hook error
}
