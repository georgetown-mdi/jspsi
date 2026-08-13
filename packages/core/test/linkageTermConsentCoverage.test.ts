import { describe, expect, test } from "vitest";

import {
  CONSENT_PROBE_TERMS,
  LINKAGE_TERM_CONSENT_CLASSIFICATION,
  consentRepresentationProbes,
} from "../src/linkageTermConsentCoverage.js";
import { declaredPositions } from "./utils/declaredPositions.js";

import type { LinkageTerms } from "../src/config/linkageTerms.js";

/**
 * Every property path {@link LinkageTerms} and the structs nested under it
 * declare. Derived rather than listed because the classification table it feeds
 * must fail on a field added to core, and a list only ever covers what someone
 * remembered to add to it. The judgment the derivation cannot make -- whether an
 * acceptor's consent turns on a field -- is what the table supplies.
 *
 * A transform step's `params` is the one position whose index signature is the
 * value rather than structure: consent turns on the parameters as a set, so the
 * record is classified whole. Any other index signature reaching the derivation
 * throws instead.
 */
function declaredTermPositions(): Set<string> {
  return declaredPositions({
    sourcePathFromCoreRoot: "src/config/linkageTerms.ts",
    rootInterface: "LinkageTerms",
    recordValuePositions: ["linkageKeys[].elements[].transform[].params"],
  }).all;
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
