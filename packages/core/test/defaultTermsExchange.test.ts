import { expect, test } from "vitest";

import PSI from "@openmined/psi.js";

import { getDefaultLinkageTerms } from "../src/defaults/builtInLinkageTerms";
import { referencedLinkageFieldNames } from "../src/config/linkageTermsSchema";
import { termsDeclareCandidateSet } from "../src/fanOutFunctions";
import { entityClusters } from "../src/psi/entityClosure";
import { prepareForExchange, runExchange } from "../src/exchange";
import { createMessagePipe } from "../src/connection/messageConnection";

import type { ExchangeResult } from "../src/exchange";
import type {
  LinkageField,
  LinkageKey,
  LinkageKeyElement,
  LinkageTerms,
} from "../src/config/linkageTermsSchema";

// The terms psilink ships, driven through the exchange boundary: the fields
// and keys getDefaultLinkageTerms emits, under the strategy it emits them
// with, over records generated from those key declarations rather than from a
// restatement of them. Every other exchange test here hand-builds a small key
// list, so nothing else fails when a shipped default key stops being runnable
// at that boundary.

const psiLibrary = await PSI();

const defaultTerms = getDefaultLinkageTerms("Party A");
const defaultKeys: ReadonlyArray<LinkageKey> = defaultTerms.linkageKeys;
const defaultFields: ReadonlyArray<LinkageField> = defaultTerms.linkageFields;

const fieldsByName = new Map(defaultFields.map((field) => [field.name, field]));

/** The default field an element reads, refusing an element naming none: the
 * generated data below is built per field, so a key element the shipped fields
 * do not declare has no value to generate. */
function fieldOf(element: LinkageKeyElement): LinkageField {
  const field = fieldsByName.get(element.field);
  if (field === undefined)
    throw new Error(
      `the built-in key element reads "${element.field}", which the built-in linkage fields do not declare`,
    );
  return field;
}

// One input column per default field, named for the field's semantic type so
// prepareForExchange's own metadata inference types it back to that field. Two
// fields of one type would collapse into one column, which the generated rows
// could not fill independently.
const columnNames = defaultFields.map((field) => field.type);
if (new Set(columnNames).size !== columnNames.length)
  throw new Error(
    "the built-in linkage fields declare two fields of one semantic type, which this file's one-column-per-field input cannot supply",
  );

/** The column a field's generated values are written to. */
function columnOf(field: LinkageField): string {
  return field.type;
}

/**
 * The character count of the longest leading substring any default key
 * element takes of its field's value, plus one -- computed over every default
 * key element, not name fields alone, so it also picks up a longer non-name
 * prefix (currently date_of_birth's year-and-month substring). That is a safe
 * overbound for the varying letters a generated name needs: the generated
 * names hold at least that many varying letters, so a counterpart built to
 * agree on a key's shorter prefix still differs at the next character.
 * Derived from the keys rather than fixed, so a key taking a longer prefix
 * widens the generated names with it.
 */
const NAME_CODE_LENGTH =
  1 +
  Math.max(
    0,
    ...defaultKeys.flatMap((key) =>
      key.elements.map((element) => leadingSubstringLength(element) ?? 0),
    ),
  );

type PartyName = "a" | "b";

// Disjoint halves of the alphabet, so no letter of one party's generated names
// is ever a letter of the other's: an agreement between the two parties' rows
// is one counterpartRow put there for a key element, never a coincidence of the
// generator.
const LETTER_POOLS: Record<PartyName, string> = {
  a: "ABCDEFGHIJKLM",
  b: "NOPQRSTUVWXYZ",
};

/** The letters one record's generated names begin with: the record number
 * written as base-`pool.length` digits, least significant first, from the
 * party's own pool. Distinct for every record below `pool.length **
 * NAME_CODE_LENGTH`, which every record index this file generates falls well
 * under -- unlike a periodic scheme, which would give two records that many
 * apart the same code. Verified below rather than merely asserted here. */
function nameCode(party: PartyName, record: number): string {
  const pool = LETTER_POOLS[party];
  return Array.from(
    { length: NAME_CODE_LENGTH },
    (_unused, position) =>
      pool[Math.floor(record / pool.length ** position) % pool.length],
  ).join("");
}

/**
 * The leading substring a key element takes of its field's standardized value,
 * or `undefined` where it takes the whole value.
 *
 * Refuses any other transform: the counterpart generator below can only
 * construct agreement on a leading substring, so a default key that grows a
 * different transform must be given a construction here rather than be
 * generated wrongly and pass.
 */
function leadingSubstringLength(
  element: LinkageKeyElement,
): number | undefined {
  if (element.generateFuzzyComparisons !== undefined)
    throw new Error(
      `the built-in key element on "${element.field}" declares a fuzzy expansion, which this file generates no counterpart value for`,
    );
  const steps = element.transform;
  if (steps === undefined || steps.length === 0) return undefined;
  const length = steps[0].params?.length;
  if (
    steps.length !== 1 ||
    steps[0].function !== "substring" ||
    steps[0].params?.start !== 1 ||
    typeof length !== "number"
  )
    throw new Error(
      `the built-in key element on "${element.field}" declares a transform other than a leading substring, which this file generates no counterpart value for`,
    );
  return length;
}

