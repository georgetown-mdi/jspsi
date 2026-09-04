import fs from "node:fs";

import { afterEach, expect, test, vi } from "vitest";

import {
  ConnectionError,
  InternalConsistencyError,
  OperatorConfigError,
  SIGNING_CERTIFICATE_VERSION,
  StandardizationTermsError,
  UsageError,
  assertLocalCertificateAuthorizesAgreedIdentity,
  assertSigningModeImplemented,
} from "@psilink/core";

import {
  EVENT_STREAM_FD,
  EVENT_STREAM_VERSION,
  PERSISTENCE_LOSS_EXIT_CODE,
  assertEventStreamFdOpen,
  buildErrorEvent,
  buildMetricsEvent,
  buildResultEvent,
  buildStageEndEvent,
  buildStageEvent,
  buildStagesEvent,
  buildWarningEvent,
  classifyTerminalError,
  openEventStream,
  reportPersistenceLoss,
  type ErrorPhase,
  type StreamEvent,
} from "../../src/eventStream";
import { exitCodeForError } from "../../src/util/exit";
import { openEventStreamWithFdWired } from "../eventStreamTestSupport";

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
    case "stageEnd":
      return (
        typeof event.id === "string" &&
        typeof event.durationMs === "number" &&
        Number.isInteger(event.durationMs) &&
        event.durationMs >= 0
      );
    case "warning":
      return typeof event.message === "string";
    case "metrics":
      return (
        ["recordsProcessed", "transportRetries", "reconnects"] as const
      ).every(
        (k) =>
          typeof event[k] === "number" &&
          Number.isInteger(event[k] as number) &&
          (event[k] as number) >= 0,
      );
    case "result":
      return (
        typeof event.resultWritten === "boolean" &&
        // The count-only fields are optional and paired: a present count is a
        // non-negative integer like every other numeric field of this stream,
        // and its provenance flag travels with it or not at all.
        (event.intersectionCount === undefined
          ? event.countReportedByPartner === undefined
          : typeof event.intersectionCount === "number" &&
            Number.isInteger(event.intersectionCount) &&
            event.intersectionCount >= 0 &&
            typeof event.countReportedByPartner === "boolean")
      );
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
const RLO_INJECTION = "user\u202eEVIL";

// --- Schema conformance: every event type validates, version present ---------

test("every event type validates against the schema and carries a version", () => {
  const events: StreamEvent[] = [
    buildStagesEvent([
      { id: "confirming protocol", label: "Confirming protocol" },
    ]),
    buildStageEvent("stage 1 / 2", "Linking key 1 / 2"),
    buildStageEndEvent("stage 1 / 2", 1234),
    buildWarningEvent("a terms warning"),
    buildMetricsEvent(1000, 2, 1),
    buildResultEvent(true),
    buildResultEvent(false),
    buildResultEvent(false, { intersectionCount: 7, reportedByPartner: false }),
    buildResultEvent(false, { intersectionCount: 7, reportedByPartner: true }),
    buildErrorEvent(new Error("boom"), "run"),
  ];
  for (const event of events) {
    expect(validateEvent(event)).toBe(true);
    expect(event.v).toBe(EVENT_STREAM_VERSION);
  }
});

// --- Stage timing and operational counters -----------------------------------

test("a metrics event carries the operational counters verbatim", () => {
  const event = buildMetricsEvent(4200, 3, 2);
  expect(validateEvent(event)).toBe(true);
  expect(event.recordsProcessed).toBe(4200);
  expect(event.transportRetries).toBe(3);
  expect(event.reconnects).toBe(2);
  expect(event.v).toBe(EVENT_STREAM_VERSION);
});

test("metrics counters and stage durations are clamped to non-negative integers", () => {
  // The values are this party's own integers, but the builder floors any
  // malformed input so a schema-invalid numeric field can never be emitted.
  const metrics = buildMetricsEvent(-5, Number.NaN, 1.9);
  expect(metrics.recordsProcessed).toBe(0);
  expect(metrics.transportRetries).toBe(0);
  expect(metrics.reconnects).toBe(1);
  expect(validateEvent(metrics)).toBe(true);

  const stageEnd = buildStageEndEvent("stage 1 / 1", -7);
  expect(stageEnd.durationMs).toBe(0);
  expect(validateEvent(stageEnd)).toBe(true);
});

