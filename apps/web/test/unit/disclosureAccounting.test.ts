import { describe, expect, test } from "vitest";

import { EXCHANGE_RECORD_VERSION } from "@psilink/core";

import {
  DISCLOSURE_ACCOUNTING_VERSION,
  appendDisclosureRecord,
  parseDisclosureAccounting,
  parseStoredDisclosureAccounting,
  storedEntriesAheadOfThisBuild,
} from "../../src/psi/disclosureAccounting.js";

import {
  disclosureRecord,
  neighbouringRecordVersion,
} from "../utils/disclosureFixtures.js";

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

/**
 * The premise the recovery affordance rests on, driven against the real parsers
 * rather than asserted in prose: a move of the exchange-record version literal
 * invalidates the stored ENTRIES and leaves the ENVELOPE intact, so the stored
 * entries come back whole through the envelope-only read.
 *
 * This is the tripwire. If a future record format is ever reached whose bump also
 * takes the accounting envelope with it -- or whose stored entries the envelope
 * read no longer returns verbatim -- the recovery has no export arm, and this is
 * what fails rather than an operator discovering it while stranded. The
 * complementary check, that the version literal cannot move without the decision
 * being re-taken, is scripts/check-exchange-record-version.mjs.
 *
 * A bump is simulated by presenting a stored entry under a literal that is not the
 * current one, which is parse-identical to the app's own constant moving forward.
 * The simulated literal is derived from core's constant rather than written out,
 * so it stays a NON-current version when core's does move. Its stated limit: a
 * real bump also moves the record's field set, so an entry under it would raise
 * whatever the new field set requires ON TOP of the version issue. That widens
 * what the entry read rejects and reaches the envelope not at all, since the
 * envelope schema looks inside no entry -- which is what these tests pin.
 */
describe("a moved exchange-record version leaves the stored entries recoverable", () => {
  /** A stored accounting whose entries carry a record version this build does not
   * admit, as an app upgrade that moved the literal would leave at rest. */
  async function accountingFromAnotherRecordVersion(): Promise<unknown> {
    const record = await disclosureRecord();
    expect(record.version).toBe(EXCHANGE_RECORD_VERSION);
    return {
      version: DISCLOSURE_ACCOUNTING_VERSION,
      entries: [{ ...record, version: `${EXCHANGE_RECORD_VERSION}-moved` }],
    };
  }

  test("the entries reject and the envelope does not, which is what makes an export possible", async () => {
    const stored = await accountingFromAnotherRecordVersion();

    // One value, two reads: the validating read refuses it wholesale -- the state
    // an operator is stranded in -- while the envelope read returns it.
    expect(() => parseDisclosureAccounting(stored)).toThrow();
    expect(() => parseStoredDisclosureAccounting(stored)).not.toThrow();
  });

  test("the envelope read hands back every stored entry verbatim", async () => {
    const stored = (await accountingFromAnotherRecordVersion()) as {
      version: string;
      entries: Array<unknown>;
    };

    const recovered = parseStoredDisclosureAccounting(stored);

    // Deep equality against what is at rest, not a count: an export that dropped
    // or reshaped an entry would hand the operator a shorter account of what was
    // disclosed, which is the failure the validating read exists to prevent.
    expect(recovered.entries).toEqual(stored.entries);
    expect(recovered.version).toBe(DISCLOSURE_ACCOUNTING_VERSION);
  });

  test("a mix of admissible and inadmissible entries comes back whole", async () => {
    // The realistic post-upgrade shape: runs filed before the bump and runs filed
    // after it, in one accounting. The export must carry both.
    const current = await disclosureRecord();
    const earlier = {
      ...(await disclosureRecord()),
      version: `${EXCHANGE_RECORD_VERSION}-moved`,
    };
    const stored = {
      version: DISCLOSURE_ACCOUNTING_VERSION,
      entries: [earlier, current],
    };

    expect(() => parseDisclosureAccounting(stored)).toThrow();
    expect(parseStoredDisclosureAccounting(stored).entries).toEqual([
      earlier,
      current,
    ]);
  });
});

