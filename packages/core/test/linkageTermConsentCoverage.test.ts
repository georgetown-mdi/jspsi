import { fileURLToPath } from "node:url";

import { describe, expect, test } from "vitest";

import ts from "typescript";

import {
  CONSENT_PROBE_TERMS,
  LINKAGE_TERM_CONSENT_CLASSIFICATION,
  consentRepresentationProbes,
} from "../src/linkageTermConsentCoverage.js";

import type { LinkageTerms } from "../src/config/linkageTerms.js";

/** Absolute path of a repository file named relative to this test. */
function repoPath(relative: string): string {
  return fileURLToPath(new URL(relative, import.meta.url));
}

const TERMS_SOURCE = repoPath("../src/config/linkageTerms.ts");
const TERMS_ROOT = "LinkageTerms";
const CORE_ROOT = repoPath("../");

/**
 * Type flags carrying no properties of their own, so a position of that type is
 * where a path ends. `VoidLike` covers the `undefined` an optional property's
 * union carries.
 */
const STRUCTURELESS_TYPE =
  ts.TypeFlags.StringLike |
  ts.TypeFlags.NumberLike |
  ts.TypeFlags.BooleanLike |
  ts.TypeFlags.BigIntLike |
  ts.TypeFlags.ESSymbolLike |
  ts.TypeFlags.VoidLike |
  ts.TypeFlags.Null |
  ts.TypeFlags.Never |
  ts.TypeFlags.Any |
  ts.TypeFlags.Unknown;

/**
 * Every property path {@link LinkageTerms} and the structs nested under it
 * declare, read from those declarations with the compiler API at test time, with
 * array and tuple indices collapsed to `[]` -- so a path reads
 * `linkageKeys[].elements[].transform[].function`.
 *
 * Derived rather than listed because the classification table it feeds must fail
 * on a field added to core, and a list only ever covers what someone remembered
 * to add to it. The judgment the derivation cannot make -- whether an acceptor's
 * consent turns on a field -- is what the table supplies.
 */
function declaredTermPositions(): Set<string> {
  const configPath = repoPath("../tsconfig.json");
  const config = ts.readConfigFile(configPath, ts.sys.readFile);
  if (config.error !== undefined)
    throw new Error(
      `cannot read ${configPath} for the linkage-terms derivation`,
    );
  const parsed = ts.parseJsonConfigFileContent(
    config.config,
    ts.sys,
    CORE_ROOT,
  );
  const program = ts.createProgram({
    rootNames: [TERMS_SOURCE],
    options: { ...parsed.options, noEmit: true },
  });
  const checker = program.getTypeChecker();
  const source = program.getSourceFile(TERMS_SOURCE);
  if (source === undefined)
    throw new Error(`${TERMS_SOURCE} is not in the program`);
  const root = source.statements.find(
    (statement): statement is ts.InterfaceDeclaration =>
      ts.isInterfaceDeclaration(statement) &&
      statement.name.text === TERMS_ROOT,
  );
  if (root === undefined)
    throw new Error(`${TERMS_ROOT} is not declared in ${TERMS_SOURCE}`);

  const positions = new Set<string>();

  // `enclosing` is the chain of struct types the current path runs through, so a
  // struct that ever nests itself terminates instead of descending forever; every
  // other repetition is a distinct path and is walked.
  const collect = (
    type: ts.Type,
    prefix: string,
    enclosing: ReadonlySet<ts.Type>,
  ): void => {
    for (const property of type.getProperties()) {
      const declaration =
        property.valueDeclaration ?? property.declarations?.[0];
      if (declaration === undefined)
        throw new Error(`no declaration for ${prefix}.${property.name}`);
      const position =
        prefix === "" ? property.name : `${prefix}.${property.name}`;
      positions.add(position);
      descend(
        checker.getTypeOfSymbolAtLocation(property, declaration),
        position,
        enclosing,
      );
    }
  };

  const descend = (
    type: ts.Type,
    position: string,
    enclosing: ReadonlySet<ts.Type>,
  ): void => {
    if ((type.flags & STRUCTURELESS_TYPE) !== 0 || enclosing.has(type)) return;
    if (type.isUnion()) {
      for (const member of type.types) descend(member, position, enclosing);
      return;
    }
    if (checker.isArrayType(type) || checker.isTupleType(type)) {
      for (const element of checker.getTypeArguments(type as ts.TypeReference))
        descend(element, `${position}[]`, enclosing);
      return;
    }
    if (type.isIntersection()) {
      for (const member of type.types) descend(member, position, enclosing);
      return;
    }
    collect(type, position, new Set(enclosing).add(type));
  };

  descend(checker.getTypeAtLocation(root.name), "", new Set());
  return positions;
}