// --- The terminal result event's count-only field ----------------------------

test("the result event carries a count-only run's count, and omits the field otherwise", () => {
  // The field's PRESENCE is the discriminant between the two resultWritten:false
  // outcomes, so a zero count must be emitted as a present zero rather than
  // collapsing into the withheld shape a missing field means.
  const counted = buildResultEvent(false, {
    intersectionCount: 0,
    reportedByPartner: false,
  });
  expect(validateEvent(counted)).toBe(true);
  expect(counted.resultWritten).toBe(false);
  expect("intersectionCount" in counted).toBe(true);
  expect(counted.intersectionCount).toBe(0);
  expect(counted.countReportedByPartner).toBe(false);

  const withheld = buildResultEvent(false);
  expect(validateEvent(withheld)).toBe(true);
  expect("intersectionCount" in withheld).toBe(false);
  expect("countReportedByPartner" in withheld).toBe(false);

  const written = buildResultEvent(true);
  expect("intersectionCount" in written).toBe(false);

  // Serialized, the absence is a field a consumer never sees rather than a null.
  expect(JSON.parse(JSON.stringify(withheld))).toEqual({
    v: EVENT_STREAM_VERSION,
    type: "result",
    resultWritten: false,
  });
});

test("a malformed count is floored like every other numeric field", () => {
  // The count is the one numeric field a partner can influence (the count-report
  // leg), so the builder floors it rather than trusting the value it is handed.
  const floored = (intersectionCount: number) =>
    buildResultEvent(false, { intersectionCount, reportedByPartner: false })
      .intersectionCount;
  expect(floored(-3)).toBe(0);
  expect(floored(Number.NaN)).toBe(0);
  expect(floored(4.7)).toBe(4);
});

test("a stageEnd event pairs an id with a whole-millisecond duration", () => {
  const event = buildStageEndEvent("stage 2 / 2", 512);
  expect(validateEvent(event)).toBe(true);
  expect(event.id).toBe("stage 2 / 2");
  expect(event.durationMs).toBe(512);
});

test("sanitizes a hostile stageEnd id (partner-authored linkage-key name)", () => {
  const event = buildStageEndEvent(RLO_INJECTION, 10);
  expect(event.id).not.toContain("\u202e");
  expect(event.id).toContain("\\u202e");
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

  // Core's prepare-time signing-mode refusal is raised from this party's own
  // config, so the error it actually throws reaches this category rather than
  // the generic, retryable-looking `exchange` one.
  let signingRefusal: unknown;
  try {
    assertSigningModeImplemented("session-derived");
  } catch (thrown) {
    signingRefusal = thrown;
  }
  expect(classifyTerminalError(signingRefusal, "prepare")).toBe("config");
});

