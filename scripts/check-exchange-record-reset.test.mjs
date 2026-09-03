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

import { parse } from "yaml";

import {
  CHECKLIST_HEADING,
  CHECKLIST_STEP,
  PRE_PUBLICATION_RELEASE,
  RECORD_VERSION_SOURCE,
  RELEASE_MANIFEST,
  RESET_RECORD_VERSION,
  RESET_SOURCE,
  RESET_TAKEN_AT_RELEASE,
  resetViolations,
} from "./check-exchange-record-reset.mjs";
import { PRE_PUBLICATION_RELEASE as PROTOCOL_CHECK_FLOOR } from "./check-protocol-version-bump.mjs";
import { declaredRecordVersion } from "./lib/exchangeRecordVersion.mjs";

/**
 * The first-publication reset rule. Its two halves bind at opposite ends of one
 * release marker -- the literal must not be the reset value before it, and must
 * be at it -- and the repository sits on the first half, so the armed states are
 * driven through the real script against fixture trees.
 */

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, "..");
const SCRIPT = resolve(here, "check-exchange-record-reset.mjs");

const readRoot = (relative) =>
  readFileSync(resolve(repoRoot, relative), "utf8");

const temporaryRoots = [];
afterAll(() => {
  for (const root of temporaryRoots)
    rmSync(root, { recursive: true, force: true });
});

const DEVELOPMENT_VERSION = "psilink-exchange-record/v6";
const FIRST_PUBLISHED_RELEASE = "0.2.0";

/** The kinds a set of violations reports, in the order reported. */
const kindsOf = (violations) => violations.map(({ kind }) => kind);

/** The state the check reads, with `overrides` applied. */
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
 * A tree carrying only what the check reads: the release manifest and the record
 * version source. This is how the states beyond this repository's own are driven
 * end to end through the real script.
 */
function fixtureTree({
  releaseVersion = PRE_PUBLICATION_RELEASE,
  declared = DEVELOPMENT_VERSION,
  recordSource,
} = {}) {
  const root = mkdtempSync(resolve(tmpdir(), "psilink-record-reset-"));
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

describe("the marker the reset is dated by", () => {
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

describe("the recorded discharge", () => {
  it("retires the rule, so a later forward bump is not held to the reset", () => {
    // The reset is taken once. Without this the check would fail every ordinary
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
  it("passes against the committed tree, naming the reset still to come", () => {
    const { status, stdout } = runCheck();

    expect(status).toBe(0);
    expect(stdout).toContain("development counter");
    expect(stdout).toContain(RESET_RECORD_VERSION);
  });

  it("reads the committed literal as a value the reset has not reached", () => {
    expect(declaredRecordVersion(readRoot(RECORD_VERSION_SOURCE))).not.toBe(
      RESET_RECORD_VERSION,
    );
  });

  it("fails a published release that did not take the reset", () => {
    const { status, stderr } = runCheck(
      fixtureTree({ releaseVersion: FIRST_PUBLISHED_RELEASE }),
    );

    expect(status).toBe(1);
    expect(stderr).toContain("Exchange record reset check failed");
    expect(stderr).toContain(RESET_RECORD_VERSION);
  });

  it("fails a reset taken before that release", () => {
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

  it("passes a published release whose recorded discharge retires the rule", () => {
    // The retire driven through the real script, since the discharge is a
    // constant in the check rather than an input the fixture tree carries.
    const scriptRoot = mkdtempSync(resolve(tmpdir(), "psilink-reset-script-"));
    temporaryRoots.push(scriptRoot);
    mkdirSync(resolve(scriptRoot, "scripts/lib"), { recursive: true });
    for (const relative of [
      "scripts/lib/exchangeRecordVersion.mjs",
      "scripts/lib/releaseManifest.mjs",
    ]) {
      copyFileSync(resolve(repoRoot, relative), resolve(scriptRoot, relative));
    }
    const declaration = "export const RESET_TAKEN_AT_RELEASE = undefined;";
    const source = readRoot(RESET_SOURCE);
    expect(source).toContain(declaration);
    const staged = resolve(scriptRoot, RESET_SOURCE);
    writeFileSync(
      staged,
      source.replace(
        declaration,
        `export const RESET_TAKEN_AT_RELEASE = "${FIRST_PUBLISHED_RELEASE}";`,
      ),
    );

    const { status, stdout } = runCheck(
      fixtureTree({
        releaseVersion: FIRST_PUBLISHED_RELEASE,
        declared: "psilink-exchange-record/v2",
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
      "check:exchange-record-reset",
      `node ${RESET_SOURCE}`,
    );
  });

  it("runs as a step of the Static Checks gate", () => {
    const workflow = parse(readRoot(".github/workflows/static_checks.yaml"));
    const steps = Object.values(workflow.jobs).flatMap((job) => job.steps);

    expect(
      steps.some((step) =>
        (step.run ?? "").includes("npm run check:exchange-record-reset"),
      ),
    ).toBe(true);
  });

  it("is carried by the release checklist step its failures name", () => {
    // The check reads the literal; the artifact-side obligations it cannot read
    // are the checklist's, so a step that stopped carrying them -- or a heading
    // reworded out from under the pointer -- would leave every failure message
    // naming a place that says nothing.
    const releases = readRoot("docs/RELEASES.md");

    expect(releases).toContain(`#### ${CHECKLIST_HEADING}`);
    expect(releases).toContain(RESET_RECORD_VERSION);
    expect(releases).toContain("npm run check:exchange-record-reset");
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
