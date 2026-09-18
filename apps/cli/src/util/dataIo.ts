// The command's data in and data out: the input CSV as a readable stream, and
// the result CSV written owner-only to a path or plainly to stdout. Kept apart
// from the diagnostic sink in ./logging, which owns stderr.

import fs from "node:fs";

import {
  keepOperatorSuppliedText,
  messageWithOperatorText,
  operatorSuppliedText,
  UsageError,
} from "@psilink/core";

import { createOwnerOnlyWriteStream } from "../fileUtils";
import { settleWithinCeiling, type CeilingOutcome } from "./ceiling";

/**
 * Resolve a CSV input positional to the readable stream core's `loadCSVFile`
 * consumes: `process.stdin` when `input` is `-`, otherwise the file at
 * `input`, opened with `fs.createReadStream` after confirming it exists.
 *
 * The not-found error names `input` as the operator's own text, so it renders
 * as they typed it rather than escaped, and every caller must pass a path that
 * came from argv or from the operator's configuration. A partner- or
 * server-delivered string passed here would reach the display unescaped.
 *
 * Thrown errors hold an `exitCode` for the caller to forward to
 * `process.exit`: a missing file throws with `exitCode: 69`.
 *
 * `allowStdin` gates the `-` case. Every input command supports stdin;
 * `accept` supports it only with `--consent-to-terms`, since otherwise it
 * reads its interactive y/N confirmation from `process.stdin`
 * (`promptConfirm`), and stdin is single-use -- a stdin CSV would starve that
 * prompt into a silent decline. The rejection message is command-agnostic,
 * since the default is `false`.
 *
 * When `-` is allowed but `process.stdin` is an interactive terminal with
 * nothing piped in, reading it would block forever, so that case is rejected
 * up front as a {@link UsageError} naming both alternatives. The check is
 * strict `=== true`: `isTTY` is `undefined` (not `false`) for a pipe, a `<`
 * redirect, or `/dev/null`, so a strict test can never reject a legitimate
 * non-interactive run.
 *
 * The guard covers only an interactive terminal; a non-TTY stream that
 * delivers data but never reaches EOF (an unclosed FIFO, a stalled producer)
 * still blocks -- a visible, interruptible hang, not data loss.
 */
export function openInputSource(
  input: string,
  { allowStdin = false }: { allowStdin?: boolean } = {},
): NodeJS.ReadableStream {
  if (input === "-") {
    if (!allowStdin)
      throw new UsageError(
        "this command cannot read its input CSV from stdin; pass a file path " +
          "instead of `-`",
      );
    if (process.stdin.isTTY === true)
      throw new UsageError(
        "nothing is piped to stdin, so `-` would wait for input forever; pipe " +
          "a CSV (e.g. `cat data.csv | psilink exchange - results.csv`) or pass " +
          "a file path instead of `-`",
      );
    return process.stdin;
  }
  if (!fs.existsSync(input)) {
    const message = messageWithOperatorText`${operatorSuppliedText(input)} does not exist`;
    throw Object.assign(
      keepOperatorSuppliedText(new Error(message.text), message),
      { exitCode: 69 },
    );
  }
  return fs.createReadStream(input);
}

/**
 * True when stdout (fd 1) is a redirected regular file -- a `> file` shell
 * redirect -- as opposed to a TTY, a pipe, or a character device like
 * `/dev/null`. `fs.fstatSync(1).isFile()` is the distinguishing test:
 * `process.stdout.isTTY` cannot tell a `> file` redirect from a pipe (both
 * report `undefined`). Best-effort: any stat failure yields `false`, since a
 * detection fault must never abort the result write it only annotates.
 */
function stdoutIsRedirectedFile(): boolean {
  try {
    return fs.fstatSync(1).isFile();
  } catch {
    return false;
  }
}

/**
 * How long the stdout result may go with no line leaving the process before
 * the run gives up on the reader. A pipe's consumer sets the pace, and a
 * result of any size can take as long as that consumer needs to read it, so
 * what this bounds is a consumer that has stopped reading altogether and would
 * otherwise hold a finished run open with no one left to receive what it is
 * holding. Each time the reader takes what is buffered starts it again.
 */
export const STDOUT_RESULT_IDLE_CEILING_MS = 60_000;

/**
 * What the run reports when the drain went its whole idle ceiling with nothing
 * leaving the process: the result was not delivered, and the exchange it came
 * from still happened.
 */
export function stdoutDrainExpiredNotice(idleCeilingMs: number): string {
  return (
    `nothing more of the result left the process for ` +
    `${Math.round(idleCeilingMs / 1000)}s, so the reader has stopped taking ` +
    `it and what is past that point is lost. The exchange itself completed, ` +
    `so re-running conducts a second one: fix the receiving command to keep ` +
    `reading, and write the result to a path instead of a pipe if it cannot.`
  );
}

/**
 * What the run reports when the write to stdout failed outright: the same loss
 * the ceiling reports, reached by the reader closing the pipe rather than by
 * stopping at it.
 */
