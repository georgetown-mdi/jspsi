import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, beforeEach, expect, test } from "vitest";
import logLibrary from "loglevel";
import { getDiagnosticSink, getLogger, setDiagnosticSink } from "@psilink/core";

import {
  configureLogFile,
  configureStderrLogging,
} from "../../../src/util/logging";
import {
  captureStdio,
  snapshotDiagnosticSinkAndLevel,
} from "../../loggingTestSupport";

// The private-key redaction safety check at the operator-facing log sinks. It runs
// in core's log prefixer, so it covers both CLI routings -- stderr and
// --log-file -- and every logger, including the ones built at import time before
// a command installs its sink. These assertions read the RENDERED bytes each
// sink emitted, not the arguments handed to it.

snapshotDiagnosticSinkAndLevel();

let tmpDir: string;
let uid = 0;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "psilink-logredact-"));
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

/** Log one line through both operator-facing sinks, returning what each wrote. */
function logToBothSinks(...args: unknown[]): { stderr: string; file: string } {
  const logPath = path.join(tmpDir, `run-${uid}.log`);
  const name = `log-redaction-${uid++}`;

  const captured = captureStdio();
  const stderrSink = configureStderrLogging();
  logLibrary.setDefaultLevel(logLibrary.levels.TRACE);
  try {
    (getLogger(name).warn as (...a: unknown[]) => void)(...args);
  } finally {
    stderrSink.close();
    captured.restore();
  }

  const fileSink = configureLogFile(logPath);
  try {
    (getLogger(name).warn as (...a: unknown[]) => void)(...args);
  } finally {
    fileSink.close();
  }

  return {
    stderr: captured.stderrWrites.join(""),
    file: fs.readFileSync(logPath, "utf8"),
  };
}

// A key sliced into a log line has whatever structure the thing that held it
// left behind, so the delivery shapes here are the ones the renderer's own
// safety-check tests enumerate: real line breaks, CRLF, a lone CR, folded
// spaces, tabs, no separator at all, and literal backslash-n from a JSON
// scalar.
const ARMOR_LINES = [
  "b3BlbnNzaC1rZXktdjEAAAAABG5vbmUAAAAEbm9uZQAAAAAAAAABAAAAMwAAAAtz",
  "c2gtZWQyNTUxOQAAACBQ1n3QqzB2rN0m8oL7vC5xY6aJ4kD1gH2sF3dP9uT8iQ",
  "Wq1n3QqzB2rN0m8oL7vC5xY6aJ4kD1gH2sF3dP9uT8iR6eW0yA==",
];
const BEGIN_MARKER = "-----BEGIN OPENSSH PRIVATE KEY-----";
const END_MARKER = "-----END OPENSSH PRIVATE KEY-----";
const SEPARATORS = ["\n", "\r\n", "\r", " ", "\t", "", "\\n"];

test("a whole private-key block on a log line is redacted at stderr and in --log-file", () => {
  for (const separator of SEPARATORS) {
    const key = [BEGIN_MARKER, ...ARMOR_LINES, END_MARKER].join(separator);
    const { stderr, file } = logToBothSinks(`could not load key: ${key}`);
    for (const rendered of [stderr, file]) {
      expect(rendered).toContain("[redacted private key]");
      for (const line of ARMOR_LINES) {
        expect(rendered).not.toContain(line.slice(0, 24));
        expect(rendered).not.toContain(line.slice(-24));
      }
      // Not vacuous: the line itself reached the sink.
      expect(rendered).toContain("could not load key:");
    }
  }
});

test("a truncated private key on a log line is redacted at stderr and in --log-file", () => {
  // A key sliced mid-stream has no END marker; the fail-closed dangling rule
  // must still strip from the BEGIN marker onward at both sinks.
  for (const separator of SEPARATORS) {
    const sliced = [BEGIN_MARKER, ...ARMOR_LINES].join(separator);
    const { stderr, file } = logToBothSinks(`writing ${sliced}`);
    for (const rendered of [stderr, file]) {
      expect(rendered).toContain("[redacted private key]");
      for (const line of ARMOR_LINES) {
        expect(rendered).not.toContain(line.slice(0, 24));
        expect(rendered).not.toContain(line.slice(-24));
      }
    }
  }
});

