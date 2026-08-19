import { expect, test, describe } from "vitest";

import {
  buildStandardizedDataset,
  StandardizedDataset,
  StandardizedField,
  StandardizedKeyIterable,
} from "../src/standardization";
import type { LinkageTerms } from "../src/config/linkageTerms";
import type { ColumnMetadata } from "../src/config/metadata";
import { withUnlistedFanOutFunctions } from "./utils/unlistedFanOut";

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
  linkageStrategy: "cascade",
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

  test("treats an empty-string field value as a real value, not exclusion", () => {
    // Row 2 has an empty SSN; buildKeyStrings concatenates "" like any other value.
    expect(iter.at(2)).toBe("NOSSN19800101");
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

describe("StandardizedKeyIterable — a row whose value fans out", () => {
  // A row realizing several candidates yields all of them: narrowing to one, or
  // dropping the row, would match on less than the terms declare, which says each
  // candidate matches independently. Matching on the set is what is unimplemented
  // (the strategies refuse it), not realizing it.
  const splittingRows = [
    { ssn: "559811301", last_name: "SMITH-JONES", date_of_birth: "19750716" },
    { ssn: "322842281", last_name: "IORIO", date_of_birth: "19750817" },
  ];
  const splitDataset = new StandardizedDataset([
    new StandardizedField("ssn", "ssn", [], splittingRows),
    new StandardizedField(
      "lastName",
      "last_name",
      [{ function: "split_on", params: { delimiter: "-" } }],
      splittingRows,
    ),
    new StandardizedField("dateOfBirth", "date_of_birth", [], splittingRows),
  ]);
  const key = terms.linkageKeys[0];
  const iter = new StandardizedKeyIterable(
    key,
    splitDataset,
    splittingRows.length,
  );

  test("yields every candidate value the row realizes", () => {
    expect(iter.at(0)).toEqual(
      new Set(["559811301SMITH19750716", "559811301JONES19750716"]),
    );
  });

  test("iteration and indexed access agree with at()", () => {
    expect([...iter][0]).toEqual(iter.at(0));
    expect(iter[0]).toEqual(iter.at(0));
  });

  test("a row whose value does not split yields its single key as a string", () => {
    // split_on emits a one-element set when the delimiter does not match: one
    // candidate is the bare string, never a one-element set, so a consumer needs
    // one type test to tell the cases apart.
    expect(iter.at(1)).toBe("322842281IORIO19750817");
  });

  test("a row over the width bound yields the record-excluded sentinel", () => {
    // The width-bound drop reaches the surface as `undefined` -- the same
    // sentinel a NULL realization produces -- so the record sits this key's round
    // out and stays eligible for later keys.
    const wideRows = [
      {
        ssn: "559811301",
        last_name: Array.from({ length: 21 }, (_unused, i) => `N${i}`).join(
          "-",
        ),
        date_of_birth: "19750716",
      },
    ];
    const wideDataset = new StandardizedDataset([
      new StandardizedField("ssn", "ssn", [], wideRows),
      new StandardizedField(
        "lastName",
        "last_name",
        [{ function: "split_on", params: { delimiter: "-" } }],
        wideRows,
      ),
      new StandardizedField("dateOfBirth", "date_of_birth", [], wideRows),
    ]);
    const wideIter = new StandardizedKeyIterable(key, wideDataset, 1);
    expect(wideIter.at(0)).toBeUndefined();
  });

  test("an over-width row an unlisted producer expanded reaches the strategy", () => {
    // The same row, expanded by a function that is not one of the declared
    // producers the drop binds: it surfaces as the candidate set rather than the
    // excluded sentinel, so the strategy consuming it refuses the exchange
    // instead of matching fewer records than the terms describe.
    const wideIter = withUnlistedFanOutFunctions(() => {
      const wideRows = [
        {
          ssn: "559811301",
          last_name: Array.from({ length: 21 }, (_unused, i) => `N${i}`).join(
            "-",
          ),
          date_of_birth: "19750716",
        },
      ];
      const wideDataset = new StandardizedDataset([
        new StandardizedField("ssn", "ssn", [], wideRows),
        new StandardizedField(
          "lastName",
          "last_name",
          [{ function: "split_on", params: { delimiter: "-" } }],
          wideRows,
        ),
        new StandardizedField("dateOfBirth", "date_of_birth", [], wideRows),
      ]);
      return new StandardizedKeyIterable(key, wideDataset, 1);
    });
    const candidates = wideIter.at(0);
    expect(candidates).toBeInstanceOf(Set);
    expect((candidates as ReadonlySet<string>).size).toBe(21);
  });
});

describe("StandardizedKeyIterable — a key realizing the empty string", () => {
  // `""` is a present, matchable key value, distinct from the record-excluded
  // sentinel a NULL/absent realization produces (docs/spec/PROTOCOL.md, Key input
  // data). The distinction survives the multi-value surface: a singleton {""} is
  // the string, not `undefined`.
  const blankRows = [{ last_name: "" }];
  const blankDataset = new StandardizedDataset([
    new StandardizedField("lastName", "last_name", [], blankRows),
  ]);
  const blankKey = { name: "LN", elements: [{ field: "lastName" }] };
  const iter = new StandardizedKeyIterable(blankKey, blankDataset, 1);

  test("yields the empty string rather than the excluded sentinel", () => {
    expect(iter.at(0)).toBe("");
    expect(iter.at(0)).not.toBeUndefined();
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
