import { execFileSync } from "node:child_process";
import {
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
  FIELD_SET_DECLARATIONS,
  KEY_SET_DECLARATIONS,
  contentDigest,
} from "./lib/builtInRuleSets.mjs";
import {
  NOTE_SECTION,
  PINS_FILE,
  RULE_SET_SOURCE,
  compareVersions,
  parseVersion,
  pinReport,
  pinViolations,
  suggestedLedger,
  suggestionVersion,
} from "./check-built-in-set-versions.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, "..");
const SCRIPT = resolve(here, "check-built-in-set-versions.mjs");

const readRoot = (relative) =>
  readFileSync(resolve(repoRoot, relative), "utf8");

// The script driven as the workflow runs it, against `root` or -- with no root
// -- against this repository.
function runCheck(root) {
  const args = root === undefined ? [SCRIPT] : [SCRIPT, "--root", root];
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

const temporaryRoots = [];
afterAll(() => {
  for (const root of temporaryRoots)
    rmSync(root, { recursive: true, force: true });
});

const FIELDS = [
  { name: "ssn", type: "ssn", constraints: { validOnly: true } },
  { name: "last_name", type: "last_name" },
];

const KEYS = [
  { name: "SSN + LN", elements: [{ field: "ssn" }, { field: "last_name" }] },
  { name: "LN", elements: [{ field: "last_name" }] },
];

const declaredSets = ({
  fieldSetVersion = "1.0.0",
  keySetVersion = "1.0.0",
  fields = FIELDS,
  keys = KEYS,
} = {}) => ({
  fieldSet: {
    name: "baseline-pii",
    version: fieldSetVersion,
    digest: contentDigest(fields),
  },
  keySet: {
    name: "hmis-keys",
    version: keySetVersion,
    digest: contentDigest(keys),
  },
});

/** The ledger those sets imply at their declared versions. */
const ledgerFor = (sets) =>
  Object.fromEntries(
    Object.values(sets).map((set) => [set.name, { [set.version]: set.digest }]),
  );

/** A tree carrying only what the check reads: the two sets and the ledger. */
function fixtureTree({
  fieldSetVersion = "1.0.0",
  keySetVersion = "1.0.0",
  fields = FIELDS,
  keys = KEYS,
  source,
  pins,
  ledgerText,
} = {}) {
  const root = mkdtempSync(resolve(tmpdir(), "psilink-set-versions-"));
  temporaryRoots.push(root);
  const write = (relative, content) => {
    mkdirSync(resolve(root, dirname(relative)), { recursive: true });
    writeFileSync(resolve(root, relative), content);
  };
  write(
    RULE_SET_SOURCE,
    source ??
      `export const ${FIELD_SET_DECLARATIONS.name} = "baseline-pii";
export const ${FIELD_SET_DECLARATIONS.version} = "${fieldSetVersion}";
const ${FIELD_SET_DECLARATIONS.content} = ${JSON.stringify(fields, null, 2)};
export const ${KEY_SET_DECLARATIONS.name} = "hmis-keys";
export const ${KEY_SET_DECLARATIONS.version} = "${keySetVersion}";
const ${KEY_SET_DECLARATIONS.content} = ${JSON.stringify(keys, null, 2)};
`,
  );
  write(
    PINS_FILE,
    ledgerText ??
      JSON.stringify(
        {
          pins:
            pins ?? ledgerFor(declaredSets({ fieldSetVersion, keySetVersion })),
        },
        null,
        2,
      ),
  );
  return root;
}

describe("the versions the pins are recorded under", () => {
  it("reads a major.minor.patch triple out of its shape", () => {
    expect(parseVersion("1.0.0")).toEqual([1, 0, 0]);
    expect(parseVersion("2.11.3")).toEqual([2, 11, 3]);
  });

  it("reads anything else as none rather than guessing", () => {
    for (const version of ["1.0", "v1.0.0", "1.0.0-rc.1", "", 1, undefined]) {
      expect(parseVersion(version)).toBeUndefined();
    }
  });

  it("orders by component", () => {
    expect(compareVersions("1.0.0", "1.0.1")).toBeLessThan(0);
    expect(compareVersions("1.2.0", "1.10.0")).toBeLessThan(0);
    expect(compareVersions("2.0.0", "1.9.9")).toBeGreaterThan(0);
    expect(compareVersions("1.0.0", "1.0.0")).toBe(0);
  });
});

describe("the ledger block a failure prints", () => {
  it("records under the declared version when the ledger holds none", () => {
    expect(suggestionVersion({}, "1.0.0")).toBe("1.0.0");
  });

  it("records under the next minor when the declared version has moved", () => {
    expect(suggestionVersion({ "1.4.2": "sha256:x" }, "1.4.2")).toBe("1.5.0");
  });

  it("adds the entry beside the recorded ones rather than over them", () => {
    const sets = declaredSets();
    const pins = { "baseline-pii": { "1.0.0": "sha256:old" } };
    const block = JSON.parse(
      suggestedLedger(pins, sets, { "baseline-pii": "1.1.0" }),
    );
    expect(block.pins["baseline-pii"]).toEqual({
      "1.0.0": "sha256:old",
      "1.1.0": sets.fieldSet.digest,
    });
    expect(block.pins["hmis-keys"]).toBeUndefined();
  });
});

describe("the rule over a recorded pin", () => {
  it("passes content that matches what the ledger records", () => {
    const sets = declaredSets();
    expect(pinViolations({ sets, pins: ledgerFor(sets) })).toEqual([]);
  });

  it("fails moved key content carrying no bump, naming the note", () => {
    const sets = declaredSets();
    const moved = declaredSets({ keys: [...KEYS, { name: "LN + SSN" }] });
    const violations = pinViolations({ sets: moved, pins: ledgerFor(sets) });
    expect(violations).toHaveLength(1);
    expect(violations[0].kind).toBe("moved");
    expect(violations[0].set).toBe("hmis-keys");
    expect(violations[0].message).toContain(KEY_SET_DECLARATIONS.content);
    expect(violations[0].message).toContain(KEY_SET_DECLARATIONS.version);
    expect(violations[0].message).toContain(NOTE_SECTION);
  });

  it("fails a reorder of the keys, which is cascade order", () => {
    const sets = declaredSets();
    const reordered = declaredSets({ keys: [KEYS[1], KEYS[0]] });
    expect(
      pinViolations({ sets: reordered, pins: ledgerFor(sets) }).map(
        ({ kind }) => kind,
      ),
    ).toEqual(["moved"]);
  });

  it("fails a key renamed with its elements left alone", () => {
    const sets = declaredSets();
    const renamed = declaredSets({
      keys: [{ ...KEYS[0], name: "SSN + LASTNAME" }, KEYS[1]],
    });
    expect(
      pinViolations({ sets: renamed, pins: ledgerFor(sets) }).map(
        ({ kind }) => kind,
      ),
    ).toEqual(["moved"]);
  });

  it("holds nothing against a property written in another order", () => {
    const sets = declaredSets();
    const rewritten = declaredSets({
      fields: [
        { type: "ssn", constraints: { validOnly: true }, name: "ssn" },
        { type: "last_name", name: "last_name" },
      ],
    });
    expect(pinViolations({ sets: rewritten, pins: ledgerFor(sets) })).toEqual(
      [],
    );
  });

  it("versions each set independently", () => {
    const sets = declaredSets();
    const editedFields = declaredSets({
      fields: [...FIELDS, { name: "ssn4", type: "ssn4" }],
    });
    const violations = pinViolations({
      sets: editedFields,
      pins: ledgerFor(sets),
    });
    expect(violations.map(({ set }) => set)).toEqual(["baseline-pii"]);
  });

  it("asks for the pin a bump introduces", () => {
    const sets = declaredSets();
    const bumped = declaredSets({
      keySetVersion: "1.1.0",
      keys: [...KEYS, { name: "LN + SSN" }],
    });
    const violations = pinViolations({ sets: bumped, pins: ledgerFor(sets) });
    expect(violations).toHaveLength(1);
    expect(violations[0].kind).toBe("record");
    expect(violations[0].message).toContain("hmis-keys 1.1.0");
  });

  it("fails a pin recorded ahead of the declared version", () => {
    const sets = declaredSets();
    const pins = ledgerFor(sets);
    pins["hmis-keys"]["2.0.0"] = "sha256:unshipped";
    const violations = pinViolations({ sets, pins });
    expect(violations).toHaveLength(1);
    expect(violations[0].kind).toBe("ledger");
    expect(violations[0].message).toContain("above the 1.0.0");
  });

  it("fails a ledger key that is not a version, naming the key", () => {
    const sets = declaredSets();
    const pins = ledgerFor(sets);
    pins["hmis-keys"]["latest"] = "sha256:unlookupable";
    const violations = pinViolations({ sets, pins });
    expect(violations.map(({ kind }) => kind)).toEqual(["ledger"]);
    expect(violations[0].message).toContain('under "latest"');
  });

  it("fails an entry under a set name the source does not declare", () => {
    const sets = declaredSets();
    const pins = { ...ledgerFor(sets), "hmis-keys-legacy": { "1.0.0": "x" } };
    const violations = pinViolations({ sets, pins });
    expect(violations.map(({ kind }) => kind)).toEqual(["ledger"]);
    expect(violations[0].message).toContain('"hmis-keys-legacy"');
  });

  it("asks for a pin for a set the ledger does not carry at all", () => {
    const sets = declaredSets();
    const violations = pinViolations({ sets, pins: {} });
    expect(violations.map(({ kind, set }) => [kind, set])).toEqual([
      ["record", "baseline-pii"],
      ["record", "hmis-keys"],
    ]);
  });
});

describe("the check driven end to end", () => {
  it("passes against this repository", () => {
    const { status, stdout } = runCheck();
    expect(status).toBe(0);
    expect(stdout).toContain("Built-in rule set version check passed");
  });

  it("fails an edited key set whose version stayed where it was", () => {
    const root = fixtureTree({ pins: ledgerFor(declaredSets()) });
    writeFileSync(
      resolve(root, RULE_SET_SOURCE),
      readFileSync(resolve(root, RULE_SET_SOURCE), "utf8").replace(
        '"name": "LN"',
        '"name": "LN only"',
      ),
    );
    const { status, stderr } = runCheck(root);
    expect(status).toBe(1);
    expect(stderr).toContain("Built-in rule set version check failed");
    expect(stderr).toContain("has moved under hmis-keys 1.0.0");
    expect(stderr).toContain(`The ledger ${PINS_FILE} would carry`);
    expect(stderr).toContain('"1.1.0"');
  });

  it("passes the same edit once it bumps and records the new pin", () => {
    const keys = [KEYS[0], { ...KEYS[1], name: "LN only" }];
    const pins = ledgerFor(declaredSets());
    pins["hmis-keys"]["1.1.0"] = contentDigest(keys);
    const root = fixtureTree({ keys, keySetVersion: "1.1.0", pins });
    const { status, stdout } = runCheck(root);
    expect(status).toBe(0);
    expect(stdout).toContain("hmis-keys 1.1.0");
  });

  it("fails a bump that records no pin for the version it introduces", () => {
    const root = fixtureTree({
      keys: [KEYS[0], { ...KEYS[1], name: "LN only" }],
      keySetVersion: "1.1.0",
      pins: ledgerFor(declaredSets()),
    });
    const { status, stderr } = runCheck(root);
    expect(status).toBe(1);
    expect(stderr).toContain("records no pin for hmis-keys 1.1.0");
  });

  it("fails a ledger it cannot read rather than passing as agreement", () => {
    const root = fixtureTree({ ledgerText: "{ not json" });
    const { status, stderr } = runCheck(root);
    expect(status).toBe(1);
    expect(stderr).toContain("could not run");
    expect(stderr).toContain("no `pins` object");
  });

  it("fails a version declaration it cannot read", () => {
    const root = fixtureTree({ keySetVersion: "latest" });
    const { status, stderr } = runCheck(root);
    expect(status).toBe(1);
    expect(stderr).toContain("could not run");
    expect(stderr).toContain(KEY_SET_DECLARATIONS.version);
  });

  it("fails a --root missing the source file rather than crashing", () => {
    const root = mkdtempSync(resolve(tmpdir(), "psilink-set-versions-"));
    temporaryRoots.push(root);
    const { status, stderr } = runCheck(root);
    expect(status).toBe(1);
    expect(stderr).toContain("Built-in rule set version check could not run");
    expect(stderr).toContain(RULE_SET_SOURCE);
    expect(stderr).toContain("could not be read");
    expect(stderr).not.toMatch(/\n\s+at /);
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

  it("states the pin each set carries on a passing run", () => {
    expect(pinReport(declaredSets())).toEqual([
      `  baseline-pii 1.0.0 -- ${contentDigest(FIELDS)}`,
      `  hmis-keys 1.0.0 -- ${contentDigest(KEYS)}`,
    ]);
  });
});

describe("the check's registration", () => {
  it("is the command the workflow invokes", () => {
    expect(JSON.parse(readRoot("package.json")).scripts).toHaveProperty(
      "check:built-in-set-versions",
      "node scripts/check-built-in-set-versions.mjs",
    );
  });

  it("runs as a step of the Static Checks gate", () => {
    const workflow = parse(readRoot(".github/workflows/static_checks.yaml"));
    const steps = Object.values(workflow.jobs).flatMap((job) => job.steps);
    expect(
      steps.some((step) =>
        (step.run ?? "").includes("npm run check:built-in-set-versions"),
      ),
    ).toBe(true);
  });

  it("ships a pin for each declared set, the rule binding now", () => {
    const pins = JSON.parse(readRoot(PINS_FILE)).pins;
    expect(Object.keys(pins).sort()).toEqual(["baseline-pii", "hmis-keys"]);
    for (const entry of Object.values(pins)) {
      expect(Object.keys(entry).length).toBeGreaterThan(0);
    }
  });
});