function stdoutWriteFailedNotice(): string {
  return (
    `the result could not be written to stdout, so what is past the point it ` +
    `stopped is lost. The exchange itself completed, so re-running conducts a ` +
    `second one: fix the receiving command to read the result to its end, and ` +
    `write the result to a path instead of a pipe if it cannot.`
  );
}

// Installed for the rest of the process once a result write to stdout has
// failed or reached its drain ceiling. The pipe still holds what was not
// flushed, so a reader that dies later -- during the exchange record and
// receipt writes, or the transport teardown -- emits an `'error'` on a stream
// with no listener, which ends the process before the run's terminal event.
// The loss is already reported by the throw that installs this, and nothing
// after it writes to stdout, so there is nothing further to say about one.
let laterStdoutErrorsIgnored = false;
function ignoreStdoutError(): void {}
function ignoreLaterStdoutErrors(): void {
  if (laterStdoutErrorsIgnored) return;
  laterStdoutErrorsIgnored = true;
  process.stdout.on("error", ignoreStdoutError);
}

/**
 * Remove the `process.stdout` `'error'` guard a failed result write leaves
 * installed, so a case drives that install from a known state.
 *
 * @internal exported for testing
 */
export function resetStdoutErrorGuard(): void {
  if (!laterStdoutErrorsIgnored) return;
  process.stdout.off("error", ignoreStdoutError);
  laterStdoutErrorsIgnored = false;
}

/**
 * Write the result CSV to stdout, resolving once the last line has left the
 * process and REJECTING if no line has left it for `idleCeilingMs` or if the
 * write fails.
 *
 * The drain waits on the LAST LINE's own write callback. A zero-length chunk
 * written after the rows is not equivalent: measured against a reader taking
 * 50,000 lines in 5 ms bursts, its callback fires with the stream's queue
 * already empty while the real write is still in flight, and an exit taken on
 * it truncated the result (45,582 of 50,000 lines), where the last line's
 * callback delivered all 50,000.
 *
 * The lines before it are written under BACKPRESSURE -- fill the stream's
 * buffer, wait for its `'drain'`, write on -- and each `'drain'` is the
 * progress that restarts the ceiling ({@link settleWithinCeiling}). That is
 * what makes the ceiling a bound on a reader that STOPPED rather than on one
 * that is slow: a consumer taking a large result in small reads holds the
 * drain open for as long as it needs, where a total budget would fail it
 * however much it had taken. Writing every line in one pass reports nothing
 * to bound: measured against 60,000 lines read at about 1 MB/s, one pass hands
 * libuv a single write it completes at the end, and all 60,001 callbacks
 * arrive together 6.4 s in, where the same result written under backpressure
 * reported 77 drains spread across it. A reader taking less than the stream's
 * buffer in a whole ceiling is read as stopped, which at a ceiling of a minute
 * is a kilobyte a second.
 *
 * Reaching the ceiling is a result that was not delivered, which is what the
 * caller's own result-write failure path reports, so it is raised rather than
 * resolved: resolving would hand back a flush and a give-up as the same
 * outcome, and the run would report a result it still holds as written.
 *
 * A reader that CLOSES the pipe -- `psilink ... | head -1` past the pipe's own
 * buffer -- is the same loss and takes the same path, over two channels
 * because neither covers it alone. The last line's callback reports an EPIPE
 * that reaches that line, and an `'error'` listener held for the drain's
 * duration reports one that reaches any earlier write, whose callback this
 * does not take; without that listener `process.stdout` emits an unhandled
 * `'error'` and the run ends there, before the record of the disclosure it
 * already made is written.
 *
 * Either failure leaves a no-op `'error'` listener behind it for the rest of
 * the process ({@link ignoreLaterStdoutErrors}): the data the reader did not
 * take is still queued, so a reader that dies during the writes or the
 * teardown that follow would otherwise end the run before its terminal event.
 * A drain that finished leaves nothing queued and removes its listener.
 */
async function writeResultToStdout(
  headers: string[],
  rows: Array<Array<string>>,
  idleCeilingMs: number,
): Promise<void> {
  // Both assigned by the executor inside the wait below, which runs
  // synchronously before that call returns.
  let rejectDrain!: (err: unknown) => void;
  let onDrain!: () => void;
  let outcome: CeilingOutcome;
  try {
    outcome = await settleWithinCeiling(
      idleCeilingMs,
      (noteProgress) =>
        new Promise<void>((resolve, reject) => {
          rejectDrain = reject;
          process.stdout.on("error", reject);
          const flushed = (err?: Error | null): void => {
            if (err === undefined || err === null) resolve();
            else reject(err);
          };
          let next = 0;
          const pump = (): void => {
            while (next <= rows.length) {
              const isLast = next === rows.length;
              const line =
                next === 0
                  ? headers.join(",") + "\n"
                  : rows[next - 1].join(",") + "\n";
              next += 1;
              const accepted = process.stdout.write(
                line,
                isLast ? flushed : undefined,
              );
              // The last line waits on its own callback rather than on a
              // further drain, which is the same wait one event later.
              if (!accepted && !isLast) {
                process.stdout.once("drain", onDrain);
                return;
              }
            }
          };
          onDrain = (): void => {
            noteProgress();
            pump();
          };
          pump();
        }),
    );
  } catch (err) {
    ignoreLaterStdoutErrors();
    throw new Error(stdoutWriteFailedNotice(), { cause: err });
  } finally {
    // The pump is parked on a drain that never came where the wait expired,
    // and writing on once the run has reported the loss would hand lines to a
    // reader it has already told the operator is gone.
    process.stdout.off("drain", onDrain);
    process.stdout.off("error", rejectDrain);
  }
  if (!outcome.finished) {
    ignoreLaterStdoutErrors();
    throw new Error(stdoutDrainExpiredNotice(idleCeilingMs));
  }
}

