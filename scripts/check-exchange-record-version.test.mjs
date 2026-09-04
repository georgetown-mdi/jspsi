import { execFileSync } from "node:child_process";
import {
  copyFileSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, describe, expect, it } from "vitest";

import {
  CHECKLIST_HEADING,
  CHECKLIST_STEP,
  CHECK_SOURCE,
  PRE_PUBLICATION_RELEASE,
  RECORD_VERSION_PIN,
  RECORD_VERSION_SOURCE,
  RECOVERY_ENTRY_POINTS,
  RELEASE_MANIFEST,
  RESET_RECORD_VERSION,
  RESET_TAKEN_AT_RELEASE,
  bumpViolations,
  declaredRecordVersion,
  missingRecoveryEntryPoints,
  resetViolations,
} from "./check-exchange-record-version.mjs";
import { PRE_PUBLICATION_RELEASE as PROTOCOL_CHECK_FLOOR } from "./check-protocol-version-bump.mjs";
import { CHECKS } from "./run-checks.mjs";

/**
 * The two obligations the exchange-record literal carries. The bump rule's whole
 * value is that it fires on a move and on nothing else; the reset rule's two
 * halves bind at opposite ends of one release marker, and the repository sits on
 * the first half. So the move and the armed reset states are driven through the
 * real script against fixture trees, and the rules that read the tree as it
 * stands read the real sources rather than strings that look like them.
 */

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, "..");
const SCRIPT = resolve(here, "check-exchange-record-version.mjs");

const readRoot = (relative) =>
  readFileSync(resolve(repoRoot, relative), "utf8");

/** The real recovery sources, as the check reads them. */
const realSources = Object.fromEntries(
  Object.keys(RECOVERY_ENTRY_POINTS).map((file) => [file, readRoot(file)]),
);

const temporaryRoots = [];
afterAll(() => {
  for (const root of temporaryRoots)
    rmSync(root, { recursive: true, force: true });
});

const DEVELOPMENT_VERSION = "psilink-exchange-record/v6";
const FIRST_PUBLISHED_RELEASE = "0.2.0";

/** The kinds a set of violations reports, in the order reported. */
const kindsOf = (violations) => violations.map(({ kind }) => kind);

/** The state the reset rule reads, with `overrides` applied. */
function state(overrides = {}) {
  return {
    published: false,
    releaseVersion: PRE_PUBLICATION_RELEASE,
    declared: DEVELOPMENT_VERSION,
    takenAtRelease: undefined,
    ...overrides,
  };
}

/** The state at a published release, with `overrides` applied. */
function publishedState(overrides = {}) {
  return state({
    published: true,
    releaseVersion: FIRST_PUBLISHED_RELEASE,
    ...overrides,
  });
}

/**
 * A tree carrying what the check reads: the release manifest, the record version
 * source, and the recovery sources, copied so the recovery rule reads the real
 * declarations. `omitRecovery` leaves one of them out, which is how the deleted
 * source is reached. This is how the states beyond this repository's own are
 * driven end to end through the real script.
 */
function fixtureTree({
  releaseVersion = PRE_PUBLICATION_RELEASE,
  declared = DEVELOPMENT_VERSION,
  recordSource,
  omitRecovery = null,
} = {}) {
  const root = mkdtempSync(resolve(tmpdir(), "psilink-record-version-"));
  temporaryRoots.push(root);
  const write = (relative, content) => {
    mkdirSync(resolve(root, dirname(relative)), { recursive: true });
    writeFileSync(resolve(root, relative), content);
  };
  write(RELEASE_MANIFEST, JSON.stringify({ version: releaseVersion }));
  write(
    RECORD_VERSION_SOURCE,
    recordSource ?? `export const EXCHANGE_RECORD_VERSION = "${declared}";\n`,
  );
  for (const file of Object.keys(RECOVERY_ENTRY_POINTS)) {
    if (file === omitRecovery) continue;
    mkdirSync(resolve(root, dirname(file)), { recursive: true });
    copyFileSync(resolve(repoRoot, file), resolve(root, file));
  }
  return root;
}

