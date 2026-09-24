import { describe, expect, test } from "vitest";

import {
  UNFILED_DISCLOSURE_VERSION,
  noteUnfiledDisclosure,
  parseStoredUnfiledDisclosures,
  unfiledDisclosureKey,
  unfiledDisclosuresAfterFiling,
  unfiledDisclosuresOf,
} from "../../../src/psi/unfiledDisclosure.js";

import {
  disclosureRecord,
  neighbouringRecordVersion,
} from "../../utils/disclosureFixtures.js";

import type { StoredUnfiledDisclosures } from "../../../src/psi/unfiledDisclosure.js";

/**
 * The note a run leaves when its disclosure record never reached the accounting:
 * the shape at rest, the merge that keeps one entry per run, and the reading that
 * tells a run whose record can still be filed from one whose cannot.
 *
 * The fact and the retained record are separate things here, and the suite drives
 * them apart: a note whose record this build refuses must still say that a run
 * went unfiled, since that is the whole reason the note exists.
 */

const NOTED_AT = "2026-07-01T09:00:01.000Z";

function noted(
  entries: StoredUnfiledDisclosures["entries"],
): StoredUnfiledDisclosures {
  return { version: UNFILED_DISCLOSURE_VERSION, entries };
}

describe("where the note sits", () => {
  test("the key is not a key any accounting can be stored under", () => {
    const id = "6f1d1e1a-0000-4000-8000-000000000001";

    const key = unfiledDisclosureKey(id);

    // An array key orders and compares against no string key, so an exchange id
    // that spells the note's own key cannot reach another exchange's accounting.
    expect(Array.isArray(key)).toBe(true);
    expect(key).toEqual([id, "unfiled"]);
    expect(unfiledDisclosureKey(`${id}/unfiled`)).not.toEqual(key);
  });
});

describe("noting a run", () => {
  test("a first note starts one and keeps the record it retains", async () => {
    const record = await disclosureRecord();

    const note = noteUnfiledDisclosure(undefined, { at: NOTED_AT, record });

    expect(note.version).toBe(UNFILED_DISCLOSURE_VERSION);
    expect(note.entries).toEqual([{ at: NOTED_AT, record }]);
  });

  test("noting the same run twice leaves one entry", async () => {
    const record = await disclosureRecord();
    const first = noteUnfiledDisclosure(undefined, { at: NOTED_AT, record });

    // A second write of the same disclosure, at a different instant: the run is
    // identified by its record's own binding nonce, not by when it was noted.
    const again = noteUnfiledDisclosure(first, {
      at: "2026-07-02T09:00:00.000Z",
      record,
    });

    expect(again).toBe(first);
  });

  test("two runs that both went unfiled are both noted", async () => {
    const first = await disclosureRecord();
    const second = await disclosureRecord({
      createdAt: "2026-08-01T09:00:00.000Z",
    });

    const note = noteUnfiledDisclosure(
      noteUnfiledDisclosure(undefined, { at: NOTED_AT, record: first }),
      { at: "2026-08-01T09:00:01.000Z", record: second },
    );

    // The count of entries is the count of runs the accounting is short, so a
    // second shortfall may not displace the first.
    expect(note.entries).toHaveLength(2);
  });

  test("a run with no record is noted by its instant, and only once", () => {
    const first = noteUnfiledDisclosure(undefined, { at: NOTED_AT });

    const again = noteUnfiledDisclosure(first, { at: NOTED_AT });
    const later = noteUnfiledDisclosure(first, {
      at: "2026-08-01T09:00:00.000Z",
    });

    expect(again).toBe(first);
    expect(later.entries).toHaveLength(2);
  });
});

describe("the stored note", () => {
  test("a value under another version is refused", () => {
    expect(() =>
      parseStoredUnfiledDisclosures({
        version: "alcove-unfiled-disclosure/v3",
        entries: [],
      }),
    ).toThrow();
  });

  test("an unknown key is refused", () => {
    expect(() =>
      parseStoredUnfiledDisclosures({
        ...noted([]),
        filed: true,
      }),
    ).toThrow();
  });

  test("a record this build refuses does not refuse the note", async () => {
    const stranded = {
      ...(await disclosureRecord()),
      version: neighbouringRecordVersion(-1),
    };

    const stored = parseStoredUnfiledDisclosures(
      noted([{ at: NOTED_AT, record: stranded }]),
    );

    // The note survives a record-format move because the parse looks inside no
    // record: what it keeps is that a run disclosed and was never filed, which
    // no record format can invalidate. The record is still at rest, so the
    // reading marks it apart from a run that built none.
    expect(stored.entries).toHaveLength(1);
    expect(unfiledDisclosuresOf(stored)).toEqual([
      { at: NOTED_AT, unreadableRecordRetained: true },
    ]);
  });
});

describe("reading the noted runs", () => {
  test("a retained record names its own run instant", async () => {
    const record = await disclosureRecord();

    const read = unfiledDisclosuresOf(noted([{ at: NOTED_AT, record }]));

    expect(read).toEqual([{ at: record.createdAt, record }]);
  });

  test("a run that retained no record is reported as the fact alone", () => {
    expect(unfiledDisclosuresOf(noted([{ at: NOTED_AT }]))).toEqual([
      { at: NOTED_AT },
    ]);
  });
});

describe("what filing leaves behind", () => {
  test("a filed run is dropped and an unfiled one is kept", async () => {
    const filed = await disclosureRecord();
    const stranded = await disclosureRecord({
      createdAt: "2026-08-01T09:00:00.000Z",
    });
    const stored = noted([
      { at: NOTED_AT, record: filed },
      { at: "2026-08-01T09:00:01.000Z", record: stranded },
      { at: "2026-09-01T09:00:00.000Z" },
    ]);

    const left = unfiledDisclosuresAfterFiling(
      stored,
      new Set([filed.bindingNonce]),
    );

    expect(left?.entries).toEqual([
      { at: "2026-08-01T09:00:01.000Z", record: stranded },
      { at: "2026-09-01T09:00:00.000Z" },
    ]);
  });

  test("filing the last noted run leaves nothing to keep", async () => {
    const record = await disclosureRecord();

    const left = unfiledDisclosuresAfterFiling(
      noted([{ at: NOTED_AT, record }]),
      new Set([record.bindingNonce]),
    );

    // Undefined rather than an empty note: the store removes the key, so an
    // exchange that owes nothing holds nothing.
    expect(left).toBeUndefined();
  });
});
