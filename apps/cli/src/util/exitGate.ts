// The bound between a command finishing everything it owes and the process
// returning to whoever started it. A scheduled run's caller -- cron, a
// supervisor, a container runtime -- waits on the process, not on the work,
// so a dependency that leaves a timer or a socket armed after the run is over
// holds a slot that the run itself has finished with. This module states how
// long that is allowed to last and reports what held it.

import fs from "node:fs";

/**
 * How long the process may stay alive after the command it ran has settled,
 * before it is made to return.
 *
 * The clock starts when the command promise settles, which is after every
 * local obligation the run owes -- the result file, the exchange record, the
 * receipt, the terminal event on fd 3, the log flush -- so the budget bounds
 * only what is left holding the event loop with no work behind it. Measured
 * from settlement to natural exit on a completed two-party `filedrop`
 * exchange, that drain was 0-1 ms across ten party-runs, so this is three
 * orders of magnitude of headroom rather than a wait any healthy run spends:
 * a clean event loop exits on its own and never reaches it.
 */
export const PROCESS_RETURN_BUDGET_MS = 3_000;

/**
 * The distinct resource kinds currently keeping the event loop alive, from
 * `process.getActiveResourcesInfo()`, deduplicated and ordered so one run's
 * report reads the same as another's. Node's own closed vocabulary of handle
 * and request type names (`Timeout`, `TCPSocketWrap`, `PipeWrap`), never a
 * value from a partner or a server, so nothing here needs escaping. An
 * unref'd handle does not appear: it is not what holds the loop.
 */
export function heldResourceKinds(): string[] {
  return [...new Set(process.getActiveResourcesInfo())].sort();
}

/**
 * The line the process writes when it reaches {@link PROCESS_RETURN_BUDGET_MS}
 * with the loop still held: how long it waited past the run's own work, and
 * which resource kinds were still armed.
 *
 * `kinds` can be empty -- the loop is held by something Node does not name in
 * that report -- and the line says so rather than trailing off after a colon.
 */
export function processHeldNotice(
  elapsedMs: number,
  kinds: readonly string[],
): string {
  const held =
    kinds.length === 0 ? "something Node does not name" : kinds.join(", ");
  return (
    `psilink finished this run and wrote its files, but the process was ` +
    `still held open ${Math.round(elapsedMs / 1000)}s later by: ${held}. ` +
    `Exiting with the run's own status; report this with those names.`
  );
}

/**
 * Write one line to stderr with `fs.writeSync`, looping over a short write.
 * Not `console.error` or `process.stderr.write`: a write to a pipe is
 * asynchronous on some platforms, and the caller here exits the process on the
 * next statement, which would drop the line on exactly the runs it exists for.
 */
function writeStderrLine(line: string): void {
  const buf = Buffer.from(line + "\n", "utf8");
  let offset = 0;
  try {
    while (offset < buf.length)
      offset += fs.writeSync(2, buf, offset, buf.length - offset);
  } catch {
    // stderr is closed or wedged. The exit status is the outcome either way,
    // and a failed diagnostic must not become the reason the process hangs.
  }
}

/**
 * Whether a signal handler has taken responsibility for ending this process.
 * Module state rather than a parameter: the handler that takes it over and the
 * entry point that arms the gate are in different modules and share no value.
 */
let signalOwnsExit = false;

/**
 * Record that a signal handler is ending this process with the status the
 * signal calls for, so {@link armProcessReturnGate} stays out of its way.
 *
 * An interrupt's teardown runs after the command promise has already settled,
 * so the gate would otherwise be armed over a handler that has not reached its
 * own exit yet, and a teardown longer than the budget would end the run at the
 * gate's status and print a notice saying the run finished and wrote its files.
 */
export function noteSignalOwnsExit(): void {
  signalOwnsExit = true;
}

/**
 * The status the gate exits with: the one the run already resolved.
 *
 * `process.exitCode` is `number | string | null | undefined`, and only a number
 * is an exit status this can forward; anything else, and an unset code, is the
 * clean 0 a command that set nothing means.
 */
function resolvedExitCode(): number {
  return typeof process.exitCode === "number" ? process.exitCode : 0;
}

/**
 * Arm the one deadline that makes the process return: after `budgetMs` with
 * the event loop still held, name the resource kinds still armed on stderr and
 * exit with the code the run already resolved.
 *
 * The timer is unref'd, so a clean loop exits naturally and silently and no
 * run pays the budget. The handle that held the loop is never unref'd or
 * closed from here: sweeping it would hide the next leak instead of reporting
 * it, and nothing at this boundary knows what a stranger's handle owes.
 *
 * Called once, after the command promise settles. A signal handler owning the
 * exit ({@link noteSignalOwnsExit}) stops it, whether that ownership was taken
 * before the gate was armed or while it was waiting, so an interrupt always
 * ends the process on its own status. The status here is read from
 * `process.exitCode` and passed explicitly, so a persistence loss that set 73
 * keeps it and a clean run still exits 0: a housekeeping fact about the
 * process never changes the exchange's own outcome.
 */
export function armProcessReturnGate(
  budgetMs: number = PROCESS_RETURN_BUDGET_MS,
): void {
  if (signalOwnsExit) return;
  const armedAt = Date.now();
  const deadline = setTimeout(() => {
    if (signalOwnsExit) return;
    writeStderrLine(
      processHeldNotice(Date.now() - armedAt, heldResourceKinds()),
    );
    process.exit(resolvedExitCode());
  }, budgetMs);
  deadline.unref();
}