/** The script driven as the workflow runs it, against `root` when given one. */
function runCheck(root, script = SCRIPT) {
  const args = root === undefined ? [script] : [script, "--root", root];
  try {
    const stdout = execFileSync(process.execPath, args, {
      cwd: repoRoot,
      encoding: "utf8",
    });
    return { status: 0, stdout, stderr: "" };
  } catch (error) {
    return { status: error.status, stdout: error.stdout, stderr: error.stderr };
  }
}

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
    // and guessing one would make the rule silently inert.
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

describe("rule 1 fires on a version move and on nothing else", () => {
  it("passes against the tree as it stands", () => {
    expect(bumpViolations(RECORD_VERSION_PIN, realSources)).toEqual([]);
  });

  it("fails a simulated move, naming the obligation rather than only the mismatch", () => {
    const violations = bumpViolations(
      "psilink-exchange-record/v7",
      realSources,
    );

    expect(kindsOf(violations)).toEqual(["moved"]);
    const [{ message }] = violations;
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
});

describe("the recovery path rule 1 points at", () => {
  it("finds every entry point in the real sources", () => {
    expect(missingRecoveryEntryPoints(realSources)).toEqual([]);
  });

  it("fails when an entry point is gone, so the rule cannot defer to nothing", () => {
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
    expect(bumpViolations(RECORD_VERSION_PIN, gutted)[0].message).toContain(
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

describe("the marker rule 2 is dated by", () => {
  it("is the same publication floor the wire-format pin arms on", () => {
    // One definition of "first publication" rather than two: the reset and the
    // protocol bump are dated by the same release, so a moved floor moves both.
    expect(PRE_PUBLICATION_RELEASE).toBe(PROTOCOL_CHECK_FLOOR);
  });
});

describe("before the release that publishes the reset", () => {
  it("leaves the development counter alone wherever it stands", () => {
    for (const declared of [
      DEVELOPMENT_VERSION,
      "psilink-exchange-record/v7",
      "psilink-exchange-record/v12",
    ]) {
      expect(resetViolations(state({ declared }))).toEqual([]);
    }
  });

  it("fails a reset taken ahead of the release that publishes it", () => {
    // Re-using a previously-cycled value mid-development lets an artifact
    // written under the old one parse as current and fail on its field set,
    // instead of taking the clean version refusal the reader gives.
    const violations = resetViolations(
      state({ declared: RESET_RECORD_VERSION }),
    );

    expect(kindsOf(violations)).toEqual(["early"]);
    expect(violations[0].message).toContain("fails on its field set");
    expect(violations[0].message).toContain(CHECKLIST_STEP);
  });
});

describe("at the release that publishes the reset", () => {
  it("asks for the whole reset, not only the literal", () => {
    const violations = resetViolations(publishedState());

    expect(kindsOf(violations)).toEqual(["due"]);
    const [{ message }] = violations;
    // Both versions, so which of the two is wrong is readable from the failure.
    expect(message).toContain(DEVELOPMENT_VERSION);
    expect(message).toContain(RESET_RECORD_VERSION);
    // The obligations a literal edit alone does not discharge.
    expect(message).toContain("check:vectors");
    expect(message).toContain("RECORD_VERSION_PIN");
    expect(message).toContain("development artifacts");
    expect(message).toContain("RESET_TAKEN_AT_RELEASE");
    expect(message).toContain(CHECKLIST_STEP);
  });

  it("asks for the discharge once the literal is there", () => {
    const violations = resetViolations(
      publishedState({ declared: RESET_RECORD_VERSION }),
    );

    expect(kindsOf(violations)).toEqual(["record"]);
    expect(violations[0].message).toContain(
      `RESET_TAKEN_AT_RELEASE to "${FIRST_PUBLISHED_RELEASE}"`,
    );
  });
});

describe("the recorded reset discharge", () => {
  it("retires the rule, so a later forward bump is not held to the reset", () => {
    // The reset is taken once. Without this the rule would fail every ordinary
    // bump after publication, demanding a version that already shipped.
    for (const declared of [
      RESET_RECORD_VERSION,
      "psilink-exchange-record/v2",
      "psilink-exchange-record/v3",
    ]) {
      expect(
        resetViolations(
          publishedState({
            declared,
            takenAtRelease: FIRST_PUBLISHED_RELEASE,
          }),
        ),
      ).toEqual([]);
    }
  });

  it("refuses a value naming no published release", () => {
    for (const takenAtRelease of [
      PRE_PUBLICATION_RELEASE,
      "0.0.9",
      "someday",
      "v0.2.0",
    ]) {
      const violations = resetViolations(publishedState({ takenAtRelease }));

      expect(kindsOf(violations)).toEqual(["discharge"]);
      expect(violations[0].message).toContain(takenAtRelease);
    }
  });

  it("refuses a value recorded ahead of the marker", () => {
    // A discharge recorded before the release it names would disarm the rule on
    // the way to publication, which is the whole window it exists to cover.
    const violations = resetViolations(
      state({ takenAtRelease: FIRST_PUBLISHED_RELEASE }),
    );

    expect(kindsOf(violations)).toEqual(["discharge"]);
    expect(violations[0].message).toContain("ahead of the");
  });

  it("is unrecorded in the committed tree", () => {
    expect(RESET_TAKEN_AT_RELEASE).toBeUndefined();
  });
});

describe("the check as CI runs it", () => {
  it("passes against the committed tree, reporting both obligations", () => {
    const { status, stdout } = runCheck();

    expect(status).toBe(0);
    expect(stdout).toContain(RECORD_VERSION_PIN);
    expect(stdout).toContain("recovery path");
    expect(stdout).toContain("development counter");
    expect(stdout).toContain(RESET_RECORD_VERSION);
  });

  it("passes against a fixture copy of that tree, so the fixture is faithful", () => {
    const { status, stdout } = runCheck(fixtureTree());

    expect(status).toBe(0);
    expect(stdout).toContain(RECORD_VERSION_PIN);
  });

  it("reports both rules on one moved literal, in one run", () => {
    const { status, stderr } = runCheck(
      fixtureTree({
        releaseVersion: FIRST_PUBLISHED_RELEASE,
        declared: "psilink-exchange-record/v7",
      }),
    );

    expect(status).toBe(1);
    expect(stderr).toContain("Exchange record version check failed");
    expect(stderr).toContain("moved from");
    expect(stderr).toContain(RESET_RECORD_VERSION);
  });

  it("reports a deleted recovery source rather than crashing on the read", () => {
    // Deleting the file outright is the loudest form of the failure rule 1
    // reports, so it must reach the message naming the entry point: an ENOENT
    // out of the read still exits non-zero, with CI red and the diagnostic lost.
    const [omitted] = Object.keys(RECOVERY_ENTRY_POINTS);
    const { status, stderr } = runCheck(fixtureTree({ omitRecovery: omitted }));

    expect(status).toBe(1);
    expect(stderr).not.toContain("ENOENT");
    expect(stderr).toContain("nothing to defer to");
    for (const name of RECOVERY_ENTRY_POINTS[omitted])
      expect(stderr).toContain(`${omitted}: "${name}"`);
  });

  it("fails a reset taken before the release that publishes it", () => {
    const { status, stderr } = runCheck(
      fixtureTree({ declared: RESET_RECORD_VERSION }),
    );

    expect(status).toBe(1);
    expect(stderr).toContain("already");
  });

  it("fails a taken reset that is not recorded", () => {
    const { status, stderr } = runCheck(
      fixtureTree({
        releaseVersion: FIRST_PUBLISHED_RELEASE,
        declared: RESET_RECORD_VERSION,
      }),
    );

    expect(status).toBe(1);
    expect(stderr).toContain("records no discharge");
  });

  it("passes a published release whose recorded discharges retire both rules", () => {
    // Both discharges driven through the real script, since each is a constant
    // in the check rather than an input the fixture tree carries.
    const moved = "psilink-exchange-record/v2";
    const scriptRoot = mkdtempSync(
      resolve(tmpdir(), "psilink-record-version-script-"),
    );
    temporaryRoots.push(scriptRoot);
    mkdirSync(resolve(scriptRoot, "scripts/lib"), { recursive: true });
    for (const module of [
      "scripts/lib/deferredObligation.mjs",
      "scripts/lib/releaseManifest.mjs",
    ]) {
      copyFileSync(resolve(repoRoot, module), resolve(scriptRoot, module));
    }
    const source = readRoot(CHECK_SOURCE);
    const edits = [
      [
        "export const RESET_TAKEN_AT_RELEASE = undefined;",
        `export const RESET_TAKEN_AT_RELEASE = "${FIRST_PUBLISHED_RELEASE}";`,
      ],
      [
        `export const RECORD_VERSION_PIN = "${RECORD_VERSION_PIN}";`,
        `export const RECORD_VERSION_PIN = "${moved}";`,
      ],
    ];
    const staged = resolve(scriptRoot, CHECK_SOURCE);
    writeFileSync(
      staged,
      edits.reduce((text, [from, to]) => {
        expect(text).toContain(from);
        return text.replace(from, to);
      }, source),
    );

    const { status, stdout } = runCheck(
      fixtureTree({
        releaseVersion: FIRST_PUBLISHED_RELEASE,
        declared: moved,
      }),
      staged,
    );

    expect(status).toBe(0);
    expect(stdout).toContain(`taken at release ${FIRST_PUBLISHED_RELEASE}`);
  });

  it("fails a marker it cannot read rather than treating the reset as not due", () => {
    const root = fixtureTree();
    writeFileSync(
      resolve(root, RELEASE_MANIFEST),
      JSON.stringify({ name: "psilink" }),
    );
    const { status, stderr } = runCheck(root);

    expect(status).toBe(1);
    expect(stderr).toContain("could not run");
    expect(stderr).toContain("no version");
  });

  it("fails a literal it cannot read rather than a comparison it never made", () => {
    const { status, stderr } = runCheck(
      fixtureTree({
        recordSource:
          "export const EXCHANGE_RECORD_VERSION = RECORD_VERSIONS.current;\n",
      }),
    );

    expect(status).toBe(1);
    expect(stderr).toContain("could not run");
    expect(stderr).toContain("extraction pattern rotted");
  });

  it("refuses a --root it was handed no value for", () => {
    const { status } = (() => {
      try {
        execFileSync(process.execPath, [SCRIPT, "--root"], {
          cwd: repoRoot,
          encoding: "utf8",
        });
        return { status: 0 };
      } catch (error) {
        return { status: error.status };
      }
    })();

    expect(status).toBe(2);
  });
});

describe("the check's registration", () => {
  it("is the command the workflow invokes", () => {
    expect(JSON.parse(readRoot("package.json")).scripts).toHaveProperty(
      "check:exchange-record-version",
      `node ${CHECK_SOURCE}`,
    );
  });

  it("is on the list the Static Checks gate runs", () => {
    expect(CHECKS.map((check) => check.script)).toContain(
      "check:exchange-record-version",
    );
  });

  it("is carried by the release checklist step its failures name", () => {
    // The check reads the literal; the artifact-side obligations it cannot read
    // are the checklist's, so a step that stopped carrying them -- or a heading
    // reworded out from under the pointer -- would leave every failure message
    // naming a place that says nothing.
    const releases = readRoot("docs/RELEASES.md");

    expect(releases).toContain(`#### ${CHECKLIST_HEADING}`);
    expect(releases).toContain(RESET_RECORD_VERSION);
    expect(releases).toContain("npm run check:exchange-record-version");
    expect(releases).toContain("RESET_TAKEN_AT_RELEASE");
    // The two artifact classes a downward move leaves misread, by name. The
    // web-store names are extracted from the constants the store actually
    // opens, so a rename there fails here instead of leaving the guidance
    // naming a database that no longer exists.
    const store = readRoot("apps/web/src/psi/managedExchangeStore.ts");
    const dbName = store.match(/MANAGED_EXCHANGE_DB_NAME = "([^"]+)"/)?.[1];
    const storeName = store.match(
      /MANAGED_EXCHANGE_DISCLOSURE_STORE_NAME = "([^"]+)"/,
    )?.[1];
    expect(dbName).toBeTruthy();
    expect(storeName).toBeTruthy();
    expect(releases).toContain(dbName);
    expect(releases).toContain(storeName);
    expect(releases).toContain("psilink-record-");
  });
});
