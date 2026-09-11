// The per-session record that the orchestration ruleset has been read, and
// where that record is kept.
//
// Two hooks split the job: record-orchestration-ruleset-read.mjs writes the
// marker when a session reads the ruleset, and
// require-orchestration-ruleset-read.mjs refuses that session's first Agent or
// Workflow call until one is there and fresh. They must derive the same path
// from the same session id and agree on how long a read stands for -- a
// divergence in either would refuse every spawn in every session, since the gate
// would be looking where nothing is ever written -- so both live here rather
// than in each hook.
//
// WHERE THE MARKERS GO, and why not under the repository. The two hooks fire
// from whichever checkout the session is working in, and one session works in
// the primary checkout and in a linked worktree in turn; a path under the
// harness's own temp directory is the same from all of them without asking git
// anything, which is what keeps the recorded read findable. It is also outside
// every checkout, so no marker can become repository content or appear in a
// working tree's status. The cost is that the markers do not survive a reboot,
// which costs a session one re-read.

import { mkdirSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

/** The ruleset, as a path relative to a checkout's root. */
export const RULESET_PATH = ".claude/orchestration/ruleset.md";

/**
 * The tail a command line names the ruleset by from any directory inside the
 * repository, so a session that reads it from within `.claude/` still matches.
 */
export const RULESET_TAIL = RULESET_PATH.split("/").slice(-2).join("/");

/**
 * How long a recorded read stands for. Long enough to cover an orchestration
 * session's working stretch, which hands off well inside it, and short enough
 * that a session resumed a day later reads the file again -- the re-read the
 * rule asks for after a context reset, which keeps the session id it was
 * recorded under.
 */
export const READ_TTL_MS = 8 * 60 * 60 * 1000;

const MARKER_DIR = join(tmpdir(), "psilink-orchestration-reads");

// A session id is a UUID, so this bound is never reached by one; it holds for
// whatever else a harness may put in the field.
const KEY_LENGTH_LIMIT = 128;

/**
 * The marker file for a session id, or null when the id is missing or holds no
 * character a filename can be built from. Everything outside the filename set
 * is replaced and leading dots are stripped, so no id can name a directory
 * component of its own.
 */
export function markerPath(sessionId) {
  if (typeof sessionId !== "string") return null;
  const key = sessionId
    .replace(/[^A-Za-z0-9._-]+/g, "_")
    .replace(/^\.+/, "")
    .slice(0, KEY_LENGTH_LIMIT);
  return key.length === 0 ? null : join(MARKER_DIR, key);
}

/**
 * How long ago the read was recorded, from the marker's mtime, or null when no
 * marker is there or it cannot be statted. The mtime is the record: the
 * timestamp written into the file is for a person listing the directory.
 */
export function recordedReadAgeMs(path) {
  try {
    return Date.now() - statSync(path).mtimeMs;
  } catch {
    return null;
  }
}

/**
 * Record a read at `path`, creating the marker directory when it is missing.
 * False when the write failed, which the caller decides what to do about.
 */
export function recordRead(path) {
  try {
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, `${new Date().toISOString()}\n`);
    return true;
  } catch {
    return false;
  }
}
