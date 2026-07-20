import { describe, expect, test } from "vitest";
import { v4 as uuidv4 } from "uuid";

import {
  messageFilename,
  resolveUnexpectedFilesPolicy,
  isRecognizedLoopFile,
} from "../src/connection/fileSyncMessageLoop";

// Per-seam contract coverage for the pure message-loop classification helpers.
// Before the split these were only exercised behind FileSyncConnection's
// poll()/send(); these tests pin the filename form, the policy defaults, and the
// loop-file grammar branches directly.

describe("messageFilename", () => {
  test("no-timestamp form is <id>-<byteCount>.json", () => {
    expect(
      messageFilename({
        id: "alice",
        timestampInFilename: false,
        byteCount: 42,
        seq: 3,
        ts: Date.UTC(2026, 0, 2, 3, 4, 5),
      }),
    ).toBe("alice-42.json");
  });

  test("timestamped form is <id>-<ts>-<counter>-<byteCount>.json", () => {
    expect(
      messageFilename({
        id: "bob",
        timestampInFilename: true,
        byteCount: 100,
        seq: 5,
        ts: Date.UTC(2026, 0, 2, 3, 4, 5),
      }),
    ).toBe("bob-20260102T030405-005-100.json");
  });

  test("counter zero-pads to three digits and widens past 999", () => {
    const ts = Date.UTC(2026, 0, 2, 3, 4, 5);
    expect(
      messageFilename({
        id: "bob",
        timestampInFilename: true,
        byteCount: 7,
        seq: 7,
        ts,
      }),
    ).toBe("bob-20260102T030405-007-7.json");
    expect(
      messageFilename({
        id: "bob",
        timestampInFilename: true,
        byteCount: 7,
        seq: 1000,
        ts,
      }),
    ).toBe("bob-20260102T030405-1000-7.json");
  });
});

describe("resolveUnexpectedFilesPolicy", () => {
  test("an explicit policy always wins over the mode default", () => {
    expect(
      resolveUnexpectedFilesPolicy({
        unexpectedFiles: "ignore",
        retainFiles: true,
        locklessRendezvous: true,
      }),
    ).toBe("ignore");
    expect(
      resolveUnexpectedFilesPolicy({
        unexpectedFiles: "error",
        retainFiles: true,
        locklessRendezvous: false,
      }),
    ).toBe("error");
  });

  test("retain mode defaults to warn", () => {
    expect(
      resolveUnexpectedFilesPolicy({
        retainFiles: true,
        locklessRendezvous: false,
      }),
    ).toBe("warn");
  });

  test("lockless rendezvous defaults to warn", () => {
    expect(
      resolveUnexpectedFilesPolicy({
        retainFiles: false,
        locklessRendezvous: true,
      }),
    ).toBe("warn");
  });

  test("plain delete mode defaults to error", () => {
    expect(
      resolveUnexpectedFilesPolicy({
        retainFiles: false,
        locklessRendezvous: false,
      }),
    ).toBe("error");
  });
});

describe("isRecognizedLoopFile", () => {
  const self = "alice";
  const peer = "bob";
  const recognized = (
    name: string,
    snapshot: ReadonlySet<string> = new Set(),
  ) => isRecognizedLoopFile(name, self, peer, snapshot);

  test("a foreign file snapshotted at entry is tolerated", () => {
    const snapshot = new Set(["leftover.txt"]);
    expect(recognized("leftover.txt", snapshot)).toBe(true);
    expect(recognized("leftover.txt")).toBe(false);
  });

  test("the protocol's own temp shape is recognized, a foreign temp is not", () => {
    expect(recognized(`temp-${uuidv4()}.tmp`)).toBe(true);
    expect(recognized("temp-notauuid.tmp")).toBe(false);
  });

  test("both expected abort markers are recognized, a foreign one is not", () => {
    expect(recognized("alice-abort.json")).toBe(true);
    expect(recognized("bob-abort.json")).toBe(true);
    expect(recognized("eve-abort.json")).toBe(false);
  });

  test("hellos match by exact name only", () => {
    expect(recognized("alice-hello.json")).toBe(true);
    expect(recognized("bob-hello.json")).toBe(true);
    expect(recognized("alice-x-hello.json")).toBe(false);
  });

  test("the lock matches by exact name in either arrival order", () => {
    expect(recognized("alice-bob-lock.json")).toBe(true);
    expect(recognized("bob-alice-lock.json")).toBe(true);
    expect(recognized("alice-x-lock.json")).toBe(false);
  });

  test("an own numeric terminal is recognized but a peer numeric terminal is not", () => {
    expect(recognized("alice-100.json")).toBe(true);
    expect(recognized("bob-100.json")).toBe(false);
  });

  test("an ack is recognized only when its inner target is a legal name", () => {
    expect(recognized("bob-alice-hello-ack.json")).toBe(true);
    expect(recognized("alice-bob-hello-ack.json")).toBe(true);
    expect(recognized("bob-alice-50-ack.json")).toBe(true);
    expect(recognized("alice-x-y-ack.json")).toBe(false);
  });

  test("a conflict copy of a protocol file is not recognized", () => {
    expect(recognized("alice-100 (conflicted copy).json")).toBe(false);
  });
});
