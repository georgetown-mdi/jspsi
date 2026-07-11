import fs from "node:fs";

import { afterEach, expect, test, vi } from "vitest";

import {
  ConnectionError,
  OperatorConfigError,
  StandardizationTermsError,
  UsageError,
} from "@psilink/core";

import {
  EVENT_STREAM_FD,
  EVENT_STREAM_VERSION,
  EventStreamWriter,
  assertEventStreamFdOpen,
  buildErrorEvent,
  buildResultEvent,
  buildStageEvent,
  buildStagesEvent,
  buildWarningEvent,
  classifyTerminalError,
  createEventStreamEmitter,
  type ErrorPhase,
  type StreamEvent,
} from "../../src/eventStream";

afterEach(() => {
  vi.restoreAllMocks();
});

// --- Schema validator (a small hand validator, matching the CLI idiom of
// asserting shapes directly rather than pulling zod into a test). It checks the
// closed vocabulary of each event type and that the version field is a positive
// integer, so a drift in the emitted shape fails a test rather than silently
// changing the wire contract.

const CATEGORIES = new Set(["exchange", "output", "security", "config"]);

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** True when `event` is a well-formed {@link StreamEvent} of its declared type. */
function validateEvent(event: unknown): event is StreamEvent {
  if (!isRecord(event)) return false;
  // Every line carries a positive-integer version field, observable on its own.
  if (typeof event.v !== "number" || !Number.isInteger(event.v) || event.v < 1)
    return false;
  switch (event.type) {
    case "stages":
      return (
        Array.isArray(event.stages) &&
        event.stages.every(
          (s) =>
            isRecord(s) &&
            typeof s.id === "string" &&
            typeof s.label === "string",
        )
      );
    case "stage":
      return typeof event.id === "string" && typeof event.label === "string";
    case "warning":
      return typeof event.message === "string";
    case "result":
      return typeof event.resultWritten === "boolean";
    case "error":
      return (
        typeof event.message === "string" &&
        typeof event.category === "string" &&
        CATEGORIES.has(event.category)
      );
    default:
      return false;
  }
}

// The repo's hostile-value strings: an ANSI/control ESC sequence and a
// right-to-left override (RLO), mirroring packages/core's sanitize tests.
const ESC_INJECTION = "\x1b[31mEVIL\x1b[0m";
const RLO_INJECTION = "user‮EVIL";

// --- Schema conformance: every event type validates, version present ---------

test("every event type validates against the schema and carries a version", () => {
  const events: StreamEvent[] = [
    buildStagesEvent([
      { id: "confirming protocol", label: "Confirming protocol" },
    ]),
    buildStageEvent("stage 1 / 2", "Linking key 1 / 2"),
    buildWarningEvent("a terms warning"),
    buildResultEvent(true),
    buildResultEvent(false),
    buildErrorEvent(new Error("boom"), "run"),
  ];
  for (const event of events) {
    expect(validateEvent(event)).toBe(true);
    expect(event.v).toBe(EVENT_STREAM_VERSION);
  }
});

// --- Terminal-error classification for each of the four categories -----------

test("classifies a PREPARE-phase OperatorConfigError as config", () => {
  const err = new OperatorConfigError("bad standardization");
  expect(classifyTerminalError(err, "prepare")).toBe("config");
  // The subclass the CLI actually throws is also config.
  expect(
    classifyTerminalError(new StandardizationTermsError("x"), "prepare"),
  ).toBe("config");
  expect(buildErrorEvent(err, "prepare").category).toBe("config");
});

test("classifies a security-kind ConnectionError as security in any phase", () => {
  const err = new ConnectionError("wrong secret", "security");
  for (const phase of ["prepare", "run"] as ErrorPhase[])
    expect(classifyTerminalError(err, phase)).toBe("security");
  expect(buildErrorEvent(err, "run").category).toBe("security");
});

test("classifies an output-phase failure as output", () => {
  // The output phase is decided by where the failure landed, not the error type:
  // even a plain transport-looking error in the output stage is `output`.
  expect(classifyTerminalError(new Error("disk full"), "output")).toBe(
    "output",
  );
  expect(
    classifyTerminalError(
      new ConnectionError("late drop", "transport"),
      "output",
    ),
  ).toBe("output");
  expect(buildErrorEvent(new Error("disk full"), "output").category).toBe(
    "output",
  );
});

test("classifies every other failure as exchange", () => {
  // A prepare-phase plain UsageError is NOT config: it can embed partner text, so
  // it stays exchange (message swallowed by the generic alert, per the web rule).
  expect(classifyTerminalError(new UsageError("payload send"), "prepare")).toBe(
    "exchange",
  );
  // A transport ConnectionError in the run phase is a retryable exchange fault.
  expect(
    classifyTerminalError(
      new ConnectionError("peer silent", "transport"),
      "run",
    ),
  ).toBe("exchange");
  // A non-security ConnectionError kind stays exchange.
  expect(
    classifyTerminalError(new ConnectionError("bad frame", "usage"), "run"),
  ).toBe("exchange");
});

test("the security category is identifiable from the terminal event alone", () => {
  // Exit codes cannot distinguish a security failure from a plain usage/transport
  // failure, so the marker must live in the event: a security ConnectionError is
  // not a UsageError, so it would exit 69 -- indistinguishable from a transport
  // drop by code -- yet the event names it.
  const event = buildErrorEvent(
    new ConnectionError("tampered handshake", "security"),
    "run",
  );
  expect(event.category).toBe("security");
});

// --- Hostile-value sanitization (ESC / RLO injection) ------------------------

