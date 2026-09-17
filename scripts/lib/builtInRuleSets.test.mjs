import { describe, expect, it } from "vitest";

import {
  REGISTRY_DECLARATION,
  RULE_SET_SOURCE,
  canonicalize,
  contentDigest,
  declaredSets,
  identityConflicts,
  readRuleSets,
  readRuleSetsFrom,
} from "./builtInRuleSets.mjs";

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../..");

/** What one set's six declarations are called, under a per-set prefix. */
const declarationsOf = (prefix) => ({
  fieldSetName: `${prefix}_FIELD_SET_NAME`,
  fieldSetVersion: `${prefix}_FIELD_SET_VERSION`,
  fields: `${prefix}_FIELDS`,
  keySetName: `${prefix}_KEY_SET_NAME`,
  keySetVersion: `${prefix}_KEY_SET_VERSION`,
  keys: `${prefix}_KEYS`,
  ruleSet: `${prefix}_RULE_SET`,
});

/** One rule set as the source declares it: six declarations and the frozen
 * composition over them, the shape the reader follows. */
const ruleSetBlock = ({
  prefix = "DEFAULT",
  fieldSetName = '"baseline-pii"',
  fieldSetVersion = '"1.0.0"',
  fields = '[{ name: "ssn", type: "ssn" }]',
  keySetName = '"hmis-keys"',
  keySetVersion = '"1.0.0"',
  keys = '[{ name: "SSN", elements: [{ field: "ssn" }] }]',
} = {}) => {
  const declared = declarationsOf(prefix);
  return `export const ${declared.fieldSetName} = ${fieldSetName};
export const ${declared.fieldSetVersion} = ${fieldSetVersion};
const ${declared.fields}: ReadonlyArray<LinkageField> = ${fields};
export const ${declared.keySetName} = ${keySetName};
export const ${declared.keySetVersion} = ${keySetVersion};
const ${declared.keys} = ${keys};
export const ${declared.ruleSet}: BuiltInLinkageRuleSet = Object.freeze({
  reference: Object.freeze({
    fieldSet: {
      name: ${declared.fieldSetName},
      version: ${declared.fieldSetVersion},
    },
    keySet: {
      name: ${declared.keySetName},
      version: ${declared.keySetVersion},
    },
  }),
  linkageFields: frozenThroughContents(${declared.fields}),
  linkageKeys: frozenThroughContents(${declared.keys}),
});
`;
};

/** A whole source file: the given sets, and a registry over them. */
const source = ({ sets = [{}], registry } = {}) => {
  const entries = sets
    .map((set) => declarationsOf(set.prefix ?? "DEFAULT").ruleSet)
    .join(", ");
  return `import type { LinkageField } from "../config/linkageTermsSchema";

${sets.map(ruleSetBlock).join("\n")}
export const ${REGISTRY_DECLARATION}: ReadonlyArray<BuiltInLinkageRuleSet> =
  Object.freeze(${registry ?? `[${entries}]`});
`;
};

/** The one set a default source declares. */
const onlySet = (built) => {
  expect(built.unreadable).toEqual([]);
  expect(built.ruleSets).toHaveLength(1);
  return built.ruleSets[0];
};

