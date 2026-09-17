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

import { REGISTRY_DECLARATION } from "./lib/builtInRuleSets.mjs";
import {
  NOTE_SECTION,
  RULE_SET_SOURCE,
  inspect,
  keyFieldViolations,
  substrateReport,
} from "./check-zero-setup-keys.mjs";
import { CHECKS } from "./run-checks.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, "..");
const SCRIPT = resolve(here, "check-zero-setup-keys.mjs");

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
  { name: "ssn", type: "ssn" },
  { name: "last_name", type: "last_name" },
  { name: "date_of_birth", type: "date_of_birth" },
];

const KEYS = [
  {
    name: "SSN + LN + DOB",
    elements: [
      { field: "ssn" },
      { field: "last_name" },
      { field: "date_of_birth" },
    ],
  },
];

/** The registry entries the check reads, as its reader hands them over. */
const sets = ({ fields = FIELDS, keys = KEYS, second } = {}) => [
  {
    declaration: "DEFAULT_LINKAGE_RULE_SET",
    fieldSet: { name: "baseline-pii", version: "1.0.0", content: fields },
    keySet: { name: "hmis-keys", version: "1.0.0", content: keys },
  },
  ...(second === undefined ? [] : [second]),
];

/** One rule set as the source declares it: its declarations, and the
 * composition the reader follows from the registry. */
const ruleSetSource = ({ prefix, fieldSetName, fields, keySetName, keys }) => `
export const ${prefix}_FIELD_SET_NAME = "${fieldSetName}";
export const ${prefix}_FIELD_SET_VERSION = "1.0.0";
const ${prefix}_FIELDS = ${JSON.stringify(fields, null, 2)};
export const ${prefix}_KEY_SET_NAME = "${keySetName}";
export const ${prefix}_KEY_SET_VERSION = "1.0.0";
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

/** A tree holding only what the check reads: the registry and its sets. */
function fixtureTree({ fields = FIELDS, keys = KEYS, second, source } = {}) {
  const root = mkdtempSync(resolve(tmpdir(), "psilink-zero-setup-keys-"));
  temporaryRoots.push(root);
  mkdirSync(resolve(root, dirname(RULE_SET_SOURCE)), { recursive: true });
  const entries = [
    {
      prefix: "DEFAULT_LINKAGE",
      fieldSetName: "baseline-pii",
      fields,
      keySetName: "hmis-keys",
      keys,
    },
    ...(second === undefined ? [] : [second]),
  ];
  writeFileSync(
    resolve(root, RULE_SET_SOURCE),
    source ??
      `${entries.map(ruleSetSource).join("")}
export const ${REGISTRY_DECLARATION} = Object.freeze([${entries
        .map((entry) => `${entry.prefix}_RULE_SET`)
        .join(", ")}]);
