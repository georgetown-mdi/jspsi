import { execFileSync, spawnSync } from "node:child_process";
import {
  copyFileSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";

import {
  RECORD_VERSION_PIN,
  RECORD_VERSION_SOURCE,
  RECOVERY_ENTRY_POINTS,
  bumpViolations,
  declaredRecordVersion,
  missingRecoveryEntryPoints,
} from "./check-disclosure-recovery.mjs";

/**
 * The deferred record-version bump check. Its whole value is that it fires on a
 * move and on nothing else, so the two tests that matter are the simulated move
 * and the tree as it stands -- and both are run against the real sources rather
 * than against strings that only look like them.
 */

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, "..");
const SCRIPT = resolve(here, "check-disclosure-recovery.mjs");

const readRoot = (relative) =>
  readFileSync(resolve(repoRoot, relative), "utf8");

/** The real recovery sources, as the check reads them. */
const realSources = Object.fromEntries(
  Object.keys(RECOVERY_ENTRY_POINTS).map((file) => [file, readRoot(file)]),
);

describe("reading the declared record version", () => {
  it("reads the literal out of the real source", () => {
    expect(declaredRecordVersion(readRoot(RECORD_VERSION_SOURCE))).toBe(
      RECORD_VERSION_PIN,
    );
  });

  it("reads a moved literal as the moved value", () => {
    expect(
      declaredRecordVersion(
        'export const EXCHANGE_RECORD_VERSION = "psilink-exchange-record/v7";',
      ),
    ).toBe("psilink-exchange-record/v7");
  });

  it("reads none from a declaration that is not a quoted literal", () => {
    // A computed or re-exported constant is not a value this check can compare,
    // and guessing one would make the tripwire silently inert.
    for (const source of [
      "export const EXCHANGE_RECORD_VERSION = RECORD_VERSIONS.current;",
      "export const EXCHANGE_RECORD_VERSION = `psilink-exchange-record/v${n}`;",
      "export { EXCHANGE_RECORD_VERSION } from './versions';",
      "",
    ]) {
      expect(declaredRecordVersion(source)).toBeUndefined();
    }
  });
});

describe("the tripwire fires on a version move and on nothing else", () => {
  it("passes against the tree as it stands", () => {
    expect(bumpViolations(RECORD_VERSION_PIN, realSources)).toEqual([]);
  });

  it("fails a simulated move, naming the obligation rather than only the mismatch", () => {
    const violations = bumpViolations(
      "psilink-exchange-record/v7",
      realSources,
    );

    expect(violations).toHaveLength(1);
    const [message] = violations;
    // Both versions, so which of the two is wrong is the maintainer's call.
    expect(message).toContain(RECORD_VERSION_PIN);
    expect(message).toContain("psilink-exchange-record/v7");
    // The obligation itself: what a move does to a stored accounting, and what
    // has to be re-taken before the new value is recorded.
    expect(message).toContain("accounting of disclosures");
    expect(message).toContain("RECORD_VERSION_PIN");
    expect(message).toContain(
      "apps/web/test/unit/disclosureAccounting.test.ts",
    );
  });

  it("fails an unreadable declaration rather than passing a comparison it never made", () => {
    const violations = bumpViolations(undefined, realSources);

    expect(violations).toHaveLength(1);
    expect(violations[0]).toContain("extraction pattern rotted");
  });
});

describe("the recovery path the deferral points at", () => {
  it("finds every entry point in the real sources", () => {
    expect(missingRecoveryEntryPoints(realSources)).toEqual([]);
  });

  it("fails when an entry point is gone, so the check cannot defer to nothing", () => {
    // A tree that dropped the recovery would otherwise pass the pin check while
    // deferring a bump decision to a path that no longer exists.
    const [file] = Object.keys(RECOVERY_ENTRY_POINTS);
    const [name] = RECOVERY_ENTRY_POINTS[file];
    const gutted = {
      ...realSources,
      [file]: realSources[file].replace(
        `export function ${name}`,
        `function ${name}`,
      ),
    };

    expect(missingRecoveryEntryPoints(gutted)).toEqual([{ file, name }]);
    expect(bumpViolations(RECORD_VERSION_PIN, gutted)[0]).toContain(
      "nothing to defer to",
    );
  });

  it("reports every missing entry point, not just the first", () => {
    const empty = Object.fromEntries(
      Object.keys(RECOVERY_ENTRY_POINTS).map((file) => [file, ""]),
    );
    const expected = Object.values(RECOVERY_ENTRY_POINTS).flat().length;

    expect(missingRecoveryEntryPoints(empty)).toHaveLength(expected);
  });
});

describe("the check as CI runs it", () => {
  let staged = null;

  afterEach(() => {
    if (staged === null) return;
    rmSync(staged, { recursive: true, force: true });
    staged = null;
  });

  /**
   * A tree holding the check and the sources it reads, minus `omitted`. The check
   * resolves its root from its own location, so driving it against anything but
   * the repository means staging one -- which is also the only way to reach the
   * case where a source file is not there at all.
   */
  function stageTree(omitted = null) {
    staged = mkdtempSync(join(tmpdir(), "psilink-disclosure-recovery-"));
    const place = (relative) => {
      const destination = join(staged, relative);
      mkdirSync(dirname(destination), { recursive: true });
      copyFileSync(resolve(repoRoot, relative), destination);
    };
    place("scripts/check-disclosure-recovery.mjs");
    place("scripts/lib/exchangeRecordVersion.mjs");
    place(RECORD_VERSION_SOURCE);
    for (const file of Object.keys(RECOVERY_ENTRY_POINTS))
      if (file !== omitted) place(file);
    return spawnSync(
      "node",
      [join(staged, "scripts", "check-disclosure-recovery.mjs")],
      {
        encoding: "utf8",
      },
    );
  }

  it("exits zero against the committed tree", () => {
    const output = execFileSync("node", [SCRIPT], {
      cwd: repoRoot,
      encoding: "utf8",
    });

    expect(output).toContain(RECORD_VERSION_PIN);
  });

  it("passes against a staged copy of that tree, so the staging is faithful", () => {
    const { status, stdout } = stageTree();

    expect(status).toBe(0);
    expect(stdout).toContain(RECORD_VERSION_PIN);
  });

  it("reports a deleted recovery source rather than crashing on the read", () => {
    // Deleting the file outright is the loudest form of the failure this check
    // reports, so it must reach the message naming the entry point: an ENOENT out
    // of the read still exits non-zero, with CI red and the diagnostic lost.
    const [omitted] = Object.keys(RECOVERY_ENTRY_POINTS);
    const { status, stderr } = stageTree(omitted);

    expect(status).toBe(1);
    expect(stderr).not.toContain("ENOENT");
    expect(stderr).toContain("nothing to defer to");
    for (const name of RECOVERY_ENTRY_POINTS[omitted])
      expect(stderr).toContain(`${omitted}: "${name}"`);
  });
});