test("classifies a mid-RUN OperatorConfigError as config, agreeing with its exit code", () => {
  // The class contract is that a member's message is composed solely of this
  // party's own content, whatever phase raises it, so the type alone carries the
  // rule. What the category has to agree with is the exit code: core's local
  // certificate/terms refusal is raised from the run phase and exits 64, the
  // do-not-retry code, so reporting it under the retryable `exchange` bucket
  // would have the two signals disagree on a fault every retry reproduces.
  let refusal: unknown;
  try {
    assertLocalCertificateAuthorizesAgreedIdentity(
      {
        version: SIGNING_CERTIFICATE_VERSION,
        algorithm: "ecdsa-p256-sha256",
        identity: "Bound Party",
        publicKey: { kty: "EC", crv: "P-256", x: "eA", y: "eQ" },
      },
      "Agreed Party",
    );
  } catch (thrown) {
    refusal = thrown;
  }
  expect(refusal).toBeInstanceOf(OperatorConfigError);
  expect(classifyTerminalError(refusal, "run")).toBe("config");
  expect(buildErrorEvent(refusal, "run").category).toBe("config");
  expect(exitCodeForError(refusal)).toBe(64);
  // The output phase still wins over the type: the exchange succeeded there, and
  // only local result generation failed.
  expect(classifyTerminalError(refusal, "output")).toBe("output");
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

test("classifies a run-phase InternalConsistencyError as exchange", () => {
  // The class the single-pass send-time reply-cap backstop raises (pinned as what
  // a triggered backstop throws in core's psiLink.test.ts). The four categories
  // have no internal-fault member, so it lands in the default bucket beside the
  // retryable transport faults; the exit code (70, pinned in cli.test.ts) is where
  // a supervisor sees the difference -- the mirror of a `security` failure, which
  // only the category shows.
  const backstop = new InternalConsistencyError(
    "single-pass built a reply of 10 byte(s), above the 8 byte(s) both parties " +
      "derive from their declared sizes",
  );
  expect(classifyTerminalError(backstop, "run")).toBe("exchange");
  expect(buildErrorEvent(backstop, "run").category).toBe("exchange");
});

// --- Hostile-value sanitization (ESC / RLO injection) ------------------------

test("sanitizes a hostile stage label (partner-authored linkage-key name)", () => {
  const event = buildStagesEvent([{ id: "stage 1 / 1", label: RLO_INJECTION }]);
  const label = event.stages[0].label;
  expect(label).not.toContain("\u202e");
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
  expect(event.message).not.toContain("\u202e");
  expect(event.message).toContain("\\u202e");
});

test("redacts private-key material carried in a warning message", () => {
  // The fd-3 stream is a persisted machine sink like --log-file, and its error
  // event is already redacted, so the warning is the one text field that would
  // otherwise carry key material in the clear. Driven with a raw block rather
  // than a live warning source, since both live sources redact per fragment
  // where they compose -- this pins the backstop, not their composition.
  const body = "b3BlbnNzaC1rZXktdjEAAAAABG5vbmUAAAAEbm9uZQAAAAAAAAAB";
  const event = buildWarningEvent(
    `key file rejected: -----BEGIN OPENSSH PRIVATE KEY-----\n${body}\n` +
      `-----END OPENSSH PRIVATE KEY-----`,
  );
  expect(event.message).toContain("[redacted private key]");
  expect(event.message).not.toContain(body);
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

test("every event serializes to a printable-ASCII line", () => {
  // This stream is the machine-readable line the printable-ASCII encoder behind
  // the --json stdout lines (apps/cli/src/util/jsonLine.ts) names as what it
  // excludes: its text is display-escaped where each event is composed instead,
  // and bare JSON.stringify passes DEL, the C1 range and U+2028 through, so the
  // composition pass is the whole of what keeps those bytes off the descriptor.
  // Held here, over the fields this stream carries, rather than in the encoder's
  // header prose.
  const PRINTABLE_ASCII_ONLY = /^[\x20-\x7e]*$/;
  const hostile =
    `${ESC_INJECTION}\n${RLO_INJECTION}` +
    `${String.fromCharCode(0x7f)}${String.fromCharCode(0x9b)} \u{1f600}`;
  const events: StreamEvent[] = [
    buildStagesEvent([{ id: hostile, label: hostile }]),
    buildStageEvent(hostile, hostile),
    buildStageEndEvent(hostile, 1234),
    buildWarningEvent(hostile),
    buildMetricsEvent(1000, 2, 1),
    buildResultEvent(false, { intersectionCount: 7, reportedByPartner: true }),
    buildErrorEvent(new Error(hostile), "run"),
  ];
  for (const event of events)
    expect(PRINTABLE_ASCII_ONLY.test(JSON.stringify(event))).toBe(true);
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

test("openEventStream builds no emitter, and never stats fd 3, when the flag is off", () => {
  const spy = vi.spyOn(fs, "fstatSync");
  expect(openEventStream(undefined)).toBeUndefined();
  expect(openEventStream(false)).toBeUndefined();
  expect(spy).not.toHaveBeenCalled();
});

test("openEventStream takes the fail-closed preflight before it hands back an emitter", () => {
  // Preflight and construction are fused so a second opener cannot acquire a
  // writer that skipped the check: an unwired fd 3 yields the usage error, never
  // an emitter that would drop every event it is later given.
  vi.spyOn(fs, "fstatSync").mockImplementation(((fd: number) => {
    throw Object.assign(new Error("EBADF: bad file descriptor, fstat"), {
      code: "EBADF",
    });
    void fd;
  }) as typeof fs.fstatSync);
  expect(() => openEventStream(true)).toThrow(UsageError);

  vi.mocked(fs.fstatSync).mockReturnValue({} as fs.Stats);
  expect(openEventStream(true)).toBeDefined();
});

// --- persistence loss on a completed run --------------------------------------

test("reportPersistenceLoss warns on the stream and sets the persistence-loss exit code", () => {
  // Both machine channels at once: a supervisor reading fd 3 gets the warning, a
  // supervisor reading only exit status gets 73 (EX_CANTCREAT) -- the literal the
  // exit-code contract in docs/CLI.md publishes, and deliberately not the 69 that
  // says the exchange did not happen and may be retried.
  const cap = captureFd3Writes();
  const exitCodeBefore = process.exitCode;
  try {
    reportPersistenceLoss(
      "the record was not written",
      openEventStreamWithFdWired(),
    );
    expect(process.exitCode).toBe(73);
    expect(process.exitCode).toBe(PERSISTENCE_LOSS_EXIT_CODE);
  } finally {
    process.exitCode = exitCodeBefore;
  }
  const lines = cap.lines();
  expect(lines).toHaveLength(1);
  const event = JSON.parse(lines[0]) as StreamEvent;
  expect(event.type).toBe("warning");
  expect((event as { message: string }).message).toBe(
    "the record was not written",
  );
});

test("reportPersistenceLoss still moves the exit code with no stream open", () => {
  // The default run: --event-stream is off, so there is no emitter and nothing
  // reaches fd 3 -- but the loss must still be visible to a bare supervisor.
  const writeSync = vi.spyOn(fs, "writeSync");
  const exitCodeBefore = process.exitCode;
  try {
    reportPersistenceLoss("the configuration was not written", undefined);
    expect(process.exitCode).toBe(PERSISTENCE_LOSS_EXIT_CODE);
  } finally {
    process.exitCode = exitCodeBefore;
  }
  expect(writeSync).not.toHaveBeenCalled();
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
  const emitter = openEventStreamWithFdWired();
  emitter.stages([{ id: "confirming protocol", label: "Confirming protocol" }]);
  emitter.stage("stage 1 / 1", "Linking key 1 / 1");
  emitter.stageEnd("stage 1 / 1", 42);
  emitter.warning("a warning");
  emitter.metrics(500, 1, 2);
  emitter.result(true);

  const lines = cap.lines();
  expect(lines).toHaveLength(6);
  for (const line of lines) {
    const parsed: unknown = JSON.parse(line);
    expect(validateEvent(parsed)).toBe(true);
    // The version is readable from any single line on its own.
    expect((parsed as { v: number }).v).toBe(EVENT_STREAM_VERSION);
  }
  expect(lines.map((l) => (JSON.parse(l) as StreamEvent).type)).toEqual([
    "stages",
    "stage",
    "stageEnd",
    "warning",
    "metrics",
    "result",
  ]);
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

  const message = "x".repeat(200);
  openEventStreamWithFdWired().warning(message);
  const written = Buffer.concat(chunks).toString("utf8");
  expect(written.endsWith("\n")).toBe(true);
  expect(JSON.parse(written.trimEnd())).toEqual(buildWarningEvent(message));
});

test("a broken pipe stops the writer without throwing into the exchange", () => {
  let calls = 0;
  vi.spyOn(fs, "writeSync").mockImplementation((() => {
    calls += 1;
    throw Object.assign(new Error("EPIPE: broken pipe, write"), {
      code: "EPIPE",
    });
  }) as unknown as typeof fs.writeSync);

  // One emitter, so one writer: the broken flag has to survive between the two
  // emissions below for the retry to be suppressed.
  const emitter = openEventStreamWithFdWired();
  expect(() => emitter.result(true)).not.toThrow();
  // A later emit does not retry the write once the stream is marked broken.
  emitter.result(false);
  expect(calls).toBe(1);
});
