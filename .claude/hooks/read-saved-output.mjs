#!/usr/bin/env node
// PostToolUse hook: when the harness persists an oversized Bash result to a file
// and shows the session only a preview, read that file back into context.
//
// Why this exists: a long build, test, or log command routinely exceeds the
// inline result budget. The harness then writes the whole output to a file under
// the session's tool-results directory and renders a short notice plus the first
// couple of kilobytes. A session that acts on the preview alone reasons from the
// beginning of a run whose verdict is at its end -- the failing assertion, the
// summary line, the exit status -- and an agent with no next turn cannot go and
// read the file after the fact. Reading it back at the moment of truncation puts
// the verdict where the decision is made.
//
// THE ANCHOR, and the misfire it closes. The notice is matched only at the START
// of a candidate field, optionally behind the harness's own <persisted-output>
// wrapper line -- never anywhere inside the text. An unanchored search matches
// output that merely CONTAINS the notice, which is not exotic: printing this
// file, grepping the hooks directory, or catting a transcript all quote it, and
// the hook then chases a path built out of the quoted line and warns about a file
// that was never supposed to exist. Anchoring makes the match structural rather
// than lexical: only the harness writes that sentence at position zero.
//
// STATED LIMITS.
//   - The anchor is deliberately strict, so a change to the notice's wording or
//     framing makes this hook SILENT rather than noisy. That is the direction to
//     fail in: the session still sees the harness's own notice and can read the
//     file itself, while a loosened match resumes misfiring on quoted text.
//   - What a PostToolUse payload carries for a persisted result is the harness's
//     business and is not asserted here: every string-valued candidate field is
//     tried, and no field carrying the notice means no readback. Measured on the
//     2026-08-31 harness by running a command with 60KB of output, the rendered
//     notice reads `Output too large (60.5KB). Full output saved to: <path>`
//     inside a <persisted-output> element; the payload's own shape was not
//     observable from inside a session, so a payload that never carries it
//     leaves this hook inert rather than wrong.
//   - The readback is capped at READBACK_BYTES and says so when it truncates.
//     The file itself stays on disk for a targeted read of the rest.
//
// PostToolUse cannot block -- the command has already run -- so the only outcomes
// are an additionalContext message or silence. Fail open on every error.

import { readFileSync, statSync } from "node:fs";

const READBACK_BYTES = 51200;
const CANDIDATE_FIELDS = ["output", "stdout", "content"];

// The harness's persisted-result notice, anchored to the start of the field.
const NOTICE =
  /^\s*(?:<persisted-output>\r?\n)?Output too large \([^)\r\n]*\)\. Full output saved to: ([^\r\n]+?)[ \t]*(?:\r?\n|$)/;

function candidates(toolResponse) {
  if (typeof toolResponse === "string") return [toolResponse];
  if (toolResponse === null || typeof toolResponse !== "object") return [];
  return CANDIDATE_FIELDS.map((field) => toolResponse[field]).filter(
    (value) => typeof value === "string",
  );
}

/** The persisted-output path a candidate field announces, or null. */
function savedOutputPath(toolResponse) {
  for (const candidate of candidates(toolResponse)) {
    const match = NOTICE.exec(candidate);
    if (match) return match[1];
  }
  return null;
}

function emit(additionalContext) {
  process.stdout.write(
    JSON.stringify({
      hookSpecificOutput: { hookEventName: "PostToolUse", additionalContext },
    }),
  );
  process.exit(0);
}

function readback(path) {
  const contents = readFileSync(path, "utf8");
  const kept = contents.slice(0, READBACK_BYTES);
  const note =
    kept.length < contents.length
      ? `\n[read back to ${READBACK_BYTES} bytes -- read '${path}' directly for the rest]`
      : "";
  return `Full bash output (read from ${path}):\n${kept}${note}`;
}

function main() {
  let event;
  try {
    event = JSON.parse(readFileSync(0, "utf8"));
  } catch {
    process.exit(0); // unreadable event -- do not interfere
  }
  if (event.tool_name !== "Bash") process.exit(0);

  const path = savedOutputPath(event.tool_response);
  if (path === null) process.exit(0);

  try {
    if (!statSync(path).isFile()) throw new Error("not a regular file");
  } catch {
    emit(
      `WARNING: this command's output was too large to show and was saved to ${path}, ` +
        "but that path is not a readable file. The result above is a preview only -- " +
        "re-run the command narrowed to what you need rather than concluding from it.",
    );
  }

  try {
    emit(readback(path));
  } catch (error) {
    emit(
      `WARNING: this command's output was too large to show and was saved to ${path}, ` +
        `which could not be read back (${error?.message ?? error}). The result above is ` +
        "a preview only -- read that file directly before concluding from it.",
    );
  }
}

try {
  main();
} catch {
  process.exit(0); // fail open: never disrupt the session on an unexpected error
}
