import { expect, test, describe, afterEach, vi } from "vitest";

import {
  buildStandardizedDataset,
  MAX_DROP_LINES_PER_KEY_ROUND,
  StandardizedDataset,
  StandardizedField,
  StandardizedKeyIterable,
} from "../src/standardization";
import type { LinkageTerms } from "../src/config/linkageTerms";
import type { ColumnMetadata } from "../src/config/metadata";
import { getLogger } from "../src/utils/logger";
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
  // A row realizing several candidates yields all of them, never narrowed
  // to one or dropped. Matching on the set as a whole remains unimplemented
  // (the strategies refuse it); realizing the candidates is implemented.
  const splittingRows = [
    { ssn: "559811301", last_name: "SMITH-JONES", date_of_birth: "19750716" },
    { ssn: "322842281", last_name: "IORIO", date_of_birth: "19750817" },
  ];
  const splitDataset = new StandardizedDataset(
    [
      new StandardizedField("ssn", "ssn", [], splittingRows),
      new StandardizedField(
        "lastName",
        "last_name",
        [{ function: "split_on", params: { delimiter: "-" } }],
        splittingRows,
      ),
      new StandardizedField("dateOfBirth", "date_of_birth", [], splittingRows),
    ],
    terms.linkageKeys,
  );
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
    // A row over the width bound yields `undefined`, the same sentinel a
    // NULL realization produces, so the record sits this key's round out
    // and stays eligible for later keys.
    const wideRows = [
      {
        ssn: "559811301",
        last_name: Array.from({ length: 21 }, (_unused, i) => `N${i}`).join(
          "-",
        ),
        date_of_birth: "19750716",
      },
    ];
    const wideDataset = new StandardizedDataset(
      [
        new StandardizedField("ssn", "ssn", [], wideRows),
        new StandardizedField(
          "lastName",
          "last_name",
          [{ function: "split_on", params: { delimiter: "-" } }],
          wideRows,
        ),
        new StandardizedField("dateOfBirth", "date_of_birth", [], wideRows),
      ],
      terms.linkageKeys,
    );
    const wideIter = new StandardizedKeyIterable(key, wideDataset, 1);
    expect(wideIter.at(0)).toBeUndefined();
  });

  test("an over-width row an unlisted producer expanded reaches the strategy", () => {
    // The same row, expanded by a function that is not one of the declared
    // producers the drop binds, shows up as the candidate set rather than
    // the excluded sentinel: the strategy consuming it refuses the
    // exchange rather than matching fewer records than the terms describe.
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
      const wideDataset = new StandardizedDataset(
        [
          new StandardizedField("ssn", "ssn", [], wideRows),
          new StandardizedField(
            "lastName",
            "last_name",
            [{ function: "split_on", params: { delimiter: "-" } }],
            wideRows,
          ),
          new StandardizedField("dateOfBirth", "date_of_birth", [], wideRows),
        ],
        terms.linkageKeys,
      );
      return new StandardizedKeyIterable(key, wideDataset, 1);
    });
    const candidates = wideIter.at(0);
    expect(candidates).toBeInstanceOf(Set);
    expect((candidates as ReadonlySet<string>).size).toBe(21);
  });
});