/**
 * Which DIRECTION a refused entry was written in, which is what separates a
 * stranded accounting from a stale page. The predicate reads the refused entry's
 * own version literal, so both directions are driven from core's constant rather
 * than from a hard-coded literal beside it: a version this build is ahead of is
 * the app-upgrade case the destructive recovery exists for, and one it is behind
 * is a page running older code than the build that filed the entry.
 *
 * Each neighbouring version comes from {@link neighbouringRecordVersion}, which
 * throws rather than falling back when core's literal carries no ordinal to count
 * from: a predicate that silently stopped ordering anything would otherwise leave
 * every case below passing on the same answer.
 */
describe("telling a stranded accounting from a stale page", () => {
  /** A stored accounting holding exactly these entries. */
  function storedWith(entries: Array<unknown>) {
    return parseStoredDisclosureAccounting({
      version: DISCLOSURE_ACCOUNTING_VERSION,
      entries,
    });
  }

  test("an entry from a later record format says this page is behind", async () => {
    const record = await disclosureRecord();
    const later = neighbouringRecordVersion(1);
    expect(later).not.toBe(EXCHANGE_RECORD_VERSION);

    expect(
      storedEntriesAheadOfThisBuild(
        storedWith([{ ...record, version: later }]),
      ),
    ).toBe(true);
  });

  test("an entry from an earlier record format does not", async () => {
    // The app-upgrade direction: this build is current, the entries are stranded,
    // and the export-then-reset recovery is what gets them out.
    const record = await disclosureRecord();

    expect(
      storedEntriesAheadOfThisBuild(
        storedWith([{ ...record, version: neighbouringRecordVersion(-1) }]),
      ),
    ).toBe(false);
  });

  test("entries this build admits are not ahead of it", async () => {
    const record = await disclosureRecord();
    expect(record.version).toBe(EXCHANGE_RECORD_VERSION);

    expect(storedEntriesAheadOfThisBuild(storedWith([record]))).toBe(false);
  });

  test("one later entry beside admissible ones is enough", async () => {
    // Mixed, so the reading is not "everything here is newer" but "something here
    // is": the build that should decide what to do about the rest is the current
    // one, which this page is not running.
    const record = await disclosureRecord();
    const later = { ...record, version: neighbouringRecordVersion(1) };

    expect(storedEntriesAheadOfThisBuild(storedWith([record, later]))).toBe(
      true,
    );
  });

  test("a version literal it cannot order is not ahead", async () => {
    // Another family, an unparsable literal, and an entry that is not an object
    // at all: nothing can be concluded from any of them, so each keeps the
    // app-upgrade reading -- the one that offers a way out.
    const record = await disclosureRecord();

    for (const entry of [
      { ...record, version: `${EXCHANGE_RECORD_VERSION}-moved` },
      { ...record, version: "psilink-disclosure-accounting/v99" },
      { ...record, version: "psilink-exchange-record/vNext" },
      { ...record, version: 6 },
      "one disclosure",
      null,
    ]) {
      expect(storedEntriesAheadOfThisBuild(storedWith([entry]))).toBe(false);
    }
  });
});

describe("the envelope-only read is scoped to the envelope, not an escape hatch", () => {
  test("an accounting this version can read is returned unchanged by it", async () => {
    const accounting = appendDisclosureRecord(
      undefined,
      await disclosureRecord(),
    );

    expect(parseStoredDisclosureAccounting(accounting).entries).toEqual(
      accounting.entries,
    );
  });

  test("rejects an unrecognized accounting version, exactly as the validating read does", async () => {
    const accounting = appendDisclosureRecord(
      undefined,
      await disclosureRecord(),
    );

    expect(() =>
      parseStoredDisclosureAccounting({
        ...accounting,
        version: "psilink-disclosure-accounting/v2",
      }),
    ).toThrow();
  });

  test("rejects an unknown key on the envelope", async () => {
    const accounting = appendDisclosureRecord(
      undefined,
      await disclosureRecord(),
    );

    expect(() =>
      parseStoredDisclosureAccounting({
        ...accounting,
        retainUntil: "2030-01-01",
      }),
    ).toThrow();
  });

  test("rejects a value whose entries are not a list, so a corrupted envelope offers nothing", () => {
    // The state the recovery surface must distinguish from a version bump: there
    // is no export to offer, and the surface says so rather than handing over a
    // shape it cannot vouch for at all.
    expect(() =>
      parseStoredDisclosureAccounting({
        version: DISCLOSURE_ACCOUNTING_VERSION,
        entries: "one disclosure",
      }),
    ).toThrow();
  });
});
