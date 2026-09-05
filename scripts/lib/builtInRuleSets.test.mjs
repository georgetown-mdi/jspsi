import { afterAll, describe, expect, it } from "vitest";

import {
  FIELD_SET_DECLARATIONS,
  KEY_SET_DECLARATIONS,
  RULE_SET_SOURCE,
  canonicalize,
  contentDigest,
  declaredLiterals,
  readRuleSets,
  readRuleSetsFrom,
} from "./builtInRuleSets.mjs";

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../..");

const source = ({
  fieldSetName = '"baseline-pii"',
  fieldSetVersion = '"1.0.0"',
  fields = '[{ name: "ssn", type: "ssn" }]',
  keySetName = '"hmis-keys"',
  keySetVersion = '"1.0.0"',
  keys = '[{ name: "SSN", elements: [{ field: "ssn" }] }]',
} = {}) => `import type { LinkageField } from "../config/linkageTerms";

export const ${FIELD_SET_DECLARATIONS.name} = ${fieldSetName};
export const ${FIELD_SET_DECLARATIONS.version} = ${fieldSetVersion};
const ${FIELD_SET_DECLARATIONS.content}: ReadonlyArray<LinkageField> = ${fields};
export const ${KEY_SET_DECLARATIONS.name} = ${keySetName};
export const ${KEY_SET_DECLARATIONS.version} = ${keySetVersion};
const ${KEY_SET_DECLARATIONS.content} = ${keys};
`;

describe("the declarations it evaluates", () => {
  it("reads both sets out of the source", () => {
    const { fieldSet, keySet, unreadable } = readRuleSets(source());
    expect(unreadable).toEqual([]);
    expect(fieldSet).toEqual({
      name: "baseline-pii",
      version: "1.0.0",
      content: [{ name: "ssn", type: "ssn" }],
    });
    expect(keySet).toEqual({
      name: "hmis-keys",
      version: "1.0.0",
      content: [{ name: "SSN", elements: [{ field: "ssn" }] }],
    });
  });

  it("evaluates the literal forms the sets are written in", () => {
    const { fieldSet } = readRuleSets(
      source({
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
      }),
    );
    expect(fieldSet.content).toEqual([
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
      source({ keys: '[{ name: "SSN" }] as const' }),
    );
    expect(asserted.keySet.content).toEqual([{ name: "SSN" }]);
  });

  it("refuses an initializer that is not a literal, naming the declaration", () => {
    const { keySet, unreadable } = readRuleSets(
      source({ keys: "buildDefaultKeys()" }),
    );
    expect(keySet).toBeUndefined();
    expect(unreadable).toEqual([
      {
        declaration: KEY_SET_DECLARATIONS.content,
        reason: expect.stringContaining("rather than a literal"),
      },
    ]);
  });

  it("refuses a spread, whose value lives in another binding", () => {
    const { unreadable } = readRuleSets(
      source({ keys: '[...LEGACY_KEYS, { name: "SSN" }]' }),
    );
    expect(unreadable).toEqual([
      {
        declaration: KEY_SET_DECLARATIONS.content,
        reason: expect.stringContaining("spread"),
      },
    ]);
  });

  it("refuses a computed key and a shorthand property", () => {
    expect(
      readRuleSets(source({ fields: "[{ [nameOf(field)]: 1 }]" })).unreadable[0]
        .reason,
    ).toContain("object key is");
    expect(
      readRuleSets(source({ fields: "[{ name }]" })).unreadable[0].reason,
    ).toContain("plain `key: value` assignment");
  });

  it("reports a declaration the source does not contain", () => {
    const trimmed = source().replace(
      new RegExp(`^.*${KEY_SET_DECLARATIONS.version}.*$`, "m"),
      "",
    );
    expect(readRuleSets(trimmed).unreadable).toEqual([
      {
        declaration: KEY_SET_DECLARATIONS.version,
        reason: expect.stringContaining("no top-level"),
      },
    ]);
  });

  it("ignores a same-named binding inside a function", () => {
    const shadowed = `${source()}
function build() {
  const ${KEY_SET_DECLARATIONS.content} = [{ name: "shadow" }];
  return ${KEY_SET_DECLARATIONS.content};
}
`;
    expect(readRuleSets(shadowed).keySet.content).toEqual([
      { name: "SSN", elements: [{ field: "ssn" }] },
    ]);
  });

  it("reads the committed source", () => {
    const { fieldSet, keySet, unreadable } = readRuleSetsFrom(repoRoot);
    expect(unreadable).toEqual([]);
    expect(fieldSet.name).toBe("baseline-pii");
    expect(keySet.name).toBe("hmis-keys");
    expect(keySet.content.length).toBeGreaterThan(0);
  });

  it("fails a tree that does not contain the source at all, naming the file", () => {
    const root = mkdtempSync(resolve(tmpdir(), "psilink-rule-set-source-"));
    try {
      const { fieldSet, keySet, unreadable } = readRuleSetsFrom(root);
      expect(fieldSet).toBeUndefined();
      expect(keySet).toBeUndefined();
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
    expect(RULE_SET_SOURCE).toBe("packages/core/src/defaults/linkageTerms.ts");
  });

  it("names every declaration it reads", () => {
    expect(
      declaredLiterals(source(), [FIELD_SET_DECLARATIONS.name]).values,
    ).toEqual({ [FIELD_SET_DECLARATIONS.name]: "baseline-pii" });
  });
});