/**
 * The derived positions that hold a value rather than the structure around one:
 * every position no other position extends. A container's consent relevance is
 * exactly the union of the values under it, so classifying `payload` alongside
 * `payload.send[].name` would ask the same question twice with two answers able
 * to disagree.
 */
function valuePositions(declared: ReadonlySet<string>): Set<string> {
  const all = [...declared];
  return new Set(
    all.filter(
      (position) =>
        !all.some(
          (other) =>
            other !== position &&
            (other.startsWith(`${position}.`) ||
              other.startsWith(`${position}[`)),
        ),
    ),
  );
}

/**
 * The value a terms document holds at each derived value position, as the ordered
 * list of every occurrence (array entries collapse onto one path, so a changed
 * count shows up as a changed list). The walk stops at a value position, so a
 * `params` record is compared whole -- the grain its classification is made at.
 *
 * A primitive at a path the derivation does not name would mean the walk stopped
 * short of a field the schema admits, which would silently shrink what the
 * variants below are checked against, so it throws rather than being skipped.
 */
function valuesByPosition(
  terms: LinkageTerms,
  positions: ReadonlySet<string>,
): Map<string, Array<string>> {
  const found = new Map<string, Array<string>>();
  const walk = (value: unknown, path: string): void => {
    if (positions.has(path)) {
      const seen = found.get(path) ?? [];
      seen.push(JSON.stringify(value ?? null));
      found.set(path, seen);
      return;
    }
    if (Array.isArray(value)) {
      for (const entry of value) walk(entry, `${path}[]`);
      return;
    }
    if (typeof value === "object" && value !== null) {
      for (const [key, entry] of Object.entries(value)) {
        if (entry === undefined) continue;
        walk(entry, path === "" ? key : `${path}.${key}`);
      }
      return;
    }
    throw new Error(
      `the derivation names no value position for ${path === "" ? "<root>" : path}`,
    );
  };
  walk(terms, "");
  return found;
}

/** The value positions at which two terms documents hold different content. */
function differingPositions(
  left: LinkageTerms,
  right: LinkageTerms,
  positions: ReadonlySet<string>,
): Array<string> {
  const leftValues = valuesByPosition(left, positions);
  const rightValues = valuesByPosition(right, positions);
  const paths = new Set([...leftValues.keys(), ...rightValues.keys()]);
  return [...paths]
    .filter(
      (path) =>
        JSON.stringify(leftValues.get(path) ?? null) !==
        JSON.stringify(rightValues.get(path) ?? null),
    )
    .sort();
}

describe("the linkage-term consent classification", () => {
  const declared = valuePositions(declaredTermPositions());

  test("classifies every value position LinkageTerms declares, and only those", () => {
    const classified = new Set(
      Object.keys(LINKAGE_TERM_CONSENT_CLASSIFICATION),
    );

    // A field added to LinkageTerms lands here until someone judges whether an
    // acceptor's consent turns on it.
    expect(
      [...declared].filter((position) => !classified.has(position)).sort(),
    ).toEqual([]);

    // And the other direction, so an entry for a field core dropped cannot sit
    // here claiming coverage of something that no longer exists -- and so the
    // derivation cannot quietly stop short without the table noticing.
    expect(
      [...classified].filter((position) => !declared.has(position)).sort(),
    ).toEqual([]);
  });

  test("gives every classified position a reason", () => {
    expect(
      Object.entries(LINKAGE_TERM_CONSENT_CLASSIFICATION)
        .filter(([, entry]) => entry.reason.trim() === "")
        .map(([position]) => position),
    ).toEqual([]);
  });

  test("varies each consent-relevant position at that position alone", () => {
    // A variant differing anywhere else would let a surface's rendering change
    // for a reason other than the field under test, and the probe would report
    // that field represented when it is not.
    for (const probe of consentRepresentationProbes())
      expect(differingPositions(probe.base, probe.variant, declared)).toEqual([
        probe.path,
      ]);
  });

  test("builds every probe from a coherent, fully populated base", () => {
    const probes = consentRepresentationProbes();
    const consentRelevant = Object.entries(
      LINKAGE_TERM_CONSENT_CLASSIFICATION,
    ).filter(([, entry]) => entry.classification === "consent-relevant");
    expect(probes.map((probe) => probe.path)).toEqual(
      consentRelevant.map(([position]) => position),
    );

    // Every consent-relevant position must hold a value in the shared base, or
    // its variant would have to introduce the structure around it and so differ
    // at more than one position. (`consentRepresentationProbes` parses both sides
    // of each pair, so coherence is already enforced by the time this runs.)
    const populated = valuesByPosition(CONSENT_PROBE_TERMS, declared);
    expect(
      probes
        .map((probe) => probe.path)
        .filter((path) => !populated.has(path))
        .sort(),
    ).toEqual([]);
  });
});
