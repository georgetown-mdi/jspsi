import { describe, expect, test } from "vitest";

import { DEFAULT_LINKAGE_RULE_SET } from "../src/defaults/builtInLinkageTerms";

import type {
  LinkageField,
  LinkageKey,
} from "../src/config/linkageTermsSchema";

const { linkageFields, linkageKeys } = DEFAULT_LINKAGE_RULE_SET;

/**
 * The set's own field names of the given types. Every classification below reads
 * a key through these rather than through a list of key names repeated here, so
 * a key renamed, added, or rebuilt from different fields is classified by what it
 * actually references.
 */
function fieldNamesOfType(
  ...types: ReadonlyArray<LinkageField["type"]>
): ReadonlySet<string> {
  return new Set(
    linkageFields.filter((f) => types.includes(f.type)).map((f) => f.name),
  );
}

const dateFields = fieldNamesOfType("date_of_birth");
const ssnFields = fieldNamesOfType("ssn", "ssn4");
const lastNameFields = fieldNamesOfType("last_name");

function references(key: LinkageKey, fields: ReadonlySet<string>): boolean {
  return key.elements.some((element) => fields.has(element.field));
}

/**
 * How a key treats the date of birth: `full` where every date element it
 * references holds the field's whole canonical value, `coarsened` where any is
 * transformed, `absent` where it references no date field at all.
 */
function dateComponent(key: LinkageKey): "full" | "coarsened" | "absent" {
  const dateElements = key.elements.filter((el) => dateFields.has(el.field));
  if (dateElements.length === 0) return "absent";
  return dateElements.every((el) => el.transform === undefined)
    ? "full"
    : "coarsened";
}

/**
 * Everything a key is built from except its date component, as a value two
 * keys can be compared on: the same fields under the same transforms, plus
 * the same swap. Element order is not part of it: it decides how the key
 * string is concatenated, not which evidence the key rests on, so the
 * comparison stays indifferent to a reordered pair should the set ever
 * declare one (today none does).
 */
function nonDateShape(key: LinkageKey): string {
  const elements = key.elements
    .filter((el) => !dateFields.has(el.field))
    .map((el) =>
      JSON.stringify([el.field, el.name ?? null, el.transform ?? null]),
    )
    .sort();
  return JSON.stringify([elements, key.swap ?? null]);
}

function describePosition(index: number): string {
  return `${linkageKeys[index].name} (position ${index + 1})`;
}

describe("the built-in key set's cascade order", () => {
  test("places a full-date key above the coarsened key built from the same other elements", () => {
    const byShape = new Map<string, { full: number[]; coarsened: number[] }>();
    linkageKeys.forEach((key, index) => {
      const component = dateComponent(key);
      if (component === "absent") return;
      const shape = nonDateShape(key);
      const seen = byShape.get(shape) ?? { full: [], coarsened: [] };
      seen[component].push(index);
      byShape.set(shape, seen);
    });

    const inverted: string[] = [];
    let pairsCompared = 0;
    for (const { full, coarsened } of byShape.values()) {
      for (const coarse of coarsened) {
        for (const whole of full) {
          pairsCompared += 1;
          if (coarse < whole) {
            inverted.push(
              `${describePosition(coarse)} precedes ${describePosition(whole)}`,
            );
          }
        }
      }
    }

    expect(inverted).toStrictEqual([]);
    // A set declaring no full-date/coarsened pair at all would satisfy the
    // assertion above while holding none of the property, so the pairs the set
    // does declare are counted rather than assumed.
    expect(pairsCompared).toBeGreaterThan(0);
  });

  test("is not a ranking by strength of evidence", () => {
    // The two arrangements DEFAULT_LINKAGE_KEYS documents as the reason its
    // order must not be read as a precision ranking. A reorder to
    // strongest-evidence-first would leave that statement describing a set
    // nobody ships, so it fails here rather than going unnoticed.
    const firstWithoutSsn = linkageKeys.findIndex(
      (key) => !references(key, ssnFields),
    );
    let lastWithSsn = -1;
    linkageKeys.forEach((key, index) => {
      if (references(key, ssnFields)) lastWithSsn = index;
    });
    expect(firstWithoutSsn).toBeGreaterThanOrEqual(0);
    expect(firstWithoutSsn).toBeLessThan(lastWithSsn);

    const firstSsnWithoutLastName = linkageKeys.findIndex(
      (key) => references(key, ssnFields) && !references(key, lastNameFields),
    );
    expect(firstSsnWithoutLastName).toBeGreaterThanOrEqual(0);
    expect(firstSsnWithoutLastName).toBeLessThan(firstWithoutSsn);
  });
});