/**
 * Write formatted exchange results to a file or stdout as CSV, resolving once
 * the write is complete. When given an output path, the result CSV -- the
 * most sensitive artifact the tool produces -- is created owner-only (see
 * {@link createOwnerOnlyWriteStream}).
 *
 * `headers` and `rows` arrive as RFC 4180 FIELDS, not as raw values: core's
 * `buildOutputTable` quotes any cell containing a comma, a double quote, CR
 * or LF and doubles that cell's embedded quotes. Both branches join the
 * fields with commas and escape nothing themselves -- a second pass here
 * would double-escape and break the verify path's re-supply. Pinned by the
 * write-then-read round trip in `test/unit/util/resultCsvEscaping.test.ts`.
 *
 * The file path is owned end to end: the returned promise resolves on the
 * stream's `'close'` (all rows flushed AND the descriptor closed) and rejects
 * on any `'error'`, so a mid-write or close failure (a full disk, a revoked
 * mount) is recoverable rather than crashing with no diagnostic, and the
 * caller can order a later write (the secondary exchange record) after the
 * result file is durable. Resolving on `'close'` rather than `'finish'`
 * matters: a networked or userspace filesystem (NFS/CIFS/FUSE) and a full
 * disk both defer their error to the `close(2)` that follows the last
 * flushed write, arriving after `'finish'` -- which would report a truncated
 * result CSV as written.
 *
 * The stdout branch (no path given) writes to `process.stdout` and resolves
 * once the last line has been flushed to the descriptor. A write to a pipe is
 * buffered, so resolving before the flush would hand the caller a result that
 * is only partly out of the process, and the run's exit would truncate it.
 * That wait is bounded by how long it goes with nothing leaving the process --
 * a reader that never reads again would otherwise hold the run forever, while
 * a slow one is entitled to as long as it takes -- and reaching the bound
 * rejects, on the same channel as the file branch's own faults: what the
 * reader did not take is as lost as a result that never reached disk, and the
 * caller reports both the same way. A reader that closes the pipe rather than
 * stalling at it rejects on that same channel, from the failed write instead
 * of from the bound. `idleCeilingMs` is that bound; it is a parameter so a
 * test can drive the expiry rather than wait one out.
 *
 * Before it writes, it checks whether stdout is a redirected
 * regular file ({@link stdoutIsRedirectedFile}) and, if so, notifies the
 * operator on `log` at ERROR level (not warn, since a routine
 * `--log-level error` must not hide an operator-actionable data exposure): a
 * `> file` redirect is created by the shell under its umask, not the
 * owner-only permissions an OUTPUT_FILE path gets, so on a shared host the
 * matched records can silently land group/world-readable. Detection is
 * fd-1-local -- a redirect applied outside this process (e.g. across a
 * container boundary) is undetectable, so the absence of the notice is not a
 * guarantee the output is owner-only.
 */
export function writeOutput(
  output: string | undefined,
  headers: string[],
  rows: Array<Array<string>>,
  log: { error: (message: string) => void },
  idleCeilingMs: number = STDOUT_RESULT_IDLE_CEILING_MS,
): Promise<void> {
  if (output === undefined) {
    if (stdoutIsRedirectedFile())
      log.error(
        "result written to redirected stdout: the shell created that file " +
          "under its umask, not the owner-only permissions an OUTPUT_FILE path " +
          "gets, so on a shared host the matched records may be " +
          "group/world-readable. Pass an OUTPUT_FILE path argument instead of " +
          "redirecting stdout with `>` to have psilink create the result " +
          "owner-only.",
      );
    return writeResultToStdout(headers, rows, idleCeilingMs);
  }
  return new Promise<void>((resolve, reject) => {
    // createOwnerOnlyWriteStream is inside the executor so a synchronous failure
    // (a missing parent dir, the fchmod/icacls refusal) rejects the promise too,
    // rather than throwing past it -- the caller sees one failure channel.
    const out = createOwnerOnlyWriteStream(output);
    out.on("error", reject);
    out.on("close", () => resolve());
    out.write(headers.join(",") + "\n");
    for (const row of rows) out.write(row.join(",") + "\n");
    out.end();
  });
}
