// The hook event on stdin: the read every hook in this directory opens with.
//
// Each hook is handed one JSON object on file descriptor 0 and decides from that
// alone. Fifteen of them opened with the same read, the same handling of an
// unreadable event, and the same tool_name test, so a fix to any of the three was
// fifteen edits with nothing to notice a missed one.
//
// Nothing here exits or blocks. What an unreadable event means is the hook's own
// answer -- most allow the call, require-clean-tree-for-review.mjs blocks -- so
// each states it at the call site.

import { readFileSync } from "node:fs";

/** The event on stdin, or null when it is not readable as a JSON object. */
export function readEvent() {
  let event;
  try {
    event = JSON.parse(readFileSync(0, "utf8"));
  } catch {
    return null;
  }
  return typeof event === "object" && event !== null ? event : null;
}

/**
 * The event on stdin when it names one of these tools, or null for anything
 * else: an unreadable event, or one for a tool this hook does not gate. The
 * hooks treat those two the same way, so one test at the call site covers both.
 */
export function eventForTools(...tools) {
  const event = readEvent();
  return event !== null && tools.includes(event.tool_name) ? event : null;
}

/** A Bash event's command line, or null when it carries none as a string. */
export function commandOf(event) {
  const command = event?.tool_input?.command;
  return typeof command === "string" ? command : null;
}

/**
 * The directory the call was made from, or null when the event names none. An
 * empty string names no directory, so it reads as absent.
 */
export function eventCwd(event) {
  const cwd = event?.cwd;
  return typeof cwd === "string" && cwd.length > 0 ? cwd : null;
}