/**
 * A record's own value for each default field: distinct per party and per
 * record in every field, and in the leading characters of every field a key
 * takes a substring of.
 *
 * Written as the raw cell an operator's file holds, which the default
 * standardization then cleans -- MM/DD/YYYY dates (the format the exchange
 * infers for this column), 9-digit SSNs that meet the SSA structural rules,
 * and names already in the letters-only form the name pipeline produces.
 */
function baseValues(party: PartyName, record: number): Record<string, string> {
  const values: Record<string, string> = {};
  for (const field of defaultFields) {
    switch (field.type) {
      case "ssn":
        values[field.name] = `${(party === "a" ? 201 : 501) + record}55${
          (party === "a" ? 1000 : 5000) + record
        }`;
        break;
      case "ssn4":
        values[field.name] = `${(party === "a" ? 2000 : 6000) + record}`;
        break;
      case "first_name":
        values[field.name] = `${nameCode(party, record)}FIRST`;
        break;
      case "last_name":
        values[field.name] = `${nameCode(party, record)}LAST`;
        break;
      case "date_of_birth":
        values[field.name] =
          party === "a" ? `03/14/${1970 + record}` : `07/21/${1900 + record}`;
        break;
      default:
        throw new Error(
          `the built-in linkage fields declare a "${field.type}" field, which this file generates no value for`,
        );
    }
  }
  return values;
}

/**
 * The party B value that agrees with `anchorValue` on exactly what `element`
 * reads: the whole value where the element takes one, and its leading
 * characters alone where the element takes a substring -- the rest stays party
 * B's own, so the pair agrees on what this element reads and no further.
 */
function agreeingValue(
  element: LinkageKeyElement,
  anchorValue: string,
  ownValue: string,
): string {
  const prefix = leadingSubstringLength(element);
  if (prefix === undefined) return anchorValue;
  const field = fieldOf(element);
  switch (field.type) {
    // The digits and letters of these three pipelines survive cleaning in
    // place, so a raw value's leading characters are its standardized value's.
    case "ssn":
    case "first_name":
    case "last_name":
      return anchorValue.slice(0, prefix) + ownValue.slice(prefix);
    case "date_of_birth":
      // The default date pipeline emits YYYYMMDD, so the six leading characters
      // a built-in key takes are the year and month. The raw dates baseValues
      // writes are MM/DD/YYYY, so the anchor's month and year beside party B's
      // own day is that value with its day replaced.
      if (prefix !== 6)
        throw new Error(
          `the built-in keys take ${prefix} leading characters of a date, and this file generates a counterpart date for a year-and-month prefix only`,
        );
      return `${anchorValue.slice(0, 3)}${ownValue.slice(3, 5)}${anchorValue.slice(5)}`;
    default:
      throw new Error(
        `the built-in keys take a leading substring of a "${field.type}" field, which this file generates no counterpart value for`,
      );
  }
}

/**
 * Party B's row for one key: its own record throughout, except where `key`
 * reads party A's row at `record`.
 *
 * A key declaring `swap` gets the exchanged arrangement instead -- the two
 * named elements' values crossed -- which is the arrangement the receiver
 * builds for such a key, and which no other built-in key relates.
 */
function counterpartRow(
  key: LinkageKey,
  record: number,
): Record<string, string> {
  const anchor = baseValues("a", record);
  const values = baseValues("b", record);
  for (const element of key.elements) {
    const field = fieldOf(element);
    values[field.name] = agreeingValue(
      element,
      anchor[field.name],
      values[field.name],
    );
  }
  if (key.swap !== undefined) {
    const swapped = key.swap.map((identifier) => {
      const element = key.elements.find(
        (candidate) => (candidate.name ?? candidate.field) === identifier,
      );
      if (element === undefined)
        throw new Error(
          `the built-in key "${key.name}" swaps "${identifier}", which none of its elements declares`,
        );
      return fieldOf(element);
    });
    const [first, second] = swapped;
    const held = values[first.name];
    values[first.name] = values[second.name];
    values[second.name] = held;
  }
  return values;
}

/** A record's values laid out as the input row the exchange reads. */
function asRow(values: Record<string, string>): Record<string, string> {
  const row: Record<string, string> = {};
  for (const field of defaultFields) row[columnOf(field)] = values[field.name];
  return row;
}

// The record neither party's keys relate: party A's own row at a record index
// no counterpart was built for, against party B's own row at the same index. It
// keeps a run in which everything matched from passing.
const UNRELATED_RECORD = defaultKeys.length;

