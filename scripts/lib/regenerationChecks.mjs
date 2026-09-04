// What the two in-place regeneration checks share -- check-routetree-fresh.mjs
// and check-vectors-generators.mjs. Both write over a checked-in generated file,
// run the real generator against it, and compare what comes back with what was
// there, so both owe the working tree its original bytes whatever happens, and
// both report where the two copies first diverge. Held here rather than beside
// each check: a correctness fix to either piece has one place to land instead of
// two that can silently disagree.

/** The signals a {@link withRestoreOnSignal} restore is armed against. */
export const RESTORE_SIGNALS = ["SIGINT", "SIGTERM"];

/**
 * Run `body` with `restore` armed against {@link RESTORE_SIGNALS}, and call
 * `restore` exactly once: when `body` returns or throws, when the promise it
 * returned settles, or -- ahead of any of those -- when one of those signals
 * arrives, which is then re-raised so the process still dies of what it was
 * sent. `body`'s value, or the settled value of its promise, is what this
 * returns; a throw from either side propagates once `restore` has run.
 *
 * `restore` is the caller's own, because what a restore has to put back differs:
 * one check rewrites bytes it kept in a backup directory, another rewrites bytes
 * and an mtime. Only the arming is shared, and the arming is the part a plain
 * `try`/`finally` cannot express -- a `finally` does not run when a signal
 * terminates the process, which would leave a regenerated copy, or a probe, in
 * the working tree the check promises not to touch.
 *
 * What the arming does not cover: a generator run synchronously (execFileSync)
 * blocks this process, and Node dispatches a signal to a JS handler only once
 * that call has returned, so a kill that takes the process mid-run leaves
 * whatever the generator had already written for git to restore. Held as a check
 * rather than a claim in prose by the sibling test's dispatch-gap case.
 */
export function withRestoreOnSignal(restore, body) {
  let restored = false;
  const restoreOnce = () => {
    if (restored) return;
    restored = true;
    restore();
  };
  const handlers = RESTORE_SIGNALS.map((signal) => {
    const handler = () => {
      restoreOnce();
      process.kill(process.pid, signal);
    };
    process.once(signal, handler);
    return [signal, handler];
  });
  const disarm = () => {
    for (const [signal, handler] of handlers) process.off(signal, handler);
    restoreOnce();
  };

  let outcome;
  try {
    outcome = body();
  } catch (error) {
    disarm();
    throw error;
  }
  if (typeof outcome?.then !== "function") {
    disarm();
    return outcome;
  }
  return outcome.then(
    (value) => {
      disarm();
      return value;
    },
    (error) => {
      disarm();
      throw error;
    },
  );
}

/** The stand-in reported for a line past the end of the shorter side. */
export const END_OF_FILE = "<end of file>";

/**
 * The 1-based number of the first line at which `committed` and `produced`
 * differ, with both sides of it, or null when they are identical. The sides are
 * named for what a regeneration check compares: the copy that is checked in
 * against what the generator produced. A side that has run out of lines displays
 * as {@link END_OF_FILE}.
 */
export function firstDifference(committed, produced) {
  const left = committed.split("\n");
  const right = produced.split("\n");
  for (let i = 0; i < Math.max(left.length, right.length); i += 1) {
    if (left[i] !== right[i]) {
      return {
        line: i + 1,
        committed: left[i] ?? END_OF_FILE,
        produced: right[i] ?? END_OF_FILE,
      };
    }
  }
  return null;
}

/**
 * {@link firstDifference}'s line number on its own, for a caller that reports
 * where two copies diverge without quoting either side.
 */
export function firstDifferingLine(committed, produced) {
  return firstDifference(committed, produced)?.line ?? null;
}
