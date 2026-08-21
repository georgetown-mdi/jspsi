import { describe, expect, test } from "vitest";

import {
  DISCLOSURE_ACCOUNTING_VERSION,
  appendDisclosureRecord,
  parseDisclosureAccounting,
} from "../../src/psi/disclosureAccounting.js";

import { disclosureRecord } from "../utils/disclosureFixtures.js";

import type { DisclosureAccounting } from "../../src/psi/disclosureAccounting.js";

/**
 * The stored shape of a managed exchange's accounting of disclosures: an entry is
 * one run's self-attested exchange record, verbatim, and the append that files it.
 *
 * The verbatim property is the one this suite exists for. The accounting's whole
 * claim is that it is built on the exchange record rather than beside it, so a test
 * that asserted a summary of the record -- rather than deep equality with the
 * record core produced -- would leave a derived-and-drifting store passing.
 */

describe("the disclosure accounting's entries", () => {
  test("an appended entry is the run's exchange record, verbatim", async () => {
    const record = await disclosureRecord();

    const accounting = appendDisclosureRecord(undefined, record);

    expect(accounting.version).toBe(DISCLOSURE_ACCOUNTING_VERSION);
    expect(accounting.entries).toHaveLength(1);
    // Deep equality against core's own artifact: no field is dropped, renamed, or
    // summarized on its way into the accounting.
    expect(accounting.entries[0]).toEqual(record);
  });

  test("each run appends one entry, in run order", async () => {
    const first = await disclosureRecord({
      createdAt: "2026-07-01T09:00:00.000Z",
    });
    const second = await disclosureRecord({
      createdAt: "2026-08-01T09:00:00.000Z",
    });

    const accounting = appendDisclosureRecord(
      appendDisclosureRecord(undefined, first),
      second,
    );

    expect(accounting.entries.map((entry) => entry.createdAt)).toEqual([
      "2026-07-01T09:00:00.000Z",
      "2026-08-01T09:00:00.000Z",
    ]);
  });

  test("re-appending one run's record is a no-op, so a retried write cannot inflate the count", async () => {
    const record = await disclosureRecord();
    const filed = appendDisclosureRecord(undefined, record);

    const again = appendDisclosureRecord(filed, record);

    expect(again.entries).toHaveLength(1);
  });

  test("two runs with identical terms are two entries, told apart by their own binding nonces", async () => {
    // Same terms, same instant: what separates the two records is the per-exchange
    // binding nonce core generates locally for each, which is exactly what the
    // append matches on.
    const first = await disclosureRecord();
    const second = await disclosureRecord();
    expect(second.bindingNonce).not.toBe(first.bindingNonce);

    const accounting = appendDisclosureRecord(
      appendDisclosureRecord(undefined, first),
      second,
    );

    expect(accounting.entries).toHaveLength(2);
  });
});

describe("reading a stored accounting", () => {
  test("round-trips an accounting through the structured-clone shape a store holds", async () => {
    const accounting = appendDisclosureRecord(
      undefined,
      await disclosureRecord(),
    );

    const read = parseDisclosureAccounting(
      JSON.parse(JSON.stringify(accounting)),
    );

    expect(read).toEqual(accounting);
  });

  test("rejects an unrecognized format version rather than migrating it", async () => {
    const accounting = appendDisclosureRecord(
      undefined,
      await disclosureRecord(),
    );

    expect(() =>
      parseDisclosureAccounting({
        ...accounting,
        version: "psilink-disclosure-accounting/v2",
      }),
    ).toThrow();
  });

  test("rejects an entry that is not a valid exchange record, rather than dropping it", async () => {
    // A dropped entry would render as a shorter and quietly false account of what
    // this exchange disclosed, so the read fails instead.
    const accounting: DisclosureAccounting = {
      version: DISCLOSURE_ACCOUNTING_VERSION,
      entries: [await disclosureRecord()],
    };

    expect(() =>
      parseDisclosureAccounting({
        ...accounting,
        entries: [
          ...accounting.entries,
          { ...accounting.entries[0], version: "psilink-exchange-record/v99" },
        ],
      }),
    ).toThrow();
  });

  test("rejects an unknown key on the envelope", async () => {
    const accounting = appendDisclosureRecord(
      undefined,
      await disclosureRecord(),
    );

    expect(() =>
      parseDisclosureAccounting({ ...accounting, retainUntil: "2030-01-01" }),
    ).toThrow();
  });
});