`,
  );
  return root;
}

describe("the property it holds", () => {
  it("passes a key set built entirely from the declared fields", () => {
    expect(keyFieldViolations(sets())).toEqual([]);
  });

  it("fails a key over a field the set does not declare, naming both", () => {
    const violations = keyFieldViolations(
      sets({
        keys: [
          ...KEYS,
          {
            name: "PHONE + DOB",
            elements: [{ field: "phone_number" }, { field: "date_of_birth" }],
          },
        ],
      }),
    );
    expect(violations).toHaveLength(1);
    expect(violations[0].kind).toBe("outside");
    expect(violations[0].message).toContain('Key "PHONE + DOB"');
    expect(violations[0].message).toContain("`phone_number`");
    expect(violations[0].message).toContain("baseline-pii does not declare");
    expect(violations[0].message).toContain(NOTE_SECTION);
  });

  it("fails a key over a field no input can supply by type", () => {
    const violations = keyFieldViolations(
      sets({
        fields: [{ name: "ssn_full", type: "ssn" }, ...FIELDS.slice(1)],
        keys: [
          {
            name: "SSN + LN",
            elements: [{ field: "ssn_full" }, { field: "last_name" }],
          },
        ],
      }),
    );
    expect(violations).toHaveLength(1);
    expect(violations[0].kind).toBe("unbindable");
    expect(violations[0].message).toContain("`ssn_full`");
    expect(violations[0].message).toContain("type `ssn`");
  });

  it("reports one violation per offending element, not per key", () => {
    const violations = keyFieldViolations(
      sets({
        keys: [
          {
            name: "PHONE + EMAIL",
            elements: [{ field: "phone_number" }, { field: "email_address" }],
          },
        ],
      }),
    );
    expect(violations.map(({ kind }) => kind)).toEqual(["outside", "outside"]);
  });

  it("holds nothing against a declared field no key references", () => {
    expect(
      keyFieldViolations(
        sets({ fields: [...FIELDS, { name: "zip", type: "zip_code" }] }),
      ),
    ).toEqual([]);
  });

  it("holds every set the registry declares, each against its own fields", () => {
    const violations = keyFieldViolations(
      sets({
        second: {
          declaration: "COUNTY_RULE_SET",
          fieldSet: {
            name: "county-pii",
            version: "1.0.0",
            content: [{ name: "ssn", type: "ssn" }],
          },
          keySet: {
            name: "county-keys",
            version: "1.0.0",
            content: [
              {
                name: "SSN + DOB",
                elements: [{ field: "ssn" }, { field: "date_of_birth" }],
              },
            ],
          },
        },
      }),
    );
    expect(violations).toHaveLength(1);
    expect(violations[0].kind).toBe("outside");
    expect(violations[0].message).toContain("county-keys");
    expect(violations[0].message).toContain("county-pii does not declare");
  });

  it("states the substrate the property rests on", () => {
    expect(substrateReport({ ruleSets: sets() })).toEqual([
      "  baseline-pii  ssn -- type ssn",
      "  baseline-pii  last_name -- type last_name",
      "  baseline-pii  date_of_birth -- type date_of_birth",
      "  hmis-keys  1 key, every element inside baseline-pii",
    ]);
  });
});

describe("the check driven end to end", () => {
  it("passes against this repository", () => {
    const { status, stdout } = runCheck();
    expect(status).toBe(0);
    expect(stdout).toContain("Zero-setup key-field check passed");
  });

  it("fails a tree whose default key leaves the field set", () => {
    const root = fixtureTree({
      keys: [
        ...KEYS,
        {
          name: "PHONE + DOB",
          elements: [{ field: "phone_number" }, { field: "date_of_birth" }],
        },
      ],
    });
    const { status, stderr } = runCheck(root);
    expect(status).toBe(1);
    expect(stderr).toContain("Zero-setup key-field check failed");
    expect(stderr).toContain("`phone_number`");
  });

  it("fails a second registry set whose key leaves its own field set", () => {
    const root = fixtureTree({
      second: {
        prefix: "COUNTY",
        fieldSetName: "county-pii",
        fields: [{ name: "ssn", type: "ssn" }],
        keySetName: "county-keys",
        keys: [{ name: "EMAIL", elements: [{ field: "email_address" }] }],
      },
    });
    const { status, stderr } = runCheck(root);
    expect(status).toBe(1);
    expect(stderr).toContain("`email_address`");
    expect(stderr).toContain("county-pii does not declare");
  });

  it("fails a set it cannot read rather than reading it as empty", () => {
    const root = fixtureTree({
      source: `const DEFAULT_LINKAGE_KEYS = buildDefaultKeys();
export const DEFAULT_LINKAGE_RULE_SET = Object.freeze({
  reference: Object.freeze({
    fieldSet: { name: "baseline-pii", version: "1.0.0" },
    keySet: { name: "hmis-keys", version: "1.0.0" },
  }),
  linkageFields: [{ name: "ssn", type: "ssn" }],
  linkageKeys: frozenThroughContents(DEFAULT_LINKAGE_KEYS),
});
export const ${REGISTRY_DECLARATION} = Object.freeze([DEFAULT_LINKAGE_RULE_SET]);
`,
    });
    const { status, stderr } = runCheck(root);
    expect(status).toBe(1);
    expect(stderr).toContain("could not run");
    expect(stderr).toContain("DEFAULT_LINKAGE_KEYS");
    expect(inspect(root).violations).toEqual([]);
  });

  it("fails a --root missing the source file rather than crashing", () => {
    const root = mkdtempSync(resolve(tmpdir(), "psilink-zero-setup-keys-"));
    temporaryRoots.push(root);
    const { status, stderr } = runCheck(root);
    expect(status).toBe(1);
    expect(stderr).toContain("Zero-setup key-field check could not run");
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
});

describe("the check's registration", () => {
  it("is the command the workflow invokes", () => {
    expect(JSON.parse(readRoot("package.json")).scripts).toHaveProperty(
      "check:zero-setup-keys",
      "node scripts/check-zero-setup-keys.mjs",
    );
  });

  it("is on the list the Static Checks gate runs", () => {
    expect(CHECKS.map((check) => check.script)).toContain(
      "check:zero-setup-keys",
    );
  });
});