describe("StandardizedKeyIterable — drop reporting over a whole round", () => {
  // A split every row crosses the width bound on. The drop is
  // deterministic per (row, key); uncoalesced, it would put one line per
  // row in front of the operator, regardless of dataset size.
  const logger = getLogger("cleaning");
  const key = terms.linkageKeys[0];
  const rowCount = MAX_DROP_LINES_PER_KEY_ROUND * 3;
  const wideRows = Array.from({ length: rowCount }, (_unused, row) => ({
    ssn: `55981130${row}`,
    last_name: Array.from({ length: 21 }, (_u, i) => `N${row}x${i}`).join("-"),
    date_of_birth: "19750716",
  }));
  const wideDataset = () =>
    new StandardizedDataset(
      [
        new StandardizedField("ssn", "ssn", [], wideRows),
        new StandardizedField(
          "lastName",
          "last_name",
          [{ function: "split_on", params: { delimiter: "-" } }],
          wideRows,
        ),
        new StandardizedField("dateOfBirth", "date_of_birth", [], wideRows),
      ],
      terms.linkageKeys,
    );

  afterEach(() => vi.restoreAllMocks());

  test("reports the first few rows in full and the rest as one summary", () => {
    const warn = vi.spyOn(logger, "warn").mockImplementation(() => {});
    const iter = new StandardizedKeyIterable(key, wideDataset(), rowCount);
    expect([...iter].every((value) => value === undefined)).toBe(true);
    // Every row dropped, and only the allowance was reported one at a time.
    expect(warn).toHaveBeenCalledTimes(MAX_DROP_LINES_PER_KEY_ROUND);
    for (const [row, call] of warn.mock.calls.entries())
      expect(call[0]).toMatch(
        new RegExp(`^row ${row}, key "SSN \\+ LN \\+ DOB": realizes 21 `),
      );

    iter.summarizeDroppedRows();
    expect(warn).toHaveBeenCalledTimes(MAX_DROP_LINES_PER_KEY_ROUND + 1);
    const summary = warn.mock.calls[MAX_DROP_LINES_PER_KEY_ROUND][0] as string;
    expect(summary).toContain(`key "${key.name}"`);
    expect(summary).toContain(`${rowCount} rows dropped`);
    expect(summary).toContain(
      `${rowCount - MAX_DROP_LINES_PER_KEY_ROUND} of them beyond`,
    );
    // The summary names no value, exactly as the individual lines do not:
    // the rows it stands for hold this party's own data.
    expect(summary).not.toContain("N0x");
    expect(summary).not.toContain("55981130");
  });

  test("the summary is a WARN, the level the individual lines use", () => {
    const warn = vi.spyOn(logger, "warn").mockImplementation(() => {});
    const info = vi.spyOn(logger, "info").mockImplementation(() => {});
    const iter = new StandardizedKeyIterable(key, wideDataset(), rowCount);
    for (const _value of iter);
    iter.summarizeDroppedRows();
    expect(warn.mock.calls.at(-1)?.[0]).toContain("rows dropped");
    expect(info).not.toHaveBeenCalled();
  });

  test("closing a round twice states the surplus once", () => {
    const warn = vi.spyOn(logger, "warn").mockImplementation(() => {});
    const iter = new StandardizedKeyIterable(key, wideDataset(), rowCount);
    for (const _value of iter);
    iter.summarizeDroppedRows();
    iter.summarizeDroppedRows();
    expect(warn).toHaveBeenCalledTimes(MAX_DROP_LINES_PER_KEY_ROUND + 1);
  });

  test("a round closed again after further drops counts them as a delta", () => {
    const warn = vi.spyOn(logger, "warn").mockImplementation(() => {});
    const iter = new StandardizedKeyIterable(key, wideDataset(), rowCount);
    const firstBatch = MAX_DROP_LINES_PER_KEY_ROUND * 2;
    for (let row = 0; row < firstBatch; row++) iter.at(row);
    iter.summarizeDroppedRows();
    for (let row = firstBatch; row < rowCount; row++) iter.at(row);
    iter.summarizeDroppedRows();

    const summaries = warn.mock.calls
      .map((call) => call[0] as string)
      .filter((message) => message.includes("dropped from this key's round"));
    expect(summaries).toHaveLength(2);
    expect(summaries[0]).toContain(`${firstBatch} rows dropped`);
    expect(summaries[0]).toContain(
      `${firstBatch - MAX_DROP_LINES_PER_KEY_ROUND} of them beyond the ` +
        `${MAX_DROP_LINES_PER_KEY_ROUND} reported individually`,
    );
    // The allowance was spent before the second batch, so the second
    // summary line counts its rows against the total the first one held,
    // not against the fixed allowance.
    expect(summaries[1]).toContain(`${rowCount - firstBatch} further rows`);
    expect(summaries[1]).toContain(`${rowCount} in total`);
    expect(summaries[1]).not.toContain("reported individually");
  });

  test("a round under the allowance closes with no summary at all", () => {
    const warn = vi.spyOn(logger, "warn").mockImplementation(() => {});
    const iter = new StandardizedKeyIterable(key, wideDataset(), rowCount);
    for (let row = 0; row < MAX_DROP_LINES_PER_KEY_ROUND; row++) iter.at(row);
    iter.summarizeDroppedRows();
    expect(warn).toHaveBeenCalledTimes(MAX_DROP_LINES_PER_KEY_ROUND);
  });

  test("a round that dropped nothing closes silently", () => {
    const warn = vi.spyOn(logger, "warn").mockImplementation(() => {});
    const iter = new StandardizedKeyIterable(key, dataset, rawRows.length);
    for (const _value of iter);
    iter.summarizeDroppedRows();
    expect(warn).not.toHaveBeenCalled();
  });

  test("two rounds over one key object count their drops apart", () => {
    // The sender's round and the receiver's read the same key; a tally shared
    // between them would report one round's rows against the other's.
    const warn = vi.spyOn(logger, "warn").mockImplementation(() => {});
    const shared = wideDataset();
    const sender = new StandardizedKeyIterable(key, shared, rowCount, false);
    const receiver = new StandardizedKeyIterable(key, shared, rowCount, true);
    for (const _value of sender);
    for (const _value of receiver);
    sender.summarizeDroppedRows();
    receiver.summarizeDroppedRows();
    const summaries = warn.mock.calls
      .map((call) => call[0] as string)
      .filter((message) => message.includes("rows dropped"));
    expect(summaries).toHaveLength(2);
    for (const summary of summaries)
      expect(summary).toContain(`${rowCount} rows dropped`);
  });

  test("the summary escapes the key name, as the individual lines do", () => {
    // A key name is partner-authored free text and both lines interpolate it, so
    // each is a sink of its own: a bell, an ESC that would drive an ANSI
    // sequence, and a backslash must reach the operator as visible escapes.
    const bell = String.fromCharCode(0x07);
    const escape = String.fromCharCode(0x1b);
    const hostileName = `SSN${bell}${escape}[31m\\LN`;
    const escapedName = "SSN\\x07\\x1b[31m\\\\LN";
    const warn = vi.spyOn(logger, "warn").mockImplementation(() => {});
    const iter = new StandardizedKeyIterable(
      { ...key, name: hostileName },
      wideDataset(),
      rowCount,
    );
    for (const _value of iter);
    iter.summarizeDroppedRows();

    const lines = warn.mock.calls.map((call) => call[0] as string);
    expect(lines).toHaveLength(MAX_DROP_LINES_PER_KEY_ROUND + 1);
    for (const line of lines) {
      expect(line).toContain(`key "${escapedName}"`);
      expect(line).not.toContain(bell);
      expect(line).not.toContain(escape);
      expect(line).not.toContain(hostileName);
    }
  });
});

describe("StandardizedKeyIterable — a key realizing the empty string", () => {
  // `""` is a present, matchable key value, distinct from the
  // record-excluded sentinel a NULL/absent realization produces
  // (docs/spec/PROTOCOL.md, Key input data). The distinction holds for a
  // multi-candidate result too: a singleton {""} is the string, not
  // `undefined`.
  const blankRows = [{ last_name: "" }];
  const blankKey = { name: "LN", elements: [{ field: "lastName" }] };
  const blankDataset = new StandardizedDataset(
    [new StandardizedField("lastName", "last_name", [], blankRows)],
    [blankKey],
  );
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

describe("StandardizedKeyIterable — an element transform that cannot compile", () => {
  // The key compiles once for the whole run, not once per row, and that
  // compile is deferred to the first row read: a function this build does
  // not have fails during the exchange's row loop, not at iterable
  // construction.
  const key = {
    name: "LN",
    elements: [
      {
        field: "lastName",
        transform: [{ function: "no_such_standardizing_function" }],
      },
    ],
  };

  test("refuses at the first row read rather than at construction", () => {
    const iter = new StandardizedKeyIterable(key, dataset, rawRows.length);
    expect(() => iter.at(0)).toThrow("unknown standardization function");
  });
});
