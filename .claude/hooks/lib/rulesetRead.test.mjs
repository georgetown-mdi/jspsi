import { randomUUID } from "node:crypto";
import { existsSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import {
  markerPath,
  READ_TTL_MS,
  recordedReadAgeMs,
  recordRead,
  RULESET_PATH,
  RULESET_TAIL,
} from "./rulesetRead.mjs";

const written = [];

afterEach(() => {
  while (written.length > 0) rmSync(written.pop(), { force: true });
});

describe("markerPath", () => {
  it("keys a session under one directory in the temp dir", () => {
    const path = markerPath("8f2b1c66-0000-4000-8000-0123456789ab");
    expect(path).toBe(
      join(
        tmpdir(),
        "psilink-orchestration-reads",
        "8f2b1c66-0000-4000-8000-0123456789ab",
      ),
    );
  });

  it("gives two sessions two markers", () => {
    expect(markerPath("one")).not.toBe(markerPath("two"));
  });

  it("names no marker when the id is missing or holds no filename character", () => {
    for (const id of [undefined, null, 7, "", ".."]) {
      expect(markerPath(id), JSON.stringify(id)).toBeNull();
    }
  });

  it("keeps an id holding separators inside the marker directory", () => {
    for (const id of ["../../etc/passwd", "/", "a/b"]) {
      expect(dirname(markerPath(id)), id).toBe(
        join(tmpdir(), "psilink-orchestration-reads"),
      );
    }
  });
});

describe("recordRead and recordedReadAgeMs", () => {
  it("records a read the age reads back as just now", () => {
    const path = markerPath(randomUUID());
    written.push(path);
    expect(recordRead(path)).toBe(true);
    expect(existsSync(path)).toBe(true);
    const age = recordedReadAgeMs(path);
    expect(age).toBeGreaterThanOrEqual(0);
    expect(age).toBeLessThan(READ_TTL_MS);
  });

  it("reads no age when nothing is recorded", () => {
    expect(recordedReadAgeMs(markerPath(randomUUID()))).toBeNull();
  });
});

describe("RULESET_TAIL", () => {
  it("is the tail a command line names the ruleset by from inside .claude", () => {
    expect(RULESET_TAIL).toBe("orchestration/ruleset.md");
    expect(RULESET_PATH.endsWith(RULESET_TAIL)).toBe(true);
  });
});
