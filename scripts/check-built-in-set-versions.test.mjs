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

import { REGISTRY_DECLARATION, contentDigest } from "./lib/builtInRuleSets.mjs";
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
import { CHECKS } from "./run-checks.mjs";

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

/** What each half of the default entry is declared as, as the reader reports
 * it: what a failure names for the author to edit. */
const DECLARATIONS = {
  fieldSet: {
    name: "DEFAULT_LINKAGE_FIELD_SET_NAME",
    version: "DEFAULT_LINKAGE_FIELD_SET_VERSION",
    content: "DEFAULT_LINKAGE_FIELDS",
  },
  keySet: {
    name: "DEFAULT_LINKAGE_KEY_SET_NAME",
    version: "DEFAULT_LINKAGE_KEY_SET_VERSION",
    content: "DEFAULT_LINKAGE_KEYS",
  },
};

/** The named sets a registry declares, as the reader hands them over. */
const declaredSets = ({
  fieldSetVersion = "1.0.0",
  keySetVersion = "1.0.0",
  fields = FIELDS,
  keys = KEYS,
} = {}) => [
  {
    role: "fieldSet",
    name: "baseline-pii",
    version: fieldSetVersion,
    digest: contentDigest(fields),
    declarations: DECLARATIONS.fieldSet,
  },
  {
    role: "keySet",
    name: "hmis-keys",
    version: keySetVersion,
    digest: contentDigest(keys),
    declarations: DECLARATIONS.keySet,
  },
];

/** The ledger those sets imply at their declared versions. */
const ledgerFor = (sets) =>
  Object.fromEntries(
    sets.map((set) => [set.name, { [set.version]: set.digest }]),
  );

/** One rule set as the source declares it: its declarations, and the
 * composition the reader follows from the registry. */
const ruleSetSource = ({
  prefix,
  fieldSetName,
  fieldSetVersion,
  fields,
  keySetName,
  keySetVersion,
  keys,
}) => `
export const ${prefix}_FIELD_SET_NAME = "${fieldSetName}";
export const ${prefix}_FIELD_SET_VERSION = "${fieldSetVersion}";
const ${prefix}_FIELDS = ${JSON.stringify(fields, null, 2)};
export const ${prefix}_KEY_SET_NAME = "${keySetName}";
export const ${prefix}_KEY_SET_VERSION = "${keySetVersion}";
const ${prefix}_KEYS = ${JSON.stringify(keys, null, 2)};
export const ${prefix}_RULE_SET = Object.freeze({
  reference: Object.freeze({
    fieldSet: {
      name: ${prefix}_FIELD_SET_NAME,
      version: ${prefix}_FIELD_SET_VERSION,
    },
    keySet: { name: ${prefix}_KEY_SET_NAME, version: ${prefix}_KEY_SET_VERSION },
  }),
  linkageFields: frozenThroughContents(${prefix}_FIELDS),
  linkageKeys: frozenThroughContents(${prefix}_KEYS),
});
`;

/** A tree holding only what the check reads: the registry's sets and the
 * ledger. */