describe("the registry it follows", () => {
  it("reads each entry's two halves out of the declarations it composes", () => {
    const ruleSet = onlySet(readRuleSets(source()));
    expect(ruleSet.declaration).toBe("DEFAULT_RULE_SET");
    expect(ruleSet.index).toBe(0);
    expect(ruleSet.fieldSet).toEqual({
      role: "fieldSet",
      name: "baseline-pii",
      version: "1.0.0",
      content: [{ name: "ssn", type: "ssn" }],
      declarations: {
        name: "DEFAULT_FIELD_SET_NAME",
        version: "DEFAULT_FIELD_SET_VERSION",
        content: "DEFAULT_FIELDS",
      },
    });
    expect(ruleSet.keySet).toEqual({
      role: "keySet",
      name: "hmis-keys",
      version: "1.0.0",
      content: [{ name: "SSN", elements: [{ field: "ssn" }] }],
      declarations: {
        name: "DEFAULT_KEY_SET_NAME",
        version: "DEFAULT_KEY_SET_VERSION",
        content: "DEFAULT_KEYS",
      },
    });
  });

  it("reads every entry the registry holds, in its declaration order", () => {
    const { ruleSets, unreadable } = readRuleSets(
      source({
        sets: [{}, { prefix: "COUNTY", fieldSetName: '"county-pii"' }],
      }),
    );
    expect(unreadable).toEqual([]);
    expect(ruleSets.map((ruleSet) => ruleSet.fieldSet.name)).toEqual([
      "baseline-pii",
      "county-pii",
    ]);
    expect(ruleSets.map((ruleSet) => ruleSet.declaration)).toEqual([
      "DEFAULT_RULE_SET",
      "COUNTY_RULE_SET",
    ]);
  });

  it("names an inline entry's halves by where they sit", () => {
    const inline = readRuleSets(
      source({
        registry: `[
          {
            reference: {
              fieldSet: { name: "inline-pii", version: "2.0.0" },
              keySet: { name: "inline-keys", version: "2.0.0" },
            },
            linkageFields: [{ name: "ssn", type: "ssn" }],
            linkageKeys: [{ name: "SSN", elements: [{ field: "ssn" }] }],
          },
        ]`,
      }),
    );
    const ruleSet = onlySet(inline);
    expect(ruleSet.fieldSet.name).toBe("inline-pii");
    expect(ruleSet.fieldSet.declarations.content).toBe(
      `${REGISTRY_DECLARATION}[0].linkageFields`,
    );
    expect(ruleSet.keySet.declarations.version).toBe(
      `${REGISTRY_DECLARATION}[0].keySet version`,
    );
  });

  it("refuses a registry that is not an array of entries", () => {
    expect(
      readRuleSets(source({ registry: "shippedRuleSets()" })).unreadable,
    ).toEqual([
      {
        declaration: REGISTRY_DECLARATION,
        reason: expect.stringContaining("rather than an array literal"),
      },
    ]);
    expect(
      readRuleSets(source({ registry: "[...LEGACY_SETS]" })).unreadable[0]
        .reason,
    ).toContain("spread");
    expect(
      readRuleSets(source({ registry: "[]" })).unreadable[0].reason,
    ).toContain("holds no rule set");
  });

  it("refuses a source declaring no registry at all", () => {
    const withoutRegistry = ruleSetBlock();
    expect(readRuleSets(withoutRegistry).unreadable).toEqual([
      {
        declaration: REGISTRY_DECLARATION,
        reason: expect.stringContaining("no top-level"),
      },
    ]);
  });

  it("refuses an entry missing a half, naming the entry", () => {
    const withoutKeys = source().replace(
      /  linkageKeys: frozenThroughContents\(DEFAULT_KEYS\),\n/,
      "",
    );
    expect(readRuleSets(withoutKeys).unreadable).toEqual([
      {
        declaration: "DEFAULT_RULE_SET",
        reason: expect.stringContaining("declares no `linkageKeys`"),
      },
    ]);
  });
});