test("key material in a later log argument is redacted at both sinks", () => {
  const key = `${BEGIN_MARKER}\n${ARMOR_LINES.join("\n")}\n${END_MARKER}`;
  const { stderr, file } = logToBothSinks("key file rejected:", key);
  for (const rendered of [stderr, file]) {
    expect(rendered).toContain("key file rejected:");
    expect(rendered).toContain("[redacted private key]");
    expect(rendered).not.toContain(ARMOR_LINES[0].slice(0, 24));
  }
});

test("the pass reaches only within one argument, not across the joined line", () => {
  // A stated limit, pinned so widening or narrowing it is a visible decision: a
  // marker in one argument and the body in the next are two separate strings
  // to the pass, just as a split key is two separate links to the per-link
  // cause-chain pass. Joining first would let a dangling marker consume every
  // argument behind it.
  const { stderr, file } = logToBothSinks(BEGIN_MARKER, ARMOR_LINES[0]);
  for (const rendered of [stderr, file]) {
    expect(rendered).toContain("[redacted private key]");
    expect(rendered).toContain(ARMOR_LINES[0]);
  }
});

test("a charset-conforming marker lookalike is not redacted", () => {
  // `keyTypeFromBlob` admits `[A-Za-z0-9._@-]` only, so a hostile server can
  // send a key type that LOOKS like a BEGIN marker with hyphens where the armor
  // has spaces. It matches no redaction pattern and reaches the operator
  // verbatim. The cost is operator confusion, not disclosure; recorded as a
  // stated limit in docs/spec/CHANNEL_SECURITY.md rather than fixed by widening
  // the patterns, which would start matching legitimate text.
  const lookalike = "-----BEGIN-OPENSSH-PRIVATE-KEY-----";
  const { stderr, file } = logToBothSinks(`presented a ${lookalike} host key`);
  for (const rendered of [stderr, file]) {
    expect(rendered).toContain(lookalike);
    expect(rendered).not.toContain("[redacted private key]");
  }
});

test("a non-string log argument is passed to the sink by reference", () => {
  // The sink receives raw `unknown[]` and owns formatting, so the redaction pass
  // must not stringify an object argument on its way through.
  const payload = { rows: 3, path: "/mnt/share" };
  const seen: unknown[][] = [];
  const previous = getDiagnosticSink();
  setDiagnosticSink((_method, _prefix, args) => seen.push(args));
  try {
    logLibrary.setDefaultLevel(logLibrary.levels.TRACE);
    getLogger(`log-redaction-object-${uid++}`).info("summary:", payload, 7);
  } finally {
    setDiagnosticSink(previous);
  }

  expect(seen).toHaveLength(1);
  expect(seen[0][1]).toBe(payload);
  expect(seen[0][2]).toBe(7);
});

test("a non-string log argument renders unchanged at both sinks", () => {
  const { stderr, file } = logToBothSinks("summary:", { rows: 3 }, [1, 2]);
  for (const rendered of [stderr, file]) {
    expect(rendered).toContain("{ rows: 3 }");
    expect(rendered).toContain("[ 1, 2 ]");
  }
});

test("the console fallthrough redacts too, and passes non-strings by reference", () => {
  // With no sink installed the prefixer takes its rawMethod branch -- the
  // default per-level console routing the web app keeps, and the CLI's own
  // routing for any line logged before a command installs its sink. Placing the
  // pass in the prefixer rather than in a consumer's sink is what covers this
  // branch, so it is pinned rather than left to the sink-installed path.
  const key = `${BEGIN_MARKER}\n${ARMOR_LINES.join("\n")}\n${END_MARKER}`;
  const payload = { rows: 3 };
  const seen: unknown[][] = [];
  const previous = getDiagnosticSink();
  setDiagnosticSink(undefined);
  const consoleWarn = console.warn;
  console.warn = (...args: unknown[]) => void seen.push(args);
  try {
    logLibrary.setDefaultLevel(logLibrary.levels.TRACE);
    (
      getLogger(`log-redaction-console-${uid++}`).warn as (
        ...a: unknown[]
      ) => void
    )(`could not load key: ${key}`, payload);
  } finally {
    console.warn = consoleWarn;
    setDiagnosticSink(previous);
  }

  expect(seen).toHaveLength(1);
  // [prefix, string argument, object argument]
  expect(seen[0][1]).toContain("[redacted private key]");
  expect(seen[0][1]).not.toContain(ARMOR_LINES[0].slice(0, 24));
  expect(seen[0][2]).toBe(payload);
});