function fixtureTree({
  fieldSetVersion = "1.0.0",
  keySetVersion = "1.0.0",
  fields = FIELDS,
  keys = KEYS,
  second,
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
      `${ruleSetSource({
        prefix: "DEFAULT_LINKAGE",
        fieldSetName: "baseline-pii",
        fieldSetVersion,
        fields,
        keySetName: "hmis-keys",
        keySetVersion,
        keys,
      })}${second === undefined ? "" : ruleSetSource(second)}
export const ${REGISTRY_DECLARATION} = Object.freeze([DEFAULT_LINKAGE_RULE_SET${
        second === undefined ? "" : `, ${second.prefix}_RULE_SET`
      }]);
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
      "1.1.0": sets[0].digest,
    });
    expect(block.pins["hmis-keys"]).toBeUndefined();
  });
});

describe("the rule over a recorded pin", () => {
  it("passes content that matches what the ledger records", () => {
    const sets = declaredSets();
    expect(pinViolations({ sets, pins: ledgerFor(sets) })).toEqual([]);
  });

  it("fails moved key content containing no bump, naming the note", () => {
    const sets = declaredSets();
    const moved = declaredSets({ keys: [...KEYS, { name: "LN + SSN" }] });
    const violations = pinViolations({ sets: moved, pins: ledgerFor(sets) });
    expect(violations).toHaveLength(1);
    expect(violations[0].kind).toBe("moved");
    expect(violations[0].set).toBe("hmis-keys");
    expect(violations[0].message).toContain(DECLARATIONS.keySet.content);
    expect(violations[0].message).toContain(DECLARATIONS.keySet.version);
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

  it("asks for a pin for a set the ledger does not hold at all", () => {
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
    expect(stderr).toContain(DECLARATIONS.keySet.version);
  });

  it("pins a second registry set the same way as the first", () => {
    const countyFields = [{ name: "ssn", type: "ssn" }];
    const countyKeys = [{ name: "SSN", elements: [{ field: "ssn" }] }];
    const second = {
      prefix: "COUNTY",
      fieldSetName: "county-pii",
      fieldSetVersion: "1.0.0",
      fields: countyFields,
      keySetName: "county-keys",
      keySetVersion: "1.0.0",
      keys: countyKeys,
    };
    const unpinned = fixtureTree({ second, pins: ledgerFor(declaredSets()) });
    expect(runCheck(unpinned).stderr).toContain(
      "records no pin for county-pii",
    );

    const pins = ledgerFor(declaredSets());
    pins["county-pii"] = { "1.0.0": contentDigest(countyFields) };
    pins["county-keys"] = { "1.0.0": contentDigest(countyKeys) };
    const pinned = fixtureTree({ second, pins });
    const { status, stdout } = runCheck(pinned);
    expect(status).toBe(0);
    expect(stdout).toContain("county-keys 1.0.0");
  });

  it("fails one name and version covering two different contents", () => {
    // A second entry over its own idea of baseline-pii 1.0.0 would resolve to
    // whichever came first and ship the other under a name nothing holds it to.
    const root = fixtureTree({
      second: {
        prefix: "COUNTY",
        fieldSetName: "baseline-pii",
        fieldSetVersion: "1.0.0",
        fields: [{ name: "ssn", type: "ssn" }],
        keySetName: "county-keys",
        keySetVersion: "1.0.0",
        keys: [{ name: "SSN", elements: [{ field: "ssn" }] }],
      },
      pins: ledgerFor(declaredSets()),
    });
    const { status, stderr } = runCheck(root);
    expect(status).toBe(1);
    expect(stderr).toContain(
      'declares "baseline-pii" 1.0.0 over two different',
    );
    expect(stderr).toContain("DEFAULT_LINKAGE_FIELDS");
    expect(stderr).toContain("COUNTY_FIELDS");
  });

  it("passes a set two entries share, which is one content under one name", () => {
    const root = fixtureTree({
      second: {
        prefix: "COUNTY",
        fieldSetName: "baseline-pii",
        fieldSetVersion: "1.0.0",
        fields: FIELDS,
        keySetName: "county-keys",
        keySetVersion: "1.0.0",
        keys: [{ name: "LN", elements: [{ field: "last_name" }] }],
      },
      pins: {
        ...ledgerFor(declaredSets()),
        "county-keys": {
          "1.0.0": contentDigest([
            { name: "LN", elements: [{ field: "last_name" }] },
          ]),
        },
      },
    });
    const { status, stdout } = runCheck(root);
    expect(status).toBe(0);
    expect(stdout.match(/baseline-pii 1\.0\.0/g)).toHaveLength(1);
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

  it("states the pin each set holds on a passing run", () => {
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

  it("is on the list the Static Checks gate runs", () => {
    expect(CHECKS.map((check) => check.script)).toContain(
      "check:built-in-set-versions",
    );
  });

  it("ships a pin for each declared set the rule binds", () => {
    const pins = JSON.parse(readRoot(PINS_FILE)).pins;
    expect(Object.keys(pins).sort()).toEqual(["baseline-pii", "hmis-keys"]);
    for (const entry of Object.values(pins)) {
      expect(Object.keys(entry).length).toBeGreaterThan(0);
    }
  });
});