describe("the declarations it evaluates", () => {
  it("evaluates the literal forms the sets are written in", () => {
    const ruleSet = onlySet(
      readRuleSets(
        source({
          sets: [
            {
              fields: `[
                {
                  name: "ssn",
                  type: "ssn",
                  constraints: { exclude: ["111111111"], validOnly: true },
                },
                {
                  "date_of_birth": "quoted key",
                  transform: [{ params: { start: 1, length: -3 } }],
                  absent: null,
                },
              ]`,
            },
          ],
        }),
      ),
    );
    expect(ruleSet.fieldSet.content).toEqual([
      {
        name: "ssn",
        type: "ssn",
        constraints: { exclude: ["111111111"], validOnly: true },
      },
      {
        date_of_birth: "quoted key",
        transform: [{ params: { start: 1, length: -3 } }],
        absent: null,
      },
    ]);
  });

  it("sees through the type assertions a declaration may have", () => {
    const asserted = readRuleSets(
      source({ sets: [{ keys: '[{ name: "SSN" }] as const' }] }),
    );
    expect(onlySet(asserted).keySet.content).toEqual([{ name: "SSN" }]);
  });

  it("refuses an initializer that is not a literal, naming the declaration", () => {
    const { ruleSets, unreadable } = readRuleSets(
      source({ sets: [{ keys: "buildDefaultKeys()" }] }),
    );
    expect(ruleSets).toEqual([]);
    expect(unreadable).toEqual([
      {
        declaration: "DEFAULT_KEYS",
        reason: expect.stringContaining("rather than a literal"),
      },
    ]);
  });

  it("refuses a spread, whose value lives in another binding", () => {
    const { unreadable } = readRuleSets(
      source({ sets: [{ keys: '[...LEGACY_KEYS, { name: "SSN" }]' }] }),
    );
    expect(unreadable).toEqual([
      {
        declaration: "DEFAULT_KEYS",
        reason: expect.stringContaining("spread"),
      },
    ]);
  });

  it("refuses a computed key and a shorthand property", () => {
    expect(
      readRuleSets(source({ sets: [{ fields: "[{ [nameOf(field)]: 1 }]" }] }))
        .unreadable[0].reason,
    ).toContain("object key is");
    expect(
      readRuleSets(source({ sets: [{ fields: "[{ name }]" }] })).unreadable[0]
        .reason,
    ).toContain("plain `key: value` assignment");
  });

  it("reports a declaration the source does not contain", () => {
    const trimmed = source().replace(/^.*DEFAULT_KEY_SET_VERSION = .*$/m, "");
    expect(readRuleSets(trimmed).unreadable).toEqual([
      {
        declaration: "DEFAULT_KEY_SET_VERSION",
        reason: expect.stringContaining("no top-level"),
      },
    ]);
  });

  it("refuses a declaration that reads itself", () => {
    const circular = source().replace(
      /^const DEFAULT_KEYS = .*$/m,
      "const DEFAULT_KEYS = DEFAULT_KEYS;",
    );
    expect(readRuleSets(circular).unreadable).toEqual([
      {
        declaration: "DEFAULT_KEYS",
        reason: expect.stringContaining("reads itself"),
      },
    ]);
  });

  it("ignores a same-named binding inside a function", () => {
    const shadowed = `${source()}
function build() {
  const DEFAULT_KEYS = [{ name: "shadow" }];
  return DEFAULT_KEYS;
}
`;
    expect(onlySet(readRuleSets(shadowed)).keySet.content).toEqual([
      { name: "SSN", elements: [{ field: "ssn" }] },
    ]);
  });

  it("reads the committed source", () => {
    const { ruleSets, unreadable } = readRuleSetsFrom(repoRoot);
    expect(unreadable).toEqual([]);
    expect(ruleSets.length).toBeGreaterThan(0);
    expect(ruleSets[0].fieldSet.name).toBe("baseline-pii");
    expect(ruleSets[0].keySet.name).toBe("hmis-keys");
    expect(ruleSets[0].keySet.content.length).toBeGreaterThan(0);
  });

  it("fails a tree that does not contain the source at all, naming the file", () => {
    const root = mkdtempSync(resolve(tmpdir(), "psilink-rule-set-source-"));
    try {
      const { ruleSets, unreadable } = readRuleSetsFrom(root);
      expect(ruleSets).toEqual([]);
      expect(unreadable).toEqual([
        {
          declaration: RULE_SET_SOURCE,
          reason: expect.stringContaining("ENOENT"),
        },
      ]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe("the named sets the registry declares", () => {
  const setsOf = (built) => {
    expect(built.unreadable).toEqual([]);
    return declaredSets(built.ruleSets);
  };

  it("lists both halves of every entry, digested", () => {
    const sets = setsOf(readRuleSets(source()));
    expect(sets.map((set) => `${set.name} ${set.version}`)).toEqual([
      "baseline-pii 1.0.0",
      "hmis-keys 1.0.0",
    ]);
    expect(sets[0].digest).toBe(contentDigest([{ name: "ssn", type: "ssn" }]));
    expect(sets[0].entry).toBe("DEFAULT_RULE_SET");
  });

  it("reports no conflict where two entries share one set", () => {
    // Two key sets over one field set is sharing, not a collision: both entries
    // name the same content, so a citation resolving to either is the same
    // answer and one pin covers both.
    const shared = source({
      sets: [
        {},
        { prefix: "COUNTY", keySetName: '"county-keys"', keys: "DEFAULT_KEYS" },
      ],
    });
    const sets = setsOf(readRuleSets(shared));
    expect(sets.map((set) => set.name)).toEqual([
      "baseline-pii",
      "hmis-keys",
      "baseline-pii",
      "county-keys",
    ]);
    expect(identityConflicts(sets)).toEqual([]);
  });

  it("reports a conflict where one name and version covers two contents", () => {
    const collided = source({
      sets: [
        {},
        {
          prefix: "COUNTY",
          keySetName: '"county-keys"',
          fields: '[{ name: "ssn4", type: "ssn4" }]',
        },
      ],
    });
    const conflicts = identityConflicts(setsOf(readRuleSets(collided)));
    expect(conflicts).toHaveLength(1);
    expect(conflicts[0].kind).toBe("identity");
    expect(conflicts[0].set).toBe("baseline-pii");
    expect(conflicts[0].message).toContain("DEFAULT_FIELDS");
    expect(conflicts[0].message).toContain("COUNTY_FIELDS");
    expect(conflicts[0].message).toContain("baseline-pii");
  });

  it("reports a conflict between a field set and a key set of one name", () => {
    // The pin ledger is keyed by name alone, so two halves of one name and
    // version are one entry there whichever role each plays.
    const crossed = source({
      sets: [
        {},
        {
          prefix: "COUNTY",
          fieldSetName: '"shared"',
          keySetName: '"shared"',
        },
      ],
    });
    expect(identityConflicts(setsOf(readRuleSets(crossed)))).toHaveLength(1);
  });

  it("leaves two versions of one name alone", () => {
    const bumped = source({
      sets: [
        {},
        {
          prefix: "COUNTY",
          fieldSetVersion: '"2.0.0"',
          fields: '[{ name: "ssn4", type: "ssn4" }]',
          keySetName: '"county-keys"',
        },
      ],
    });
    expect(identityConflicts(setsOf(readRuleSets(bumped)))).toEqual([]);
  });
});

describe("the digest the pins are taken over", () => {
  it("does not move on the order two properties are written in", () => {
    expect(contentDigest([{ name: "ssn", type: "ssn" }])).toBe(
      contentDigest([{ type: "ssn", name: "ssn" }]),
    );
  });

  it("moves on any value, and on array order", () => {
    expect(contentDigest([{ name: "ssn" }])).not.toBe(
      contentDigest([{ name: "ssn4" }]),
    );
    expect(contentDigest([{ name: "a" }, { name: "b" }])).not.toBe(
      contentDigest([{ name: "b" }, { name: "a" }]),
    );
  });

  it("canonicalizes nested objects and leaves arrays where they are", () => {
    expect(canonicalize({ b: 1, a: [{ d: 2, c: 3 }] })).toEqual({
      a: [{ c: 3, d: 2 }],
      b: 1,
    });
    expect(Object.keys(canonicalize({ b: 1, a: 2 }))).toEqual(["a", "b"]);
  });
});

describe("the source it names", () => {
  it("is the file the built-in sets are declared in", () => {
    expect(RULE_SET_SOURCE).toBe(
      "packages/core/src/defaults/builtInLinkageTerms.ts",
    );
  });

  it("names the registry the committed source declares", () => {
    expect(REGISTRY_DECLARATION).toBe("BUILT_IN_LINKAGE_RULE_SETS");
  });
});
