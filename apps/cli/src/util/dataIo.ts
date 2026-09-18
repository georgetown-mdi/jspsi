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
 * How long the stdout result waits to be flushed before the run gives up on
 * the reader and carries on. A pipe's consumer sets the pace, so the drain
 * is normally as long as that consumer takes to read a few hundred kilobytes;
 * this bounds the other case, a consumer that has stopped reading altogether
 * and would otherwise hold a finished run open with no one left to receive
 * what it is holding.
 */
export const STDOUT_RESULT_DRAIN_CEILING_MS = 60_000;

/**
 * Write the result CSV to stdout and resolve once the last line has left the
 * process, or at {@link STDOUT_RESULT_DRAIN_CEILING_MS}.
 *
 * The drain waits on the LAST LINE's own write callback. A zero-length chunk
 * written after the rows is not equivalent: measured against a reader taking
 * 50,000 lines in 5 ms bursts, its callback fires with the stream's queue
 * already empty while the real write is still in flight, and an exit taken on
 * it truncated the result (45,582 of 50,000 lines), where the last line's
 * callback delivered all 50,000.
 */
function writeResultToStdout(
  headers: string[],
  rows: Array<Array<string>>,
): Promise<void> {
  return new Promise<void>((resolve) => {
    let settled = false;
    const flushed = (): void => {
      if (settled) return;
      settled = true;
      clearTimeout(ceiling);
      resolve();
    };
    const ceiling = setTimeout(flushed, STDOUT_RESULT_DRAIN_CEILING_MS);
    const lastRow = rows.length - 1;
    process.stdout.write(
      headers.join(",") + "\n",
      rows.length === 0 ? flushed : undefined,
    );
    rows.forEach((row, index) => {
      process.stdout.write(
        row.join(",") + "\n",
        index === lastRow ? flushed : undefined,
      );
    });
  });
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
 * once the last line has been flushed to the descriptor, or after
 * {@link STDOUT_RESULT_DRAIN_CEILING_MS} if the reader has stopped consuming.
 * A write to a pipe is buffered, so resolving before the flush would hand the
 * caller a result that is only partly out of the process, and the run's exit
 * would truncate it. The drain is bounded rather than unbounded because a
 * reader that never reads again would otherwise hold the run forever; what is
 * past the bound is lost, as a `>`-redirected result on a full disk already is.
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
    return writeResultToStdout(headers, rows);
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
