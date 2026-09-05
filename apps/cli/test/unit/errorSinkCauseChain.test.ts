import fs from "node:fs";

import { afterEach, expect, test, vi } from "vitest";

import {
  COMPOSED_MESSAGE_MAX_DISPLAY_LENGTH,
  DISPLAY_TRUNCATION_MARKER,
  sanitizeErrorForDisplay,
  UsageError,
} from "@psilink/core";
import { withCapturedLogs } from "@psilink/core/testing";

import { EVENT_STREAM_FD, type ErrorEvent } from "../../src/eventStream";
import { openEventStreamWithFdWired } from "../eventStreamTestSupport";
import { exitWithError, runOrExit } from "../../src/util/exit";
import { parseOrExit } from "../../src/util/flags";
import { captureProcessExit } from "../exitCapture";

// src/index.ts is a module-top-level side effect -- buildCli(...).parseAsync()
// with the last-resort catch attached to it -- so its own catch runs only when
// the module is imported with the parser it builds replaced by one that rejects.
const { parseAsync } = vi.hoisted(() => ({
  parseAsync: vi.fn<() => Promise<never>>(),
}));
vi.mock("../../src/cliParser", () => ({
  buildCli: () => ({ parseAsync }),
}));

afterEach(() => {
  vi.restoreAllMocks();
});

// --- the error every sink is driven with -------------------------------------
// A refusal composed the way the partitioned ones are: the summary on the
// error's own message, the step the operator has to act on a cause link of
// its own. sanitizeErrorForDisplay caps each link separately, so a summary
// sharing its link with a fragment somebody else chose spends the budget on
// that fragment. Synthesized rather than raised from a flow that composes
// this shape: the subject here is the sinks.

// The fragment somebody else chose, sized off the renderer's own link budget so
// it overruns that link whatever the budget is.
const REMOTE_CHOSEN_LABEL = "partner-chosen-label.";
const REMOTE_CHOSEN_FRAGMENT = `sftp.${REMOTE_CHOSEN_LABEL.repeat(
  Math.ceil(COMPOSED_MESSAGE_MAX_DISPLAY_LENGTH / REMOTE_CHOSEN_LABEL.length),
)}example`;

const REFUSAL_SUMMARY =
  "the server's identity could not be confirmed, so no connection was made " +
  `and nothing was written; configured host: ${REMOTE_CHOSEN_FRAGMENT}`;

// Restated whole, so a sink delivering a PREFIX of it -- what a shared link
// leaves behind once the cap falls -- fails rather than matching a phrase that
// happens to survive.
const RECOVERY_STEP =
  "Obtain the server's fingerprint out-of-band and pin it by setting " +
  "connection.server.host_key_fingerprint in the configuration file, or run " +
  "once from an interactive terminal to review and pin the presented key.";

// Every sink is driven with a UsageError because parseOrExit renders only that
// class (anything else rethrows); UsageError forwards options.cause to Error, so
// one error shape serves the whole table.
function partitionShapedError(): UsageError {
  return new UsageError(REFUSAL_SUMMARY, { cause: new Error(RECOVERY_STEP) });
}

// The renderer's own cause-link separator, read back out of a two-link render
// rather than restated here, so splitting a rendered chain into its links cannot
// drift from the framing the renderer emits.
const CAUSE_SEPARATOR = sanitizeErrorForDisplay(
  new Error("a", { cause: new Error("b") }),
).slice(1, -1);

test("the driven error has its recovery step only on a cause link", () => {
  const error = partitionShapedError();
  expect(error.message).not.toContain(RECOVERY_STEP);
  const links = sanitizeErrorForDisplay(error).split(CAUSE_SEPARATOR);
  expect(links).toHaveLength(2);
  // The summary link truncates, so there was never room to hold the step on it.
  expect(links[0]).toContain(DISPLAY_TRUNCATION_MARKER);
  expect(links[1]).toBe(RECOVERY_STEP);
});

// --- the sinks ---------------------------------------------------------------

/** Replace `process.exit` with a throw, so the exit is observable and the test keeps control. */
function exitThrows(): void {
  captureProcessExit();
}

