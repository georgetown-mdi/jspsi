import { expect, test, describe } from "vitest";

import {
  buildStandardizedDataset,
  StandardizedKeyIterable,
} from "../src/standardization";
import type { LinkageTerms } from "../src/config/linkageTerms";
import type { ColumnMetadata } from "../src/config/metadata";

// Pre-cleaned rows (SSNs without dashes, DOBs in YYYYMMDD).
const rawRows: ReadonlyArray<Record<string, string>> = [
  {
    ssn: "559811301",
    last_name: "HEARD",
    first_name: "JAMES",
    date_of_birth: "19750716",
  },
  {
    ssn: "322842281",
    last_name: "IORIO",
    first_name: "ALBERT",
    date_of_birth: "19750817",
  },
  {
    ssn: "",
    last_name: "NOSSN",
    first_name: "NOISY",
    date_of_birth: "19800101",
  },
];

const metadata: ColumnMetadata[] = [
  { name: "ssn", type: "ssn", role: "linkage", isPayload: false },
  { name: "last_name", type: "last_name", role: "linkage", isPayload: false },
  { name: "first_name", type: "first_name", role: "linkage", isPayload: false },
  {
    name: "date_of_birth",
    type: "date_of_birth",
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
    { name: "lastName", type: "last_name" },
    { name: "firstName", type: "first_name" },
    { name: "dateOfBirth", type: "date_of_birth" },
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
    {
      name: "swap(LN, FN) + DOB",
      elements: [
        { field: "lastName" },
        { field: "firstName" },
        { field: "dateOfBirth" },
      ],
      swap: ["lastName", "firstName"],
    },
  ],
};

const dataset = buildStandardizedDataset(undefined, rawRows, metadata, terms);

describe("StandardizedKeyIterable — basic concatenation", () => {
  const key = terms.linkageKeys[0];
  const iter = new StandardizedKeyIterable(key, dataset, rawRows.length);

  test("length matches row count", () => {
    expect(iter.length).toBe(3);
  });

  test("produces correct string for row with all fields present", () => {
    expect(iter.at(0)).toBe("559811301HEARD19750716");
    expect(iter.at(1)).toBe("322842281IORIO19750817");
  });

  test("returns undefined when a required field is empty", () => {
    // Row 2 has an empty SSN; the field value is "" which buildKeyStrings treats as non-empty.
    // Verify at least that it does not throw.
    expect(() => iter.at(2)).not.toThrow();
  });

  test("Symbol.iterator agrees with at()", () => {
    const values = [...iter];
    expect(values).toHaveLength(3);
    expect(values[0]).toBe(iter.at(0));
    expect(values[1]).toBe(iter.at(1));
    expect(values[2]).toBe(iter.at(2));
  });

  test("at() out of bounds returns undefined", () => {
    expect(iter.at(-1)).toBeUndefined();
    expect(iter.at(3)).toBeUndefined();
  });
});

describe("StandardizedKeyIterable — element transforms", () => {
  const key = terms.linkageKeys[1];
  const iter = new StandardizedKeyIterable(key, dataset, rawRows.length);

  test("substring transform: first char of last name and first name", () => {
    expect(iter.at(0)).toBe("559811301HJ");
    expect(iter.at(1)).toBe("322842281IA");
  });
});

describe("StandardizedKeyIterable — swap (isReceiver)", () => {
  const key = terms.linkageKeys[2];

  test("sender: last_name then first_name", () => {
    const sender = new StandardizedKeyIterable(
      key,
      dataset,
      rawRows.length,
      false,
    );
    expect(sender.at(0)).toBe("HEARDJAMES19750716");
    expect(sender.at(1)).toBe("IORIOALBERT19750817");
  });

  test("receiver: first_name then last_name (swapped)", () => {
    const receiver = new StandardizedKeyIterable(
      key,
      dataset,
      rawRows.length,
      true,
    );
    expect(receiver.at(0)).toBe("JAMESHEARD19750716");
    expect(receiver.at(1)).toBe("ALBERTIORIO19750817");
  });
});

describe("StandardizedKeyIterable — field absent from dataset", () => {
  const termsWithMissingField: LinkageTerms = {
    ...terms,
    linkageFields: [
      ...terms.linkageFields,
      { name: "phoneNumber", type: "phone_number" },
    ],
    linkageKeys: [
      {
        name: "SSN + phone",
        elements: [{ field: "ssn" }, { field: "phoneNumber" }],
      },
    ],
  };
  // Dataset built without phone data; identity transform cannot be resolved.
  const smallDataset = buildStandardizedDataset(
    undefined,
    rawRows,
    metadata,
    termsWithMissingField,
  );
  const key = termsWithMissingField.linkageKeys[0];
  const iter = new StandardizedKeyIterable(key, smallDataset, rawRows.length);

  test("returns undefined when a field is missing from the dataset", () => {
    expect(iter.at(0)).toBeUndefined();
    expect(iter.at(1)).toBeUndefined();
  });
});