// Every record index this file generates must get its own name code, per
// party: a collision would let an unrelated pair agree on a name field by
// construction of the generator rather than by a key relating them, silently
// hollowing out the non-relation guarantee UNRELATED_RECORD exists for.
for (const party of ["a", "b"] as const) {
  const seen = new Map<string, number>();
  for (let record = 0; record <= UNRELATED_RECORD; record++) {
    const code = nameCode(party, record);
    const collidesWith = seen.get(code);
    if (collidesWith !== undefined)
      throw new Error(
        `nameCode gave party ${party}'s records ${collidesWith} and ${record} the same name code "${code}"`,
      );
    seen.set(code, record);
  }
}

const anchorRows = [
  ...defaultKeys.map((_key, record) => asRow(baseValues("a", record))),
  asRow(baseValues("a", UNRELATED_RECORD)),
];
const counterpartRows = [
  ...defaultKeys.map((key, record) => asRow(counterpartRow(key, record))),
  asRow(baseValues("b", UNRELATED_RECORD)),
];

function prepared(
  terms: LinkageTerms,
  identity: string,
  rows: Array<Record<string, string>>,
) {
  return prepareForExchange(
    { linkageTerms: terms },
    identity,
    rows,
    columnNames,
  );
}

/** One exchange between the two parties over `terms`, each holding its own
 * rows, both entitled to output. */
async function runDefaultTermsExchange(
  terms: (identity: string) => LinkageTerms,
  anchor: Array<Record<string, string>>,
  counterpart: Array<Record<string, string>>,
): Promise<{ anchor: ExchangeResult; counterpart: ExchangeResult }> {
  const [connAnchor, connCounterpart] = createMessagePipe();
  const [anchorResult, counterpartResult] = await Promise.all([
    runExchange(
      connAnchor,
      "initiator",
      prepared(terms("Party A"), "Party A", anchor),
      { psiLibrary },
    ),
    runExchange(
      connCounterpart,
      "responder",
      prepared(terms("Party B"), "Party B", counterpart),
      { psiLibrary },
    ),
  ]);
  return { anchor: anchorResult, counterpart: counterpartResult };
}

// The matched (local row, partner row) pairs in ascending local order.
function matchedPairs(result: ExchangeResult): Array<[number, number]> {
  const table = result.associationTable;
  expect(table).toBeDefined();
  return table![0].map((local, i) => [local, table![1][i]]);
}

test("the built-in default terms link the records their keys relate", async () => {
  // One record pair per built-in key, each built to meet that key alone, plus
  // one pair the keys relate through nothing. The run is the terms
  // getDefaultLinkageTerms emits, unedited, under the strategy they declare.
  expect(defaultTerms.linkageStrategy).toBe("cascade");

  const { anchor, counterpart } = await runDefaultTermsExchange(
    (identity) => getDefaultLinkageTerms(identity),
    anchorRows,
    counterpartRows,
  );

  const expected = defaultKeys.map((_key, record): [number, number] => [
    record,
    record,
  ]);
  expect(matchedPairs(anchor)).toEqual(expected);
  expect(matchedPairs(counterpart)).toEqual(expected);
  expect(anchor.audit?.record.resultSize).toBe(defaultKeys.length);
});

test("the built-in default terms run with both parties deduplicating", async () => {
  // The shipped key set declares a candidate set of its own -- its swap key
  // names both orders -- so the pair both parties deduplicating resolves to is
  // the one the cascade matches over a round's blocks and closes into entity
  // clusters. It relates the same records the single-sided run does, each
  // cluster one record a side.
  expect(termsDeclareCandidateSet(defaultTerms)).toBe(true);

  const { anchor, counterpart } = await runDefaultTermsExchange(
    (identity) => ({ ...getDefaultLinkageTerms(identity), deduplicate: true }),
    anchorRows,
    counterpartRows,
  );

  const expected = defaultKeys.map((_key, record): [number, number] => [
    record,
    record,
  ]);
  expect(matchedPairs(anchor)).toEqual(expected);
  expect(matchedPairs(counterpart)).toEqual(expected);
  expect(entityClusters(anchor.associationTable!)).toEqual(
    expected.map(([local, partner]) => ({
      localRows: [local],
      partnerRows: [partner],
    })),
  );
});

// The same pairs one key at a time. Under the whole cascade a pair built for a
// broad key is also related by the narrower keys the set declares beside it, so
// a single key going unrunnable there can still be covered by another; a round
// holding that key alone is what pins each of them.
for (const [record, key] of defaultKeys.entries()) {
  test(`the built-in key "${key.name}" links its records on its own`, async () => {
    const keyOnly = (identity: string): LinkageTerms => {
      const terms = getDefaultLinkageTerms(identity);
      const referenced = referencedLinkageFieldNames([key]);
      return {
        ...terms,
        linkageKeys: [key],
        linkageFields: terms.linkageFields.filter((field) =>
          referenced.has(field.name),
        ),
      };
    };

    const { anchor, counterpart } = await runDefaultTermsExchange(
      keyOnly,
      [anchorRows[record], anchorRows[UNRELATED_RECORD]],
      [counterpartRows[record], counterpartRows[UNRELATED_RECORD]],
    );

    expect(matchedPairs(anchor)).toEqual([[0, 0]]);
    expect(matchedPairs(counterpart)).toEqual([[0, 0]]);
  });
}