/** Collect what a sink writes to `console.error`, and keep it off the suite's output. */
function captureConsoleError(): string[] {
  const written: string[] = [];
  vi.spyOn(console, "error").mockImplementation((...args: unknown[]) => {
    written.push(args.map(String).join(" "));
  });
  return written;
}

/** A logger name no other module builds, so runOrExit's lazy `getLogger` binds to the capture interceptor. */
const PROBE_LOGGER_NAME = "error-sink-cause-chain-probe";

interface SinkProbe {
  /** The sink, named where it lives: a terminal sink absent from this table is not covered. */
  name: string;
  /** Drive the real sink with `error`, returning every operator-visible string it produced. */
  drive: (error: unknown) => string[] | Promise<string[]>;
}

// Every CLI sink that renders a terminating error to an operator or a
// supervisor. Driven through the real sink rather than through
// sanitizeErrorForDisplay, because what is under test is the routing between the
// throw and the output, not the renderer.
const SINK_PROBES: SinkProbe[] = [
  {
    name: "parseOrExit (apps/cli/src/util/flags.ts)",
    drive: (error) => {
      const written = captureConsoleError();
      exitThrows();
      expect(() =>
        parseOrExit(() => {
          throw error;
        }),
      ).toThrow("exit:64");
      return written;
    },
  },
  {
    name: "exitWithError (apps/cli/src/util/exit.ts)",
    drive: (error) => {
      const written: string[] = [];
      exitThrows();
      expect(() =>
        exitWithError(
          {
            error: (message: string) => {
              written.push(message);
            },
          },
          error,
          64,
        ),
      ).toThrow("exit:64");
      return written;
    },
  },
  {
    name: "runOrExit (apps/cli/src/util/exit.ts)",
    drive: async (error) => {
      // runOrExit builds its logger inside the catch, so the getLogger call
      // happens within the callback below -- after withCapturedLogs has
      // installed the interceptor. loglevel binds a logger's methods from the
      // factory live at creation, so a name materialized earlier would bypass
      // capture and deliver nothing here.
      exitThrows();
      const [, captured] = await withCapturedLogs(
        async () => {
          await expect(
            runOrExit(PROBE_LOGGER_NAME, () => Promise.reject(error)),
          ).rejects.toThrow("exit:64");
        },
        (level) => level === "ERROR",
      );
      return captured.map((entry) => entry.message);
    },
  },
  {
    name: "the last-resort catch (apps/cli/src/index.ts)",
    drive: async (error) => {
      const written = captureConsoleError();
      const exit = vi
        .spyOn(process, "exit")
        .mockImplementation((() => undefined) as never);
      parseAsync.mockRejectedValue(error);
      vi.resetModules();
      await import("../../src/index");
      // The catch runs on the microtask the rejected parseAsync settles, after
      // the module finishes evaluating; drain the queue before reading.
      await new Promise((resolve) => setImmediate(resolve));
      expect(exit).toHaveBeenCalledWith(1);
      return written;
    },
  },
  {
    name: "the --event-stream error event (apps/cli/src/eventStream.ts)",
    drive: (error) => {
      const chunks: Buffer[] = [];
      // The real emitter and writer, with only the fd-3 syscall itself stubbed,
      // so what is read back is the serialized NDJSON line rather than the
      // built event.
      vi.spyOn(fs, "writeSync").mockImplementation(((
        fd: number,
        buffer: Buffer,
        offset: number,
        length: number,
      ) => {
        expect(fd).toBe(EVENT_STREAM_FD);
        chunks.push(Buffer.from(buffer.subarray(offset, offset + length)));
        return length;
      }) as unknown as typeof fs.writeSync);
      openEventStreamWithFdWired().error(error, "prepare");
      return Buffer.concat(chunks)
        .toString("utf8")
        .split("\n")
        .filter((line) => line.length > 0)
        .map((line) => (JSON.parse(line) as ErrorEvent).message);
    },
  },
];

test.each(SINK_PROBES)(
  "$name delivers a recovery step held on a cause link",
  async ({ drive }) => {
    const delivered = await drive(partitionShapedError());
    expect(delivered).toHaveLength(1);
    expect(delivered[0]).toContain(RECOVERY_STEP);
  },
);