test("sanitizes a hostile stage label (partner-authored linkage-key name)", () => {
  const event = buildStagesEvent([{ id: "stage 1 / 1", label: RLO_INJECTION }]);
  const label = event.stages[0].label;
  expect(label).not.toContain("‮");
  expect(label).toContain("\\u202e");
});

test("sanitizes a hostile stage-transition label and id", () => {
  const event = buildStageEvent(ESC_INJECTION, ESC_INJECTION);
  expect(event.id).not.toContain("\x1b");
  expect(event.label).not.toContain("\x1b");
  expect(event.label).toContain("\\x1b");
});

test("sanitizes a hostile warning message", () => {
  const event = buildWarningEvent(RLO_INJECTION);
  expect(event.message).not.toContain("‮");
  expect(event.message).toContain("\\u202e");
});

test("sanitizes hostile error text through the display boundary", () => {
  const event = buildErrorEvent(new Error(ESC_INJECTION), "run");
  expect(event.message).not.toContain("\x1b");
  expect(event.message).toContain("\\x1b");
});

test("no raw ESC or newline survives serialization of a hostile event", () => {
  // A serialized line must not carry a raw control byte or an embedded newline
  // (which would spoof a second NDJSON line). The escaped forms may appear.
  const line = JSON.stringify(buildWarningEvent("a\x1b[31m\nb"));
  expect(line).not.toContain("\x1b");
  // The sanitizer escaped the newline to a visible \x0a before serialization, so
  // no raw 0x0a survives to spoof a second NDJSON line.
  expect(line.includes("\n")).toBe(false);
});

// --- fail-closed missing-fd path ---------------------------------------------

test("assertEventStreamFdOpen throws a UsageError when fd 3 is not open", () => {
  const spy = vi.spyOn(fs, "fstatSync").mockImplementation(((fd: number) => {
    // Model an unopened descriptor: fstat raises EBADF.
    throw Object.assign(new Error("EBADF: bad file descriptor, fstat"), {
      code: "EBADF",
    });
    void fd;
  }) as typeof fs.fstatSync);
  expect(() => assertEventStreamFdOpen()).toThrow(UsageError);
  expect(() => assertEventStreamFdOpen()).toThrow(
    /file descriptor 3 is not open/,
  );
  expect(spy).toHaveBeenCalledWith(EVENT_STREAM_FD);
});

test("assertEventStreamFdOpen succeeds when fd 3 stats cleanly", () => {
  vi.spyOn(fs, "fstatSync").mockReturnValue({} as fs.Stats);
  expect(() => assertEventStreamFdOpen()).not.toThrow();
});

// --- NDJSON writer framing ----------------------------------------------------

// Capture every buffer the writer flushes to fd 3, reassembling the bytes so a
// short write (a partial writeSync return) is exercised too.
function captureFd3Writes(): { lines: () => string[]; short?: boolean } {
  const chunks: Buffer[] = [];
  vi.spyOn(fs, "writeSync").mockImplementation(((
    fd: number,
    buffer: Buffer,
    offset: number,
    length: number,
  ) => {
    expect(fd).toBe(EVENT_STREAM_FD);
    const slice = buffer.subarray(offset, offset + length);
    chunks.push(Buffer.from(slice));
    return length;
  }) as unknown as typeof fs.writeSync);
  return {
    lines: () =>
      Buffer.concat(chunks)
        .toString("utf8")
        .split("\n")
        .filter((l) => l.length > 0),
  };
}

test("emits one NDJSON object per line to fd 3, each a valid event", () => {
  const cap = captureFd3Writes();
  const emitter = createEventStreamEmitter();
  emitter.stages([{ id: "confirming protocol", label: "Confirming protocol" }]);
  emitter.stage("stage 1 / 1", "Linking key 1 / 1");
  emitter.warning("a warning");
  emitter.result(true);

  const lines = cap.lines();
  expect(lines).toHaveLength(4);
  for (const line of lines) {
    const parsed: unknown = JSON.parse(line);
    expect(validateEvent(parsed)).toBe(true);
    // The version is readable from any single line on its own.
    expect((parsed as { v: number }).v).toBe(EVENT_STREAM_VERSION);
  }
  expect((JSON.parse(lines[0]) as StreamEvent).type).toBe("stages");
  expect((JSON.parse(lines[3]) as StreamEvent).type).toBe("result");
});

test("drains a short write so a long line is never truncated", () => {
  const chunks: Buffer[] = [];
  // Return 1 byte per call to force the drain loop over many iterations.
  vi.spyOn(fs, "writeSync").mockImplementation(((
    _fd: number,
    buffer: Buffer,
    offset: number,
  ) => {
    chunks.push(Buffer.from(buffer.subarray(offset, offset + 1)));
    return 1;
  }) as unknown as typeof fs.writeSync);

  const writer = new EventStreamWriter();
  const event = buildWarningEvent("x".repeat(200));
  writer.emit(event);
  const written = Buffer.concat(chunks).toString("utf8");
  expect(written.endsWith("\n")).toBe(true);
  expect(JSON.parse(written.trimEnd())).toEqual(event);
});

test("a broken pipe stops the writer without throwing into the exchange", () => {
  let calls = 0;
  vi.spyOn(fs, "writeSync").mockImplementation((() => {
    calls += 1;
    throw Object.assign(new Error("EPIPE: broken pipe, write"), {
      code: "EPIPE",
    });
  }) as unknown as typeof fs.writeSync);

  const writer = new EventStreamWriter();
  expect(() => writer.emit(buildResultEvent(true))).not.toThrow();
  // A later emit does not retry the write once the stream is marked broken.
  writer.emit(buildResultEvent(false));
  expect(calls).toBe(1);
});
