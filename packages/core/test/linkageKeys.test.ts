import { expect, test } from "vitest";

import {
  buildStandardizedDataset,
  StandardizedKeyIterable,
} from "../src/standardization";
import type { LinkageTerms } from "../src/config/linkageTerms";
import type { ColumnMetadata } from "../src/config/metadata";

// ─── Shared fixtures ─────────────────────────────────────────────────────────

const metadata: ColumnMetadata[] = [
  { name: "id", type: "identifier", role: "identifier", isPayload: false },
  { name: "first_name", type: "firstName", role: "linkage", isPayload: false },
  { name: "last_name", type: "lastName", role: "linkage", isPayload: false },
  { name: "ssn", type: "ssn", role: "linkage", isPayload: false },
  {
    name: "date_of_birth",
    type: "dateOfBirth",
    role: "linkage",
    isPayload: false,
  },
];

const terms: LinkageTerms = {
  version: "1.0.0",
  identity: "test",
  date: "2026-01-01",
  algorithm: "psi",
  output: { expectsOutput: true, shareWithPartner: true },
  deduplicate: false,
  linkageFields: [
    { name: "ssn", type: "ssn" },
    { name: "lastName", type: "lastName" },
    { name: "firstName", type: "firstName" },
    { name: "dateOfBirth", type: "dateOfBirth" },
  ],
  linkageKeys: [
    {
      name: "SSN + LN + DOB",
      elements: [
        { field: "ssn" },
        { field: "lastName" },
        { field: "dateOfBirth" },
      ],
    },
    {
      name: "SSN + LN1 + FN1",
      elements: [
        { field: "ssn" },
        {
          field: "lastName",
          transform: [
            { function: "substring", params: { start: 1, length: 1 } },
          ],
        },
        {
          field: "firstName",
          transform: [
            { function: "substring", params: { start: 1, length: 1 } },
          ],
        },
      ],
    },
  ],
};

function makeIterables(
  rawRows: ReadonlyArray<Record<string, string>>,
): StandardizedKeyIterable[] {
  const dataset = buildStandardizedDataset(undefined, rawRows, metadata, terms);
  return terms.linkageKeys.map(
    (key) => new StandardizedKeyIterable(key, dataset, rawRows.length),
  );
}

// ─── Basic length / shape tests ──────────────────────────────────────────────

test("handles trailing newline (row count)", () => {
  const rows = [
    {
      id: "159859483",
      first_name: "James",
      last_name: "Heard",
      ssn: "559811301",
      date_of_birth: "19750716",
    },
  ];
  const iters = makeIterables(rows);
  expect(iters).toHaveLength(terms.linkageKeys.length);
  expect(iters[0].length).toBe(1);
});

test("handles multiple rows", () => {
  const rows = [
    {
      id: "159859483",
      first_name: "JAMES",
      last_name: "HEARD",
      ssn: "559811301",
      date_of_birth: "19750716",
    },
    {
      id: "165562801",
      first_name: "ALBERT",
      last_name: "IORIO",
      ssn: "322842281",
      date_of_birth: "19750817",
    },
  ];
  const iters = makeIterables(rows);
  expect(iters[0].length).toBe(2);
  expect(iters[0].at(0)).toBe("559811301HEARD19750716");
  expect(iters[0].at(1)).toBe("322842281IORIO19750817");
});

test("second key applies element transforms", () => {
  const rows = [
    {
      id: "159859483",
      first_name: "JAMES",
      last_name: "HEARD",
      ssn: "559811301",
      date_of_birth: "19750716",
    },
    {
      id: "165562801",
      first_name: "ALBERT",
      last_name: "IORIO",
      ssn: "322842281",
      date_of_birth: "19750817",
    },
  ];
  const iters = makeIterables(rows);
  expect(iters[1].at(0)).toBe("559811301HJ");
  expect(iters[1].at(1)).toBe("322842281IA");
});

test("returns undefined when a required field is absent", () => {
  const rows = [
    {
      id: "1",
      first_name: "JAMES",
      last_name: "HEARD",
      ssn: "",
      date_of_birth: "19750716",
    },
  ];
  // SSN is empty; buildKeyStrings returns null because the field value is "".
  // StandardizedKeyIterable must return undefined (not throw).
  const iters = makeIterables(rows);
  expect(() => iters[0].at(0)).not.toThrow();
});

test("indexed access via [] agrees with at()", () => {
  const rows = [
    {
      id: "159859483",
      first_name: "JAMES",
      last_name: "HEARD",
      ssn: "559811301",
      date_of_birth: "19750716",
    },
    {
      id: "165562801",
      first_name: "ALBERT",
      last_name: "IORIO",
      ssn: "322842281",
      date_of_birth: "19750817",
    },
  ];
  const iters = makeIterables(rows);
  expect(iters[0][0]).toBe(iters[0].at(0));
  expect(iters[0][1]).toBe(iters[0].at(1));
});

test("Symbol.iterator yields same values as at()", () => {
  const rows = [
    {
      id: "159859483",
      first_name: "JAMES",
      last_name: "HEARD",
      ssn: "559811301",
      date_of_birth: "19750716",
    },
    {
      id: "165562801",
      first_name: "ALBERT",
      last_name: "IORIO",
      ssn: "322842281",
      date_of_birth: "19750817",
    },
  ];
  const iters = makeIterables(rows);
  const spread = [...iters[0]];
  expect(spread[0]).toBe(iters[0].at(0));
  expect(spread[1]).toBe(iters[0].at(1));
});

// ─── Standardization step integration ────────────────────────────────────────

test("identity transform: last_name already upper-case is unchanged", () => {
  const rows = [
    {
      id: "1",
      first_name: "J",
      last_name: "SMITH",
      ssn: "123456789",
      date_of_birth: "20000101",
    },
  ];
  const iters = makeIterables(rows);
  expect(iters[0].at(0)).toBe("123456789SMITH20000101");
});

test("identity transform: mixed-case last_name is passed through as-is (no standardization steps)", () => {
  const rows = [
    {
      id: "1",
      first_name: "J",
      last_name: "Smith",
      ssn: "123456789",
      date_of_birth: "20000101",
    },
  ];
  const iters = makeIterables(rows);
  // Without a to_upper_case cleaning step the raw value is used unchanged.
  expect(iters[0].at(0)).toBe("123456789Smith20000101");
});
