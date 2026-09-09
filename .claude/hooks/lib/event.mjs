// The hook event on stdin: the read every hook in this directory opens with.
//
// Every hook is handed one JSON object on file descriptor 0 and decides from
// that alone. Each reads stdin, handles an unreadable event, and tests
// tool_name the same way; sharing that logic here means a fix to any of the
// three applies to every hook at once. Reading a Workflow's `args` is here for
// the same reason: two gates read the same field out of the same three
// deliveries, and a delivery one of them mishandles is one the other does too.
//
// Nothing here exits or blocks. What an unreadable event means is the hook's own
// answer -- most allow the call, require-clean-tree-for-review.mjs and
// block-model-drop-sendmessage.mjs block -- so each states it at the call site.
// The two unreadable shapes are reported apart for that reason: stdin holding
// nothing parseable is null and every hook allows on it, while a JSON value that
// is not an object is NOT_AN_EVENT, which the two that block refuse.

import { readFileSync } from "node:fs";

/**
 * Stands in for the event when stdin held a parseable JSON value that is not an
 * object: null, an array, a number, a string. It names no tool, so nothing in it
 * can rule a call out, which is why the hooks that must confirm a call before
 * allowing it refuse this payload rather than treating it as no event at all.
 */
export const NOT_AN_EVENT = Symbol("not an event");

/**
 * The event on stdin: a JSON object, NOT_AN_EVENT when stdin held a JSON value
 * of any other shape, or null when it held nothing parseable.
 */
export function readEvent() {
  let event;
  try {
    event = JSON.parse(readFileSync(0, "utf8"));
  } catch {
    return null;
  }
  const isObject =
    typeof event === "object" && event !== null && !Array.isArray(event);
  return isObject ? event : NOT_AN_EVENT;
}

/**
 * The event on stdin when it names one of these tools, or null for anything
 * else: an unreadable event of either shape, or one for a tool this hook does
 * not gate. The hooks that allow the call on all of those treat them the same
 * way, so one test at the call site covers them.
 */
export function eventForTools(...tools) {
  const event = readEvent();
  if (event === null || event === NOT_AN_EVENT) return null;
  return tools.includes(event.tool_name) ? event : null;
}

/** A Bash event's command line, or null when it holds none as a string. */
export function commandOf(event) {
  const command = event?.tool_input?.command;
  return typeof command === "string" ? command : null;
}

/**
 * A Workflow call's named arguments as an object, or null when `args` was
 * delivered in a shape holding no named field -- a string that is not JSON, a
 * primitive, an array. Absent arguments are an empty set, not an unreadable one,
 * so they come back as `{}`. What null means is the caller's: the gates that
 * must confirm something about a named argument refuse it, and the ones that
 * only refine a call allow it.
 */
export function workflowArgs(toolInput) {
  const delivered = toolInput?.args;
  if (delivered === undefined || delivered === null) return {};
  let resolved = delivered;
  if (typeof delivered === "string") {
    try {
      resolved = JSON.parse(delivered);
    } catch {
      return null;
    }
  }
  if (
    resolved === null ||
    typeof resolved !== "object" ||
    Array.isArray(resolved)
  ) {
    return null;
  }
  return resolved;
}

/**
 * The directory the call was made from, or null when the event names none. An
 * empty string names no directory, so it is treated as absent.
 */
export function eventCwd(event) {
  const cwd = event?.cwd;
  return typeof cwd === "string" && cwd.length > 0 ? cwd : null;
}
