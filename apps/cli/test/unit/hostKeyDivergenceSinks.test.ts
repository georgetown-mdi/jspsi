import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, beforeEach, expect, test, vi } from "vitest";
import logLibrary from "loglevel";
import { getLogger, reconcileHostKeyFingerprints } from "@psilink/core";
import type { PresentedHostKey } from "@psilink/core";

import { EVENT_STREAM_FD, type WarningEvent } from "../../src/eventStream";
import { openEventStreamWithFdWired } from "../eventStreamTestSupport";
import {
  configureLogFile,
  configureStderrLogging,
} from "../../src/util/logging";
import {
  captureStdio,
  snapshotDiagnosticSinkAndLevel,
} from "../loggingTestSupport";

// The cross-party host-key divergence warning is the composition the redaction
// assignment exists for: the two parties' observed key types and fingerprints
// are named AHEAD of the rekey-versus-interception explanation and the
// out-of-band-confirm instruction, and the party the warning is ABOUT chooses
// half of them. Both of its sinks redact the whole line they are given, and that
// pass is fail-closed past a BEGIN marker with no END. These assertions read the
// bytes each sink actually emitted -- stderr, the --log-file, and the fd-3
// warning event -- with a marker planted in each server-chosen fragment.

snapshotDiagnosticSinkAndLevel();

let tmpDir: string;
let uid = 0;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "psilink-divergence-"));
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
  vi.restoreAllMocks();
});

const PEM_MARKER = "-----BEGIN OPENSSH PRIVATE KEY-----";
const LOCAL_KEY: PresentedHostKey = {
  fingerprint: "SHA256:" + "a".repeat(43),
  keyType: "ssh-ed25519",
};
const EXPLANATION = /interception/;
const INSTRUCTION = "re-pin it on both sides";

/** The real divergence message for a partner advertising `partner`. */
function divergence(
  partner: PresentedHostKey,
  local: PresentedHostKey = LOCAL_KEY,
): string {
  const msg = reconcileHostKeyFingerprints(local, partner);
  expect(msg).toBeDefined();
  return msg!;
}

/** What the two operator-facing log sinks wrote for one `log.warn(message)`. */
function warnToLogSinks(message: string): { stderr: string; file: string } {
  const logPath = path.join(tmpDir, `run-${uid}.log`);
  const name = `divergence-${uid++}`;

  const captured = captureStdio();
  const stderrSink = configureStderrLogging();
  logLibrary.setDefaultLevel(logLibrary.levels.TRACE);
  try {
    getLogger(name).warn(message);
  } finally {
    stderrSink.close();
    captured.restore();
  }

  const fileSink = configureLogFile(logPath);
  try {
    getLogger(name).warn(message);
  } finally {
    fileSink.close();
  }

  return {
    stderr: captured.stderrWrites.join(""),
    file: fs.readFileSync(logPath, "utf8"),
  };
}

/** The `message` field of the warning event the emitter serialized to fd 3. */
function warnToEventStream(message: string): string {
  const chunks: Buffer[] = [];
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

  openEventStreamWithFdWired().warning(message);

  const line = Buffer.concat(chunks).toString("utf8").trimEnd();
  const event = JSON.parse(line) as WarningEvent;
  expect(event.type).toBe("warning");
  return event.message;
}

const PLANTED: Array<[string, PresentedHostKey]> = [
  [
    "the partner's advertised key type",
    { fingerprint: "SHA256:" + "b".repeat(43), keyType: PEM_MARKER },
  ],
  [
    "the partner's advertised fingerprint",
    { fingerprint: PEM_MARKER, keyType: "ssh-rsa" },
  ],
  [
    "both partner-advertised fragments at once",
    { fingerprint: PEM_MARKER, keyType: PEM_MARKER },
  ],
];

for (const [where, partner] of PLANTED) {
  test(`a marker in ${where} keeps the divergence warning whole on the log path`, () => {
    const { stderr, file } = warnToLogSinks(divergence(partner));
    for (const rendered of [stderr, file]) {
      expect(rendered).toMatch(EXPLANATION);
      expect(rendered).toContain(INSTRUCTION);
      expect(rendered).toContain("[redacted private key]");
    }
  });

  test(`a marker in ${where} keeps the divergence warning whole on the event path`, () => {
    const message = warnToEventStream(divergence(partner));
    expect(message).toMatch(EXPLANATION);
    expect(message).toContain(INSTRUCTION);
    expect(message).toContain("[redacted private key]");
  });
}

test("a benign divergence reaches the event stream whole, not truncated", () => {
  // The warning-event cap is a cap on a COMPOSITION, not on one value: the
  // per-value default cuts this warning mid-explanation, taking the instruction
  // an appliance supervisor that discards stderr has nothing else to read. The
  // fragments are flooded to their own display cap here, so the size is held by
  // this assertion rather than by the copy's current length. All FOUR the
  // composition interpolates are flooded, both parties' key types and both
  // fingerprints, which is the worst case the cap has to admit; the two sides
  // differ so the reconciliation still finds a divergence to warn about.
  const flooded: PresentedHostKey = {
    fingerprint: "‮".repeat(100),
    keyType: "‮".repeat(64),
  };
  const floodedLocal: PresentedHostKey = {
    fingerprint: "‭".repeat(100),
    keyType: "‭".repeat(64),
  };
  const message = warnToEventStream(divergence(flooded, floodedLocal));
  expect(message).toMatch(EXPLANATION);
  // The composition runs to its own last byte. Each fragment still truncates at
  // its own cap -- that bound is untouched -- so what is asserted is that the
  // composition's tail, not a fragment's, is what the event ends on.
  expect(message.endsWith(`${INSTRUCTION}.`)).toBe(true);
});
